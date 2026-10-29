-- Multi-site API test (docs/multi-site.md): only a site's Admin adds a site to
-- its tenant and becomes the new site's Admin; names are unique per tenant;
-- the time zone must be real; the last site cannot be retired.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant'), ('10000000-0000-0000-0000-000000000009', 'Other tenant');
insert into sites (id, tenant_id, name, time_zone) values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver'),
  ('10000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000009', 'Not ours', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'superintendent', '{*}', 'Sol', 'sol@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_add_site('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "name": "Mine B", "timeZone": "America/Edmonton"}', '{"shifts": [{"name": "Day", "startLocal": "06:00"}]}', '{}');
  raise exception 'a superintendent added a site';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_add_site('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "name": "mine a", "timeZone": "America/Edmonton"}', '{"shifts": []}', '{}');
  raise exception 'a duplicate name was allowed';
exception when unique_violation then null; end $$;
do $$ begin
  perform app_add_site('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "name": "Mine B", "timeZone": "Mars/Olympus"}', '{"shifts": []}', '{}');
  raise exception 'a bad time zone was allowed';
exception when check_violation then null; end $$;
do $$ begin
  perform app_add_site('10000000-0000-0000-0000-000000000008', '{"id": "30000000-0000-0000-0000-000000000001", "name": "Mine B", "timeZone": "UTC"}', '{"shifts": []}', '{}');
  raise exception 'a site was added to another tenant';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_retire_site('10000000-0000-0000-0000-000000000002', 'Closed');
  raise exception 'the last site was retired';
exception when check_violation then null; end $$;
select app_add_site('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "name": "Mine B", "timeZone": "America/Edmonton"}',
  '{"shifts": [{"name": "Day", "startLocal": "06:00"}, {"name": "Night", "startLocal": "18:00"}], "rotation": null}', '{"a": 1}');
do $$ begin
  if (select count(*) from app_my_sites()) <> 2 then raise exception 'the admin should see two sites'; end if;
  if (select role from app_my_sites() where site_id = '30000000-0000-0000-0000-000000000001') <> 'admin' then raise exception 'the adder is not the new admin'; end if;
  if (select tenant_id from app_my_sites() where site_id = '30000000-0000-0000-0000-000000000001') <> '10000000-0000-0000-0000-000000000001' then raise exception 'wrong tenant'; end if;
  if (app_load('30000000-0000-0000-0000-000000000001')->'calendar'->'shifts'->1->>'startLocal') <> '18:00' then raise exception 'calendar not set'; end if;
  if (app_load('30000000-0000-0000-0000-000000000001')->'site'->>'timeZone') <> 'America/Edmonton' then raise exception 'time zone not set'; end if;
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  if exists (select 1 from app_my_sites() where site_id = '30000000-0000-0000-0000-000000000001') then raise exception 'a non-member sees the new site'; end if;
  perform app_retire_site('30000000-0000-0000-0000-000000000001', 'x');
  raise exception 'a non-member retired a site';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_retire_site('30000000-0000-0000-0000-000000000001', 'Sold');
do $$ begin
  if (select count(*) from app_my_sites()) <> 1 then raise exception 'a retired site still shows'; end if;
end $$;
reset role;
do $$ begin
  if (select count(*) from audit_log where entity = 'site') <> 3 then raise exception 'expected 3 site audit rows, got %', (select count(*) from audit_log where entity = 'site'); end if;
  if (select retire_reason from sites where id = '30000000-0000-0000-0000-000000000001') <> 'Sold' then raise exception 'no retire reason'; end if;
end $$;
rollback;
\o
\echo Multi-site API test passed
