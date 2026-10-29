-- Phase 3b, fixed plant part 2 (docs/fixed-plant.md): the structure editor's
-- backstop, shutdowns with their scope, and operator rounds and lube routes
-- through inspections. The app runs the rules in packages/core/src
-- (plant-structure.ts, shutdowns.ts, rounds.ts); these are the backstop.
-- Nothing is deleted; every table is audited.

-- ---------- plant structure: kinds in their places, no loops, one node per functional location ----------

create or replace function plant_fl_key(fl text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(trim(both '-./ ' from coalesce(fl, '')), '[-./ ]+', '-', 'g')), '');
$$;

create or replace function plant_node_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_parent_kind text;
begin
  if new.parent_id is not null then
    select kind into v_parent_kind from plant_nodes p where p.id = new.parent_id and p.site_id = new.site_id and p.retired_at is null;
    if not found then raise exception 'The parent must be an active node at the same site.' using errcode = 'check_violation'; end if;
  end if;
  if new.retired_at is null and not (
    (new.kind = 'plant' and v_parent_kind is null) or
    (new.kind = 'area' and coalesce(v_parent_kind, '') = 'plant') or
    (new.kind = 'circuit' and coalesce(v_parent_kind, '') in ('plant', 'area')) or
    (new.kind = 'group' and coalesce(v_parent_kind, '') in ('circuit', 'group'))) then
    raise exception 'A % cannot sit there (docs/fixed-plant.md, Structure editor).', new.kind using errcode = 'check_violation';
  end if;
  if new.parent_id is not null and exists (
    with recursive up(id) as (
      select new.parent_id
      union
      select p.parent_id from plant_nodes p join up on p.id = up.id where p.parent_id is not null)
    select 1 from up where id = new.id) then
    raise exception 'A node cannot sit under itself or under a node below it.' using errcode = 'check_violation';
  end if;
  if new.retired_at is null and plant_fl_key(new.functional_location) is not null and exists (
    select 1 from plant_nodes o where o.site_id = new.site_id and o.id <> new.id and o.retired_at is null
      and plant_fl_key(o.functional_location) = plant_fl_key(new.functional_location)) then
    raise exception 'Another active node uses that functional location.' using errcode = 'unique_violation';
  end if;
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id or new.site_id <> old.site_id or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
      raise exception 'A plant node stays at its site.' using errcode = 'insufficient_privilege';
    end if;
    if old.retired_at is not null and (to_jsonb(new) - array['updated_at', 'updated_by']) is distinct from (to_jsonb(old) - array['updated_at', 'updated_by']) then
      raise exception 'This plant node is retired.' using errcode = 'insufficient_privilege';
    end if;
    if new.retired_at is not null and old.retired_at is null
       and exists (select 1 from plant_nodes c where c.parent_id = new.id and c.retired_at is null) then
      raise exception 'Retire or move the nodes under it first.' using errcode = 'check_violation';
    end if;
    new.updated_at := now(); new.updated_by := auth.uid();
  else
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  end if;
  return new;
end $$;

-- ---------- routes: inspection forms with stops ----------

alter table inspection_forms add column route jsonb check (route is null or (
  jsonb_typeof(route) = 'object' and route->>'kind' in ('operator_round', 'lube_route') and route ? 'nodeId'
  and jsonb_typeof(route->'stops') = 'array' and jsonb_array_length(route->'stops') > 0));
alter table inspection_forms drop constraint inspection_forms_every_unit_check;
alter table inspection_forms add constraint inspection_forms_every_unit_check check (every_unit in ('days', 'smu_hours', 'shifts'));
alter table inspection_forms add constraint inspection_forms_route_shape check (
  (route is null and every_unit <> 'shifts') or (route is not null and asset_class = 'fixed_plant' and every_unit <> 'smu_hours'));

create or replace function inspection_form_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now(); new.retired_at := null;
    if new.route is not null and not exists (select 1 from plant_nodes n where n.id = (new.route->>'nodeId')::uuid and n.site_id = new.site_id) then
      raise exception 'The route''s node is not at this site.' using errcode = 'insufficient_privilege';
    end if;
    if new.route is not null and exists (
      select 1 from jsonb_array_elements_text(new.route->'stops') s
      where not exists (select 1 from assets a where a.id = s::uuid and a.site_id = new.site_id and a.asset_class = 'fixed_plant')) then
      raise exception 'Every stop is plant equipment at this site.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  -- A form version is fixed. The only change is retiring it.
  if (new.id, new.version, new.tenant_id, new.site_id, new.name, new.asset_class, new.models, new.every_n, new.every_unit, new.items, new.route, new.reason, new.created_by, new.created_at)
     is distinct from (old.id, old.version, old.tenant_id, old.site_id, old.name, old.asset_class, old.models, old.every_n, old.every_unit, old.items, old.route, old.reason, old.created_by, old.created_at)
     or old.retired_at is not null then
    raise exception 'A form version cannot be changed. Save a new version instead.' using errcode = 'insufficient_privilege';
  end if;
  new.retired_at := now();
  return new;
