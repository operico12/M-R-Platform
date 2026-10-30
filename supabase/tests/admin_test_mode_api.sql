-- Admin test mode (docs/access.md section 4): only an Admin, only while test mode is on, two-step
-- sign-in still first, every rule follows the picked role, off sends everyone back, audited.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com');
create function pg_temp.as_user(p_id text, p_aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true),
    set_config('request.jwt.claims', json_build_object('sub', p_id, 'aal', p_aal)::text, true);
$$;
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');

-- Off by default: the Admin cannot pick.
do $$ begin
  perform app_set_test_role('10000000-0000-0000-0000-000000000002', 'technician');
  raise exception 'picked a role with test mode off';
exception when insufficient_privilege then null; end $$;

-- The Admin turns test mode on and tests as a technician: the database treats them as one.
insert into site_settings (tenant_id, site_id, key, value, reason) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'access',
  '{"requestDomains": [], "adminMfa": false, "sessionDays": 30, "idleDays": 7, "testMode": true}', 'Testing');
do $$ begin
  if app_set_test_role('10000000-0000-0000-0000-000000000002', 'technician') <> 'technician' then raise exception 'pick not returned'; end if;
  if site_role('10000000-0000-0000-0000-000000000002') <> 'technician' then raise exception 'site_role ignores the pick'; end if;
  if (app_my_test_role('10000000-0000-0000-0000-000000000002')->>'ownRole') <> 'admin' then raise exception 'own role lost'; end if;
end $$;
-- As a technician the Admin-only rules now refuse (the access setting is the Admin's).
do $$ begin
  update site_settings set value = value || '{"testMode": false}' where key = 'access';
  if found then raise exception 'technician changed the access setting'; end if;
end $$;
-- As a superintendent, the superintendent's rules apply.
do $$ begin
  perform app_set_test_role('10000000-0000-0000-0000-000000000002', 'superintendent');
  if not can_write_setting('10000000-0000-0000-0000-000000000002', 'work') then raise exception 'superintendent rule not applied'; end if;
end $$;
-- Back to Admin, then test mode off: the pick is ignored even if set.
do $$ begin
  perform app_set_test_role('10000000-0000-0000-0000-000000000002', 'admin');
  if site_role('10000000-0000-0000-0000-000000000002') <> 'admin' then raise exception 'not back to admin'; end if;
  perform app_set_test_role('10000000-0000-0000-0000-000000000002', 'viewer');
end $$;
-- Viewer cannot write settings, so go back to Admin to switch off.
select app_set_test_role('10000000-0000-0000-0000-000000000002', null);
update site_settings set value = value || '{"testMode": false}' where key = 'access';
reset role;
update admin_test_roles set role = 'viewer';
set local role authenticated;
do $$ begin
  if site_role('10000000-0000-0000-0000-000000000002') <> 'admin' then raise exception 'pick applied with test mode off'; end if;
end $$;

-- A supervisor cannot pick, even with test mode on, and cannot write the table directly.
reset role;
update site_settings set value = value || '{"testMode": true}' where key = 'access';
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_set_test_role('10000000-0000-0000-0000-000000000002', 'superintendent');
  raise exception 'supervisor picked a role';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into admin_test_roles (tenant_id, site_id, user_id, role) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'superintendent');
  raise exception 'direct insert allowed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  if (select count(*) from admin_test_roles) <> 0 then raise exception 'supervisor sees the Admin''s pick'; end if;
  if site_role('10000000-0000-0000-0000-000000000002') <> 'supervisor' then raise exception 'supervisor changed'; end if;
end $$;

-- Two-step sign-in comes first: with adminMfa on and no code check, the Admin is a Viewer whatever the pick.
reset role;
update site_settings set value = value || '{"adminMfa": true}' where key = 'access';
update admin_test_roles set role = 'superintendent';
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'aal1');
do $$ begin
  if site_role('10000000-0000-0000-0000-000000000002') <> 'viewer' then raise exception 'test pick skipped two-step'; end if;
  perform app_set_test_role('10000000-0000-0000-0000-000000000002', 'technician');
  raise exception 'picked without the code check';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'aal2');
do $$ begin
  if site_role('10000000-0000-0000-0000-000000000002') <> 'superintendent' then raise exception 'pick lost after code check'; end if;
end $$;

-- Never deleted, and every pick audited.
do $$ begin
  delete from admin_test_roles;
  raise exception 'delete allowed';
exception when insufficient_privilege then null; end $$;
reset role;
do $$ begin
  if (select count(*) from audit_log where entity = 'admin_test_roles') < 4 then raise exception 'picks not audited (%)', (select count(*) from audit_log where entity = 'admin_test_roles'); end if;
end $$;
rollback;
\o
\echo Admin test mode API test passed
