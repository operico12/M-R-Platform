-- Access (docs/access.md): account requests by email domain, a 30-day cap on a
-- sign-in, and two-step sign-in for Admins. The rules live in the two helpers
-- every policy already uses (is_site_member and site_role), so they hold for
-- every table and function at once.

-- ---------- the site setting ----------

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts', 'condition', 'rcm', 'spares', 'assist', 'plant', 'imports', 'access'));
alter table site_settings add constraint site_settings_access_shape check (
  key <> 'access' or (
    jsonb_typeof(value->'requestDomains') = 'array' and jsonb_array_length(value->'requestDomains') <= 10
    and jsonb_typeof(value->'adminMfa') = 'boolean'
    and (value->>'sessionDays')::int between 1 and 30
    and (value->>'idleDays')::int between 1 and 30
  )
);

create or replace function can_write_setting(p_site uuid, p_key text) returns boolean
language sql stable security invoker set search_path = public as $$
  select case p_key
    when 'work' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'condition' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'rcm' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'spares' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'assist' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'plant' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'imports' then site_role(p_site) = 'admin'
    when 'access' then site_role(p_site) = 'admin'
    else false end;
$$;

-- ---------- sign-in token helpers ----------

-- The assurance level of this sign-in: aal2 after the authenticator code check.
create or replace function jwt_aal() returns text language sql stable as $$
  select coalesce(auth.jwt()->>'aal', 'aal1');
$$;

