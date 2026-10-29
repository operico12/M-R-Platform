-- Assist API test: the assist setting by the right roles only.
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

-- A supervisor and an admin cannot change assist settings.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'assist', '{"suggestCodes": true}'::jsonb, 'x');
  raise exception 'supervisor changed assist settings';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'assist', '{"suggestCodes": true}'::jsonb, 'x');
  raise exception 'admin changed assist settings';
exception when insufficient_privilege then null; end $$;

-- Rae can.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_setting('10000000-0000-0000-0000-000000000002', 'assist', '{"suggestCodes": true, "minScore": 0.85}'::jsonb, 'Trial on haul trucks');
reset role;
do $$ begin
  if (select (value->>'minScore')::numeric from site_settings where key = 'assist') <> 0.85 then raise exception 'setting not saved'; end if;
end $$;
rollback;
\o
\echo Assist API test passed
