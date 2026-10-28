-- App API for phase 1a: load a site in the app's own shapes, save what the
-- core commands produced, and let invited people join a site.
--
-- The web app runs every business rule in packages/core before it saves.
-- These functions run as the signed-in user (security invoker), so the
-- row-level security policies in the core schema are the backstop: a role
-- that may not write a table cannot, whatever the browser sends.

-- ---------- columns the app needs ----------

-- Intervals are append-only in the app; seq is their position, used to match on save.
alter table flag_stage_intervals add column seq int;
alter table flag_location_intervals add column seq int;
alter table flag_etas add column seq int;
alter table flag_reopen_gaps add column seq int;
create unique index flag_stage_seq on flag_stage_intervals (flag_id, seq);
create unique index flag_location_seq on flag_location_intervals (flag_id, seq);
create unique index flag_etas_seq on flag_etas (flag_id, seq);
create unique index flag_reopen_gaps_seq on flag_reopen_gaps (flag_id, seq);

alter table down_flags add column type_suggestion flag_type;

alter table work_orders
  add column number text,
  add column external_asset_id text,
  add column work_class text not null default 'other' check (work_class in ('pm', 'corrective', 'inspection', 'project', 'other')),
  add column is_open boolean not null default true;

alter table targets
  add column fleet_name text,
  add column reason text,
  add column set_at timestamptz not null default now();

alter table codes add column applies_to flag_type, add column retired_reason text;
alter table site_members add column name text, add column email text, add column retired_reason text;

-- Updates to these were not allowed before; the app needs them.
create policy smu_update on smu_readings for update using (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent', 'admin'));
create policy wo_write on work_orders for insert with check (site_role(site_id) = 'admin');
create policy wo_update on work_orders for update using (site_role(site_id) = 'admin');
create policy assets_write on assets for insert with check (site_role(site_id) = 'admin');
create policy assets_update on assets for update using (site_role(site_id) = 'admin');
create policy attrs_write on asset_attributes for insert with check (site_role(site_id) = 'admin');
create policy attrs_update on asset_attributes for update using (site_role(site_id) = 'admin');

-- ---------- invites: how a person gets access ----------
-- The Admin adds a person by email. When that person signs in, app_join()
-- turns the invite into a site membership. Only the signed-in email counts.

create table site_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  email text not null check (email = lower(email)),
  name text not null,
  role app_role not null,
  scope text[] not null default '{*}',
  accepted_at timestamptz,
  accepted_by uuid,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz,
  unique (site_id, email)
);
alter table site_invites enable row level security;
create policy site_invites_read on site_invites for select using (is_site_member(site_id));
create policy site_invites_admin on site_invites for all using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');
create trigger site_invites_updated before update on site_invites for each row execute function set_updated();
create trigger site_invites_no_delete before delete on site_invites for each row execute function refuse_delete();
create trigger site_invites_audit after insert or update on site_invites for each row execute function audit_row();

create or replace function app_join() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_uid uuid := auth.uid();
  n int := 0;
  i record;
begin
  if v_uid is null or v_email = '' then return 0; end if;
  for i in select * from site_invites where email = v_email and accepted_at is null and retired_at is null loop
    insert into site_members (tenant_id, site_id, user_id, role, scope, name, email, created_by)
    values (i.tenant_id, i.site_id, v_uid, i.role, i.scope, i.name, v_email, i.created_by)
    on conflict (site_id, user_id) do update set role = excluded.role, scope = excluded.scope, retired_at = null;
    update site_invites set accepted_at = now(), accepted_by = v_uid where id = i.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Sites the signed-in person belongs to, with their role there.
create or replace function app_my_sites() returns table (site_id uuid, site_name text, time_zone text, role app_role)
language sql stable security invoker set search_path = public as $$
  select s.id, s.name, s.time_zone, site_role(s.id)
  from sites s where is_site_member(s.id) and s.retired_at is null
  order by s.name;
$$;

-- ---------- load ----------

create or replace function app_load(p_site uuid, p_since timestamptz default now() - interval '400 days') returns jsonb
language sql stable security invoker set search_path = public as $$
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
        'release', nullif(jsonb_strip_nulls(jsonb_build_object('system', d.system, 'component', d.component, 'failureModes', to_jsonb(d.failure_modes),
          'repairSummary', d.repair_summary, 'findings', d.findings, 'causeCode', d.cause_code, 'detectionMethod', d.detection_method,
          'smuAtFailure', d.smu_at_failure, 'workOrder', (select min(w.work_order_number) from flag_work_orders w where w.flag_id = d.id))), '{}'::jsonb),
        'falseRelease', nullif(d.false_release, false), 'voidReason', d.void_reason, 'restated', nullif(d.restated, false),
        'source', d.source, 'setBy', d.set_by, 'enteredAt', d.entered_at, 'releasedBy', d.released_by, 'notes', d.notes,
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
$$;

-- ---------- save ----------

