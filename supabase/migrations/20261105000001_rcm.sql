-- Phase 3: RCM to PM job plans (docs/rcm.md). Failure modes are never
-- edited: each change is a new revision, and a mode that no longer applies is
-- retired with a reason. Issued job plan revisions are never changed.
-- The app runs the rules in packages/core/src/rcm.ts; these are the backstop.

create table rcm_modes (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  mode_id uuid not null,
  revision int not null check (revision >= 1),
  model text not null check (length(trim(model)) between 1 and 60),
  system text not null check (length(trim(system)) between 1 and 100),
  component text not null check (length(trim(component)) between 1 and 100),
  func text not null check (length(trim(func)) between 1 and 500),
  functional_failure text not null check (length(trim(functional_failure)) between 1 and 500),
  mode text not null check (length(trim(mode)) between 1 and 100),
  effect text not null check (length(trim(effect)) between 1 and 2000),
  consequence text not null check (consequence in ('hidden', 'safety', 'operational', 'non_operational')),
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  recommended text not null check (recommended in ('on_condition', 'restoration', 'replacement', 'failure_finding', 'run_to_failure', 'redesign')),
  task_type text not null check (task_type in ('on_condition', 'restoration', 'replacement', 'failure_finding', 'run_to_failure', 'redesign')),
  override_reason text,
  task text not null default '' check (length(task) <= 2000),
  interval_hours numeric check (interval_hours is null or (interval_hours > 0 and interval_hours <= 100000)),
  interval_basis text check (interval_basis is null or length(interval_basis) <= 500),
  craft text check (craft is null or length(trim(craft)) between 1 and 8),
  people int check (people is null or people between 1 and 20),
  task_hours numeric check (task_hours is null or (task_hours > 0 and task_hours <= 500)),
  parts jsonb not null default '[]' check (jsonb_typeof(parts) = 'array'),
  change_note text,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  retired_by uuid,
  retired_at timestamptz,
  retire_reason text,
  unique (mode_id, revision),
  check ((retired_at is null) = (retire_reason is null)),
  check (retire_reason is null or length(trim(retire_reason)) > 0),
  check (task_type = recommended or length(trim(coalesce(override_reason, ''))) > 0),
  -- A scheduled task carries its interval and labour; the others carry none.
  check (case when task_type in ('on_condition', 'restoration', 'replacement', 'failure_finding')
    then interval_hours is not null and craft is not null and people is not null and task_hours is not null and length(trim(task)) > 0
    else interval_hours is null and craft is null and people is null and task_hours is null and parts = '[]' end),
  check (revision = 1 or length(trim(coalesce(change_note, ''))) > 0)
);
create index rcm_modes_site on rcm_modes (site_id, model);

create table job_plan_versions (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  jpnum text not null check (length(trim(jpnum)) between 1 and 30),
  model text not null,
  hours numeric not null check (hours > 0),
  revision int not null check (revision >= 1),
  content jsonb not null check (jsonb_typeof(content) = 'object' and jsonb_typeof(content->'tasks') = 'array' and jsonb_array_length(content->'tasks') > 0),
  note text not null check (length(trim(note)) > 0),
  issued_by uuid not null default auth.uid(),
  issued_at timestamptz not null default now(),
  unique (site_id, jpnum, revision)
);

-- Modes: a new revision follows the latest one for the same mode, at the same site and model,
-- and only while it is not retired. The only update is retiring the latest revision, once, with a reason.
create or replace function rcm_mode_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_last rcm_modes;
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    select * into v_last from rcm_modes where mode_id = new.mode_id order by revision desc limit 1;
    if v_last.id is null then
      if new.revision <> 1 then raise exception 'A new failure mode starts at revision 1.' using errcode = 'check_violation'; end if;
    else
      if v_last.site_id <> new.site_id or v_last.model <> new.model then raise exception 'A revision stays with its site and model.' using errcode = 'check_violation'; end if;
      if v_last.retired_at is not null then raise exception 'This failure mode is retired.' using errcode = 'check_violation'; end if;
      if new.revision <> v_last.revision + 1 then raise exception 'Someone else changed this failure mode. Reload and try again.' using errcode = 'check_violation'; end if;
    end if;
    new.created_by := auth.uid(); new.created_at := now();
    new.retired_by := null; new.retired_at := null; new.retire_reason := null;
    return new;
  end if;
  if (to_jsonb(new) - array['retired_by', 'retired_at', 'retire_reason']) is distinct from (to_jsonb(old) - array['retired_by', 'retired_at', 'retire_reason']) then
    raise exception 'A failure mode cannot be changed. Save a new revision.' using errcode = 'insufficient_privilege';
  end if;
  if old.retired_at is not null then raise exception 'It is already retired.' using errcode = 'insufficient_privilege'; end if;
  if new.retire_reason is null or length(trim(new.retire_reason)) = 0 then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  if exists (select 1 from rcm_modes where mode_id = old.mode_id and revision > old.revision) then
    raise exception 'Only the latest revision is retired.' using errcode = 'check_violation';
  end if;
  new.retired_by := auth.uid(); new.retired_at := now();
  return new;
end $$;

create or replace function job_plan_version_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_last int;
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then raise exception 'An issued job plan revision cannot be changed.' using errcode = 'insufficient_privilege'; end if;
  select max(revision) into v_last from job_plan_versions where site_id = new.site_id and jpnum = new.jpnum;
  if new.revision <> coalesce(v_last, 0) + 1 then
    raise exception 'Someone else issued this job plan. Reload and try again.' using errcode = 'check_violation';
  end if;
  new.issued_by := auth.uid(); new.issued_at := now();
  return new;
