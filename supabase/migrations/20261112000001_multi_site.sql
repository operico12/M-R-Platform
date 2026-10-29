-- Multi-site (phase 4 part 1, docs/multi-site.md). Adding and retiring a site of
-- the tenant. The schema already has tenant and site IDs and row-level security
-- per site on every table, so a new site is rows, not a copy of the schema.

alter table sites add column if not exists retire_reason text;
alter table sites add column if not exists retired_by uuid;

-- Sites the signed-in person belongs to, with the tenant (for the switcher and the Sites page).
drop function if exists app_my_sites();
create function app_my_sites() returns table (site_id uuid, site_name text, time_zone text, role app_role, tenant_id uuid)
language sql stable security invoker set search_path = public as $$
  select s.id, s.name, s.time_zone, site_role(s.id), s.tenant_id
  from sites s where is_site_member(s.id) and s.retired_at is null
  order by s.name;
$$;

-- A new site of the tenant of p_from. Only the Admin of p_from can add one; they become its Admin.
-- p_calendar and p_rules come from packages/core (the default 12-hour calendar and flag rules),
-- so the database does not keep a second copy of the defaults.
create or replace function app_add_site(p_from uuid, s jsonb, p_calendar jsonb, p_rules jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := (select tenant_id from sites where id = p_from and retired_at is null);
  v_id uuid := (s->>'id')::uuid;
  v_name text := trim(coalesce(s->>'name', ''));
  v_tz text := trim(coalesce(s->>'timeZone', ''));
  v_me record;
begin
  if auth.uid() is null or v_tenant is null or site_role(p_from) is distinct from 'admin' then
    raise exception 'The Admin of a site of this tenant adds sites.' using errcode = 'insufficient_privilege';
  end if;
  if v_name = '' or length(v_name) > 100 then raise exception 'Name the site (1 to 100 characters).' using errcode = 'check_violation'; end if;
  if exists (select 1 from sites where tenant_id = v_tenant and retired_at is null and lower(trim(name)) = lower(v_name)) then
    raise exception 'The tenant already has a site called %.', v_name using errcode = 'unique_violation';
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    raise exception 'Give an IANA time zone, for example America/Edmonton.' using errcode = 'check_violation';
  end if;
  if p_calendar is null or jsonb_typeof(p_calendar->'shifts') <> 'array' or p_rules is null then
    raise exception 'The new site needs a shift calendar and flag rules.' using errcode = 'check_violation';
  end if;
  select name, email into v_me from site_members where site_id = p_from and user_id = auth.uid() and retired_at is null;
  insert into sites (id, tenant_id, name, time_zone, created_by, updated_by) values (v_id, v_tenant, v_name, v_tz, auth.uid(), auth.uid());
  insert into shift_calendars (tenant_id, site_id, shifts, rotation, effective_from, created_by)
  values (v_tenant, v_id, p_calendar->'shifts', p_calendar->'rotation', '2000-01-01', auth.uid());
  insert into flag_rules (tenant_id, site_id, rules, effective_from, created_by) values (v_tenant, v_id, p_rules, '2000-01-01', auth.uid());
  insert into site_members (tenant_id, site_id, user_id, role, scope, name, email, created_by)
  values (v_tenant, v_id, auth.uid(), 'admin', '{*}', v_me.name, v_me.email, auth.uid());
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after, reason)
  select v_tenant, x, auth.uid(), 'add_site', 'site', v_id, null, jsonb_build_object('id', v_id, 'name', v_name, 'timeZone', v_tz, 'from', p_from), 'New site ' || v_name
  from unnest(array[v_id, p_from]) x;
end $$;

-- Retire a site. Only its Admin; never the last active site of the tenant. Its records stay.
create or replace function app_retire_site(p_site uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := (select tenant_id from sites where id = p_site and retired_at is null);
begin
  if auth.uid() is null or v_tenant is null or site_role(p_site) is distinct from 'admin' then
    raise exception 'The site''s Admin retires it.' using errcode = 'insufficient_privilege';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  if not exists (select 1 from sites where tenant_id = v_tenant and id <> p_site and retired_at is null) then
    raise exception 'This is the last active site of the tenant, so it cannot be retired.' using errcode = 'check_violation';
  end if;
  update sites set retired_at = now(), retired_by = auth.uid(), retire_reason = trim(p_reason), updated_by = auth.uid() where id = p_site;
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after, reason)
  values (v_tenant, p_site, auth.uid(), 'retire_site', 'site', p_site, null, jsonb_build_object('retiredAt', now()), trim(p_reason));
end $$;

revoke execute on function app_add_site, app_retire_site from public, anon;
grant execute on function app_my_sites, app_add_site, app_retire_site to authenticated;

notify pgrst, 'reload schema';
