-- Plant part 2 API test (docs/fixed-plant.md): structure kinds, loops and functional
-- locations; routes and rounds through inspections; shutdowns and their scope in order.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com');
insert into assets (id, tenant_id, site_id, unit_number, asset_class, functional_location) values
  ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'PP01', 'fixed_plant', 'CON-GRD-PP01'),
  ('10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'PP02', 'fixed_plant', 'CON-GRD-PP02'),
  ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT101', 'mobile', null);
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- ---------- structure ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "kind": "plant", "name": "Concentrator", "functionalLocation": "CON"}');
select app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000002", "kind": "circuit", "name": "Grinding", "parentId": "20000000-0000-0000-0000-000000000001", "functionalLocation": "CON-GRD"}');
select app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000003", "kind": "group", "name": "G1", "parentId": "20000000-0000-0000-0000-000000000002"}');
select app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000004", "kind": "group", "name": "G2", "parentId": "20000000-0000-0000-0000-000000000003"}');
do $$ begin
  perform app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000009", "kind": "circuit", "name": "x", "parentId": "20000000-0000-0000-0000-000000000002"}');
  raise exception 'a circuit was put under a circuit';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000009", "kind": "area", "name": "x"}');
  raise exception 'an area was made a root';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000003", "kind": "group", "name": "G1", "parentId": "20000000-0000-0000-0000-000000000004"}');
  raise exception 'a loop was saved';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_plant_node('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000009", "kind": "circuit", "name": "Twin", "parentId": "20000000-0000-0000-0000-000000000001", "functionalLocation": "con.grd"}');
  raise exception 'two nodes share a functional location';
exception when unique_violation then null; end $$;

-- ---------- routes and rounds ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_form('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000001", "version": 1, "name": "Grinding round", "assetClass": "fixed_plant", "models": [],
  "every": {"n": 1, "unit": "shifts"}, "reason": "First",
  "route": {"kind": "operator_round", "nodeId": "20000000-0000-0000-0000-000000000002", "stops": ["10000000-0000-0000-0000-000000000005", "10000000-0000-0000-0000-000000000007"]},
  "items": [{"id": "a", "stopId": "10000000-0000-0000-0000-000000000005", "kind": "pass_fail", "text": "Seal"}, {"id": "b", "stopId": "10000000-0000-0000-0000-000000000007", "kind": "task", "text": "Grease"}]}');
do $$ begin
  perform app_save_form('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000002", "version": 1, "name": "Bad", "assetClass": "fixed_plant", "models": [],
    "every": {"n": 1, "unit": "shifts"}, "reason": "x", "route": {"kind": "operator_round", "nodeId": "20000000-0000-0000-0000-000000000002", "stops": ["10000000-0000-0000-0000-000000000006"]},
    "items": [{"id": "a", "kind": "pass_fail", "text": "x"}]}');
  raise exception 'a truck was made a route stop';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_save_form('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000003", "version": 1, "name": "Bad", "assetClass": "mobile", "models": [],
    "every": {"n": 1, "unit": "shifts"}, "reason": "x", "items": [{"id": "a", "kind": "pass_fail", "text": "x"}]}');
  raise exception 'a unit form was made due by shift';
exception when check_violation then null; end $$;

select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select app_save_round('10000000-0000-0000-0000-000000000002',
  '{"id": "60000000-0000-0000-0000-000000000001", "formId": "50000000-0000-0000-0000-000000000001", "formVersion": 1, "nodeId": "20000000-0000-0000-0000-000000000002", "startedAt": "2026-10-20T08:00:00Z", "skipped": [{"stopId": "10000000-0000-0000-0000-000000000007", "reason": "Equipment down"}]}',
  '[{"id": "61000000-0000-0000-0000-000000000001", "formId": "50000000-0000-0000-0000-000000000001", "formVersion": 1, "unitId": "10000000-0000-0000-0000-000000000005", "answers": {"a": {"value": "pass"}}, "score": 1, "result": "pass", "startedAt": "2026-10-20T08:00:00Z"}]');
do $$ begin
  if (select count(*) from inspections where round_id = '60000000-0000-0000-0000-000000000001') <> 1 then raise exception 'round inspection not saved'; end if;
  if (select status from rounds where id = '60000000-0000-0000-0000-000000000001') <> 'submitted' then raise exception 'round not submitted'; end if;
end $$;
-- A route stop outside a round, or a stop not on the route, is refused.
do $$ begin
  perform app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000002", "formId": "50000000-0000-0000-0000-000000000001", "formVersion": 1, "unitId": "10000000-0000-0000-0000-000000000005", "answers": {}, "startedAt": "2026-10-20T08:00:00Z"}');
  raise exception 'a route was done outside a round';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000003", "formId": "50000000-0000-0000-0000-000000000001", "formVersion": 1, "unitId": "10000000-0000-0000-0000-000000000006", "roundId": "60000000-0000-0000-0000-000000000001", "answers": {}, "startedAt": "2026-10-20T08:00:00Z"}');
  raise exception 'a truck was added to a round';
