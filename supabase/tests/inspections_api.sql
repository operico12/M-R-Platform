-- Inspections API test: forms are versioned, answers fixed once submitted,
-- sign-off by someone else, defects never removed, photos by the inspector only.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT107');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000f', 'supervisor', '{*}', 'Sue', 'sue@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- The supervisor cannot make forms; the reliability engineer can.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_form('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "version": 1, "name": "Pre-start",
    "assetClass": "mobile", "models": [], "every": {"n": 1, "unit": "days"}, "items": [{"id": "brakes"}], "reason": "x"}'::jsonb);
  raise exception 'supervisor made a form';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_form('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "version": 1, "name": "Pre-start",
  "assetClass": "mobile", "models": ["793F"], "every": {"n": 1, "unit": "days"}, "items": [{"id": "brakes", "kind": "pass_fail", "critical": true}], "reason": "First version"}'::jsonb);
-- A version cannot be edited, only retired (after a v2 replaces it).
do $$ begin
  update inspection_forms set name = 'Changed' where id = '20000000-0000-0000-0000-000000000001';
  raise exception 'form version was edited';
exception when insufficient_privilege then null; end $$;
select app_save_form('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "version": 2, "name": "Pre-start (2027)",
  "assetClass": "mobile", "models": ["793F"], "every": {"n": 1, "unit": "days"}, "items": [{"id": "brakes", "kind": "pass_fail", "critical": true}, {"id": "lights", "kind": "pass_fail"}], "reason": "Added lights"}'::jsonb);

-- A viewer cannot submit an inspection.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000009", "formId": "20000000-0000-0000-0000-000000000001",
    "formVersion": 2, "unitId": "10000000-0000-0000-0000-000000000005", "answers": {}, "startedAt": "2026-10-26T16:00:00Z"}'::jsonb);
  raise exception 'viewer submitted an inspection';
exception when insufficient_privilege then null; end $$;

-- A form that is not at this site cannot be used.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000008", "formId": "20000000-0000-0000-0000-000000000099",
    "formVersion": 1, "unitId": "10000000-0000-0000-0000-000000000005", "answers": {}, "startedAt": "2026-10-26T16:00:00Z"}'::jsonb);
  raise exception 'used a form that is not at this site';
exception when insufficient_privilege or foreign_key_violation then null; end $$;

-- The technician submits one; status and inspector are set by the database.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
select app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "formId": "20000000-0000-0000-0000-000000000001",
  "formVersion": 2, "unitId": "10000000-0000-0000-0000-000000000005", "smu": 12000, "status": "signed_off",
  "answers": {"brakes": {"value": "pass"}, "lights": {"value": "fail", "note": "Left beam out"}},
  "defects": [{"id": "d1", "itemId": "lights", "severity": "medium", "text": "lights: Left beam out", "status": "open"}],
  "score": 0.5, "result": "defects", "startedAt": "2026-10-26T16:00:00Z"}'::jsonb);
do $$ begin
  if (select status from inspections where id = '30000000-0000-0000-0000-000000000001') <> 'submitted' then raise exception 'arrived signed off'; end if;
  if (select started_by from inspections where id = '30000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000d' then raise exception 'wrong inspector'; end if;
end $$;
-- Answers are fixed.
do $$ begin
  update inspections set answers = '{"brakes": {"value": "pass"}, "lights": {"value": "pass"}}' where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'answers were changed';
exception when insufficient_privilege then null; end $$;
-- The inspector cannot sign off.
do $$ begin
  update inspections set status = 'signed_off' where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'technician signed off';
exception when insufficient_privilege then null; end $$;
-- Defects are followed up, never removed.
select app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "status": "submitted",
  "defects": [{"id": "d1", "itemId": "lights", "severity": "medium", "text": "lights: Left beam out", "status": "work_order", "workOrder": "4242"}]}'::jsonb);
do $$ begin
  update inspections set defects = '[]' where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'defect was removed';
exception when insufficient_privilege then null; end $$;
-- Only the inspector adds photos, and photos are kept as taken.
select app_save_photo('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000001", "inspectionId": "30000000-0000-0000-0000-000000000001",
  "itemId": "lights", "data": "data:image/jpeg;base64,AAAA"}'::jsonb);
do $$ begin
  update inspection_photos set data = 'data:image/jpeg;base64,BBBB';
  if found then raise exception 'photo was changed'; end if;
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from inspection_photos;
  if found then raise exception 'photo was deleted'; end if;
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_photo('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000002", "inspectionId": "30000000-0000-0000-0000-000000000001",
    "itemId": "lights", "data": "data:image/jpeg;base64,CCCC"}'::jsonb);
  raise exception 'someone else added a photo';
exception when insufficient_privilege then null; end $$;

-- The supervisor signs off; the database records who and when.
select app_save_inspection('10000000-0000-0000-0000-000000000002', '{"id": "30000000-0000-0000-0000-000000000001", "status": "signed_off", "signOffNote": "Checked",
  "defects": [{"id": "d1", "itemId": "lights", "severity": "medium", "text": "lights: Left beam out", "status": "work_order", "workOrder": "4242"}]}'::jsonb);
do $$ declare d jsonb := app_load_inspections('10000000-0000-0000-0000-000000000002', '2026-01-01'); begin
  if jsonb_array_length(d->'forms') <> 2 then raise exception 'forms wrong: %', d->'forms'; end if;
  if d->'inspections'->0->>'status' <> 'signed_off' or d->'inspections'->0->>'signedOffBy' <> 'a0000000-0000-0000-0000-00000000000b'
     or d->'inspections'->0->'defects'->0->>'workOrder' <> '4242' then raise exception 'inspection wrong: %', d->'inspections'; end if;
  if app_load_photo('10000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001') <> 'data:image/jpeg;base64,AAAA' then raise exception 'photo not loaded'; end if;
end $$;
-- A voided inspection needs a reason and then cannot change.
do $$ begin
  update inspections set status = 'voided', void_reason = ' ' where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'voided without a reason';
exception when check_violation then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000f');
update inspections set status = 'voided', void_reason = 'Wrong unit' where id = '30000000-0000-0000-0000-000000000001';
do $$ begin
  update inspections set sign_off_note = 'again' where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'voided inspection changed';
exception when insufficient_privilege then null; end $$;

-- The reliability engineer retires version 1.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_form('10000000-0000-0000-0000-000000000002', '{"id": "20000000-0000-0000-0000-000000000001", "version": 1, "retiredAt": "2026-10-27T00:00:00Z", "retiredReason": "Replaced"}'::jsonb);
do $$ begin
  if (select retired_at from inspection_forms where id = '20000000-0000-0000-0000-000000000001' and version = 1) is null then raise exception 'not retired'; end if;
  if (select retired_at from inspection_forms where id = '20000000-0000-0000-0000-000000000001' and version = 2) is not null then raise exception 'v2 retired'; end if;
end $$;

reset role;
do $$ declare n int; begin
  select count(*) into n from audit_log where entity in ('inspection_forms', 'inspections');
  if n < 6 then raise exception 'expected at least 6 audit entries, got %', n; end if;
end $$;
rollback;
\o
\echo inspections API test passed
