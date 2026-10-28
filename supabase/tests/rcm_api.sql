-- RCM API test: who edits the library, revisions in order, nothing edited in place,
-- retire once with a reason, issued job plans never changed, settings by the right roles.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Other mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000010', 'superintendent', '{*}', 'Sid', 'sid@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;


-- A supervisor cannot add a failure mode.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000009", "modeId": "81000000-0000-0000-0000-000000000001",
    "revision": 1, "model": "793F", "system": "Cooling", "component": "Water pump", "func": "Circulate coolant", "functionalFailure": "No flow", "mode": "Leak",
    "effect": "Overheat", "consequence": "operational", "answers": {"warning": true}, "recommended": "on_condition", "taskType": "on_condition",
    "task": "Check seal", "intervalHours": 500, "craft": "MECH", "people": 1, "taskHours": 0.25}'::jsonb);
  raise exception 'supervisor added a mode';
exception when insufficient_privilege then null; end $$;

-- Rae adds a mode and revises it.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000001", "modeId": "81000000-0000-0000-0000-000000000001",
  "revision": 1, "model": "793F", "system": "Cooling", "component": "Water pump", "func": "Circulate coolant", "functionalFailure": "No flow", "mode": "Leak",
  "effect": "Overheat", "consequence": "operational", "answers": {"warning": true}, "recommended": "on_condition", "taskType": "on_condition",
  "task": "Check seal", "intervalHours": 500, "craft": "MECH", "people": 1, "taskHours": 0.25, "parts": [{"itemNum": "SYN-1", "description": "Seal", "qty": 1}]}'::jsonb);
select app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000002", "modeId": "81000000-0000-0000-0000-000000000001",
  "revision": 2, "model": "793F", "system": "Cooling", "component": "Water pump", "func": "Circulate coolant", "functionalFailure": "No flow", "mode": "Leak",
  "effect": "Overheat", "consequence": "operational", "answers": {"warning": true}, "recommended": "on_condition", "taskType": "on_condition",
  "task": "Check seal and noise", "intervalHours": 250, "craft": "MECH", "people": 1, "taskHours": 0.25, "changeNote": "Late finds"}'::jsonb);
do $$ begin
  if (select created_by from rcm_modes where id = '80000000-0000-0000-0000-000000000002') <> 'a0000000-0000-0000-0000-00000000000e' then raise exception 'created_by not set'; end if;
end $$;
-- Out of order, another model, no change note, a scheduled task without an interval, a different task with no reason: refused.
do $$ begin
  perform app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000003", "modeId": "81000000-0000-0000-0000-000000000001",
    "revision": 2, "model": "793F", "system": "Cooling", "component": "Water pump", "func": "x", "functionalFailure": "x", "mode": "Leak", "effect": "x",
    "consequence": "operational", "recommended": "on_condition", "taskType": "on_condition", "task": "x", "intervalHours": 250, "craft": "MECH", "people": 1, "taskHours": 1, "changeNote": "x"}'::jsonb);
  raise exception 'stale revision accepted';
exception when check_violation or unique_violation then null; end $$;
do $$ begin
  perform app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000004", "modeId": "81000000-0000-0000-0000-000000000001",
    "revision": 3, "model": "797F", "system": "Cooling", "component": "Water pump", "func": "x", "functionalFailure": "x", "mode": "Leak", "effect": "x",
    "consequence": "operational", "recommended": "on_condition", "taskType": "on_condition", "task": "x", "intervalHours": 250, "craft": "MECH", "people": 1, "taskHours": 1, "changeNote": "x"}'::jsonb);
  raise exception 'model changed';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000005", "modeId": "81000000-0000-0000-0000-000000000001",
    "revision": 3, "model": "793F", "system": "Cooling", "component": "Water pump", "func": "x", "functionalFailure": "x", "mode": "Leak", "effect": "x",
    "consequence": "operational", "recommended": "on_condition", "taskType": "on_condition", "task": "x", "intervalHours": 250, "craft": "MECH", "people": 1, "taskHours": 1}'::jsonb);
  raise exception 'revision without a note';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000006", "modeId": "81000000-0000-0000-0000-000000000006",
    "revision": 1, "model": "793F", "system": "Brakes", "component": "Pack", "func": "x", "functionalFailure": "x", "mode": "Worn", "effect": "x",
    "consequence": "safety", "recommended": "on_condition", "taskType": "on_condition", "task": "Measure"}'::jsonb);
  raise exception 'scheduled task without interval';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000007", "modeId": "81000000-0000-0000-0000-000000000007",
    "revision": 1, "model": "793F", "system": "Brakes", "component": "Pack", "func": "x", "functionalFailure": "x", "mode": "Worn", "effect": "x",
    "consequence": "safety", "recommended": "on_condition", "taskType": "run_to_failure"}'::jsonb);
  raise exception 'override without reason';
exception when check_violation then null; end $$;

-- Modes are never edited in place or deleted.
do $$ begin
  update rcm_modes set interval_hours = 1000 where id = '80000000-0000-0000-0000-000000000002';
  raise exception 'mode edited';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from rcm_modes where id = '80000000-0000-0000-0000-000000000002';
  if found then raise exception 'mode deleted'; end if;
