-- Plant API test (docs/fixed-plant.md): structure by admin only, process delays by flag roles,
-- end once, void once, nothing else changes, nothing is deleted; run signals by admin, no repeats.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver'),
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Other mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com');
insert into assets (id, tenant_id, site_id, unit_number, asset_class, functional_location) values
  ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'PP01', 'fixed_plant', 'CON-GRD-PP01'),
  ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT101', 'mobile', null);
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- Structure: only the admin.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  perform app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "kind": "plant", "name": "Concentrator", "functionalLocation": "CON"}');
  raise exception 'reliability engineer added a plant node';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "kind": "plant", "name": "Concentrator", "functionalLocation": "CON", "plannedRateTph": 1200}');
select app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000002", "kind": "circuit", "name": "Grinding", "parentId": "20000000-0000-0000-0000-000000000001", "functionalLocation": "CON-GRD", "order": 1}');
do $$ begin
  perform app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000003", "kind": "valve", "name": "x"}');
  raise exception 'a bad kind was saved';
exception when check_violation then null; end $$;
-- A node with active children cannot be retired.
do $$ begin
  perform app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "kind": "plant", "name": "Concentrator", "retireReason": "Closed"}');
  raise exception 'retired a node with children';
exception when check_violation then null; end $$;
do $$ begin
  delete from plant_nodes where id = '20000000-0000-0000-0000-000000000002';
  if found then raise exception 'a plant node was deleted'; end if;
exception when others then if sqlerrm like '%deleted%' then raise; end if; end $$;

-- Run signals: admin only, fixed plant only, a repeat is skipped.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_run_signals('10000000-0000-0000-0000-000000000002', '[{"assetId": "10000000-0000-0000-0000-000000000005", "at": "2026-10-20T08:00:00Z", "running": true}]');
  raise exception 'supervisor loaded signals';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  if app_save_run_signals('10000000-0000-0000-0000-000000000002', '[{"assetId": "10000000-0000-0000-0000-000000000005", "at": "2026-10-20T08:00:00Z", "running": true}, {"assetId": "10000000-0000-0000-0000-000000000005", "at": "2026-10-20T10:00:00Z", "running": false}]') <> 2 then raise exception 'signals not saved'; end if;
  if app_save_run_signals('10000000-0000-0000-0000-000000000002', '[{"assetId": "10000000-0000-0000-0000-000000000005", "at": "2026-10-20T08:00:00Z", "running": false}]') <> 0 then raise exception 'repeat signal saved'; end if;
end $$;
do $$ begin
  perform app_save_run_signals('10000000-0000-0000-0000-000000000002', '[{"assetId": "10000000-0000-0000-0000-000000000006", "at": "2026-10-20T08:00:00Z", "running": true}]');
  raise exception 'signal saved for a truck';
exception when check_violation then null; end $$;
do $$ begin
  update run_signals set running = false where asset_id = '10000000-0000-0000-0000-000000000005' and at = '2026-10-20T08:00:00Z';
  if found then raise exception 'a run signal was changed'; end if;
exception when insufficient_privilege then null; end $$;

-- Process delays: not the technician or the admin; the supervisor can.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "nodeId": "20000000-0000-0000-0000-000000000002", "code": "No feed", "start": "2026-10-20T08:00:00Z"}');
  raise exception 'technician recorded a delay';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "nodeId": "20000000-0000-0000-0000-000000000002", "code": "No feed", "start": "2026-10-20T08:00:00Z"}');
  raise exception 'admin recorded a delay';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "nodeId": "20000000-0000-0000-0000-000000000002", "assetId": "10000000-0000-0000-0000-000000000005", "code": "Bins or stockpile full", "start": "2026-10-20T08:00:00Z", "fromFlagIds": ["40000000-0000-0000-0000-000000000001"], "notes": "Stockpile full"}');
do $$ begin
  perform app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000002", "nodeId": "20000000-0000-0000-0000-000000000002", "code": "No feed", "start": "2099-01-01T00:00:00Z"}');
  raise exception 'future delay saved';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000003", "nodeId": "20000000-0000-0000-0000-000000000002", "assetId": "10000000-0000-0000-0000-000000000006", "code": "No feed", "start": "2026-10-20T08:00:00Z"}');
  raise exception 'delay saved on a truck';
exception when check_violation then null; end $$;
-- End it once.
select app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "nodeId": "20000000-0000-0000-0000-000000000002", "assetId": "10000000-0000-0000-0000-000000000005", "code": "Bins or stockpile full", "start": "2026-10-20T08:00:00Z", "end": "2026-10-20T11:00:00Z"}');
do $$ begin
  perform app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "nodeId": "20000000-0000-0000-0000-000000000002", "code": "Bins or stockpile full", "start": "2026-10-20T08:00:00Z", "end": "2026-10-20T12:00:00Z"}');
  raise exception 'end changed twice';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update process_delays set code = 'No feed' where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'code changed';
exception when insufficient_privilege then null; end $$;
-- Void with a reason, then nothing more.
select app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "nodeId": "20000000-0000-0000-0000-000000000002", "assetId": "10000000-0000-0000-0000-000000000005", "code": "Bins or stockpile full", "start": "2026-10-20T08:00:00Z", "end": "2026-10-20T11:00:00Z", "voidReason": "Wrong circuit"}');
do $$ begin
  perform app_save_process_delay('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "nodeId": "20000000-0000-0000-0000-000000000002", "code": "Bins or stockpile full", "start": "2026-10-20T08:00:00Z", "end": "2026-10-20T11:00:00Z", "voidReason": "Again"}');
  raise exception 'voided twice';
exception when insufficient_privilege then null; end $$;

-- Load: nodes, the voided delay with its reason, and signals including the one before the window.
do $$
declare v jsonb := app_load_plant('10000000-0000-0000-0000-000000000002', '2026-10-20T09:00:00Z');
begin
  if jsonb_array_length(v->'nodes') <> 2 then raise exception 'nodes: %', v->'nodes'; end if;
  if (v->'nodes'->0->>'plannedRateTph')::numeric <> 1200 then raise exception 'rate not loaded'; end if;
  if v->'delays'->0->>'voidReason' <> 'Wrong circuit' or v->'delays'->0->>'voidedBy' is null then raise exception 'void not loaded: %', v->'delays'; end if;
  if v->'delays'->0->'fromFlagIds'->>0 <> '40000000-0000-0000-0000-000000000001' then raise exception 'flag ids not loaded'; end if;
  if jsonb_array_length(v->'signals') <> 2 then raise exception 'signals: %', v->'signals'; end if;
end $$;

-- Another site sees nothing.
do $$ begin
  if jsonb_array_length(app_load_plant('10000000-0000-0000-0000-000000000003', '2026-01-01T00:00:00Z')->'nodes') <> 0 then raise exception 'other site sees nodes'; end if;
end $$;

-- Plant settings: not the supervisor; the admin and reliability engineer can.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'plant', '{"minStopMinutes": 2}'::jsonb, 'x');
  raise exception 'supervisor changed plant settings';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_save_setting('10000000-0000-0000-0000-000000000002', 'plant', '{"minStopMinutes": 2}'::jsonb, 'Site review');
reset role;
do $$ begin
  if (select count(*) from audit_log where entity = 'process_delays') < 3 then raise exception 'delay changes not audited'; end if;
  if (select count(*) from audit_log where entity = 'run_signals') <> 2 then raise exception 'signals not audited'; end if;
end $$;
rollback;
\o
\echo Plant API test passed