exception when insufficient_privilege then null; end $$;
-- Someone else cannot add a stop to it.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000004", "formId": "50000000-0000-0000-0000-000000000001", "formVersion": 1, "unitId": "10000000-0000-0000-0000-000000000007", "roundId": "60000000-0000-0000-0000-000000000001", "answers": {}, "startedAt": "2026-10-20T08:00:00Z"}');
  raise exception 'someone else added a stop to a round';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update rounds set skipped = '[]' where id = '60000000-0000-0000-0000-000000000001';
  raise exception 'a round was changed';
exception when insufficient_privilege then null; end $$;
-- The technician cannot void it; the supervisor voids the round and its inspections.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_round('10000000-0000-0000-0000-000000000002', '{"id": "60000000-0000-0000-0000-000000000001", "status": "voided", "voidReason": "x"}', '[]');
  raise exception 'technician voided a round';
exception when no_data_found or insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_round('10000000-0000-0000-0000-000000000002', '{"id": "60000000-0000-0000-0000-000000000001", "status": "voided", "voidReason": "Wrong route"}', '[]');
do $$ begin
  if (select status from rounds where id = '60000000-0000-0000-0000-000000000001') <> 'voided' then raise exception 'round not voided'; end if;
  if exists (select 1 from inspections where round_id = '60000000-0000-0000-0000-000000000001' and status <> 'voided') then raise exception 'round inspections not voided'; end if;
  if jsonb_array_length(app_load_inspections('10000000-0000-0000-0000-000000000002', '2026-01-01')->'rounds') <> 1 then raise exception 'rounds not loaded'; end if;
  if (app_load_inspections('10000000-0000-0000-0000-000000000002', '2026-01-01')->'forms'->0->'route'->>'kind') <> 'operator_round' then raise exception 'route not loaded'; end if;
end $$;

-- ---------- shutdowns ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_shutdown('10000000-0000-0000-0000-000000000002', jsonb_build_object('id', '70000000-0000-0000-0000-000000000001', 'nodeId', '20000000-0000-0000-0000-000000000002',
    'name', 'Reline', 'workOrder', 'WO-1', 'plannedStart', now() + interval '2 days', 'plannedEnd', now() + interval '2 days 12 hours', 'freezeAt', now() - interval '1 day',
    'equipmentIds', jsonb_build_array('10000000-0000-0000-0000-000000000005')));
  raise exception 'technician planned a shutdown';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_shutdown('10000000-0000-0000-0000-000000000002', jsonb_build_object('id', '70000000-0000-0000-0000-000000000009', 'nodeId', '20000000-0000-0000-0000-000000000002',
    'name', 'Bad', 'workOrder', 'WO-1', 'plannedStart', now() + interval '2 days', 'plannedEnd', now() + interval '3 days', 'freezeAt', now(),
    'equipmentIds', jsonb_build_array('10000000-0000-0000-0000-000000000006')));
  raise exception 'a truck took part in a plant shutdown';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_shutdown('10000000-0000-0000-0000-000000000002', jsonb_build_object('id', '70000000-0000-0000-0000-000000000009', 'nodeId', '20000000-0000-0000-0000-000000000003',
    'name', 'Bad', 'workOrder', 'WO-1', 'plannedStart', now() + interval '2 days', 'plannedEnd', now() + interval '3 days', 'freezeAt', now(),
    'equipmentIds', jsonb_build_array('10000000-0000-0000-0000-000000000005')));
  raise exception 'a shutdown was planned on a redundancy group';
exception when check_violation then null; end $$;
select app_save_shutdown('10000000-0000-0000-0000-000000000002', jsonb_build_object('id', '70000000-0000-0000-0000-000000000001', 'nodeId', '20000000-0000-0000-0000-000000000002',
  'name', 'Reline', 'workOrder', 'WO-1', 'plannedStart', now() + interval '2 days', 'plannedEnd', now() + interval '2 days 12 hours', 'freezeAt', now() - interval '1 day',
  'equipmentIds', jsonb_build_array('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000007')));
-- The freeze has passed: work added needs a reason, and is marked late.
do $$ begin
  perform app_save_shutdown_scope('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', '[{"id": "71000000-0000-0000-0000-000000000001", "workOrder": "1001"}]');
  raise exception 'late work added without a reason';
exception when check_violation then null; end $$;
select app_save_shutdown_scope('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', '[{"id": "71000000-0000-0000-0000-000000000001", "workOrder": "1001", "reason": "Found late"}, {"id": "71000000-0000-0000-0000-000000000002", "workOrder": "1002", "reason": "Found late"}]');
do $$ begin
  if not (select late from shutdown_scope where id = '71000000-0000-0000-0000-000000000001') then raise exception 'late work not marked'; end if;
  perform app_save_shutdown_scope('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', '[{"id": "71000000-0000-0000-0000-000000000003", "workOrder": "1001", "reason": "again"}]');
  raise exception 'the same work order was added twice';
