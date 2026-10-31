-- Admin test mode (docs/access.md section 4). Development only, off by default.
--
-- While the site's access setting testMode is on, a person whose own role is Admin may pick a role to
-- test as. site_role() then returns that role, so every read and write rule follows it. Nothing else
-- widens: someone who is not an Admin cannot pick, two-step sign-in still comes first, and turning
-- test mode off sends everyone back to their own role at once.

-- The role a person has at the site before any test pick: the acting role until it ends, then their
-- own; an Admin who must pass two-step sign-in and has not is a Viewer (unchanged from 20261118).
create or replace function own_site_role(p_site uuid) returns app_role
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

-- One row per Admin and site: the role they test as (null = their own). Written only by
-- app_set_test_role; never deleted; audited.
create table admin_test_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  user_id uuid not null,
  role app_role,
  set_at timestamptz not null default now(),
  unique (site_id, user_id)
);
create trigger admin_test_roles_no_delete before delete on admin_test_roles for each row execute function refuse_delete();
create trigger admin_test_roles_audit after insert or update on admin_test_roles for each row execute function audit_row();
alter table admin_test_roles enable row level security;
create policy admin_test_roles_read on admin_test_roles for select using (user_id = auth.uid() and site_id in (select my_site_ids()));
grant select on admin_test_roles to authenticated;

create or replace function site_role(p_site uuid) returns app_role
language sql stable security definer set search_path = public as $$
  select case
    when o = 'admin' and coalesce((access_setting(p_site)->>'testMode')::boolean, false)
      then coalesce((select t.role from admin_test_roles t where t.site_id = p_site and t.user_id = auth.uid()), o)
    else o end
  from (select own_site_role(p_site) o) x;
$$;

-- Pick a role to test as (null or 'admin' = back to Admin). Only for an Admin, only in test mode.
create or replace function app_set_test_role(p_site uuid, p_role app_role) returns app_role
language plpgsql security definer set search_path = public as $$
declare v_role app_role := nullif(p_role, 'admin');
begin
  if auth.uid() is null or own_site_role(p_site) is distinct from 'admin' then
    raise exception 'Only an Admin can test as another role.' using errcode = 'insufficient_privilege';
  end if;
  if not coalesce((access_setting(p_site)->>'testMode')::boolean, false) then
    raise exception 'Test mode is off for this site.' using errcode = 'insufficient_privilege';
  end if;
  insert into admin_test_roles (tenant_id, site_id, user_id, role)
  select s.tenant_id, p_site, auth.uid(), v_role from sites s where s.id = p_site
  on conflict (site_id, user_id) do update set role = excluded.role, set_at = now()
    where admin_test_roles.role is distinct from excluded.role;
  return site_role(p_site);
end $$;

-- What the picker needs: the person's own role, the role in use, and the pick.
create or replace function app_my_test_role(p_site uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ownRole', own_site_role(p_site),
    'role', site_role(p_site),
    'testMode', coalesce((access_setting(p_site)->>'testMode')::boolean, false),
    'testRole', (select t.role from admin_test_roles t where t.site_id = p_site and t.user_id = auth.uid()));
$$;

revoke execute on function own_site_role, app_set_test_role, app_my_test_role from public, anon;
grant execute on function own_site_role, app_set_test_role, app_my_test_role to authenticated;

notify pgrst, 'reload schema';
