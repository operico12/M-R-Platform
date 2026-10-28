-- Actions and RCA API test, with row-level security on. Run after app_api.sql's migrations.
\set QUIET on
\o /dev/null
begin;

insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver'),
  ('10000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', 'Other mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-00000000000e', 'supervisor', '{*}', 'Oz', 'oz@example.com');

create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
create function pg_temp.action(p_status text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('id', '50000000-0000-0000-0000-000000000001', 'title', 'Reroute hoses', 'owner', 'a0000000-0000-0000-0000-00000000000c',
    'due', '2026-11-15', 'status', p_status, 'source', jsonb_build_object('kind', 'analysis', 'query', 'system=Hydraulics', 'label', 'Hydraulics')) || p_extra);
$$;

set local role authenticated;

-- The supervisor raises an action owned by Vic (a viewer).
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_actions('10000000-0000-0000-0000-000000000002', pg_temp.action('open'));

-- Vic owns it, so Vic can start and complete it ...
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select app_save_actions('10000000-0000-0000-0000-000000000002', pg_temp.action('in_progress', '{"startedAt": "2026-10-27T15:00:00Z"}'));
-- ... but not move the due date,
do $$ begin
  perform app_save_actions('10000000-0000-0000-0000-000000000002', pg_temp.action('in_progress', '{"due": "2027-01-01", "startedAt": "2026-10-27T15:00:00Z"}'));
  raise exception 'owner moved the due date';
exception when insufficient_privilege then null; end $$;
-- ... nor cancel it.
do $$ begin
  perform app_save_actions('10000000-0000-0000-0000-000000000002', pg_temp.action('cancelled', '{"cancelReason": "bored", "startedAt": "2026-10-27T15:00:00Z"}'));
  raise exception 'owner cancelled';
exception when insufficient_privilege then null; end $$;
-- Done needs a note.
do $$ begin
  perform app_save_actions('10000000-0000-0000-0000-000000000002', pg_temp.action('done', '{"doneAt": "2026-10-28T15:00:00Z", "startedAt": "2026-10-27T15:00:00Z"}'));
  raise exception 'done without a note';
exception when check_violation then null; end $$;
select app_save_actions('10000000-0000-0000-0000-000000000002', pg_temp.action('done', '{"doneAt": "2026-10-28T15:00:00Z", "doneNote": "Rerouted", "startedAt": "2026-10-27T15:00:00Z"}'));
-- A viewer cannot raise one.
do $$ begin
  perform app_save_actions('10000000-0000-0000-0000-000000000002', jsonb_build_array(jsonb_build_object('id', '50000000-0000-0000-0000-000000000002', 'title', 'x',
    'owner', 'a0000000-0000-0000-0000-00000000000c', 'due', '2026-11-15', 'status', 'open', 'source', '{"kind": "manual", "label": "x"}'::jsonb)));
  raise exception 'viewer raised an action';
exception when insufficient_privilege then null; end $$;

-- A supervisor at another site cannot see or change it, even by sending its id.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  if jsonb_array_length(app_load_improve('10000000-0000-0000-0000-000000000002')->'actions') <> 0 then raise exception 'other site can read actions'; end if;
end $$;
do $$ begin
  perform app_save_actions('10000000-0000-0000-0000-000000000009', pg_temp.action('open'));
  raise exception 'other site took over the action id';
exception when unique_violation then null; end $$;

-- RCA: the supervisor cannot start one; the reliability engineer can, and can close it only with a root cause.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_rcas('10000000-0000-0000-0000-000000000002', '[{"id": "60000000-0000-0000-0000-000000000001", "title": "t", "problem": "p",
    "source": {"kind": "manual", "label": "x"}, "status": "open", "lead": "a0000000-0000-0000-0000-00000000000d"}]'::jsonb);
  raise exception 'supervisor started an RCA';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
select app_save_rcas('10000000-0000-0000-0000-000000000002', '[{"id": "60000000-0000-0000-0000-000000000001", "title": "HT107 hoses", "problem": "Three hose failures",
  "source": {"kind": "unit", "label": "HT107"}, "status": "open", "lead": "a0000000-0000-0000-0000-00000000000d",
  "whys": ["Hose burst", "Rubbed on frame"], "fishbone": {"method": ["No clamp check"]}}]'::jsonb);
do $$ begin
  perform app_save_rcas('10000000-0000-0000-0000-000000000002', '[{"id": "60000000-0000-0000-0000-000000000001", "title": "HT107 hoses", "problem": "Three hose failures",
    "source": {"kind": "unit", "label": "HT107"}, "status": "closed", "closedAt": "2026-10-28T15:00:00Z", "closeNote": "ok", "lead": "a0000000-0000-0000-0000-00000000000d"}]'::jsonb);
  raise exception 'closed without a root cause';
exception when check_violation then null; end $$;

do $$ declare d jsonb := app_load_improve('10000000-0000-0000-0000-000000000002'); begin
  if d->'actions'->0->>'status' <> 'done' or d->'actions'->0->>'doneNote' <> 'Rerouted' or d->'actions'->0->>'due' <> '2026-11-15' then raise exception 'action wrong: %', d->'actions'; end if;
  if jsonb_array_length(d->'actions') <> 1 then raise exception 'expected 1 action at this site'; end if;
  if d->'rcas'->0->'whys'->>1 <> 'Rubbed on frame' or d->'rcas'->0->'fishbone'->'method'->>0 <> 'No clamp check' then raise exception 'rca wrong: %', d->'rcas'; end if;
end $$;

-- Nothing is deleted: no delete policy for app users, and a trigger for everyone else.
delete from improvement_actions;
reset role;
do $$ begin
  delete from improvement_actions;
  raise exception 'an action was deleted';
exception when raise_exception then if sqlerrm not like 'Records in%' then raise; end if; end $$;
do $$ declare n int; begin
  select count(*) into n from audit_log where entity = 'improvement_actions';
  if n < 3 then raise exception 'action changes missing from the audit log (%)', n; end if;
  -- The other site's row with the same id was not created over this one.
  select count(*) into n from improvement_actions where id = '50000000-0000-0000-0000-000000000001' and site_id = '10000000-0000-0000-0000-000000000002';
  if n <> 1 then raise exception 'action moved site'; end if;
end $$;

rollback;
\o
\echo improve API test passed