-- False when the sign-in (not the hourly token refresh) is more than 30 days old.
-- Supabase puts the sign-in time in the token's "amr" list. A token without it
-- (the database tests, the owner's own tools) is not limited here.
create or replace function session_fresh() returns boolean language sql stable as $$
  select coalesce(
    (select max((m->>'timestamp')::bigint) from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr') = 'array' then auth.jwt()->'amr' else '[]' end) m)
      > extract(epoch from now() - interval '30 days'),
    true);
$$;

-- Invoker rights: called by the app it sees only its own sites' settings; inside the
-- definer functions below it runs with the owner's rights.
create or replace function access_setting(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select value from site_settings where site_id = p_site and key = 'access';
$$;

create or replace function is_site_member(p_site uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select session_fresh() and exists (
    select 1 from site_members m
    where m.site_id = p_site and m.user_id = auth.uid() and m.retired_at is null
  );
$$;

-- An Admin at a site that asks for two-step sign-in acts as a Viewer until the code check is passed.
create or replace function site_role(p_site uuid) returns app_role
language sql stable security definer set search_path = public as $$
  select case
    when r = 'admin' and jwt_aal() <> 'aal2' and coalesce((access_setting(p_site)->>'adminMfa')::boolean, false) then 'viewer'::app_role
    else r end
  from (
    select case when m.acting_role is not null and m.acting_until > now() then m.acting_role else m.role end r
    from site_members m
    where m.site_id = p_site and m.user_id = auth.uid() and m.retired_at is null and session_fresh()
  ) x;
$$;

-- Turning two-step on for Admins needs an Admin who has passed the code check, so nobody is locked out.
create or replace function access_setting_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.key = 'access' and coalesce((new.value->>'adminMfa')::boolean, false)
     and (tg_op = 'INSERT' or not coalesce((old.value->>'adminMfa')::boolean, false))
     and is_client() and jwt_aal() <> 'aal2' then
    raise exception 'Turn on two-step sign-in for yourself and pass the code check first.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger site_settings_access_guard before insert or update on site_settings for each row execute function access_setting_guard();

-- The switcher also says when a site wants the code check before this person acts as Admin.
drop function if exists app_my_sites();
create function app_my_sites() returns table (site_id uuid, site_name text, time_zone text, role app_role, tenant_id uuid, mfa_required boolean)
language sql stable security invoker set search_path = public as $$
  select s.id, s.name, s.time_zone, site_role(s.id), s.tenant_id,
    exists (select 1 from site_members m where m.site_id = s.id and m.user_id = auth.uid() and m.retired_at is null and m.role = 'admin')
      and jwt_aal() <> 'aal2' and coalesce((access_setting(s.id)->>'adminMfa')::boolean, false)
  from sites s where is_site_member(s.id) and s.retired_at is null
  order by s.name;
$$;

-- ---------- account requests ----------

create table access_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  user_id uuid not null,
  email text not null check (email = lower(email)),
  name text not null check (length(trim(name)) between 1 and 80),
  note text check (note is null or length(note) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  role app_role,
  decided_by uuid,
  decided_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  check (status <> 'declined' or nullif(trim(reason), '') is not null),
  check (status <> 'approved' or role in ('viewer', 'technician', 'supervisor', 'reliability_engineer'))
);
create unique index access_requests_one_pending on access_requests (site_id, user_id) where status = 'pending';
alter table access_requests enable row level security;
-- The person sees their own requests; the site's Admin sees the site's. Writes only through the functions.
create policy access_requests_read on access_requests for select using (user_id = auth.uid() or site_role(site_id) = 'admin');
revoke all on access_requests from public, anon, authenticated;
grant select on access_requests to authenticated;

-- Sites this person may ask: active sites whose Admin listed the person's email domain.
create or replace function app_request_sites() returns table (site_id uuid, site_name text)
language sql stable security definer set search_path = public as $$
  select s.id, s.name from sites s
  where auth.uid() is not null and s.retired_at is null and session_fresh()
    and split_part(lower(coalesce(auth.jwt()->>'email', '')), '@', 2) <> ''
    and coalesce(access_setting(s.id)->'requestDomains', '[]') ? split_part(lower(auth.jwt()->>'email'), '@', 2)
    and not exists (select 1 from site_members m where m.site_id = s.id and m.user_id = auth.uid() and m.retired_at is null)
  order by s.name;
$$;

create or replace function app_request_access(p_site uuid, p_name text, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt()->>'email', ''));
  v_id uuid := gen_random_uuid();
  v_tenant uuid := (select tenant_id from sites where id = p_site and retired_at is null);
begin
  if auth.uid() is null or v_tenant is null or not exists (select 1 from app_request_sites() r where r.site_id = p_site) then
    raise exception 'This site does not take account requests from your email address.' using errcode = 'insufficient_privilege';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'Give your name (1 to 80 characters).' using errcode = 'check_violation'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'The note is up to 300 characters.' using errcode = 'check_violation'; end if;
  if exists (select 1 from access_requests where site_id = p_site and user_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a request waiting for this site.' using errcode = 'unique_violation';
  end if;
  if (select count(*) from access_requests where user_id = auth.uid() and created_at > now() - interval '1 day') >= 3 then
    raise exception 'At most 3 requests a day. Try again tomorrow.' using errcode = 'check_violation';
  end if;
  insert into access_requests (id, tenant_id, site_id, user_id, email, name, note)
  values (v_id, v_tenant, p_site, auth.uid(), v_email, trim(p_name), nullif(trim(coalesce(p_note, '')), ''));
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after, reason)
  values (v_tenant, p_site, auth.uid(), 'request_access', 'access_requests', v_id, null, jsonb_build_object('email', v_email, 'name', trim(p_name)), null);
  return v_id;
end $$;

create or replace function app_withdraw_access(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r access_requests;
begin
  select * into r from access_requests where id = p_id for update;
  if auth.uid() is null or r.id is null or r.user_id <> auth.uid() then raise exception 'Not your request.' using errcode = 'insufficient_privilege'; end if;
  if r.status <> 'pending' then raise exception 'That request has already been answered.' using errcode = 'check_violation'; end if;
  update access_requests set status = 'withdrawn', decided_at = now(), decided_by = auth.uid() where id = p_id;
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after, reason)
  values (r.tenant_id, r.site_id, auth.uid(), 'withdraw_access', 'access_requests', p_id, jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'withdrawn'), null);
end $$;

-- The person's own requests, with the site name (they cannot read the sites table yet).
create or replace function app_my_access_requests() returns table (id uuid, site_id uuid, site_name text, status text, role app_role, reason text, created_at timestamptz, decided_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, r.site_id, s.name, r.status, r.role, r.reason, r.created_at, r.decided_at
  from access_requests r join sites s on s.id = r.site_id
  where r.user_id = auth.uid() order by r.created_at desc;
$$;

create or replace function app_decide_access(p_id uuid, p_approve boolean, p_role app_role, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r access_requests;
begin
  select * into r from access_requests where id = p_id for update;
  if auth.uid() is null or r.id is null or site_role(r.site_id) is distinct from 'admin' then
    raise exception 'The site''s Admin answers account requests.' using errcode = 'insufficient_privilege';
  end if;
  if r.status <> 'pending' then raise exception 'That request has already been answered.' using errcode = 'check_violation'; end if;
  if p_approve and (p_role is null or p_role not in ('viewer', 'technician', 'supervisor', 'reliability_engineer')) then
    raise exception 'Approve as Viewer, Technician, Supervisor or Reliability engineer.' using errcode = 'check_violation';
  end if;
  if not p_approve and nullif(trim(p_reason), '') is null then raise exception 'Give the person a reason for declining.' using errcode = 'check_violation'; end if;
  update access_requests set status = case when p_approve then 'approved' else 'declined' end,
    role = case when p_approve then p_role end, decided_by = auth.uid(), decided_at = now(), reason = nullif(trim(p_reason), '')
  where id = p_id;
  if p_approve then
    insert into site_members (tenant_id, site_id, user_id, role, scope, name, email, created_by)
    values (r.tenant_id, r.site_id, r.user_id, p_role, '{*}', r.name, r.email, auth.uid())
    on conflict (site_id, user_id) do update set role = excluded.role, retired_at = null, name = excluded.name;
  end if;
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after, reason)
  values (r.tenant_id, r.site_id, auth.uid(), case when p_approve then 'approve_access' else 'decline_access' end, 'access_requests', p_id,
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', case when p_approve then 'approved' else 'declined' end, 'role', p_role, 'userId', r.user_id), nullif(trim(p_reason), ''));
end $$;

-- Postgres gives every new function to PUBLIC (and so to anon); a per-schema default cannot
-- remove that. So each migration revokes its functions, and supabase/tests/security_audit.sql
-- fails if one is missed.
revoke execute on function app_my_sites, app_request_access, app_withdraw_access, app_decide_access, app_request_sites, app_my_access_requests, access_setting, can_write_setting, is_site_member, site_role from public, anon;
grant execute on function app_my_sites, app_request_sites, app_request_access, app_withdraw_access, app_my_access_requests, app_decide_access, access_setting, jwt_aal, session_fresh to authenticated;
revoke execute on function jwt_aal, session_fresh, access_setting_guard from public, anon;

notify pgrst, 'reload schema';