end $$;

-- ---------- rounds ----------

create table rounds (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  form_id uuid not null,
  form_version int not null,
  node_id uuid not null references plant_nodes(id) on delete restrict,
  status text not null check (status in ('submitted', 'voided')),
  skipped jsonb not null default '[]' check (jsonb_typeof(skipped) = 'array'),
  started_by uuid not null default auth.uid(),
  started_at timestamptz not null,
  submitted_at timestamptz not null default now(),
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  foreign key (form_id, form_version) references inspection_forms(id, version) on delete restrict,
  check (status <> 'voided' or length(trim(coalesce(void_reason, ''))) > 0)
);
create index rounds_site on rounds (site_id, started_at);
create index rounds_form on rounds (form_id, started_at);

alter table inspections add column round_id uuid references rounds(id) on delete restrict;
create index inspections_round on inspections (round_id) where round_id is not null;

create or replace function round_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_role app_role := site_role(new.site_id);
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'submitted'; new.started_by := auth.uid(); new.submitted_at := now();
    new.voided_by := null; new.voided_at := null; new.void_reason := null;
    if new.started_at > now() then new.started_at := now(); end if;
    if not exists (select 1 from inspection_forms f where f.id = new.form_id and f.version = new.form_version and f.site_id = new.site_id
                   and f.retired_at is null and f.route is not null and (f.route->>'nodeId')::uuid = new.node_id) then
      raise exception 'That route version is not in use at this site.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'voided_by', 'voided_at', 'void_reason']) is distinct from (to_jsonb(old) - array['status', 'voided_by', 'voided_at', 'void_reason'])
     or old.status = 'voided' or new.status <> 'voided' then
    raise exception 'A submitted round is only ever voided.' using errcode = 'insufficient_privilege';
  end if;
  if v_role not in ('supervisor', 'superintendent') then raise exception 'A supervisor or superintendent voids a round.' using errcode = 'insufficient_privilege'; end if;
  new.voided_by := auth.uid(); new.voided_at := now();
  return new;
end $$;

