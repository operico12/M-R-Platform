-- Unit screen (docs/unit-screen.md): repair notes and comments, technicians assigned to a down unit,
-- the major component, and marking a stop for investigation. Nothing is deleted (rule 5), every change
-- is audited, assignment durations are calculated (rule 4). Every role test accepts admin_full (SQL 28).

-- ---------- down flags: major component and investigation ----------

alter table down_flags add column major_component text check (major_component is null or length(major_component) <= 200);
-- {at, by, reason, clearedAt?, clearedBy?, clearReason?}. Written only by app_flag_investigation.
alter table down_flags add column investigation jsonb;

create or replace function flag_investigation_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if coalesce(current_setting('app.flag_investigation', true), '') = 'on' then return new; end if;
  if tg_op = 'INSERT' and new.investigation is not null then
    raise exception 'A stop is marked for investigation after it is saved.' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.investigation is distinct from old.investigation then
    raise exception 'Mark or clear an investigation from the unit screen.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger down_flags_investigation before insert or update on down_flags for each row execute function flag_investigation_guard();

-- Repair details while the stop is open: anyone who may update the stage (update_stage), which a
-- technician may do but cannot update a down flag directly, so this function writes only these fields.
create or replace function app_flag_details(p_site uuid, p_flag uuid, p_details jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare f down_flags;
begin
  if not (admin_full(p_site) or site_role(p_site) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent')) then
    raise exception 'Your role cannot change the repair details.' using errcode = 'insufficient_privilege';
  end if;
  select * into f from down_flags where id = p_flag and site_id = p_site;
  if f.id is null then raise exception 'Stop not found.' using errcode = 'no_data_found'; end if;
  if f.state <> 'open' then raise exception 'Repair details are set on an open stop.' using errcode = 'check_violation'; end if;
  update down_flags set
    system = coalesce(nullif(trim(p_details->>'system'), ''), system),
    major_component = nullif(trim(p_details->>'majorComponent'), ''),
    component = nullif(trim(p_details->>'component'), ''),
    failure_modes = (select array_agg(trim(m)) from jsonb_array_elements_text(coalesce(p_details->'failureModes', '[]')) m where trim(m) <> ''),
    findings = nullif(trim(p_details->>'findings'), '')
  where id = p_flag;
end $$;

-- Mark (p_clear false) or clear (p_clear true) an investigation, with a reason: supervisor,
-- reliability engineer or superintendent (mark_investigation). Who and when come from the session.
create or replace function app_flag_investigation(p_site uuid, p_flag uuid, p_reason text, p_clear boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare f down_flags;
begin
  if not (admin_full(p_site) or site_role(p_site) in ('supervisor', 'reliability_engineer', 'superintendent')) then
    raise exception 'Your role cannot mark stops for investigation.' using errcode = 'insufficient_privilege';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  select * into f from down_flags where id = p_flag and site_id = p_site;
  if f.id is null then raise exception 'Stop not found.' using errcode = 'no_data_found'; end if;
  perform set_config('app.flag_investigation', 'on', true);
  if not p_clear then
    if f.state not in ('open', 'released') then raise exception 'Only an open or released stop can be marked.' using errcode = 'check_violation'; end if;
    if f.investigation is not null and f.investigation->>'clearedAt' is null then
      raise exception 'This stop is already marked for investigation.' using errcode = 'check_violation';
    end if;
    update down_flags set investigation = jsonb_build_object('at', now(), 'by', auth.uid(), 'reason', left(trim(p_reason), 500)) where id = p_flag;
  else
    if f.investigation is null or f.investigation->>'clearedAt' is not null then
      raise exception 'This stop is not marked for investigation.' using errcode = 'check_violation';
    end if;
    update down_flags set investigation = f.investigation || jsonb_build_object('clearedAt', now(), 'clearedBy', auth.uid(), 'clearReason', left(trim(p_reason), 500))
    where id = p_flag;
  end if;
  perform set_config('app.flag_investigation', '', true);
end $$;

-- ---------- unit notes ----------

create table unit_notes (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  down_flag_id uuid references down_flags(id) on delete restrict,
  kind text not null check (kind in ('repair', 'comment')),
  body text not null check (length(trim(body)) between 1 and 2000),
  written_by uuid not null default auth.uid(),
  written_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  check ((voided_at is null) = (void_reason is null)),
  check (void_reason is null or length(trim(void_reason)) between 1 and 300)
);
create index unit_notes_unit on unit_notes (site_id, asset_id, written_at);

-- Insert: the writer and the time are the session's; the stop, if given, is on the same unit.
-- Update: only voiding once, with a reason, by the writer or a superintendent.
create or replace function unit_note_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    if (select site_id from assets where id = new.asset_id) is distinct from new.site_id then
      raise exception 'That unit is not at this site.' using errcode = 'check_violation';
    end if;
    if new.down_flag_id is not null and not exists (select 1 from down_flags d where d.id = new.down_flag_id and d.asset_id = new.asset_id) then
      raise exception 'The note''s stop is not on this unit.' using errcode = 'check_violation';
    end if;
    new.written_by := auth.uid(); new.written_at := now();
    new.voided_at := null; new.voided_by := null; new.void_reason := null;
    return new;
  end if;
  if old.voided_at is not null then raise exception 'This note is voided.' using errcode = 'insufficient_privilege'; end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'A note cannot be changed. Void it and write it again.' using errcode = 'insufficient_privilege';
  end if;
  if not (old.written_by = auth.uid() or admin_full(old.site_id) or site_role(old.site_id) = 'superintendent') then
    raise exception 'Only the writer, or a superintendent, voids a note.' using errcode = 'insufficient_privilege';
  end if;
  new.voided_at := now(); new.voided_by := auth.uid();
  return new;
end $$;
create trigger unit_notes_guard before insert or update on unit_notes for each row execute function unit_note_guard();
create trigger unit_notes_no_delete before delete on unit_notes for each row execute function refuse_delete();
create trigger unit_notes_audit after insert or update on unit_notes for each row execute function audit_row();

alter table unit_notes enable row level security;
create policy unit_notes_read on unit_notes for select using (site_id in (select my_site_ids()));
-- add_notes: technician, supervisor, reliability engineer, superintendent.
create policy unit_notes_insert on unit_notes for insert
  with check (admin_full(site_id) or site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
create policy unit_notes_update on unit_notes for update
  using (admin_full(site_id) or site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'))
  with check (admin_full(site_id) or site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
grant select, insert, update on unit_notes to authenticated;

-- ---------- technicians assigned to a down unit ----------

create table flag_assignments (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  down_flag_id uuid not null references down_flags(id) on delete restrict,
  user_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  state text not null default 'open' check (state in ('open', 'ended', 'voided')),
  set_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now(),
  ended_by uuid,
  voided_at timestamptz,
  void_reason text,
  check (ends_at is null or ends_at >= starts_at),
  check ((state = 'open') = (ends_at is null) or state = 'voided'),
  check ((state = 'voided') = (void_reason is not null))
);
create index flag_assignments_site on flag_assignments (site_id, starts_at);
create unique index flag_assignments_one_open on flag_assignments (asset_id, user_id) where state = 'open';

create or replace function flag_assignment_guard() returns trigger
language plpgsql set search_path = public as $$
declare f down_flags;
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    select * into f from down_flags where id = new.down_flag_id;
    if f.id is null or f.asset_id <> new.asset_id or f.site_id <> new.site_id or f.tenant_id <> new.tenant_id or f.state <> 'open' then
      raise exception 'People are assigned to a unit with an open down flag.' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from site_members m where m.site_id = new.site_id and m.user_id = new.user_id and m.retired_at is null
                   and (m.access_until is null or m.access_until > now())) then
      raise exception 'That person is not on this site.' using errcode = 'check_violation';
    end if;
    new.starts_at := now(); new.ends_at := null; new.state := 'open';
    new.set_by := auth.uid(); new.entered_at := now();
    new.ended_by := null; new.voided_at := null; new.void_reason := null;
    return new;
  end if;
  if old.state <> 'open' then raise exception 'This assignment has already ended.' using errcode = 'insufficient_privilege'; end if;
  if (to_jsonb(new) - array['ends_at', 'state', 'ended_by', 'voided_at', 'void_reason'])
     is distinct from (to_jsonb(old) - array['ends_at', 'state', 'ended_by', 'voided_at', 'void_reason']) then
    raise exception 'An assignment cannot be changed. End it or void it.' using errcode = 'insufficient_privilege';
  end if;
  if new.state = 'open' then raise exception 'End or void the assignment.' using errcode = 'check_violation'; end if;
  if new.ends_at > now() + interval '5 minutes' then raise exception 'The end cannot be in the future.' using errcode = 'check_violation'; end if;
  if new.state = 'ended' then new.ended_by := auth.uid(); end if;
  if new.state = 'voided' then new.voided_at := now(); end if;
  return new;
end $$;
create trigger flag_assignments_guard before insert or update on flag_assignments for each row execute function flag_assignment_guard();
create trigger flag_assignments_no_delete before delete on flag_assignments for each row execute function refuse_delete();
create trigger flag_assignments_audit after insert or update on flag_assignments for each row execute function audit_row();

alter table flag_assignments enable row level security;
create policy flag_assignments_read on flag_assignments for select using (site_id in (select my_site_ids()));
-- assign_technicians: supervisor in their area (checked in the app, as for flags), reliability engineer, superintendent.
create policy flag_assignments_insert on flag_assignments for insert
  with check (admin_full(site_id) or site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy flag_assignments_update on flag_assignments for update
  using (admin_full(site_id) or site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'))
  with check (admin_full(site_id) or site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
grant select, insert, update on flag_assignments to authenticated;

-- ---------- save and load ----------

create or replace function app_save_notes(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select e from jsonb_array_elements(p_rows) e loop
    insert into unit_notes (id, tenant_id, site_id, asset_id, down_flag_id, kind, body, void_reason)
    select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'unitId')::uuid, (r->>'downFlagId')::uuid, r->>'kind', r->>'text', null
    from sites s where s.id = p_site
    on conflict (id) do update set void_reason = nullif(trim(r->>'voidReason'), ''),
      voided_at = case when nullif(trim(r->>'voidReason'), '') is not null then now() end
    where unit_notes.site_id = p_site and unit_notes.voided_at is null and nullif(trim(r->>'voidReason'), '') is not null;
  end loop;
end $$;

create or replace function app_load_notes(p_site uuid, p_since timestamptz default now() - interval '400 days') returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', n.id, 'tenantId', n.tenant_id, 'siteId', n.site_id, 'unitId', n.asset_id, 'downFlagId', n.down_flag_id, 'kind', n.kind,
    'text', n.body, 'by', n.written_by, 'at', n.written_at, 'voidedBy', n.voided_by, 'voidedAt', n.voided_at, 'voidReason', n.void_reason
  )) order by n.written_at), '[]')
  from unit_notes n where n.site_id = p_site and n.written_at >= p_since;
$$;

create or replace function app_save_assignments(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select e from jsonb_array_elements(p_rows) e loop
    insert into flag_assignments (id, tenant_id, site_id, asset_id, down_flag_id, user_id, starts_at, ends_at, state, void_reason)
    select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'unitId')::uuid, (r->>'downFlagId')::uuid, (r->>'userId')::uuid, now(), null, 'open', null
    from sites s where s.id = p_site and r->>'state' = 'open'
    on conflict (id) do nothing;
    update flag_assignments set state = r->>'state', ends_at = case when r->>'state' = 'ended' then (r->>'end')::timestamptz else ends_at end,
      void_reason = nullif(trim(r->>'voidReason'), '')
    where id = (r->>'id')::uuid and site_id = p_site and state = 'open' and r->>'state' in ('ended', 'voided');
  end loop;
end $$;

create or replace function app_load_assignments(p_site uuid, p_since timestamptz default now() - interval '400 days') returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', a.id, 'tenantId', a.tenant_id, 'siteId', a.site_id, 'unitId', a.asset_id, 'downFlagId', a.down_flag_id, 'userId', a.user_id,
    'start', a.starts_at, 'end', a.ends_at, 'state', a.state, 'setBy', a.set_by, 'enteredAt', a.entered_at, 'endedBy', a.ended_by,
    'voidedAt', a.voided_at, 'voidReason', a.void_reason
  )) order by a.starts_at), '[]')
  from flag_assignments a where a.site_id = p_site and (a.ends_at is null or a.ends_at >= p_since);
