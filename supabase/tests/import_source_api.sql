-- Import source setting test (docs/field-mapping.md): only the Admin sets it,
-- and only to Maximo or SAP PM.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'imports', '{"sourceSystem": "sap_pm"}', 'Moving to SAP');
  raise exception 'a reliability engineer set the import source';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'imports', '{"sourceSystem": "oracle"}', 'x');
  raise exception 'an unknown source system was saved';
exception when check_violation then null; end $$;
select app_save_setting('10000000-0000-0000-0000-000000000002', 'imports', '{"sourceSystem": "sap_pm", "siteValue": "1000"}', 'Moving to SAP');
do $$ begin
  if (app_load_work('10000000-0000-0000-0000-000000000002')->'settings'->'imports'->>'siteValue') <> '1000' then raise exception 'setting not saved'; end if;
end $$;
select app_save_assets('10000000-0000-0000-0000-000000000002', '[{"id": "40000000-0000-0000-0000-000000000001", "unitNumber": "HT101", "externalAssetId": "000000000010000101", "fleet": "HAULTRUCK", "model": "793F", "sourceSystem": "sap_pm"}, {"id": "40000000-0000-0000-0000-000000000002", "unitNumber": "HT102", "fleet": "Haul trucks", "model": "793F"}]');
reset role;
do $$ begin
  if (select source_system from assets where id = '40000000-0000-0000-0000-000000000001') <> 'sap_pm' then raise exception 'SAP asset not marked'; end if;
  if (select source_system from assets where id = '40000000-0000-0000-0000-000000000002') <> 'maximo' then raise exception 'default source changed'; end if;
end $$;
rollback;
\o
\echo Import source API test passed