create trigger rounds_guard before insert or update on rounds for each row execute function round_guard();
create trigger rounds_no_delete before delete on rounds for each row execute function refuse_delete();
create trigger rounds_audit after insert or update on rounds for each row execute function audit_row();
alter table rounds enable row level security;
create policy rounds_read on rounds for select using (is_site_member(site_id));
create policy rounds_insert on rounds for insert with check (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
create policy rounds_update on rounds for update using (site_role(site_id) in ('supervisor', 'superintendent'));
grant select, insert, update on rounds to authenticated;

-- An inspection that is one stop of a round belongs to that round, done by the same person, at one of its stops.
create or replace function inspection_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_role app_role := site_role(new.site_id); v_me uuid := auth.uid();
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'submitted'; new.started_by := v_me; new.submitted_at := now();
    new.signed_off_by := null; new.signed_off_at := null; new.sign_off_note := null; new.voided_by := null; new.voided_at := null; new.void_reason := null;
    if new.started_at > now() then new.started_at := now(); end if;
    if not exists (select 1 from inspection_forms f where f.id = new.form_id and f.version = new.form_version and f.site_id = new.site_id and f.retired_at is null) then
      raise exception 'That form version is not in use at this site.' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from assets a where a.id = new.unit_id and a.site_id = new.site_id) then
      raise exception 'That unit is not at this site.' using errcode = 'insufficient_privilege';
    end if;
    if new.round_id is not null then
      if not exists (select 1 from rounds r join inspection_forms f on f.id = r.form_id and f.version = r.form_version
                     where r.id = new.round_id and r.site_id = new.site_id and r.started_by = v_me and r.status = 'submitted'
                       and r.form_id = new.form_id and r.form_version = new.form_version and f.route->'stops' ? new.unit_id::text) then
        raise exception 'That stop is not part of your round.' using errcode = 'insufficient_privilege';
      end if;
    elsif exists (select 1 from inspection_forms f where f.id = new.form_id and f.version = new.form_version and f.route is not null) then
      raise exception 'A route is done as a round.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.id, new.tenant_id, new.site_id, new.form_id, new.form_version, new.unit_id, new.round_id, new.smu, new.answers, new.score, new.result, new.started_by, new.started_at, new.submitted_at)
     is distinct from (old.id, old.tenant_id, old.site_id, old.form_id, old.form_version, old.unit_id, old.round_id, old.smu, old.answers, old.score, old.result, old.started_by, old.started_at, old.submitted_at) then
    raise exception 'A submitted inspection''s answers cannot be changed. Void it and do it again.' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'voided' then raise exception 'This inspection is voided.' using errcode = 'insufficient_privilege'; end if;

  if new.status is distinct from old.status then
    if v_role not in ('supervisor', 'superintendent') then raise exception 'A supervisor or superintendent signs off and voids inspections.' using errcode = 'insufficient_privilege'; end if;
    if new.status = 'signed_off' and old.status = 'submitted' then
      if v_me = old.started_by then raise exception 'Someone other than the inspector signs it off.' using errcode = 'insufficient_privilege'; end if;
      new.signed_off_by := v_me; new.signed_off_at := now();
    elsif new.status = 'voided' then
      new.voided_by := v_me; new.voided_at := now();
    else
      raise exception 'That change of status is not allowed.' using errcode = 'insufficient_privilege';
    end if;
  elsif (new.signed_off_by, new.signed_off_at, new.sign_off_note, new.voided_by, new.voided_at, new.void_reason)
        is distinct from (old.signed_off_by, old.signed_off_at, old.sign_off_note, old.voided_by, old.voided_at, old.void_reason) then
    raise exception 'Sign-off and void details are set by those steps only.' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from jsonb_array_elements(old.defects) o where not exists (select 1 from jsonb_array_elements(new.defects) x where x->>'id' = o->>'id')) then
    raise exception 'Defects are closed with a note, never removed.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- ---------- shutdowns ----------

create table shutdowns (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  node_id uuid not null references plant_nodes(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 100),
  work_order text not null check (length(trim(work_order)) > 0),
  planned_start timestamptz not null,
  planned_end timestamptz not null,
  freeze_at timestamptz not null,
  equipment_ids uuid[] not null check (cardinality(equipment_ids) > 0),
  actual_start timestamptz,
  actual_end timestamptz,
  flag_ids uuid[] not null default '{}',
  findings text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  check (planned_end > planned_start and planned_end - planned_start <= interval '60 days'),
  check (freeze_at <= planned_start),
  check (actual_end is null or (actual_start is not null and actual_end > actual_start)),
  check (cancelled_at is null or (actual_start is null and length(trim(coalesce(cancel_reason, ''))) > 0))
);
create index shutdowns_site on shutdowns (site_id, planned_start);

create table shutdown_scope (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  shutdown_id uuid not null references shutdowns(id) on delete restrict,
  work_order text not null check (length(trim(work_order)) > 0),
  added_by uuid default auth.uid(),
  added_at timestamptz not null default now(),
  late boolean not null default false,
  reason text,
  removed_at timestamptz,
  removed_by uuid,
  removed_reason text,
  check (not late or length(trim(coalesce(reason, ''))) > 0),
  check (removed_at is null or length(trim(coalesce(removed_reason, ''))) > 0)
);
create unique index shutdown_scope_once on shutdown_scope (shutdown_id, work_order) where removed_at is null;