$$;

revoke execute on function flag_investigation_guard, unit_note_guard, flag_assignment_guard, app_flag_details, app_flag_investigation,
  app_save_notes, app_load_notes, app_save_assignments, app_load_assignments from public, anon;
grant execute on function app_flag_details, app_flag_investigation, app_save_notes, app_load_notes, app_save_assignments, app_load_assignments to authenticated;

-- ---------- flag save and load carry the new fields ----------

CREATE OR REPLACE FUNCTION public.app_save_flags(p_site uuid, p_flags jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  f jsonb;
  x jsonb;
  k int;
  v_tenant uuid := (select tenant_id from sites where id = p_site);
begin
  if v_tenant is null then raise exception 'Unknown site'; end if;
  -- Closed flags first, so a type switch or reopen never trips "one open flag per unit".
  for f in select e from jsonb_array_elements(p_flags) e order by (e->>'state' = 'open'), (e->>'start')::timestamptz loop
    if (f->>'siteId')::uuid is distinct from p_site then raise exception 'Flag % is not for this site', f->>'id'; end if;
    insert into down_flags (id, tenant_id, site_id, asset_id, flag_type, state, reason_code, system, starts_at, ends_at,
      linked_from_flag_id, link_kind, planned_duration_hours, type_suggestion, component, failure_modes, repair_summary, findings,
      cause_code, detection_method, smu_at_failure, false_release, void_reason, restated, source, set_by, entered_at, released_by, notes, major_component)
    values ((f->>'id')::uuid, v_tenant, p_site, (f->>'unitId')::uuid, (f->>'type')::flag_type, (f->>'state')::flag_state, f->>'reasonCode',
      coalesce(f->'release'->>'system', f->>'system'), (f->>'start')::timestamptz, (f->>'end')::timestamptz,
      (f->>'linkedFromFlagId')::uuid, f->>'linkKind', (f->>'plannedDurationHours')::numeric, (f->>'typeSuggestion')::flag_type,
      f->'release'->>'component', (select array_agg(m) from jsonb_array_elements_text(coalesce(f->'release'->'failureModes', '[]')) m),
      f->'release'->>'repairSummary', f->'release'->>'findings', f->'release'->>'causeCode', (f->'release'->>'detectionMethod')::detection_method,
      (f->'release'->>'smuAtFailure')::numeric, coalesce((f->>'falseRelease')::boolean, false), f->>'voidReason', coalesce((f->>'restated')::boolean, false),
      coalesce(f->>'source', 'app')::flag_source, auth.uid(), coalesce((f->>'enteredAt')::timestamptz, now()),
      case when f->>'state' = 'released' then auth.uid() end, f->>'notes', nullif(trim(f->'release'->>'majorComponent'), ''))
    on conflict (id) do update set
      flag_type = excluded.flag_type, state = excluded.state, reason_code = excluded.reason_code, system = excluded.system,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, linked_from_flag_id = excluded.linked_from_flag_id, link_kind = excluded.link_kind,
      planned_duration_hours = excluded.planned_duration_hours, type_suggestion = excluded.type_suggestion,
      component = excluded.component, failure_modes = excluded.failure_modes, repair_summary = excluded.repair_summary, findings = excluded.findings,
      cause_code = excluded.cause_code, detection_method = excluded.detection_method, smu_at_failure = excluded.smu_at_failure,
      false_release = excluded.false_release, void_reason = excluded.void_reason, restated = excluded.restated, notes = excluded.notes,
      major_component = excluded.major_component,
      released_by = coalesce(down_flags.released_by, excluded.released_by);

    k := 0;
    for x in select e from jsonb_array_elements(coalesce(f->'stages', '[]')) e loop
      insert into flag_stage_intervals (tenant_id, site_id, flag_id, seq, stage, starts_at, ends_at, reason, part_or_work_order, set_by, entered_at)
      values (v_tenant, p_site, (f->>'id')::uuid, k, (x->>'stage')::repair_stage, (x->>'start')::timestamptz, (x->>'end')::timestamptz,
        x->>'reason', x->>'partOrWorkOrder', auth.uid(), coalesce((x->>'enteredAt')::timestamptz, now()))
      on conflict (flag_id, seq) do update set stage = excluded.stage, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        reason = excluded.reason, part_or_work_order = excluded.part_or_work_order
      where (flag_stage_intervals.stage, flag_stage_intervals.starts_at, flag_stage_intervals.ends_at, flag_stage_intervals.reason, flag_stage_intervals.part_or_work_order)
        is distinct from (excluded.stage, excluded.starts_at, excluded.ends_at, excluded.reason, excluded.part_or_work_order);
      k := k + 1;
    end loop;

    k := 0;
    for x in select e from jsonb_array_elements(coalesce(f->'locations', '[]')) e loop
      insert into flag_location_intervals (tenant_id, site_id, flag_id, seq, kind, shop_line_id, field_location, functional_location, reason, starts_at, ends_at, set_by, entered_at)
      values (v_tenant, p_site, (f->>'id')::uuid, k, (x->>'kind')::location_kind, (x->>'shopLineId')::uuid, x->>'fieldLocation', x->>'functionalLocation',
        x->>'reason', (x->>'start')::timestamptz, (x->>'end')::timestamptz, auth.uid(), coalesce((x->>'enteredAt')::timestamptz, now()))
      on conflict (flag_id, seq) do update set kind = excluded.kind, shop_line_id = excluded.shop_line_id, field_location = excluded.field_location,
        functional_location = excluded.functional_location, reason = excluded.reason, starts_at = excluded.starts_at, ends_at = excluded.ends_at
      where (flag_location_intervals.kind, flag_location_intervals.shop_line_id, flag_location_intervals.field_location, flag_location_intervals.starts_at, flag_location_intervals.ends_at, flag_location_intervals.reason)
        is distinct from (excluded.kind, excluded.shop_line_id, excluded.field_location, excluded.starts_at, excluded.ends_at, excluded.reason);
      k := k + 1;
    end loop;

    k := 0;
    for x in select e from jsonb_array_elements(coalesce(f->'etas', '[]')) e loop
      insert into flag_etas (tenant_id, site_id, flag_id, seq, eta, set_at, set_by)
      values (v_tenant, p_site, (f->>'id')::uuid, k, (x->>'eta')::timestamptz, (x->>'setAt')::timestamptz, auth.uid())
      on conflict (flag_id, seq) do nothing;
      k := k + 1;
    end loop;

    k := 0;
    for x in select e from jsonb_array_elements(coalesce(f->'reopenGaps', '[]')) e loop
      insert into flag_reopen_gaps (tenant_id, site_id, flag_id, seq, starts_at, ends_at, counts_as)
      values (v_tenant, p_site, (f->>'id')::uuid, k, (x->>'start')::timestamptz, (x->>'end')::timestamptz, x->>'countsAs')
      on conflict (flag_id, seq) do nothing;
      k := k + 1;
    end loop;

    insert into flag_work_orders (flag_id, work_order_number, tenant_id, site_id)
    select (f->>'id')::uuid, w, v_tenant, p_site from jsonb_array_elements_text(coalesce(f->'workOrders', '[]')) w
    on conflict do nothing;
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.app_load(p_site uuid, p_since timestamp with time zone DEFAULT (now() - '400 days'::interval))
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'site', (select jsonb_build_object('id', s.id, 'tenantId', s.tenant_id, 'name', s.name, 'timeZone', s.time_zone) from sites s where s.id = p_site),
    'role', site_role(p_site),
    'me', auth.uid(),
    'calendar', (select jsonb_build_object('shifts', c.shifts, 'rotation', c.rotation) from shift_calendars c
                 where c.site_id = p_site and c.effective_from <= now() and (c.effective_to is null or c.effective_to > now())
                 order by c.effective_from desc limit 1),
    'rules', (select r.rules from flag_rules r where r.site_id = p_site and r.effective_from <= now() order by r.effective_from desc limit 1),
    'assets', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', a.id, 'tenantId', a.tenant_id, 'siteId', a.site_id, 'unitNumber', a.unit_number,
        'fleet', coalesce(f.name, 'Unassigned'), 'model', coalesce(at.model, 'Unknown'), 'assetClass', a.asset_class,
        'serial', a.serial, 'externalAssetId', a.external_asset_id, 'functionalLocation', a.functional_location)) order by a.unit_number)
      from assets a
      left join asset_attributes at on at.asset_id = a.id and at.effective_from <= now() and (at.effective_to is null or at.effective_to > now())
      left join fleets f on f.id = at.fleet_id
      where a.site_id = p_site and a.retired_at is null), '[]'),
    'lifecycle', coalesce((
      select jsonb_agg(jsonb_build_object('assetId', at.asset_id, 'status', at.lifecycle, 'start', at.effective_from, 'end', at.effective_to))
      from asset_attributes at where at.site_id = p_site), '[]'),
    'shopLines', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', l.id, 'siteId', l.site_id, 'shop', sh.name, 'number', l.number, 'name', l.name,
        'lineType', l.line_type, 'capacity', l.capacity, 'fits', to_jsonb(l.fits))) order by l.sort_order, l.number)
      from shop_lines l join shops sh on sh.id = l.shop_id where l.site_id = p_site and l.retired_at is null), '[]'),
    'closures', coalesce((
      select jsonb_agg(jsonb_build_object('lineId', c.shop_line_id, 'start', c.starts_at, 'end', c.ends_at, 'reason', c.reason))
      from shop_line_closures c where c.site_id = p_site), '[]'),
    'fieldLocations', coalesce((select jsonb_agg(fl.name order by fl.name) from field_locations fl where fl.site_id = p_site and fl.retired_at is null), '[]'),
    'flags', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'id', d.id, 'tenantId', d.tenant_id, 'siteId', d.site_id, 'unitId', d.asset_id, 'type', d.flag_type, 'state', d.state,
        'reasonCode', d.reason_code, 'system', d.system, 'start', d.starts_at, 'end', d.ends_at,
        'linkedFromFlagId', d.linked_from_flag_id, 'linkKind', d.link_kind, 'plannedDurationHours', d.planned_duration_hours,
        'typeSuggestion', d.type_suggestion,
        'release', nullif(jsonb_strip_nulls(jsonb_build_object('system', d.system, 'majorComponent', d.major_component, 'component', d.component, 'failureModes', to_jsonb(d.failure_modes),
          'repairSummary', d.repair_summary, 'findings', d.findings, 'causeCode', d.cause_code, 'detectionMethod', d.detection_method,
          'smuAtFailure', d.smu_at_failure, 'workOrder', (select min(w.work_order_number) from flag_work_orders w where w.flag_id = d.id))), '{}'::jsonb),
        'falseRelease', nullif(d.false_release, false), 'voidReason', d.void_reason, 'restated', nullif(d.restated, false),
        'source', d.source, 'setBy', d.set_by, 'enteredAt', d.entered_at, 'releasedBy', d.released_by, 'notes', d.notes, 'investigation', d.investigation,
        'stages', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('stage', x.stage, 'start', x.starts_at, 'end', x.ends_at,
          'reason', x.reason, 'partOrWorkOrder', x.part_or_work_order, 'setBy', x.set_by, 'enteredAt', x.entered_at)) order by x.seq)
          from flag_stage_intervals x where x.flag_id = d.id), '[]'),
        'locations', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('kind', x.kind, 'start', x.starts_at, 'end', x.ends_at,
          'shopLineId', x.shop_line_id, 'fieldLocation', x.field_location, 'functionalLocation', x.functional_location, 'reason', x.reason,
          'setBy', x.set_by, 'enteredAt', x.entered_at)) order by x.seq)
          from flag_location_intervals x where x.flag_id = d.id), '[]'),
        'etas', coalesce((select jsonb_agg(jsonb_build_object('eta', x.eta, 'setAt', x.set_at, 'setBy', x.set_by) order by x.seq)
          from flag_etas x where x.flag_id = d.id), '[]'),
        'reopenGaps', (select jsonb_agg(jsonb_build_object('start', x.starts_at, 'end', x.ends_at, 'countsAs', x.counts_as) order by x.seq)
          from flag_reopen_gaps x where x.flag_id = d.id),
        'workOrders', coalesce((select jsonb_agg(w.work_order_number order by w.created_at) from flag_work_orders w where w.flag_id = d.id), '[]')
      )) order by d.starts_at)
      from down_flags d where d.site_id = p_site and (d.ends_at is null or d.ends_at >= p_since)), '[]'),
    'smu', coalesce((
      select jsonb_agg(jsonb_build_object('unitId', r.asset_id, 'at', r.read_at, 'hours', r.hours) order by r.read_at)
      from smu_readings r where r.site_id = p_site and r.voided_at is null and r.read_at >= p_since), '[]'),
    'workOrders', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', w.id, 'tenantId', w.tenant_id, 'siteId', w.site_id, 'assetId', w.asset_id,
        'sourceSystem', w.source_system, 'sourceId', w.source_id, 'number', coalesce(w.number, w.source_id), 'numberNormalised', w.number_normalised,
        'externalAssetId', w.external_asset_id, 'woType', w.wo_type, 'workClass', w.work_class, 'status', w.status, 'open', w.is_open,
        'priority', w.priority, 'description', w.description, 'reportedAt', w.reported_at, 'completedAt', w.completed_at,
        'sourceModifiedAt', w.source_modified_at)) order by w.reported_at)
      from work_orders w where w.site_id = p_site and (w.is_open or w.completed_at >= p_since)), '[]'),
    'codes', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', c.id, 'code', c.code, 'label', c.label, 'appliesTo', c.applies_to,
        'externalCode', c.external_code, 'retiredAt', c.retired_at, 'retiredReason', c.retired_reason)) order by c.code)
      from codes c where c.site_id = p_site and c.list = 'reason'), '[]'),
    'targets', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', t.id, 'kpi', t.kpi, 'fleet', t.fleet_name, 'model', t.model, 'value', t.target,
        'amber', coalesce(t.amber, 0), 'effectiveFrom', t.effective_from, 'setBy', t.created_by, 'setAt', t.set_at, 'reason', t.reason)))
      from targets t where t.site_id = p_site), '[]'),
    'users', coalesce((
      select jsonb_agg(u order by u->>'name') from (
        select jsonb_strip_nulls(jsonb_build_object('id', m.user_id, 'name', coalesce(m.name, m.email, 'Member'), 'email', coalesce(m.email, ''),
          'role', m.role, 'scope', to_jsonb(m.scope), 'addedAt', m.created_at, 'retiredAt', m.retired_at, 'retiredReason', m.retired_reason)) u
        from site_members m where m.site_id = p_site
        union all
        select jsonb_build_object('id', i.id, 'name', i.name, 'email', i.email, 'role', i.role, 'scope', to_jsonb(i.scope), 'addedAt', i.created_at, 'invited', true)
        from site_invites i where i.site_id = p_site and i.accepted_at is null and i.retired_at is null
      ) q), '[]')
  );
$function$;

notify pgrst, 'reload schema';
