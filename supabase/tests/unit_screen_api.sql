-- Unit screen (docs/unit-screen.md): repair details, investigation, notes and assigned technicians,
-- each with its role rule, stamped with who and when, never deleted.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT107');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tom', 'tom@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'viewer', '{*}', 'Vic', 'vic@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'superintendent', '{*}', 'Sue', 'sue@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id, 'aal', 'aal1')::text, true);
$$;
set local role authenticated;

-- Sam flags HT107 down with the system, major component and failure mode known at the start.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_flags('10000000-0000-0000-0000-000000000002', '[{"id": "20000000-0000-0000-0000-000000000001", "siteId": "10000000-0000-0000-0000-000000000002",
  "unitId": "10000000-0000-0000-0000-000000000005", "type": "unscheduled", "state": "open", "reasonCode": "Hydraulics", "start": "2026-10-26T15:02:00Z",
  "release": {"system": "Hydraulics", "majorComponent": "Hoist", "failureModes": ["Hose burst"]},
  "stages": [{"stage": "waiting_crew", "start": "2026-10-26T15:02:00Z"}], "locations": [{"kind": "field", "start": "2026-10-26T15:02:00Z", "fieldLocation": "Pit 2"}],
  "etas": [], "workOrders": []}]'::jsonb);
do $$ begin
  if (select major_component || '/' || array_to_string(failure_modes, ',') from down_flags) <> 'Hoist/Hose burst' then raise exception 'details at flag down not saved'; end if;
end $$;

-- Tom (technician) fills in the repair details; Vic (viewer) cannot.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select app_flag_details('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
  '{"system": "Hydraulics", "majorComponent": "Hoist", "component": "Hoist cylinder hose", "failureModes": ["Hose burst"], "findings": "Chafed on frame"}');
do $$ begin
  if (select component || '/' || findings from down_flags) <> 'Hoist cylinder hose/Chafed on frame' then raise exception 'details not saved'; end if;
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_flag_details('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '{"component": "x"}');
  raise exception 'viewer changed details';
exception when insufficient_privilege then null; end $$;

-- Investigation: Tom cannot mark; Sam marks; nobody writes the column directly; Sue clears.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_flag_investigation('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Third hose');
  raise exception 'technician marked';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_flag_investigation('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Third hose this month');
do $$ begin
  if (select investigation->>'by' from down_flags) <> 'a0000000-0000-0000-0000-00000000000b' then raise exception 'mark not stamped'; end if;
  perform app_flag_investigation('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'again');
  raise exception 'marked twice';
exception when check_violation then null; end $$;
do $$ begin
  update down_flags set investigation = '{"at": "2020-01-01", "by": "someone", "reason": "forged"}' where id = '20000000-0000-0000-0000-000000000001';
  raise exception 'investigation written directly';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_flag_investigation('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Routing fix already planned', true);
do $$ begin
  if (select investigation->>'clearedBy' from down_flags) <> 'a0000000-0000-0000-0000-00000000000e' then raise exception 'clear not stamped'; end if;
  if (select investigation->>'reason' from down_flags) <> 'Third hose this month' then raise exception 'mark lost on clear'; end if;
end $$;

-- Notes: Tom writes a repair note (stamped as Tom, now); Vic cannot; Sam cannot void Tom's; Sue can; never deleted.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select app_save_notes('10000000-0000-0000-0000-000000000002', '[{"id": "30000000-0000-0000-0000-000000000001", "unitId": "10000000-0000-0000-0000-000000000005",
  "downFlagId": "20000000-0000-0000-0000-000000000001", "kind": "repair", "text": "Found hose chafed", "by": "someone-else"}]');
do $$ begin
  if (select written_by from unit_notes) <> 'a0000000-0000-0000-0000-00000000000c' then raise exception 'writer not stamped'; end if;
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_save_notes('10000000-0000-0000-0000-000000000002', '[{"id": "30000000-0000-0000-0000-000000000002", "unitId": "10000000-0000-0000-0000-000000000005", "kind": "comment", "text": "hi"}]');
  raise exception 'viewer wrote a note';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  update unit_notes set void_reason = 'not mine', voided_at = now() where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'supervisor voided another person''s note';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update unit_notes set body = 'changed' where id = '30000000-0000-0000-0000-000000000001';
  raise exception 'note edited';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_notes('10000000-0000-0000-0000-000000000002', '[{"id": "30000000-0000-0000-0000-000000000001", "unitId": "10000000-0000-0000-0000-000000000005",
  "kind": "repair", "text": "Found hose chafed", "voidReason": "Wrong unit"}]');
do $$ begin
  if (select voided_by from unit_notes) <> 'a0000000-0000-0000-0000-00000000000e' then raise exception 'void not stamped'; end if;
  delete from unit_notes;
  raise exception 'note deleted';
exception when insufficient_privilege then null; end $$;

-- Assignments: Sam assigns Tom; not twice; not someone off site; Tom cannot assign; ending is final.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_assignments('10000000-0000-0000-0000-000000000002', '[{"id": "40000000-0000-0000-0000-000000000001", "unitId": "10000000-0000-0000-0000-000000000005",
  "downFlagId": "20000000-0000-0000-0000-000000000001", "userId": "a0000000-0000-0000-0000-00000000000c", "state": "open"}]');
