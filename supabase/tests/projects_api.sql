-- Projects API test, with row-level security on.
\set QUIET on
\o /dev/null
begin;

insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000f', 'superintendent', '{*}', 'Sol', 'sol@example.com');

create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
-- The project as the app sends it, with overrides.
create function pg_temp.proj(p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('id', '70000000-0000-0000-0000-000000000001', 'title', 'Hose programme', 'charter', 'Cut hose failures',
    'scope', '', 'owner', 'a0000000-0000-0000-0000-00000000000d', 'stage', 'idea', 'start', '2026-10-01', 'end', '2026-12-31', 'budget', 50000,
    'forecastToComplete', 50000, 'stages', '[{"stage": "idea"}]'::jsonb, 'tasks', '[]'::jsonb, 'risks', '[]'::jsonb, 'decisions', '[]'::jsonb,
    'costs', '[]'::jsonb, 'changes', '[]'::jsonb, 'links', '{}'::jsonb) || p_extra);
$$;
create function pg_temp.expect_denied(p_rows jsonb, p_what text) returns void language plpgsql as $$
begin
  perform app_save_projects('10000000-0000-0000-0000-000000000002', p_rows);
  raise exception 'allowed: %', p_what;
exception when insufficient_privilege then null;
end $$;

set local role authenticated;

-- A supervisor cannot create a project; the reliability engineer can.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select pg_temp.expect_denied(pg_temp.proj(), 'supervisor created a project');
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
select app_save_projects('10000000-0000-0000-0000-000000000002', pg_temp.proj());
-- The RE cannot approve it.
select pg_temp.expect_denied(pg_temp.proj('{"stage": "approved", "stages": [{"stage": "idea"}, {"stage": "approved"}]}'), 'RE approved');
-- The superintendent approves.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000f');
select app_save_projects('10000000-0000-0000-0000-000000000002', pg_temp.proj('{"stage": "approved", "stages": [{"stage": "idea"}, {"stage": "approved"}]}'));
-- Now the RE cannot change the budget, nor approve their own change request, nor drop a task.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
select pg_temp.expect_denied(pg_temp.proj('{"stage": "approved", "stages": [{"stage": "idea"}, {"stage": "approved"}], "budget": 90000}'), 'RE raised the budget');
select pg_temp.expect_denied(pg_temp.proj('{"stage": "approved", "stages": [{"stage": "idea"}, {"stage": "approved"}], "changes": [{"id": "c1", "status": "approved", "budget": 90000}]}'), 'RE approved a change');
select app_save_projects('10000000-0000-0000-0000-000000000002', pg_temp.proj('{"stage": "in_progress", "stages": [{"stage": "idea"}, {"stage": "approved"}, {"stage": "in_progress"}],
  "tasks": [{"id": "t1", "title": "Order", "owner": "a0000000-0000-0000-0000-00000000000b", "status": "not_started", "dependsOn": []},
            {"id": "t2", "title": "Fit", "owner": "a0000000-0000-0000-0000-00000000000b", "status": "not_started", "dependsOn": ["t1"]}]}'));
select pg_temp.expect_denied(pg_temp.proj('{"stage": "in_progress", "stages": [{"stage": "idea"}, {"stage": "approved"}, {"stage": "in_progress"}], "tasks": []}'), 'RE deleted tasks');

-- The supervisor owns the tasks: can start t1, not t2 (waiting on t1), and cannot touch the project otherwise.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_set_task_status('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 't2', 'in_progress');
  raise exception 'started a blocked task';
exception when raise_exception then if sqlerrm not like 'A task it depends on%' then raise; end if; end $$;
select app_set_task_status('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 't1', 'done', 'Ordered PO-1');
select app_set_task_status('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 't2', 'in_progress');
do $$ begin
  perform app_set_task_status('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 't2', 'cancelled');
  raise exception 'owner cancelled';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update projects set budget = 1 where id = '70000000-0000-0000-0000-000000000001';
  if found then raise exception 'supervisor updated a project directly'; end if;
end $$;
-- Someone who does not own the task cannot use the task function.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000f');
do $$ begin
  perform app_set_task_status('10000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 't2', 'done');
  raise exception 'non-owner used the task function';
exception when insufficient_privilege then null; end $$;

do $$ declare d jsonb := app_load_projects('10000000-0000-0000-0000-000000000002'); begin
  if d->0->'tasks'->0->>'status' <> 'done' or d->0->'tasks'->0->>'note' <> 'Ordered PO-1' or d->0->'tasks'->1->>'status' <> 'in_progress' then raise exception 'tasks wrong: %', d->0->'tasks'; end if;
  if (d->0->>'budget')::numeric <> 50000 or d->0->>'stage' <> 'in_progress' or d->0->>'end' <> '2026-12-31' then raise exception 'project wrong: %', d->0; end if;
end $$;

reset role;
do $$ declare n int; begin
  select count(*) into n from audit_log where entity = 'projects' and entity_id = '70000000-0000-0000-0000-000000000001';
  -- create, approve, start with tasks, two task updates
  if n <> 5 then raise exception 'project changes missing from the audit log (%)', n; end if;
end $$;

rollback;
\o
\echo projects API test passed
