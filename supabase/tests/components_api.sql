-- Components API test: who records, costs only for cost roles, events in time
-- order, one component per position, only the latest event voided, nothing deleted.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values
  ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT107'),
  ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT108');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000010', 'superintendent', '{*}', 'Sid', 'sid@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- A viewer cannot register a component.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_component('10000000-0000-0000-0000-000000000002', '{"id": "60000000-0000-0000-0000-000000000009", "serial": "x", "kind": "engine"}'::jsonb);
  raise exception 'viewer registered a component';
exception when insufficient_privilege then null; end $$;

-- Rae registers an engine with its purchase cost, and sets a target life.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_component('10000000-0000-0000-0000-000000000002', '{"id": "60000000-0000-0000-0000-000000000001", "serial": " en1 ", "kind": "engine", "models": ["793F"]}'::jsonb);
select app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000001", "componentId": "60000000-0000-0000-0000-000000000001",
  "kind": "received", "at": "2026-01-05T16:00:00Z", "receivedAs": "new", "cost": 612345, "warrantyHours": 10000}'::jsonb);
select app_save_life_target('10000000-0000-0000-0000-000000000002', '{"id": "62000000-0000-0000-0000-000000000001", "model": "793F", "kind": "engine", "hours": 20000,
  "effectiveFrom": "2026-01-01", "reason": "OEM"}'::jsonb);

-- Sam (supervisor) installs it, but cannot enter or read costs, or set a target.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000002", "componentId": "60000000-0000-0000-0000-000000000001",
  "kind": "installed", "at": "2026-01-10T16:00:00Z", "unitId": "10000000-0000-0000-0000-000000000005", "position": "engine", "smu": 10000}'::jsonb);
do $$ begin
  if (app_load_components('10000000-0000-0000-0000-000000000002')->'events'->0) ? 'cost' then raise exception 'supervisor read a cost'; end if;
  if (select count(*) from component_event_costs) <> 0 then raise exception 'supervisor read the cost table'; end if;
  if (app_load_components('10000000-0000-0000-0000-000000000002')->'components'->0->>'serial') <> 'EN1' then raise exception 'serial not tidied'; end if;
end $$;
do $$ begin
  perform app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000009", "componentId": "60000000-0000-0000-0000-000000000001",
    "kind": "removed", "at": "2026-02-01T16:00:00Z", "smu": 10500, "reason": "planned", "cost": 1}'::jsonb);
  raise exception 'supervisor entered a cost';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_save_life_target('10000000-0000-0000-0000-000000000002', '{"id": "62000000-0000-0000-0000-000000000009", "model": "793F", "kind": "engine", "hours": 1000, "effectiveFrom": "2026-01-01", "reason": "x"}'::jsonb);
  raise exception 'supervisor set a target life';
exception when insufficient_privilege then null; end $$;

-- A second engine cannot go into the same position, or be dated before its own last event.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_component('10000000-0000-0000-0000-000000000002', '{"id": "60000000-0000-0000-0000-000000000002", "serial": "EN2", "kind": "engine"}'::jsonb);
select app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000003", "componentId": "60000000-0000-0000-0000-000000000002",
  "kind": "received", "at": "2026-01-06T16:00:00Z", "receivedAs": "used"}'::jsonb);
do $$ begin
  perform app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000004", "componentId": "60000000-0000-0000-0000-000000000002",
    "kind": "installed", "at": "2026-02-01T16:00:00Z", "unitId": "10000000-0000-0000-0000-000000000005", "position": "engine", "smu": 10400}'::jsonb);
  raise exception 'two engines in one position';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000004", "componentId": "60000000-0000-0000-0000-000000000002",
    "kind": "installed", "at": "2026-01-01T16:00:00Z", "unitId": "10000000-0000-0000-0000-000000000006", "position": "engine", "smu": 400}'::jsonb);
  raise exception 'event before the last one';
exception when check_violation then null; end $$;
select app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000004", "componentId": "60000000-0000-0000-0000-000000000002",
  "kind": "installed", "at": "2026-02-01T16:00:00Z", "unitId": "10000000-0000-0000-0000-000000000006", "position": "engine", "smu": 400}'::jsonb);
select app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000005", "componentId": "60000000-0000-0000-0000-000000000002",
  "kind": "removed", "at": "2026-03-01T16:00:00Z", "smu": 900, "reason": "failure"}'::jsonb);

-- Events cannot be edited or deleted; only the latest is voided, by its author or a superintendent.
do $$ begin
  update component_events set smu = 1 where id = '61000000-0000-0000-0000-000000000005';
  raise exception 'event edited';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from component_events where id = '61000000-0000-0000-0000-000000000005';
  if found then raise exception 'event deleted'; end if;
exception when insufficient_privilege or raise_exception then null; end $$;
do $$ begin
  perform app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000004", "voidedAt": "x", "voidReason": "wrong"}'::jsonb);
  raise exception 'voided an event that is not the latest';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000005", "voidedAt": "x", "voidReason": "mine now"}'::jsonb);
  raise exception 'someone else voided an event';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-000000000010');
select app_save_component_event('10000000-0000-0000-0000-000000000002', '{"id": "61000000-0000-0000-0000-000000000005", "voidedAt": "x", "voidReason": "Wrong truck"}'::jsonb);

-- The superintendent reads costs; the target life cannot be edited.
do $$ begin
  if (app_load_components('10000000-0000-0000-0000-000000000002')->'events'->0->>'cost')::numeric <> 612345 then raise exception 'cost role cannot read the cost'; end if;
end $$;
do $$ begin
  update life_targets set hours = 1 where id = '62000000-0000-0000-0000-000000000001';
  if found then raise exception 'target edited'; end if;
exception when insufficient_privilege then null; end $$;
reset role;
do $$ begin
  if (select voided_by from component_events where id = '61000000-0000-0000-0000-000000000005') <> 'a0000000-0000-0000-0000-000000000010' then raise exception 'void not recorded'; end if;
  if (select count(*) from component_events) <> 5 then raise exception 'an event went missing'; end if;
  if exists (select 1 from audit_log where after::text like '%612345%') then raise exception 'a cost reached the audit log: %', (select entity || after::text from audit_log where after::text like '%612345%' limit 1); end if;
end $$;
rollback;
\o
\echo components API test passed
