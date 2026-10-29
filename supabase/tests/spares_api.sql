-- Spares API test: the spares setting by the right roles only, and the spares
-- calculators accepted in saved analyses.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- A supervisor and an admin cannot change spares settings.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'spares', '{"fillTarget": 0.9}'::jsonb, 'x');
  raise exception 'supervisor changed spares settings';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'spares', '{"fillTarget": 0.9}'::jsonb, 'x');
  raise exception 'admin changed spares settings';
exception when insufficient_privilege then null; end $$;

-- Rae can, and saves a kit stocking result.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_setting('10000000-0000-0000-0000-000000000002', 'spares', '{"fillTarget": 0.9}'::jsonb, 'Site standard');
select app_save_analysis('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000001", "calculator": "kit_stocking", "version": 1,
  "title": "793F-500 kit", "inputs": {"form": {"parts": "A, 1, 30"}}, "result": {}}'::jsonb);
select app_save_analysis('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000002", "calculator": "rebuild_pool", "version": 1,
  "title": "Engines", "inputs": {}, "result": {}}'::jsonb);
reset role;
do $$ begin
  if (select (value->>'fillTarget')::numeric from site_settings where key = 'spares') <> 0.9 then raise exception 'setting not saved'; end if;
  if (select count(*) from saved_analyses where calculator in ('kit_stocking', 'rebuild_pool')) <> 2 then raise exception 'analyses not saved'; end if;
end $$;
rollback;
\o
\echo Spares API test passed