end $$;

create trigger rcm_modes_guard before insert or update on rcm_modes for each row execute function rcm_mode_guard();
create trigger rcm_modes_no_delete before delete on rcm_modes for each row execute function refuse_delete();
create trigger rcm_modes_audit after insert or update on rcm_modes for each row execute function audit_row();
create trigger job_plan_versions_guard before insert or update on job_plan_versions for each row execute function job_plan_version_guard();
create trigger job_plan_versions_no_delete before delete on job_plan_versions for each row execute function refuse_delete();
create trigger job_plan_versions_audit after insert or update on job_plan_versions for each row execute function audit_row();

alter table rcm_modes enable row level security;
alter table job_plan_versions enable row level security;
create policy rcm_modes_read on rcm_modes for select using (is_site_member(site_id));
create policy rcm_modes_insert on rcm_modes for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent'));
create policy rcm_modes_update on rcm_modes for update using (site_role(site_id) in ('reliability_engineer', 'superintendent'));
create policy job_plan_versions_read on job_plan_versions for select using (is_site_member(site_id));
create policy job_plan_versions_insert on job_plan_versions for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent'));
grant select, insert, update on rcm_modes to authenticated;
grant select, insert on job_plan_versions to authenticated;

-- ---------- settings ----------

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts', 'condition', 'rcm'));
create or replace function can_write_setting(p_site uuid, p_key text) returns boolean
language sql stable security invoker set search_path = public as $$
  select case p_key
    when 'work' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'condition' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'rcm' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    else false end;
$$;

-- Saved calculator results: the phase 3 calculators (C-11 rebuild or replace was missing here too).
alter table saved_analyses drop constraint saved_analyses_calculator_check;
alter table saved_analyses add constraint saved_analyses_calculator_check check (calculator in ('inherent_availability', 'availability_target', 'downtime_cost',
  'mtbf_confidence', 'weibull', 'conditional_weibull', 'repair_times', 'risk_matrix', 'cost_per_hour', 'mtbf_rate', 'rebuild_or_replace',
  'pf_interval', 'optimal_replacement', 'failure_finding', 'strategy_cost'));

-- ---------- API ----------

create or replace function app_save_rcm_mode(p_site uuid, m jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  insert into rcm_modes (id, tenant_id, site_id, mode_id, revision, model, system, component, func, functional_failure, mode, effect, consequence, answers,
    recommended, task_type, override_reason, task, interval_hours, interval_basis, craft, people, task_hours, parts, change_note)
  select (m->>'id')::uuid, s.tenant_id, p_site, (m->>'modeId')::uuid, (m->>'revision')::int, m->>'model', m->>'system', m->>'component', m->>'func',
    m->>'functionalFailure', m->>'mode', m->>'effect', m->>'consequence', coalesce(m->'answers', '{}'), m->>'recommended', m->>'taskType',
    nullif(trim(m->>'overrideReason'), ''), coalesce(m->>'task', ''), (m->>'intervalHours')::numeric, nullif(trim(m->>'intervalBasis'), ''),
    nullif(trim(m->>'craft'), ''), (m->>'people')::int, (m->>'taskHours')::numeric, coalesce(m->'parts', '[]'), nullif(trim(m->>'changeNote'), '')
  from sites s where s.id = p_site;
end $$;

create or replace function app_retire_rcm_mode(p_site uuid, p_id uuid, p_reason text) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update rcm_modes set retire_reason = p_reason, retired_at = now() where id = p_id and site_id = p_site;
  if not found then raise exception 'Failure mode not found.' using errcode = 'insufficient_privilege'; end if;
end $$;

create or replace function app_issue_job_plan(p_site uuid, v jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  insert into job_plan_versions (id, tenant_id, site_id, jpnum, model, hours, revision, content, note)
  select (v->>'id')::uuid, s.tenant_id, p_site, v->>'jpnum', v->>'model', (v->>'hours')::numeric, (v->>'revision')::int, v->'content', v->>'note'
  from sites s where s.id = p_site;
end $$;

create or replace function app_load_rcm(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'modes', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', m.id, 'modeId', m.mode_id, 'revision', m.revision, 'model', m.model,
      'system', m.system, 'component', m.component, 'func', m.func, 'functionalFailure', m.functional_failure, 'mode', m.mode, 'effect', m.effect,
      'consequence', m.consequence, 'answers', m.answers, 'recommended', m.recommended, 'taskType', m.task_type, 'overrideReason', m.override_reason,
      'task', m.task, 'intervalHours', m.interval_hours, 'intervalBasis', m.interval_basis, 'craft', m.craft, 'people', m.people, 'taskHours', m.task_hours,
      'parts', m.parts, 'changeNote', m.change_note, 'createdBy', m.created_by, 'createdAt', m.created_at, 'retiredBy', m.retired_by,
      'retiredAt', m.retired_at, 'retireReason', m.retire_reason)) order by m.model, m.mode_id, m.revision)
      from rcm_modes m where m.site_id = p_site), '[]'),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'jpnum', v.jpnum, 'model', v.model, 'hours', v.hours, 'revision', v.revision,
      'content', v.content, 'note', v.note, 'issuedBy', v.issued_by, 'issuedAt', v.issued_at) order by v.jpnum, v.revision)
      from job_plan_versions v where v.site_id = p_site), '[]'));
$$;

grant execute on function app_save_rcm_mode, app_retire_rcm_mode, app_issue_job_plan, app_load_rcm to authenticated;