create or replace function shutdown_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from unnest(new.equipment_ids) e where not exists (select 1 from assets a where a.id = e and a.site_id = new.site_id and a.asset_class = 'fixed_plant')) then
    raise exception 'Only plant equipment at this site can take part.' using errcode = 'check_violation';
  end if;
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now();
    new.actual_start := null; new.actual_end := null; new.flag_ids := '{}'; new.findings := null;
    new.cancelled_at := null; new.cancelled_by := null; new.cancel_reason := null;
    if not exists (select 1 from plant_nodes n where n.id = new.node_id and n.site_id = new.site_id and n.kind <> 'group' and n.retired_at is null) then
      raise exception 'Pick an active plant, area or circuit at this site.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.id, new.tenant_id, new.site_id, new.node_id, new.created_by, new.created_at) is distinct from (old.id, old.tenant_id, old.site_id, old.node_id, old.created_by, old.created_at) then
    raise exception 'A shutdown stays on its node.' using errcode = 'insufficient_privilege';
  end if;
  if old.cancelled_at is not null or old.actual_end is not null then
    raise exception 'This shutdown has ended or been cancelled.' using errcode = 'insufficient_privilege';
  end if;
  if old.actual_start is not null then
    -- In progress: only the end and the findings.
    if (to_jsonb(new) - array['actual_end', 'findings']) is distinct from (to_jsonb(old) - array['actual_end', 'findings']) then
      raise exception 'A shutdown in progress can only end.' using errcode = 'insufficient_privilege';
    end if;
    if new.actual_end is not null and new.actual_end > now() + interval '5 minutes' then
      raise exception 'The end cannot be in the future.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.actual_end is not null then raise exception 'It has not started.' using errcode = 'check_violation'; end if;
  if new.actual_start is not null and new.actual_start > now() + interval '5 minutes' then
    raise exception 'The start cannot be in the future.' using errcode = 'check_violation';
  end if;
  if new.cancelled_at is not null then new.cancelled_at := now(); new.cancelled_by := auth.uid(); end if;
  if new.actual_start is null and new.flag_ids <> '{}' then raise exception 'Flags come with the start.' using errcode = 'check_violation'; end if;
  return new;
end $$;

create or replace function shutdown_scope_guard() returns trigger
language plpgsql set search_path = public as $$
declare s shutdowns;
begin
  select * into s from shutdowns where id = new.shutdown_id and site_id = new.site_id;
  if not found then raise exception 'That shutdown is not at this site.' using errcode = 'check_violation'; end if;
  if not is_client() then return new; end if;
  if s.cancelled_at is not null or s.actual_end is not null then
    raise exception 'The scope is fixed once a shutdown has ended or been cancelled.' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    new.added_by := auth.uid(); new.added_at := now(); new.late := now() > s.freeze_at;
    new.removed_at := null; new.removed_by := null; new.removed_reason := null;
    if new.late and length(trim(coalesce(new.reason, ''))) = 0 then
      raise exception 'The scope is frozen, so work added needs a reason.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['removed_at', 'removed_by', 'removed_reason']) is distinct from (to_jsonb(old) - array['removed_at', 'removed_by', 'removed_reason'])
     or old.removed_at is not null or new.removed_at is null then
    raise exception 'A scope work order is only ever taken out, with a reason.' using errcode = 'insufficient_privilege';
  end if;
  new.removed_at := now(); new.removed_by := auth.uid();
  return new;
end $$;

