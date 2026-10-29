-- People: job title, crew and access end date (docs/people.md).
--
-- The job title is what someone does; the access role is still what they may do, so nothing here
-- widens access. access_until narrows it: from that time the person is not a member of the site
-- for any read or write rule, the same as a removed member, until the Admin changes the date.

alter table site_members add column job_title text, add column job_title_other text, add column crew text, add column access_until timestamptz;
alter table site_invites add column job_title text, add column job_title_other text, add column crew text, add column access_until timestamptz;

alter table site_members add constraint site_members_people_check check (
  (job_title is null or job_title ~ '^[a-z_]{1,40}$')
  and (job_title_other is null or length(job_title_other) between 1 and 60)
  and (crew is null or length(crew) between 1 and 20));
alter table site_invites add constraint site_invites_people_check check (
  (job_title is null or job_title ~ '^[a-z_]{1,40}$')
  and (job_title_other is null or length(job_title_other) between 1 and 60)
  and (crew is null or length(crew) between 1 and 20));

-- ---------- access stops at access_until ----------

create or replace function my_site_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select m.site_id from site_members m
  where m.user_id = auth.uid() and m.retired_at is null and (m.access_until is null or m.access_until > now()) and session_fresh();
$$;

create or replace function is_site_member(p_site uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select session_fresh() and exists (
    select 1 from site_members m
    where m.site_id = p_site and m.user_id = auth.uid() and m.retired_at is null and (m.access_until is null or m.access_until > now())
  );
$$;

create or replace function site_role(p_site uuid) returns app_role
language sql stable security definer set search_path = public as $$
  select case
    when r = 'admin' and jwt_aal() <> 'aal2' and coalesce((access_setting(p_site)->>'adminMfa')::boolean, false) then 'viewer'::app_role
    else r end
  from (
    select case when m.acting_role is not null and m.acting_until > now() then m.acting_role else m.role end r
    from site_members m
    where m.site_id = p_site and m.user_id = auth.uid() and m.retired_at is null
      and (m.access_until is null or m.access_until > now()) and session_fresh()
  ) x;
$$;

-- A superintendent whose access has ended cannot approve, so does not count.
create or replace function site_has_superintendent(p_site uuid, p_except uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_site_member(p_site) and exists (
    select 1 from site_members m
    where m.site_id = p_site and m.retired_at is null and m.id is distinct from p_except
      and (m.access_until is null or m.access_until > now())
      and (m.role = 'superintendent' or (m.acting_role = 'superintendent' and m.acting_until > now()))
  );
$$;

-- Only the Admin changes a person's title, crew or end date (a superintendent applying an
-- approval may change the role fields only; member_role_guard checks the others).
create or replace function member_people_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if is_client() and site_role(new.site_id) is distinct from 'admin'
     and (new.job_title, new.job_title_other, new.crew, new.access_until)
         is distinct from (old.job_title, old.job_title_other, old.crew, old.access_until) then
    raise exception 'Only the Admin changes users.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger site_members_people_guard before update on site_members for each row execute function member_people_guard();

-- An invite carries the details into the membership; an invite past its end date is not used.
create or replace function app_join() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_uid uuid := auth.uid();
  n int := 0;
  i record;
begin
  if v_uid is null or v_email = '' then return 0; end if;
  for i in select * from site_invites where email = v_email and accepted_at is null and retired_at is null
             and (access_until is null or access_until > now()) loop
    insert into site_members (tenant_id, site_id, user_id, role, scope, name, email, created_by, job_title, job_title_other, crew, access_until)
    values (i.tenant_id, i.site_id, v_uid, i.role, i.scope, i.name, v_email, i.created_by, i.job_title, i.job_title_other, i.crew, i.access_until)
    on conflict (site_id, user_id) do update set role = excluded.role, scope = excluded.scope, retired_at = null,
      job_title = excluded.job_title, job_title_other = excluded.job_title_other, crew = excluded.crew, access_until = excluded.access_until;
    update site_invites set accepted_at = now(), accepted_by = v_uid where id = i.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- save and load ----------

create or replace function app_save_users(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare u jsonb; v_tenant uuid := (select tenant_id from sites where id = p_site);
begin
  for u in select e from jsonb_array_elements(p_rows) e loop
    if exists (select 1 from site_members m where m.site_id = p_site and m.user_id = (u->>'id')::uuid) then
      update site_members set role = (u->>'role')::app_role, scope = (select array_agg(x) from jsonb_array_elements_text(u->'scope') x),
        name = u->>'name', email = lower(u->>'email'), retired_at = (u->>'retiredAt')::timestamptz, retired_reason = u->>'retiredReason',
        job_title = u->>'jobTitle', job_title_other = u->>'jobTitleOther', crew = u->>'crew', access_until = (u->>'accessUntil')::timestamptz
      where site_id = p_site and user_id = (u->>'id')::uuid;
    else
      insert into site_invites (id, tenant_id, site_id, email, name, role, scope, retired_at, created_by, job_title, job_title_other, crew, access_until)
      values ((u->>'id')::uuid, v_tenant, p_site, lower(u->>'email'), u->>'name', (u->>'role')::app_role,
        (select array_agg(x) from jsonb_array_elements_text(u->'scope') x), (u->>'retiredAt')::timestamptz, auth.uid(),
        u->>'jobTitle', u->>'jobTitleOther', u->>'crew', (u->>'accessUntil')::timestamptz)
      on conflict (id) do update set role = excluded.role, scope = excluded.scope, name = excluded.name, retired_at = excluded.retired_at,
        job_title = excluded.job_title, job_title_other = excluded.job_title_other, crew = excluded.crew, access_until = excluded.access_until;
    end if;
  end loop;
end $$;

-- Title, crew and end date for everyone at the site (members and open invites), read by the app
-- next to app_load. Invoker rights: the read rules decide who sees what.
create or replace function app_load_people(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(p), '[]') from (
    select jsonb_strip_nulls(jsonb_build_object('id', m.user_id, 'jobTitle', m.job_title, 'jobTitleOther', m.job_title_other, 'crew', m.crew, 'accessUntil', m.access_until)) p
    from site_members m where m.site_id = p_site
    union all
    select jsonb_strip_nulls(jsonb_build_object('id', i.id, 'jobTitle', i.job_title, 'jobTitleOther', i.job_title_other, 'crew', i.crew, 'accessUntil', i.access_until))
    from site_invites i where i.site_id = p_site and i.accepted_at is null and i.retired_at is null
  ) q;
$$;

revoke execute on function my_site_ids, is_site_member, site_role, site_has_superintendent, member_people_guard, app_join, app_save_users, app_load_people from public, anon;
grant execute on function my_site_ids, app_join, app_save_users, app_load_people to authenticated;

notify pgrst, 'reload schema';