do $$ begin
  if (select set_by from flag_assignments) <> 'a0000000-0000-0000-0000-00000000000b' then raise exception 'assigner not stamped'; end if;
  perform app_save_assignments('10000000-0000-0000-0000-000000000002', '[{"id": "40000000-0000-0000-0000-000000000002", "unitId": "10000000-0000-0000-0000-000000000005",
    "downFlagId": "20000000-0000-0000-0000-000000000001", "userId": "a0000000-0000-0000-0000-00000000000c", "state": "open"}]');
  raise exception 'assigned twice';
exception when unique_violation then null; end $$;
do $$ begin
  perform app_save_assignments('10000000-0000-0000-0000-000000000002', '[{"id": "40000000-0000-0000-0000-000000000003", "unitId": "10000000-0000-0000-0000-000000000005",
    "downFlagId": "20000000-0000-0000-0000-000000000001", "userId": "a0000000-0000-0000-0000-0000000000ff", "state": "open"}]');
  raise exception 'assigned someone off site';
exception when check_violation then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_assignments('10000000-0000-0000-0000-000000000002', '[{"id": "40000000-0000-0000-0000-000000000004", "unitId": "10000000-0000-0000-0000-000000000005",
    "downFlagId": "20000000-0000-0000-0000-000000000001", "userId": "a0000000-0000-0000-0000-00000000000b", "state": "open"}]');
  raise exception 'technician assigned';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_assignments('10000000-0000-0000-0000-000000000002', jsonb_build_array(jsonb_build_object('id', '40000000-0000-0000-0000-000000000001', 'state', 'ended', 'end', now())));
do $$ begin
  if (select state from flag_assignments) <> 'ended' then raise exception 'not ended'; end if;
  update flag_assignments set state = 'open', ends_at = null;
  raise exception 'reopened';
exception when insufficient_privilege then null; end $$;

-- The loader carries the new fields.
do $$ declare j jsonb := app_load('10000000-0000-0000-0000-000000000002'); f jsonb;
begin
  select e into f from jsonb_array_elements(j->'flags') e limit 1;
  if f->'release'->>'majorComponent' <> 'Hoist' or f->'investigation'->>'clearReason' is null then raise exception 'load misses fields: %', f; end if;
  if jsonb_array_length(app_load_notes('10000000-0000-0000-0000-000000000002')) <> 1 then raise exception 'notes not loaded'; end if;
  if jsonb_array_length(app_load_assignments('10000000-0000-0000-0000-000000000002')) <> 1 then raise exception 'assignments not loaded'; end if;
end $$;

rollback;
\o
\echo Unit screen API test passed