create trigger shutdowns_guard before insert or update on shutdowns for each row execute function shutdown_guard();
create trigger shutdown_scope_guard before insert or update on shutdown_scope for each row execute function shutdown_scope_guard();
do $$
declare t text;
begin
  foreach t in array array['shutdowns', 'shutdown_scope'] loop
    execute format('create trigger %I_no_delete before delete on %I for each row execute function refuse_delete()', t, t);
    execute format('create trigger %I_audit after insert or update on %I for each row execute function audit_row()', t, t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_read on %I for select using (is_site_member(site_id))', t, t);
    -- run_shutdowns (packages/core/src/permissions.ts): supervisor, reliability engineer, superintendent.
    execute format('create policy %I_insert on %I for insert with check (site_role(site_id) in (''supervisor'', ''reliability_engineer'', ''superintendent''))', t, t);
    execute format('create policy %I_update on %I for update using (site_role(site_id) in (''supervisor'', ''reliability_engineer'', ''superintendent''))', t, t);
  end loop;
end $$;
grant select, insert, update on shutdowns, shutdown_scope to authenticated;

-- Process delays, rounds and shutdowns are everyday work records: everyone at the site sees their history.
drop policy audit_log_read_work on audit_log;
create policy audit_log_read_work on audit_log for select using (
  is_site_member(site_id) and entity in (
    'down_flag', 'down_flags', 'flag_stage_intervals', 'flag_location_intervals', 'flag_etas', 'flag_reopen_gaps', 'flag_work_orders',
    'action', 'improvement_actions', 'rca', 'rcas', 'project', 'projects', 'alert', 'alert_answers',
    'inspection', 'inspections', 'inspection_form', 'inspection_forms', 'analysis', 'saved_analyses',
    'process_delay', 'process_delays', 'round', 'rounds', 'shutdown', 'shutdowns', 'shutdown_scope'
  )
);

-- ---------- API ----------

create or replace function app_save_form(p_site uuid, f jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update inspection_forms set retired_reason = f->>'retiredReason'
  where id = (f->>'id')::uuid and version = (f->>'version')::int and site_id = p_site and f->>'retiredAt' is not null and retired_at is null;
  if not found and not exists (select 1 from inspection_forms where id = (f->>'id')::uuid and version = (f->>'version')::int) then
    insert into inspection_forms (id, version, tenant_id, site_id, name, asset_class, models, every_n, every_unit, items, route, reason)
    select (f->>'id')::uuid, (f->>'version')::int, s.tenant_id, p_site, f->>'name', f->>'assetClass',
      coalesce((select array_agg(x) from jsonb_array_elements_text(f->'models') x), '{}'), (f->'every'->>'n')::int, f->'every'->>'unit', f->'items',
      case when jsonb_typeof(f->'route') = 'object' then f->'route' end, f->>'reason'
    from sites s where s.id = p_site;
  end if;
end $$;

create or replace function app_save_inspection(p_site uuid, i jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update inspections set status = i->>'status', defects = coalesce(i->'defects', '[]'), sign_off_note = i->>'signOffNote', void_reason = i->>'voidReason'
  where id = (i->>'id')::uuid and site_id = p_site;
  if not found then
    insert into inspections (id, tenant_id, site_id, form_id, form_version, unit_id, round_id, smu, status, answers, defects, score, result, started_at)
    select (i->>'id')::uuid, s.tenant_id, p_site, (i->>'formId')::uuid, (i->>'formVersion')::int, (i->>'unitId')::uuid, (i->>'roundId')::uuid, (i->>'smu')::numeric,
      'submitted', i->'answers', coalesce(i->'defects', '[]'), (i->>'score')::numeric, i->>'result', (i->>'startedAt')::timestamptz
    from sites s where s.id = p_site;
  end if;
end $$;

-- A submitted round and its stop inspections together, or a void of the round and its inspections.
create or replace function app_save_round(p_site uuid, r jsonb, p_inspections jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare x jsonb;
begin
  if r->>'status' = 'voided' then
    update rounds set status = 'voided', void_reason = r->>'voidReason' where id = (r->>'id')::uuid and site_id = p_site and status = 'submitted';
    if not found then raise exception 'That round is not waiting to be voided.' using errcode = 'no_data_found'; end if;
    update inspections set status = 'voided', void_reason = r->>'voidReason' where round_id = (r->>'id')::uuid and site_id = p_site and status <> 'voided';
    return;
  end if;
  if exists (select 1 from rounds where id = (r->>'id')::uuid) then return; end if;
  insert into rounds (id, tenant_id, site_id, form_id, form_version, node_id, skipped, started_at)
  select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'formId')::uuid, (r->>'formVersion')::int, (r->>'nodeId')::uuid, coalesce(r->'skipped', '[]'), (r->>'startedAt')::timestamptz
  from sites s where s.id = p_site;
  for x in select * from jsonb_array_elements(coalesce(p_inspections, '[]')) loop
    perform app_save_inspection(p_site, x || jsonb_build_object('roundId', r->>'id'));
  end loop;
end $$;

create or replace function app_load_inspections(p_site uuid, p_since timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'forms', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id, 'version', f.version, 'name', f.name, 'assetClass', f.asset_class,
      'models', to_jsonb(f.models), 'every', jsonb_build_object('n', f.every_n, 'unit', f.every_unit), 'items', f.items, 'route', f.route, 'reason', f.reason,
      'createdBy', f.created_by, 'createdAt', f.created_at, 'retiredAt', f.retired_at, 'retiredReason', f.retired_reason)) order by f.id, f.version)
      from inspection_forms f where f.site_id = p_site), '[]'),
    'inspections', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i.id, 'formId', i.form_id, 'formVersion', i.form_version,
      'unitId', i.unit_id, 'roundId', i.round_id, 'smu', i.smu, 'status', i.status, 'answers', i.answers, 'defects', i.defects, 'score', i.score, 'result', i.result,
      'startedBy', i.started_by, 'startedAt', i.started_at, 'submittedAt', i.submitted_at, 'signedOffBy', i.signed_off_by, 'signedOffAt', i.signed_off_at,
      'signOffNote', i.sign_off_note, 'voidedBy', i.voided_by, 'voidedAt', i.voided_at, 'voidReason', i.void_reason)) order by i.submitted_at)
      from inspections i where i.site_id = p_site and (i.submitted_at >= p_since or exists (
        select 1 from jsonb_array_elements(i.defects) d where d->>'status' = 'open'))), '[]'),
    'rounds', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', r.id, 'formId', r.form_id, 'formVersion', r.form_version, 'nodeId', r.node_id,
      'status', r.status, 'skipped', r.skipped, 'startedBy', r.started_by, 'startedAt', r.started_at, 'submittedAt', r.submitted_at,
      'voidedBy', r.voided_by, 'voidedAt', r.voided_at, 'voidReason', r.void_reason)) order by r.started_at)
      from rounds r where r.site_id = p_site and r.started_at >= p_since), '[]'));
