-- Phase 2: project tracking (plan section 8).
-- One row per project. Tasks, risks, decisions, costs, change requests and the
-- gate history are lists inside the row, so a project saves as one record and
-- every change lands in the audit log as one before-and-after entry. The app
-- runs the rules in packages/core/src/projects.ts; the policies, the trigger
-- and the task function below are the backstop (plan 11.2).

create table projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  charter text not null check (length(trim(charter)) > 0),
  scope text not null default '',
  owner_id uuid not null,
  stage text not null default 'idea' check (stage in ('idea', 'approved', 'in_progress', 'closed', 'benefits_confirmed', 'stopped')),
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  budget numeric not null check (budget >= 0),
  forecast_to_complete numeric not null default 0 check (forecast_to_complete >= 0),
  stages jsonb not null default '[]' check (jsonb_typeof(stages) = 'array'),
  tasks jsonb not null default '[]' check (jsonb_typeof(tasks) = 'array'),
  risks jsonb not null default '[]' check (jsonb_typeof(risks) = 'array'),
  decisions jsonb not null default '[]' check (jsonb_typeof(decisions) = 'array'),
  costs jsonb not null default '[]' check (jsonb_typeof(costs) = 'array'),
  changes jsonb not null default '[]' check (jsonb_typeof(changes) = 'array'),
  links jsonb not null default '{}' check (jsonb_typeof(links) = 'object'),
  benefit_query text,
  expected_hours_per_year numeric,
  value_per_down_hour numeric,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);
create index projects_site on projects (site_id, stage);

create trigger projects_updated before update on projects for each row execute function set_updated();
create trigger projects_no_delete before delete on projects for each row execute function refuse_delete();
create trigger projects_audit after insert or update on projects for each row execute function audit_row();
alter table projects enable row level security;
create policy projects_read on projects for select using (is_site_member(site_id));
create policy projects_insert on projects for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent') and stage = 'idea');
create policy projects_update on projects for update using (site_role(site_id) in ('reliability_engineer', 'superintendent'));

-- Gates and budgets are the superintendent's: approving, confirming benefits,
-- stopping, reopening, and any change of budget or end date after approval.
-- Lists may only grow: nothing inside a project is deleted.
create or replace function project_limits() returns trigger
language plpgsql set search_path = public as $$
declare
  k text;
  is_super boolean := site_role(new.site_id) = 'superintendent';
begin
  if auth.uid() is null then return new; end if; -- database owner, migrations and seed
  if new.site_id is distinct from old.site_id or new.tenant_id is distinct from old.tenant_id then
    raise exception 'A project cannot move site.' using errcode = 'insufficient_privilege';
  end if;
  foreach k in array array['stages', 'tasks', 'risks', 'decisions', 'costs', 'changes'] loop
    if jsonb_array_length(to_jsonb(new) -> k) < jsonb_array_length(to_jsonb(old) -> k) then
      raise exception 'Nothing in a project is deleted (%).', k using errcode = 'insufficient_privilege';
    end if;
  end loop;
  if not is_super then
    if new.stage is distinct from old.stage and (new.stage in ('approved', 'benefits_confirmed', 'stopped') or old.stage in ('closed', 'benefits_confirmed', 'stopped')) then
      raise exception 'Only the superintendent approves, stops or reopens a project.' using errcode = 'insufficient_privilege';
    end if;
    if old.stage <> 'idea' and (new.budget is distinct from old.budget or new.ends_on is distinct from old.ends_on or new.starts_on is distinct from old.starts_on) then
      raise exception 'After approval, budget and dates change through a change request.' using errcode = 'insufficient_privilege';
    end if;
    -- A change request is decided by the superintendent only.
    if exists (
      select 1 from jsonb_array_elements(new.changes) c
      where c->>'status' <> 'proposed'
        and not exists (select 1 from jsonb_array_elements(old.changes) o where o->>'id' = c->>'id' and o->>'status' = c->>'status')
    ) then
      raise exception 'Only the superintendent decides change requests.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;
create trigger projects_limits before update on projects for each row execute function project_limits();

-- ---------- app API ----------

