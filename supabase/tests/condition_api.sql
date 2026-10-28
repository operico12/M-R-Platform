-- Condition monitoring API test: who records, samples never edited, voids by the right people,
-- severity no better than the lab's, one response per alert, settings by the right roles.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Other mine', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values
  ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT107'),
  ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'OT1');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000010', 'superintendent', '{*}', 'Sid', 'sid@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- A viewer cannot enter a sample.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_oil_samples('10000000-0000-0000-0000-000000000002', '[{"id": "70000000-0000-0000-0000-000000000009", "unitId": "10000000-0000-0000-0000-000000000005",
    "compartment": "engine", "takenAt": "2026-10-20T16:00:00Z", "readings": {"fe": 20}, "severity": "normal"}]'::jsonb);
  raise exception 'viewer entered a sample';
exception when insufficient_privilege then null; end $$;

-- Sam enters two samples; a repeated lab reference is skipped.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_oil_samples('10000000-0000-0000-0000-000000000002', '[
  {"id": "70000000-0000-0000-0000-000000000001", "unitId": "10000000-0000-0000-0000-000000000005", "compartment": "engine", "takenAt": "2026-10-20T16:00:00Z",
   "reportedAt": "2026-10-23T16:00:00Z", "smu": 10100, "labRef": "L1", "labSeverity": "action", "readings": {"fe": 80}, "severity": "action", "reasons": ["Lab rated it Action."]},
  {"id": "70000000-0000-0000-0000-000000000002", "unitId": "10000000-0000-0000-0000-000000000005", "compartment": "hydraulic", "takenAt": "2026-10-20T16:00:00Z",
   "labRef": "L2", "readings": {"fe": 5}, "severity": "normal"},
  {"id": "70000000-0000-0000-0000-000000000003", "unitId": "10000000-0000-0000-0000-000000000005", "compartment": "engine", "takenAt": "2026-10-20T16:00:00Z",
   "labRef": "L1", "readings": {"fe": 1}, "severity": "normal"}]'::jsonb);
do $$ begin
  if (select count(*) from oil_samples) <> 2 then raise exception 'duplicate lab reference not skipped'; end if;
  if (select entered_by from oil_samples where id = '70000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000b' then raise exception 'entered_by not set'; end if;
end $$;
-- Better than the lab, a unit at another site, a date in the future: refused.
do $$ begin
  perform app_save_oil_samples('10000000-0000-0000-0000-000000000002', '[{"id": "70000000-0000-0000-0000-000000000004", "unitId": "10000000-0000-0000-0000-000000000005",
    "compartment": "engine", "takenAt": "2026-10-20T16:00:00Z", "labSeverity": "critical", "readings": {"fe": 20}, "severity": "monitor"}]'::jsonb);
  raise exception 'severity better than the lab';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_oil_samples('10000000-0000-0000-0000-000000000002', '[{"id": "70000000-0000-0000-0000-000000000005", "unitId": "10000000-0000-0000-0000-000000000006",
    "compartment": "engine", "takenAt": "2026-10-20T16:00:00Z", "readings": {"fe": 20}, "severity": "normal"}]'::jsonb);
  raise exception 'unit from another site';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_oil_samples('10000000-0000-0000-0000-000000000002', '[{"id": "70000000-0000-0000-0000-000000000006", "unitId": "10000000-0000-0000-0000-000000000005",
    "compartment": "engine", "takenAt": "2099-10-20T16:00:00Z", "readings": {"fe": 20}, "severity": "normal"}]'::jsonb);
  raise exception 'future sample';
exception when check_violation then null; end $$;

-- Samples are never edited or deleted.
do $$ begin
  update oil_samples set severity = 'normal' where id = '70000000-0000-0000-0000-000000000001';
  raise exception 'sample edited';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from oil_samples where id = '70000000-0000-0000-0000-000000000001';
  if found then raise exception 'sample deleted'; end if;
exception when insufficient_privilege or raise_exception then null; end $$;

-- Responses: not for a normal sample; one per alert; a work order needs its number.
do $$ begin
  perform app_save_cm_response('10000000-0000-0000-0000-000000000002', '{"id": "71000000-0000-0000-0000-000000000009", "sampleId": "70000000-0000-0000-0000-000000000002", "action": "resample", "note": "x"}'::jsonb);
  raise exception 'response to a normal sample';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_cm_response('10000000-0000-0000-0000-000000000002', '{"id": "71000000-0000-0000-0000-000000000008", "sampleId": "70000000-0000-0000-0000-000000000001", "action": "work_order", "note": "x"}'::jsonb);
  raise exception 'work order without a number';
exception when check_violation then null; end $$;
select app_save_cm_response('10000000-0000-0000-0000-000000000002', '{"id": "71000000-0000-0000-0000-000000000001", "sampleId": "70000000-0000-0000-0000-000000000001", "action": "work_order", "workOrder": "123456", "note": "Raised"}'::jsonb);
do $$ begin
  perform app_save_cm_response('10000000-0000-0000-0000-000000000002', '{"id": "71000000-0000-0000-0000-000000000002", "sampleId": "70000000-0000-0000-0000-000000000001", "action": "resample", "note": "x"}'::jsonb);
  raise exception 'second response';
exception when unique_violation then null; end $$;
do $$ begin
  update cm_responses set note = 'changed';
  if found then raise exception 'response edited'; end if;
exception when insufficient_privilege then null; end $$;

-- A viewer cannot respond; Rae cannot void Sam's sample; Sam can, with a reason, once.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_cm_response('10000000-0000-0000-0000-000000000002', '{"id": "71000000-0000-0000-0000-000000000003", "sampleId": "70000000-0000-0000-0000-000000000001", "action": "resample", "note": "x"}'::jsonb);
  raise exception 'viewer responded';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  perform app_void_oil_sample('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', 'mine now');
  raise exception 'someone else voided a sample';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_void_oil_sample('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', ' ');
  raise exception 'void without a reason';
exception when check_violation then null; end $$;
select app_void_oil_sample('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', 'Wrong unit');
do $$ begin
  perform app_void_oil_sample('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', 'again');
  raise exception 'voided twice';
exception when insufficient_privilege then null; end $$;

-- Settings: Rae can change them; Sam cannot.
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'condition', '{"tolerancePct": 20}'::jsonb, 'x');
  raise exception 'supervisor changed condition settings';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_setting('10000000-0000-0000-0000-000000000002', 'condition', '{"tolerancePct": 20}'::jsonb, 'Looser');

-- Everyone at the site reads it all back.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ declare d jsonb := app_load_condition('10000000-0000-0000-0000-000000000002', '2026-01-01'); begin
  if jsonb_array_length(d->'samples') <> 2 or jsonb_array_length(d->'responses') <> 1 then raise exception 'load: %', d; end if;
  if (d->'samples'->1->>'voidReason') is distinct from 'Wrong unit' and (d->'samples'->0->>'voidReason') is distinct from 'Wrong unit' then raise exception 'void not loaded'; end if;
  if (d->'responses'->0->>'by') <> 'a0000000-0000-0000-0000-00000000000b' then raise exception 'responder not recorded'; end if;
end $$;
reset role;
do $$ begin
  if (select voided_by from oil_samples where id = '70000000-0000-0000-0000-000000000002') <> 'a0000000-0000-0000-0000-00000000000b' then raise exception 'void not recorded'; end if;
  if (select (value->>'tolerancePct')::int from site_settings where key = 'condition') <> 20 then raise exception 'setting not saved'; end if;
end $$;
rollback;
\o
\echo condition API test passed