exception when insufficient_privilege then null; end $$;

-- Retire: only the latest revision, once, with a reason; then no more revisions.
do $$ begin
  perform app_retire_rcm_mode('10000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000001', 'old');
  raise exception 'old revision retired';
exception when check_violation then null; end $$;
do $$ begin
  perform app_retire_rcm_mode('10000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', ' ');
  raise exception 'retired without a reason';
exception when check_violation then null; end $$;

-- Rae issues a job plan; Sam cannot; the next revision must follow; issued revisions never change.
select app_issue_job_plan('10000000-0000-0000-0000-000000000002', '{"id": "82000000-0000-0000-0000-000000000001", "jpnum": "793F-250", "model": "793F", "hours": 250,
  "revision": 1, "note": "First issue", "content": {"jpnum": "793F-250", "tasks": [{"seq": 10, "description": "Check seal"}]}}'::jsonb);
do $$ begin
  perform app_issue_job_plan('10000000-0000-0000-0000-000000000002', '{"id": "82000000-0000-0000-0000-000000000002", "jpnum": "793F-250", "model": "793F", "hours": 250,
    "revision": 1, "note": "Again", "content": {"tasks": [{"seq": 10}]}}'::jsonb);
  raise exception 'duplicate revision';
exception when check_violation or unique_violation then null; end $$;
do $$ begin
  perform app_issue_job_plan('10000000-0000-0000-0000-000000000002', '{"id": "82000000-0000-0000-0000-000000000003", "jpnum": "793F-500", "model": "793F", "hours": 500,
    "revision": 1, "note": "Empty", "content": {"tasks": []}}'::jsonb);
  raise exception 'empty job plan';
exception when check_violation then null; end $$;
do $$ begin
  update job_plan_versions set note = 'changed';
  if found then raise exception 'job plan edited'; end if;
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_issue_job_plan('10000000-0000-0000-0000-000000000002', '{"id": "82000000-0000-0000-0000-000000000004", "jpnum": "793F-250", "model": "793F", "hours": 250,
    "revision": 2, "note": "Sam", "content": {"tasks": [{"seq": 10}]}}'::jsonb);
  raise exception 'supervisor issued a job plan';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'rcm', '{"nested": false}'::jsonb, 'x');
  raise exception 'supervisor changed rcm settings';
exception when insufficient_privilege then null; end $$;

-- Sid (superintendent) retires the mode; a second retire and a new revision are refused.
select pg_temp.as_user('a0000000-0000-0000-0000-000000000010');
select app_retire_rcm_mode('10000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', 'Sealed pump fitted');
do $$ begin
  perform app_retire_rcm_mode('10000000-0000-0000-0000-000000000002', '80000000-0000-0000-0000-000000000002', 'again');
  raise exception 'retired twice';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_save_rcm_mode('10000000-0000-0000-0000-000000000002', '{"id": "80000000-0000-0000-0000-000000000008", "modeId": "81000000-0000-0000-0000-000000000001",
    "revision": 3, "model": "793F", "system": "Cooling", "component": "Water pump", "func": "x", "functionalFailure": "x", "mode": "Leak", "effect": "x",
    "consequence": "operational", "recommended": "on_condition", "taskType": "on_condition", "task": "x", "intervalHours": 250, "craft": "MECH", "people": 1, "taskHours": 1, "changeNote": "x"}'::jsonb);
  raise exception 'revision after retire';
exception when check_violation then null; end $$;
select app_save_setting('10000000-0000-0000-0000-000000000002', 'rcm', '{"nested": false}'::jsonb, 'Maximo uses PM sequences');

-- A saved analysis from a new calculator is accepted.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
insert into saved_analyses (id, tenant_id, site_id, calculator, calculator_version, title, inputs, result, sentence, data_note)
values ('83000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'optimal_replacement', 1, 'Starter', '{}', '{}', 'x', 'Typed in');

-- Everyone at the site reads it back; another site sees nothing.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ declare d jsonb := app_load_rcm('10000000-0000-0000-0000-000000000002'); begin
  if jsonb_array_length(d->'modes') <> 2 or jsonb_array_length(d->'versions') <> 1 then raise exception 'load: %', d; end if;
  if (d->'modes'->1->>'retireReason') is distinct from 'Sealed pump fitted' then raise exception 'retire not loaded: %', d->'modes'->1; end if;
  if (d->'modes'->0->'parts'->0->>'itemNum') <> 'SYN-1' then raise exception 'parts not loaded'; end if;
  if jsonb_array_length(app_load_rcm('10000000-0000-0000-0000-000000000003')->'modes') <> 0 then raise exception 'other site leaked'; end if;
end $$;
reset role;
do $$ begin
  if (select retired_by from rcm_modes where id = '80000000-0000-0000-0000-000000000002') <> 'a0000000-0000-0000-0000-000000000010' then raise exception 'retire not recorded'; end if;
  if (select issued_by from job_plan_versions) <> 'a0000000-0000-0000-0000-00000000000e' then raise exception 'issuer not recorded'; end if;
  if (select (value->>'nested')::boolean from site_settings where key = 'rcm') then raise exception 'setting not saved'; end if;
end $$;
rollback;
\o
\echo RCM API test passed