-- Flags as the core commands return them. Rows are matched by id (flags) and
-- by position (intervals, which the app only ever appends to or closes).
create or replace function app_save_flags(p_site uuid, p_flags jsonb) returns void
language plpgsql security invoker set search_path = public as $$
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
      cause_code, detection_method, smu_at_failure, false_release, void_reason, restated, source, set_by, entered_at, released_by, notes)
    values ((f->>'id')::uuid, v_tenant, p_site, (f->>'unitId')::uuid, (f->>'type')::flag_type, (f->>'state')::flag_state, f->>'reasonCode',
      coalesce(f->'release'->>'system', f->>'system'), (f->>'start')::timestamptz, (f->>'end')::timestamptz,
      (f->>'linkedFromFlagId')::uuid, f->>'linkKind', (f->>'plannedDurationHours')::numeric, (f->>'typeSuggestion')::flag_type,
      f->'release'->>'component', (select array_agg(m) from jsonb_array_elements_text(coalesce(f->'release'->'failureModes', '[]')) m),
      f->'release'->>'repairSummary', f->'release'->>'findings', f->'release'->>'causeCode', (f->'release'->>'detectionMethod')::detection_method,
      (f->'release'->>'smuAtFailure')::numeric, coalesce((f->>'falseRelease')::boolean, false), f->>'voidReason', coalesce((f->>'restated')::boolean, false),
      coalesce(f->>'source', 'app')::flag_source, auth.uid(), coalesce((f->>'enteredAt')::timestamptz, now()),
      case when f->>'state' = 'released' then auth.uid() end, f->>'notes')
    on conflict (id) do update set
      flag_type = excluded.flag_type, state = excluded.state, reason_code = excluded.reason_code, system = excluded.system,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, linked_from_flag_id = excluded.linked_from_flag_id, link_kind = excluded.link_kind,
      planned_duration_hours = excluded.planned_duration_hours, type_suggestion = excluded.type_suggestion,
      component = excluded.component, failure_modes = excluded.failure_modes, repair_summary = excluded.repair_summary, findings = excluded.findings,
      cause_code = excluded.cause_code, detection_method = excluded.detection_method, smu_at_failure = excluded.smu_at_failure,
      false_release = excluded.false_release, void_reason = excluded.void_reason, restated = excluded.restated, notes = excluded.notes,
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
end $$;

