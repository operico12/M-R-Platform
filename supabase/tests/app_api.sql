-- App API test: save and load as signed-in users, with row-level security on.
-- Run after the migrations, with psql -v ON_ERROR_STOP=1.
\set QUIET on
\o /dev/null
begin;

-- Seed as the database owner.
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into shops (id, tenant_id, site_id, name) values ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'Truck shop');
insert into shop_lines (id, tenant_id, site_id, shop_id, number) values ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', 1);
insert into assets (id, tenant_id, site_id, unit_number, external_asset_id) values ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT107', 'HT107');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');

create function pg_temp.as_user(p_id text, p_email text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id, 'email', p_email)::text, true);
$$;

set local role authenticated;

-- A supervisor flags HT107 down in the field, then moves it to line 1.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b', 'sam@example.com');
select app_save_flags('10000000-0000-0000-0000-000000000002', '[{
  "id": "20000000-0000-0000-0000-000000000001", "siteId": "10000000-0000-0000-0000-000000000002", "unitId": "10000000-0000-0000-0000-000000000005",
  "type": "unscheduled", "state": "open", "reasonCode": "Hydraulics", "start": "2026-10-26T15:02:00Z",
  "stages": [{"stage": "waiting_crew", "start": "2026-10-26T15:02:00Z"}],
  "locations": [{"kind": "field", "start": "2026-10-26T15:02:00Z", "fieldLocation": "Pit 2"}],
  "etas": [], "workOrders": ["WO-1"]
}]'::jsonb);
select app_save_flags('10000000-0000-0000-0000-000000000002', '[{
  "id": "20000000-0000-0000-0000-000000000001", "siteId": "10000000-0000-0000-0000-000000000002", "unitId": "10000000-0000-0000-0000-000000000005",
  "type": "unscheduled", "state": "open", "reasonCode": "Hydraulics", "start": "2026-10-26T15:02:00Z",
  "stages": [{"stage": "waiting_crew", "start": "2026-10-26T15:02:00Z", "end": "2026-10-26T16:00:00Z"}, {"stage": "in_repair", "start": "2026-10-26T16:00:00Z"}],
  "locations": [{"kind": "field", "start": "2026-10-26T15:02:00Z", "end": "2026-10-26T16:00:00Z", "fieldLocation": "Pit 2"},
                {"kind": "shop_line", "start": "2026-10-26T16:00:00Z", "shopLineId": "10000000-0000-0000-0000-000000000004"}],
  "etas": [{"eta": "2026-10-26T22:00:00Z", "setAt": "2026-10-26T15:30:00Z"}], "workOrders": ["WO-1"]
}]'::jsonb);
select app_log('10000000-0000-0000-0000-000000000002', '[{"action": "move_location", "entity": "down_flag", "entityId": "20000000-0000-0000-0000-000000000001", "reason": "towed in"}]'::jsonb);

do $$ declare d jsonb := app_load('10000000-0000-0000-0000-000000000002'); f jsonb; begin
  f := d->'flags'->0;
  if jsonb_array_length(d->'flags') <> 1 then raise exception 'expected 1 flag, got %', jsonb_array_length(d->'flags'); end if;
  if jsonb_array_length(f->'stages') <> 2 or f->'stages'->1->>'stage' <> 'in_repair' then raise exception 'stages wrong: %', f->'stages'; end if;
  if f->'locations'->1->>'shopLineId' <> '10000000-0000-0000-0000-000000000004' then raise exception 'location wrong: %', f->'locations'; end if;
  if f->'workOrders'->>0 <> 'WO-1' or jsonb_array_length(f->'etas') <> 1 then raise exception 'children wrong: %', f; end if;
  if d->>'role' <> 'supervisor' then raise exception 'role wrong: %', d->>'role'; end if;
end $$;

-- A viewer cannot write, whatever the browser sends.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c', 'vic@example.com');
do $$ begin
  perform app_save_flags('10000000-0000-0000-0000-000000000002', '[{"id": "20000000-0000-0000-0000-000000000009", "siteId": "10000000-0000-0000-0000-000000000002",
    "unitId": "10000000-0000-0000-0000-000000000005", "type": "unscheduled", "state": "released", "reasonCode": "x",
    "start": "2026-10-20T00:00:00Z", "end": "2026-10-20T01:00:00Z"}]'::jsonb);
  raise exception 'viewer could save a flag';
exception when insufficient_privilege then null; end $$;

-- Someone who is not a member sees nothing and cannot log.
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000ff', 'eve@example.com');
do $$ begin
  if jsonb_array_length(app_load('10000000-0000-0000-0000-000000000002')->'flags') <> 0 then raise exception 'outsider can read flags'; end if;
  begin
    perform app_log('10000000-0000-0000-0000-000000000002', '[{"action": "x", "entity": "down_flag"}]'::jsonb);
    raise exception 'outsider could log';
  exception when raise_exception then if sqlerrm not like 'Not a member%' then raise; end if; end;
end $$;

-- Invites: the Admin adds Kim; when Kim signs in with that email, Kim joins.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'ada@example.com');
select app_save_users('10000000-0000-0000-0000-000000000002', '[{"id": "30000000-0000-0000-0000-000000000001", "name": "Kim", "email": "Kim@Example.com", "role": "reliability_engineer", "scope": ["*"]}]'::jsonb);
-- A supervisor cannot invite.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b', 'sam@example.com');
do $$ begin
  perform app_save_users('10000000-0000-0000-0000-000000000002', '[{"id": "30000000-0000-0000-0000-000000000002", "name": "Mal", "email": "mal@example.com", "role": "admin", "scope": ["*"]}]'::jsonb);
  raise exception 'supervisor could invite';
exception when insufficient_privilege then null; end $$;
-- Signing in with a different email does not pick up Kim's invite.
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000ee', 'notkim@example.com');
do $$ begin if app_join() <> 0 then raise exception 'wrong email joined'; end if; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000dd', 'kim@example.com');
do $$ begin
  if app_join() <> 1 then raise exception 'invite not accepted'; end if;
  if (app_load('10000000-0000-0000-0000-000000000002')->>'role') <> 'reliability_engineer' then raise exception 'Kim has the wrong role'; end if;
end $$;

-- Phase 2: nobody sets a target directly any more, not even the reliability
-- engineer; it goes through an approved request (approvals_api.sql).
do $$ begin
  perform app_save_target('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000001", "kpi": "pa", "fleet": "Haul trucks", "value": 0.92, "amber": 0.02, "effectiveFrom": "2026-11-01T07:00:00Z", "reason": "plan"}'::jsonb);
  raise exception 'reliability engineer set a target without approval';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b', 'sam@example.com');
do $$ begin
  perform app_save_target('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000002", "kpi": "pa", "value": 0.5, "amber": 0, "effectiveFrom": "2026-11-01T07:00:00Z", "reason": "x"}'::jsonb);
  raise exception 'supervisor could set a target';
exception when insufficient_privilege then null; end $$;

reset role;
do $$ declare n int; begin
  select count(*) into n from audit_log where action = 'move_location' and reason = 'towed in' and user_id = 'a0000000-0000-0000-0000-00000000000b';
  if n <> 1 then raise exception 'command audit missing'; end if;
end $$;

rollback;
\o
\echo app API test passed