exception when unique_violation then null; end $$;
select app_save_shutdown_scope('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', '[{"id": "71000000-0000-0000-0000-000000000002", "removedReason": "Parts not on site"}]');
do $$ begin
  if (select removed_reason from shutdown_scope where id = '71000000-0000-0000-0000-000000000002') <> 'Parts not on site' then raise exception 'scope not removed'; end if;
  update shutdown_scope set removed_reason = 'changed' where id = '71000000-0000-0000-0000-000000000002';
  raise exception 'a removal was changed';
exception when insufficient_privilege then null; end $$;
-- Start: not in the future; then only the end.
do $$ begin
  perform app_save_shutdown('10000000-0000-0000-0000-000000000002', (app_load_shutdowns('10000000-0000-0000-0000-000000000002')->0) || jsonb_build_object('actualStart', now() + interval '1 day'));
  raise exception 'a shutdown started in the future';
exception when check_violation then null; end $$;
select app_save_shutdown('10000000-0000-0000-0000-000000000002', (app_load_shutdowns('10000000-0000-0000-0000-000000000002')->0) || jsonb_build_object('actualStart', now() - interval '2 hours', 'flagIds', jsonb_build_array('40000000-0000-0000-0000-000000000001')));
do $$ begin
  perform app_save_shutdown('10000000-0000-0000-0000-000000000002', (app_load_shutdowns('10000000-0000-0000-0000-000000000002')->0) || jsonb_build_object('name', 'Renamed'));
  raise exception 'a shutdown in progress was renamed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_save_shutdown('10000000-0000-0000-0000-000000000002', (app_load_shutdowns('10000000-0000-0000-0000-000000000002')->0) || jsonb_build_object('cancelledAt', now(), 'cancelReason', 'x'));
  raise exception 'a shutdown in progress was cancelled';
exception when insufficient_privilege or check_violation then null; end $$;
select app_save_shutdown('10000000-0000-0000-0000-000000000002', (app_load_shutdowns('10000000-0000-0000-0000-000000000002')->0) || jsonb_build_object('actualEnd', now() - interval '1 minute', 'findings', 'Liners 40% left'));
do $$ begin
  if (select findings from shutdowns where id = '70000000-0000-0000-0000-000000000001') <> 'Liners 40% left' then raise exception 'end not saved'; end if;
  perform app_save_shutdown_scope('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', '[{"id": "71000000-0000-0000-0000-000000000004", "workOrder": "1004", "reason": "late"}]');
  raise exception 'work added after the end';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_save_shutdown('10000000-0000-0000-0000-000000000002', (app_load_shutdowns('10000000-0000-0000-0000-000000000002')->0) || jsonb_build_object('findings', 'changed'));
  raise exception 'an ended shutdown was changed';
exception when insufficient_privilege then null; end $$;
-- A planned one can be cancelled, with a reason.
select app_save_shutdown('10000000-0000-0000-0000-000000000002', jsonb_build_object('id', '70000000-0000-0000-0000-000000000002', 'nodeId', '20000000-0000-0000-0000-000000000001',
  'name', 'Next', 'workOrder', 'WO-2', 'plannedStart', now() + interval '30 days', 'plannedEnd', now() + interval '31 days', 'freezeAt', now() + interval '20 days',
  'equipmentIds', jsonb_build_array('10000000-0000-0000-0000-000000000005')));
select app_save_shutdown('10000000-0000-0000-0000-000000000002', (select x from jsonb_array_elements(app_load_shutdowns('10000000-0000-0000-0000-000000000002')) x where x->>'id' = '70000000-0000-0000-0000-000000000002')
  || jsonb_build_object('cancelledAt', now(), 'cancelReason', 'Moved to next year'));
do $$ begin
  if (select cancelled_by from shutdowns where id = '70000000-0000-0000-0000-000000000002') <> 'a0000000-0000-0000-0000-00000000000b' then raise exception 'cancel not recorded'; end if;
  if jsonb_array_length(app_load_shutdowns('10000000-0000-0000-0000-000000000002')->0->'scope') <> 2 then raise exception 'scope not loaded'; end if;
end $$;
do $$ begin
  delete from shutdowns where id = '70000000-0000-0000-0000-000000000002';
  if found then raise exception 'a shutdown was deleted'; end if;
exception when others then if sqlerrm like '%deleted%' then raise; end if; end $$;

reset role;
do $$ begin
  if (select count(*) from audit_log where entity = 'rounds') < 2 then raise exception 'rounds not audited'; end if;
  if (select count(*) from audit_log where entity = 'shutdowns') < 5 then raise exception 'shutdowns not audited'; end if;
  if (select count(*) from audit_log where entity = 'shutdown_scope') < 3 then raise exception 'scope not audited'; end if;
end $$;
rollback;
\o
\echo Plant part 2 API test passed