-- The command's own audit entries (reason, back-dated time), on top of the
-- row-level trigger log. user_id is always the signed-in user.
create or replace function app_log(p_site uuid, p_entries jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if not is_site_member(p_site) then raise exception 'Not a member of this site'; end if;
  v_tenant := (select tenant_id from sites where id = p_site);
  insert into audit_log (tenant_id, site_id, at, user_id, action, entity, entity_id, before, after, reason, effective_at, offline)
  select v_tenant, p_site, now(), auth.uid(), e->>'action', e->>'entity',
    case when (e->>'entityId') ~* '^[0-9a-f-]{36}$' then (e->>'entityId')::uuid end,
    e->'before', e->'after', e->>'reason', (e->>'effectiveAt')::timestamptz, coalesce((e->>'offline')::boolean, false)
  from jsonb_array_elements(p_entries) e;
end $$;

create or replace function app_save_smu(p_site uuid, p_rows jsonb) returns int
language sql security invoker set search_path = public as $$
  with ins as (
    insert into smu_readings (tenant_id, site_id, asset_id, read_at, hours, source, created_by)
    select s.tenant_id, p_site, (r->>'unitId')::uuid, (r->>'at')::timestamptz, (r->>'hours')::numeric, coalesce(r->>'source', 'upload'), auth.uid()
    from jsonb_array_elements(p_rows) r, sites s where s.id = p_site
    on conflict (asset_id, read_at, source) do nothing
    returning 1)
  select count(*)::int from ins;
$$;

create or replace function app_save_work_orders(p_site uuid, p_rows jsonb) returns int
language sql security invoker set search_path = public as $$
  with up as (
    insert into work_orders (id, tenant_id, site_id, asset_id, source_system, source_id, number, number_normalised, external_asset_id, wo_type,
      work_class, status, is_open, priority, description, reported_at, completed_at, source_modified_at, created_by)
    select (w->>'id')::uuid, s.tenant_id, p_site, (w->>'assetId')::uuid, w->>'sourceSystem', w->>'sourceId', w->>'number', w->>'numberNormalised',
      w->>'externalAssetId', w->>'woType', coalesce(w->>'workClass', 'other'), w->>'status', coalesce((w->>'open')::boolean, true), w->>'priority',
      w->>'description', (w->>'reportedAt')::timestamptz, (w->>'completedAt')::timestamptz, (w->>'sourceModifiedAt')::timestamptz, auth.uid()
    from jsonb_array_elements(p_rows) w, sites s where s.id = p_site
    on conflict (site_id, source_system, source_id) do update set asset_id = excluded.asset_id, number = excluded.number,
      number_normalised = excluded.number_normalised, external_asset_id = excluded.external_asset_id, wo_type = excluded.wo_type,
      work_class = excluded.work_class, status = excluded.status, is_open = excluded.is_open, priority = excluded.priority,
      description = excluded.description, reported_at = excluded.reported_at, completed_at = excluded.completed_at,
      source_modified_at = excluded.source_modified_at
    returning 1)
  select count(*)::int from up;
$$;

create or replace function app_save_assets(p_site uuid, p_rows jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare
  a jsonb;
  v_tenant uuid := (select tenant_id from sites where id = p_site);
  v_fleet uuid;
  n int := 0;
begin
  for a in select e from jsonb_array_elements(p_rows) e loop
    insert into assets (id, tenant_id, site_id, unit_number, asset_class, serial, external_asset_id, functional_location, source_system, created_by)
    values ((a->>'id')::uuid, v_tenant, p_site, a->>'unitNumber', coalesce(a->>'assetClass', 'mobile')::asset_class, a->>'serial',
      a->>'externalAssetId', a->>'functionalLocation', 'maximo', auth.uid())
    on conflict (id) do update set unit_number = excluded.unit_number, serial = excluded.serial,
      external_asset_id = excluded.external_asset_id, functional_location = excluded.functional_location;
    insert into fleets (tenant_id, site_id, name) values (v_tenant, p_site, coalesce(a->>'fleet', 'Unassigned'))
    on conflict (site_id, name) do nothing;
    v_fleet := (select id from fleets where site_id = p_site and name = coalesce(a->>'fleet', 'Unassigned'));
    -- A change of fleet or model is a new effective-dated row, so history keeps the old one.
    if not exists (select 1 from asset_attributes t where t.asset_id = (a->>'id')::uuid and t.effective_to is null
                   and t.fleet_id = v_fleet and t.model is not distinct from a->>'model') then
      update asset_attributes set effective_to = now() where asset_id = (a->>'id')::uuid and effective_to is null;
      insert into asset_attributes (tenant_id, site_id, asset_id, fleet_id, model, effective_from, created_by)
      values (v_tenant, p_site, (a->>'id')::uuid, v_fleet, a->>'model', now(), auth.uid());
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function app_save_target(p_site uuid, t jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into targets (id, tenant_id, site_id, kpi, fleet_name, model, target, amber, effective_from, reason, set_at, created_by)
  select (t->>'id')::uuid, s.tenant_id, p_site, t->>'kpi', t->>'fleet', t->>'model', (t->>'value')::numeric, (t->>'amber')::numeric,
    (t->>'effectiveFrom')::timestamptz, t->>'reason', now(), auth.uid()
  from sites s where s.id = p_site;
$$;

create or replace function app_save_codes(p_site uuid, p_rows jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into codes (id, tenant_id, site_id, list, code, label, applies_to, external_code, retired_at, retired_reason, created_by)
  select (c->>'id')::uuid, s.tenant_id, p_site, 'reason', c->>'code', c->>'label', (c->>'appliesTo')::flag_type, c->>'externalCode',
    (c->>'retiredAt')::timestamptz, c->>'retiredReason', auth.uid()
  from jsonb_array_elements(p_rows) c, sites s where s.id = p_site
  on conflict (id) do update set label = excluded.label, applies_to = excluded.applies_to, external_code = excluded.external_code,
    retired_at = excluded.retired_at, retired_reason = excluded.retired_reason;
$$;

-- Users: active members are updated in place (role, scope, removal); new people are invites.
create or replace function app_save_users(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare u jsonb; v_tenant uuid := (select tenant_id from sites where id = p_site);
begin
  for u in select e from jsonb_array_elements(p_rows) e loop
    if exists (select 1 from site_members m where m.site_id = p_site and m.user_id = (u->>'id')::uuid) then
      update site_members set role = (u->>'role')::app_role, scope = (select array_agg(x) from jsonb_array_elements_text(u->'scope') x),
        name = u->>'name', email = lower(u->>'email'), retired_at = (u->>'retiredAt')::timestamptz, retired_reason = u->>'retiredReason'
      where site_id = p_site and user_id = (u->>'id')::uuid;
    else
      insert into site_invites (id, tenant_id, site_id, email, name, role, scope, retired_at, created_by)
      values ((u->>'id')::uuid, v_tenant, p_site, lower(u->>'email'), u->>'name', (u->>'role')::app_role,
        (select array_agg(x) from jsonb_array_elements_text(u->'scope') x), (u->>'retiredAt')::timestamptz, auth.uid())
      on conflict (id) do update set role = excluded.role, scope = excluded.scope, name = excluded.name, retired_at = excluded.retired_at;
    end if;
  end loop;
end $$;

grant execute on function app_join, app_my_sites, app_load, app_save_flags, app_log, app_save_smu, app_save_work_orders,
  app_save_assets, app_save_target, app_save_codes, app_save_users to authenticated;
