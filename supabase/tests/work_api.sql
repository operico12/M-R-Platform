-- Work view API test: planning fields round-trip; settings by role.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- The Admin (data owner) imports a PM with planning fields.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_save_work_orders('10000000-0000-0000-0000-000000000002', '[{"id": "80000000-0000-0000-0000-000000000001", "sourceSystem": "maximo", "sourceId": "4242",
  "number": "4242", "numberNormalised": "4242", "woType": "PM", "workClass": "pm", "status": "WSCH", "open": true,
  "targetStart": "2026-11-02T08:00:00Z", "targetFinish": "2026-11-03T07:59:00Z", "scheduledStart": "2026-11-02T15:00:00Z",
  "estimatedHours": 16, "pmNumber": "PM250-HT101", "originWorkOrder": "4100"}]'::jsonb);

-- The supervisor cannot change work settings; the reliability engineer can, with a reason.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'work', '{"craftHoursPerWeek": 1}'::jsonb, 'x');
  raise exception 'supervisor changed work settings';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_save_setting('10000000-0000-0000-0000-000000000002', 'work', '{"craftHoursPerWeek": 1}'::jsonb, ' ');
  raise exception 'saved without a reason';
exception when check_violation then null; end $$;
select app_save_setting('10000000-0000-0000-0000-000000000002', 'work', '{"craftHoursPerWeek": 480, "pmToleranceDays": 3, "emergencyTypes": ["EM"], "emergencyPriorities": ["1"]}'::jsonb, 'Two crews');
select app_save_setting('10000000-0000-0000-0000-000000000002', 'work', '{"craftHoursPerWeek": 400, "pmToleranceDays": 3, "emergencyTypes": ["EM"], "emergencyPriorities": ["1"]}'::jsonb, 'Holidays');

do $$ declare d jsonb := app_load_work('10000000-0000-0000-0000-000000000002'); begin
  if d->'plans'->0->>'pmNumber' <> 'PM250-HT101' or (d->'plans'->0->>'estimatedHours')::numeric <> 16 or d->'plans'->0->>'originWorkOrder' <> '4100' then raise exception 'plans wrong: %', d; end if;
  if (d->'settings'->'work'->>'craftHoursPerWeek')::numeric <> 400 then raise exception 'settings wrong: %', d; end if;
end $$;

reset role;
do $$ declare n int; begin
  select count(*) into n from audit_log where entity = 'site_settings';
  if n <> 2 then raise exception 'settings changes missing from the audit log (%)', n; end if;
end $$;
rollback;
\o
\echo work API test passed