create or replace function app_load_projects(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', p.id, 'title', p.title, 'charter', p.charter, 'scope', p.scope, 'owner', p.owner_id, 'stage', p.stage, 'stages', p.stages,
    'start', p.starts_on, 'end', p.ends_on, 'budget', p.budget, 'forecastToComplete', p.forecast_to_complete,
    'tasks', p.tasks, 'risks', p.risks, 'decisions', p.decisions, 'costs', p.costs, 'changes', p.changes, 'links', p.links,
    'benefitQuery', p.benefit_query, 'expectedHoursPerYear', p.expected_hours_per_year, 'valuePerDownHour', p.value_per_down_hour,
    'createdBy', p.created_by, 'createdAt', p.created_at, 'updatedAt', p.updated_at)) order by p.created_at), '[]')
  from projects p where p.site_id = p_site;
$$;

create or replace function app_save_projects(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare p jsonb;
begin
  for p in select e from jsonb_array_elements(p_rows) e loop
    update projects set title = p->>'title', charter = p->>'charter', scope = coalesce(p->>'scope', ''), owner_id = (p->>'owner')::uuid,
      stage = p->>'stage', starts_on = (p->>'start')::date, ends_on = (p->>'end')::date, budget = (p->>'budget')::numeric,
      forecast_to_complete = (p->>'forecastToComplete')::numeric, stages = p->'stages', tasks = p->'tasks', risks = p->'risks',
      decisions = p->'decisions', costs = p->'costs', changes = p->'changes', links = p->'links', benefit_query = p->>'benefitQuery',
      expected_hours_per_year = (p->>'expectedHoursPerYear')::numeric, value_per_down_hour = (p->>'valuePerDownHour')::numeric
    where id = (p->>'id')::uuid and site_id = p_site;
    if not found then
      insert into projects (id, tenant_id, site_id, title, charter, scope, owner_id, stage, starts_on, ends_on, budget, forecast_to_complete,
        stages, tasks, risks, decisions, costs, changes, links, benefit_query, expected_hours_per_year, value_per_down_hour, created_by)
      select (p->>'id')::uuid, s.tenant_id, p_site, p->>'title', p->>'charter', coalesce(p->>'scope', ''), (p->>'owner')::uuid, p->>'stage',
        (p->>'start')::date, (p->>'end')::date, (p->>'budget')::numeric, (p->>'forecastToComplete')::numeric,
        p->'stages', p->'tasks', p->'risks', p->'decisions', p->'costs', p->'changes', p->'links', p->>'benefitQuery',
        (p->>'expectedHoursPerYear')::numeric, (p->>'valuePerDownHour')::numeric, auth.uid()
      from sites s where s.id = p_site;
    end if;
  end loop;
end $$;

-- A task owner who does not run projects (a supervisor or technician) may
-- start or finish their own task, once tasks it depends on are done. Security
-- definer, so it checks everything itself and changes only that one task.
create or replace function app_set_task_status(p_site uuid, p_project uuid, p_task text, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  p projects%rowtype;
  t jsonb;
  i int;
begin
  if not is_site_member(p_site) then raise exception 'Not a member of this site.' using errcode = 'insufficient_privilege'; end if;
  if p_status not in ('in_progress', 'done') then raise exception 'Task owners can only start or finish a task.' using errcode = 'insufficient_privilege'; end if;
  select * into p from projects where id = p_project and site_id = p_site for update;
  if not found then raise exception 'Project not found.'; end if;
  if p.stage not in ('approved', 'in_progress') then raise exception 'Work starts once the project is approved, and stops when it closes.'; end if;
  select e, n - 1 into t, i from jsonb_array_elements(p.tasks) with ordinality as x(e, n) where e->>'id' = p_task;
  if t is null then raise exception 'Task not found.'; end if;
  if (t->>'owner')::uuid is distinct from auth.uid() then raise exception 'Only the task owner can update it here.' using errcode = 'insufficient_privilege'; end if;
  if t->>'status' in ('done', 'cancelled') then raise exception 'The task is closed.'; end if;
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(t->'dependsOn', '[]')) d
    join jsonb_array_elements(p.tasks) o on o->>'id' = d
    where o->>'status' in ('not_started', 'in_progress')
  ) then raise exception 'A task it depends on is still open.'; end if;
  t := t || jsonb_build_object('status', p_status) || case when p_status = 'done' then jsonb_build_object('doneAt', now()) else '{}' end
         || case when coalesce(trim(p_note), '') <> '' then jsonb_build_object('note', trim(p_note)) else '{}' end;
  update projects set tasks = jsonb_set(tasks, array[i::text], t) where id = p.id;
end $$;

grant execute on function app_load_projects, app_save_projects, app_set_task_status to authenticated;
grant select, insert, update on projects to authenticated;
