-- Phase 2: saved calculator results (docs/calculators.md, plan 7.3).
-- A saved analysis is fixed once saved: the only later step is voiding it
-- with a reason. Never deleted. The calculators run in the browser
-- (packages/core/src/calculators.ts); this keeps what was saved.

create table saved_analyses (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  calculator text not null check (calculator in ('inherent_availability', 'availability_target', 'downtime_cost', 'mtbf_confidence', 'weibull',
    'conditional_weibull', 'repair_times', 'risk_matrix', 'cost_per_hour', 'mtbf_rate')),
  calculator_version int not null check (calculator_version >= 1),
  title text not null check (length(trim(title)) between 1 and 200),
  inputs jsonb not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  sentence text not null default '',
  data_note text not null default '',
  unit_id uuid references assets(id) on delete restrict,
  project_id uuid references projects(id) on delete restrict,
  rca_id uuid references rcas(id) on delete restrict,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  check (voided_at is null or length(trim(coalesce(void_reason, ''))) > 0),
  check (length(inputs::text) <= 200000)
);
create index saved_analyses_site on saved_analyses (site_id, created_at);

create or replace function saved_analysis_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now(); new.voided_by := null; new.voided_at := null; new.void_reason := null;
    -- Links point at records of the same site.
    if new.unit_id is not null and not exists (select 1 from assets a where a.id = new.unit_id and a.site_id = new.site_id)
       or new.project_id is not null and not exists (select 1 from projects p where p.id = new.project_id and p.site_id = new.site_id)
       or new.rca_id is not null and not exists (select 1 from rcas r where r.id = new.rca_id and r.site_id = new.site_id) then
      raise exception 'A linked unit, project or RCA is not at this site.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if old.voided_at is not null then raise exception 'This analysis is voided.' using errcode = 'insufficient_privilege'; end if;
  if (new.id, new.tenant_id, new.site_id, new.calculator, new.calculator_version, new.title, new.inputs, new.result, new.sentence, new.data_note,
      new.unit_id, new.project_id, new.rca_id, new.created_by, new.created_at)
     is distinct from (old.id, old.tenant_id, old.site_id, old.calculator, old.calculator_version, old.title, old.inputs, old.result, old.sentence, old.data_note,
      old.unit_id, old.project_id, old.rca_id, old.created_by, old.created_at)
     or new.void_reason is null then
    raise exception 'A saved analysis cannot be changed. Void it with a reason and save a new one.' using errcode = 'insufficient_privilege';
  end if;
  new.voided_by := auth.uid(); new.voided_at := now();
  return new;
end $$;

create trigger saved_analyses_guard before insert or update on saved_analyses for each row execute function saved_analysis_guard();
create trigger saved_analyses_no_delete before delete on saved_analyses for each row execute function refuse_delete();
create trigger saved_analyses_audit after insert or update on saved_analyses for each row execute function audit_row();
alter table saved_analyses enable row level security;
create policy saved_analyses_read on saved_analyses for select using (is_site_member(site_id));
-- Plan 11.2 "Run calculators and analyses".
create policy saved_analyses_insert on saved_analyses for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy saved_analyses_update on saved_analyses for update using (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));

-- ---------- API ----------

-- A new saved analysis (insert), or voiding one (update).
create or replace function app_save_analysis(p_site uuid, a jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update saved_analyses set void_reason = a->>'voidReason'
  where id = (a->>'id')::uuid and site_id = p_site and a->>'voidedAt' is not null;
  if not found then
    insert into saved_analyses (id, tenant_id, site_id, calculator, calculator_version, title, inputs, result, sentence, data_note, unit_id, project_id, rca_id)
    select (a->>'id')::uuid, s.tenant_id, p_site, a->>'calculator', (a->>'version')::int, a->>'title', coalesce(a->'inputs', 'null'), a->'result',
      coalesce(a->>'sentence', ''), coalesce(a->>'dataNote', ''), (a->'links'->>'unitId')::uuid, (a->'links'->>'projectId')::uuid, (a->'links'->>'rcaId')::uuid
    from sites s where s.id = p_site;
  end if;
end $$;

create or replace function app_load_analyses(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', x.id, 'calculator', x.calculator, 'version', x.calculator_version, 'title', x.title,
    'inputs', x.inputs, 'result', x.result, 'sentence', x.sentence, 'dataNote', x.data_note,
    'links', jsonb_strip_nulls(jsonb_build_object('unitId', x.unit_id, 'projectId', x.project_id, 'rcaId', x.rca_id)),
    'createdBy', x.created_by, 'createdAt', x.created_at, 'voidedBy', x.voided_by, 'voidedAt', x.voided_at, 'voidReason', x.void_reason))
    order by x.created_at), '[]')
  from saved_analyses x where x.site_id = p_site;
$$;

grant execute on function app_save_analysis, app_load_analyses to authenticated;
grant select, insert, update on saved_analyses to authenticated;

-- Saved analyses are everyday work records: everyone at the site sees their
-- history on the audit page.
drop policy audit_log_read_work on audit_log;
create policy audit_log_read_work on audit_log for select using (
  is_site_member(site_id) and entity in (
    'down_flag', 'down_flags', 'flag_stage_intervals', 'flag_location_intervals', 'flag_etas', 'flag_reopen_gaps', 'flag_work_orders',
    'action', 'improvement_actions', 'rca', 'rcas', 'project', 'projects', 'alert', 'alert_answers',
    'inspection', 'inspections', 'inspection_form', 'inspection_forms', 'analysis', 'saved_analyses'
  )
);
