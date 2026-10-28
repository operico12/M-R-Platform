-- Alerts API test: alert rules by role, answers append-only and by role.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- Admin (data owner) can set alert rules, but still not work settings.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_save_setting('10000000-0000-0000-0000-000000000002', 'alerts', '{"snoozeDays": 3}'::jsonb, 'Weekly meeting is on Mondays');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'work', '{"craftHoursPerWeek": 1}'::jsonb, 'x');
  raise exception 'admin changed work settings';
exception when insufficient_privilege then null; end $$;

-- The supervisor cannot change alert rules.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'alerts', '{"snoozeDays": 30}'::jsonb, 'x');
  raise exception 'supervisor changed alert rules';
exception when insufficient_privilege then null; end $$;

-- The supervisor answers; "not a problem" needs a note; answers cannot be changed or deleted.
select app_save_alert_answer('10000000-0000-0000-0000-000000000002', '{"id": "90000000-0000-0000-0000-000000000001", "alertKey": "silent:x:2026-11-01",
  "kind": "silent", "title": "HT101: SMU rose 0.1 h in 24 h", "decision": "noted", "note": "Standby for the shovel move"}'::jsonb);
do $$ begin
  perform app_save_alert_answer('10000000-0000-0000-0000-000000000002', '{"id": "90000000-0000-0000-0000-000000000002", "alertKey": "k",
    "kind": "silent", "title": "t", "decision": "not_a_problem", "note": " "}'::jsonb);
  raise exception 'saved "not a problem" without a note';
exception when check_violation then null; end $$;
do $$ begin
  update alert_answers set note = 'changed' where id = '90000000-0000-0000-0000-000000000001';
  if found then raise exception 'answer was changed'; end if;
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from alert_answers where id = '90000000-0000-0000-0000-000000000001';
  if found then raise exception 'answer was deleted'; end if;
exception when insufficient_privilege or raise_exception then null; end $$;

-- A viewer cannot answer, and cannot answer as someone else.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_alert_answer('10000000-0000-0000-0000-000000000002', '{"id": "90000000-0000-0000-0000-000000000003", "alertKey": "k",
    "kind": "silent", "title": "t", "decision": "noted"}'::jsonb);
  raise exception 'viewer answered an alert';
exception when insufficient_privilege then null; end $$;

do $$ declare d jsonb := app_load_alert_answers('10000000-0000-0000-0000-000000000002'); w jsonb := app_load_work('10000000-0000-0000-0000-000000000002'); begin
  if jsonb_array_length(d) <> 1 or d->0->>'decision' <> 'noted' or d->0->>'answeredBy' <> 'a0000000-0000-0000-0000-00000000000b' or d->0->>'answeredAt' is null then
    raise exception 'answers wrong: %', d; end if;
  if (w->'settings'->'alerts'->>'snoozeDays')::int <> 3 then raise exception 'alert rules not loaded: %', w; end if;
end $$;

reset role;
do $$ declare n int; begin
  select count(*) into n from audit_log where entity in ('alert_answers', 'site_settings');
  if n <> 2 then raise exception 'expected 2 audit entries, got %', n; end if;
end $$;
rollback;
\o
\echo alerts API test passed