$$;

-- A new shutdown, or a later step on one (plan change, start, end, cancel). The guard allows only the steps in order.
create or replace function app_save_shutdown(p_site uuid, s jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare v_ids uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(s->'equipmentIds') x), '{}');
        v_flags uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(s->'flagIds') x), '{}');
begin
  insert into shutdowns (id, tenant_id, site_id, node_id, name, work_order, planned_start, planned_end, freeze_at, equipment_ids)
  select (s->>'id')::uuid, t.tenant_id, p_site, (s->>'nodeId')::uuid, s->>'name', s->>'workOrder', (s->>'plannedStart')::timestamptz,
    (s->>'plannedEnd')::timestamptz, (s->>'freezeAt')::timestamptz, v_ids
  from sites t where t.id = p_site
  on conflict (id) do update set name = excluded.name, work_order = excluded.work_order, planned_start = excluded.planned_start,
    planned_end = excluded.planned_end, freeze_at = excluded.freeze_at, equipment_ids = excluded.equipment_ids,
    actual_start = (s->>'actualStart')::timestamptz, actual_end = (s->>'actualEnd')::timestamptz, flag_ids = v_flags,
    findings = nullif(trim(s->>'findings'), ''),
    cancelled_at = case when s->>'cancelledAt' is not null then now() end, cancel_reason = nullif(trim(s->>'cancelReason'), '')
  where shutdowns.site_id = p_site;
end $$;

-- New scope work orders, or removals (a row with removedReason).
create or replace function app_save_shutdown_scope(p_site uuid, p_shutdown uuid, rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare x jsonb;
begin
  for x in select * from jsonb_array_elements(rows) loop
    if nullif(trim(x->>'removedReason'), '') is not null then
      update shutdown_scope set removed_at = now(), removed_reason = trim(x->>'removedReason')
      where id = (x->>'id')::uuid and site_id = p_site and shutdown_id = p_shutdown and removed_at is null;
    else
      insert into shutdown_scope (id, tenant_id, site_id, shutdown_id, work_order, reason)
      select (x->>'id')::uuid, t.tenant_id, p_site, p_shutdown, x->>'workOrder', nullif(trim(x->>'reason'), '')
      from sites t where t.id = p_site
      on conflict (id) do nothing;
    end if;
  end loop;
end $$;

create or replace function app_load_shutdowns(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', s.id, 'tenantId', s.tenant_id, 'siteId', s.site_id, 'nodeId', s.node_id, 'name', s.name,
    'workOrder', s.work_order, 'plannedStart', s.planned_start, 'plannedEnd', s.planned_end, 'freezeAt', s.freeze_at, 'equipmentIds', to_jsonb(s.equipment_ids),
    'actualStart', s.actual_start, 'actualEnd', s.actual_end, 'flagIds', to_jsonb(s.flag_ids), 'findings', s.findings, 'createdBy', s.created_by, 'createdAt', s.created_at,
    'cancelledAt', s.cancelled_at, 'cancelledBy', s.cancelled_by, 'cancelReason', s.cancel_reason,
    'scope', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', c.id, 'workOrder', c.work_order, 'addedAt', c.added_at, 'addedBy', c.added_by,
      'late', c.late, 'reason', c.reason, 'removedAt', c.removed_at, 'removedBy', c.removed_by, 'removedReason', c.removed_reason)) order by c.added_at)
      from shutdown_scope c where c.shutdown_id = s.id), '[]'))) order by s.planned_start), '[]')
  from shutdowns s where s.site_id = p_site;
$$;

grant execute on function app_save_round, app_save_shutdown, app_save_shutdown_scope, app_load_shutdowns to authenticated;

notify pgrst, 'reload schema';
