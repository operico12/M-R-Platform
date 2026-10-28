-- Phase 3: component life and rebuilds (docs/component-life.md). A component
-- is tracked by serial through events that are entered once and never
-- edited; a mistake is put right by voiding the latest event with a reason.
-- Costs sit in their own table that only cost roles can read (plan 11.2).
-- The app runs the rules in packages/core/src/components.ts; these are the
-- backstop.

create table components (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  serial text not null check (length(trim(serial)) between 1 and 60),
  kind text not null check (kind in ('engine', 'transmission', 'torque_converter', 'differential', 'final_drive', 'front_strut', 'rear_strut')),
  part_number text,
  models text[] not null default '{}',
  hours_at_entry numeric not null default 0 check (hours_at_entry >= 0),
  rebuilds_at_entry int not null default 0 check (rebuilds_at_entry >= 0),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (site_id, kind, serial)
);

create table component_events (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  component_id uuid not null references components(id) on delete restrict,
  kind text not null check (kind in ('received', 'installed', 'removed', 'sent_rebuild', 'returned_rebuild', 'core_returned', 'warranty_claim', 'scrapped')),
  at timestamptz not null,
  unit_id uuid references assets(id) on delete restrict,
  position text check (position is null or position in ('engine', 'transmission', 'torque_converter', 'differential', 'final_drive_lh', 'final_drive_rh', 'front_strut_lh', 'front_strut_rh', 'rear_strut_lh', 'rear_strut_rh')),
  smu numeric check (smu is null or smu >= 0),
  reason text check (reason is null or reason in ('failure', 'planned', 'other')),
  flag_id uuid references down_flags(id) on delete restrict,
  work_order text,
  vendor text,
  reference text,
  received_as text check (received_as is null or received_as in ('new', 'exchange', 'used')),
  warranty_hours numeric check (warranty_hours is null or warranty_hours > 0),
  warranty_months int check (warranty_months is null or warranty_months between 1 and 120),
  core_due_by date,
  claim text check (claim is null or claim in ('opened', 'accepted', 'rejected')),
  note text,
  entered_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now(),
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  check (voided_at is null or length(trim(coalesce(void_reason, ''))) > 0),
  check (kind <> 'installed' or (unit_id is not null and position is not null and smu is not null)),
  check (kind <> 'removed' or (reason is not null and smu is not null)),
  check (kind <> 'sent_rebuild' or length(trim(coalesce(vendor, ''))) > 0),
  check (kind <> 'warranty_claim' or claim is not null),
  check (kind <> 'scrapped' or length(trim(coalesce(note, ''))) > 0),
  check (kind <> 'received' or received_as is not null)
);
create index component_events_component on component_events (component_id, at);
create index component_events_site on component_events (site_id, at);

-- Plan 11.2 "View cost and labour rates": a separate table, so other roles cannot read it at all.
create table component_event_costs (
  event_id uuid primary key references component_events(id) on delete restrict,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  cost numeric not null check (cost >= 0),
  entered_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now()
);

create table life_targets (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  model text not null check (length(trim(model)) > 0),
  kind text not null check (kind in ('engine', 'transmission', 'torque_converter', 'differential', 'final_drive', 'front_strut', 'rear_strut')),
  hours int not null check (hours between 100 and 200000),
  effective_from date not null,
  reason text not null check (length(trim(reason)) > 0),
  -- set_by is the person who asked; approved_by the superintendent who approved it (decided 2026-10-28).
  set_by uuid not null default auth.uid(),
  set_at timestamptz not null default now(),
  request_id uuid unique references change_requests(id) on delete restrict,
  approved_by uuid
);
create index life_targets_site on life_targets (site_id, model, kind, effective_from);

-- Components: fixed once registered.
create or replace function component_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    raise exception 'A component record cannot be changed. Its history is in its events.' using errcode = 'insufficient_privilege';
  end if;
  new.created_by := auth.uid(); new.created_at := now(); new.serial := upper(trim(new.serial));
  return new;
end $$;

-- Events: in time order, nothing after scrapped, one position holds one component,
-- and the only change allowed later is voiding the latest event.
create or replace function component_event_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  last_ev component_events;
  comp components;
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if old.voided_at is not null then raise exception 'This event is already voided.' using errcode = 'insufficient_privilege'; end if;
    if (new.id, new.tenant_id, new.site_id, new.component_id, new.kind, new.at, new.unit_id, new.position, new.smu, new.reason, new.flag_id, new.work_order,
        new.vendor, new.reference, new.received_as, new.warranty_hours, new.warranty_months, new.core_due_by, new.claim, new.note, new.entered_by, new.entered_at)
       is distinct from
       (old.id, old.tenant_id, old.site_id, old.component_id, old.kind, old.at, old.unit_id, old.position, old.smu, old.reason, old.flag_id, old.work_order,
        old.vendor, old.reference, old.received_as, old.warranty_hours, old.warranty_months, old.core_due_by, old.claim, old.note, old.entered_by, old.entered_at)
       or length(trim(coalesce(new.void_reason, ''))) = 0 then
      raise exception 'A component event cannot be changed. Void it with a reason and enter it again.' using errcode = 'insufficient_privilege';
    end if;
    if not (old.entered_by = auth.uid() or site_role(old.site_id) = 'superintendent') then
      raise exception 'Only the person who entered it, or a superintendent, voids an event.' using errcode = 'insufficient_privilege';
    end if;
    if exists (select 1 from component_events x where x.component_id = old.component_id and x.voided_at is null and x.id <> old.id
               and (x.at, x.entered_at) > (old.at, old.entered_at)) then
      raise exception 'Only the latest event of a component can be voided.' using errcode = 'insufficient_privilege';
    end if;
    new.voided_by := auth.uid(); new.voided_at := now();
    return new;
  end if;
  -- Insert.
  new.entered_by := auth.uid(); new.entered_at := now(); new.voided_by := null; new.voided_at := null; new.void_reason := null;
  select * into comp from components where id = new.component_id;
  if comp.site_id is distinct from new.site_id then raise exception 'Component not found at this site.' using errcode = 'insufficient_privilege'; end if;
  if new.at > now() + interval '5 minutes' then raise exception 'The date cannot be in the future.' using errcode = 'check_violation'; end if;
  select * into last_ev from component_events where component_id = new.component_id and voided_at is null order by at desc, entered_at desc limit 1;
  if last_ev.id is null and new.kind <> 'received' then raise exception 'A component starts with Received.' using errcode = 'check_violation'; end if;
  if last_ev.id is not null and new.kind = 'received' then raise exception 'This component is already received.' using errcode = 'check_violation'; end if;
  if last_ev.id is not null and new.at < last_ev.at then raise exception 'An event cannot be dated before the previous one.' using errcode = 'check_violation'; end if;
  if last_ev.kind = 'scrapped' then raise exception 'This component is scrapped.' using errcode = 'check_violation'; end if;
  if new.unit_id is not null and not exists (select 1 from assets a where a.id = new.unit_id and a.site_id = new.site_id) then
    raise exception 'Unit not found at this site.' using errcode = 'insufficient_privilege';
  end if;
  if new.kind = 'installed' and exists (
    select 1 from (
      select distinct on (e.component_id) e.component_id, e.kind, e.unit_id, e.position
      from component_events e
      where e.site_id = new.site_id and e.voided_at is null and e.component_id <> new.component_id
        and e.kind in ('installed', 'removed', 'scrapped')
      order by e.component_id, e.at desc, e.entered_at desc
    ) cur where cur.kind = 'installed' and cur.unit_id = new.unit_id and cur.position = new.position
  ) then
    raise exception 'That position is not empty. Remove the component there first.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function component_cost_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then raise exception 'A cost cannot be changed. Void the event and enter it again.' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from component_events e where e.id = new.event_id and e.site_id = new.site_id and e.entered_by = auth.uid()) then
    raise exception 'A cost is entered with its own event.' using errcode = 'insufficient_privilege';
  end if;
  new.entered_by := auth.uid(); new.entered_at := now();
  return new;
end $$;

-- A target life comes only from an approved request, applied by the superintendent who approved it,
-- with exactly the values that were asked for.
create or replace function life_target_guard() returns trigger
language plpgsql set search_path = public as $$
declare r change_requests;
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then raise exception 'A target life cannot be changed. Set a new one from a later date.' using errcode = 'insufficient_privilege'; end if;
  select * into r from change_requests c
  where c.id = new.request_id and c.site_id = new.site_id and c.kind = 'life_target' and c.status = 'approved'
    and c.decided_by = auth.uid() and (c.applied_id is null or c.applied_id = new.id);
  if not found
     or r.payload->'input'->>'model' is distinct from new.model or r.payload->'input'->>'kind' is distinct from new.kind
     or (r.payload->'input'->>'hours')::int is distinct from new.hours or (r.payload->'input'->>'effectiveFrom')::date is distinct from new.effective_from then
    raise exception 'A target life needs an approved request, applied by the superintendent who approved it.' using errcode = 'insufficient_privilege';
  end if;
  new.reason := r.reason; new.set_by := r.requested_by; new.approved_by := auth.uid(); new.set_at := now();
  return new;
end $$;

create trigger components_guard before insert or update on components for each row execute function component_guard();
create trigger components_no_delete before delete on components for each row execute function refuse_delete();
create trigger components_audit after insert or update on components for each row execute function audit_row();
create trigger component_events_guard before insert or update on component_events for each row execute function component_event_guard();
create trigger component_events_no_delete before delete on component_events for each row execute function refuse_delete();
create trigger component_events_audit after insert or update on component_events for each row execute function audit_row();
create trigger component_event_costs_guard before insert or update on component_event_costs for each row execute function component_cost_guard();
create trigger component_event_costs_no_delete before delete on component_event_costs for each row execute function refuse_delete();
create trigger life_targets_guard before insert or update on life_targets for each row execute function life_target_guard();
create trigger life_targets_no_delete before delete on life_targets for each row execute function refuse_delete();
create trigger life_targets_audit after insert or update on life_targets for each row execute function audit_row();
-- Costs are not written to the site-wide audit log, which more roles can read; the app's own entry leaves the cost out too.

alter table components enable row level security;
alter table component_events enable row level security;
alter table component_event_costs enable row level security;
alter table life_targets enable row level security;

create policy components_read on components for select using (is_site_member(site_id));
create policy components_insert on components for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy component_events_read on component_events for select using (is_site_member(site_id));
create policy component_events_insert on component_events for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy component_events_update on component_events for update using (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy component_event_costs_read on component_event_costs for select using (site_role(site_id) in ('reliability_engineer', 'superintendent', 'admin'));
create policy component_event_costs_insert on component_event_costs for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent'));
create policy life_targets_read on life_targets for select using (is_site_member(site_id));
create policy life_targets_insert on life_targets for insert with check (site_role(site_id) = 'superintendent');

grant select, insert, update on components, component_events to authenticated;
grant select, insert on component_event_costs, life_targets to authenticated;

-- ---------- API ----------

create or replace function app_save_component(p_site uuid, c jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  insert into components (id, tenant_id, site_id, serial, kind, part_number, models, hours_at_entry, rebuilds_at_entry)
  select (c->>'id')::uuid, s.tenant_id, p_site, c->>'serial', c->>'kind', c->>'partNumber',
    coalesce(array(select jsonb_array_elements_text(c->'models')), '{}'), coalesce((c->>'hoursAtEntry')::numeric, 0), coalesce((c->>'rebuildsAtEntry')::int, 0)
  from sites s where s.id = p_site;
end $$;

-- A new event (with its cost, for cost roles), or voiding one.
create or replace function app_save_component_event(p_site uuid, e jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if e->>'voidedAt' is not null then
    update component_events set void_reason = e->>'voidReason' where id = (e->>'id')::uuid and site_id = p_site;
    if not found then raise exception 'Event not found.' using errcode = 'insufficient_privilege'; end if;
    return;
  end if;
  if e->>'cost' is not null and site_role(p_site) not in ('reliability_engineer', 'superintendent') then
    raise exception 'Only cost roles enter costs.' using errcode = 'insufficient_privilege';
  end if;
  insert into component_events (id, tenant_id, site_id, component_id, kind, at, unit_id, position, smu, reason, flag_id, work_order, vendor, reference,
    received_as, warranty_hours, warranty_months, core_due_by, claim, note)
  select (e->>'id')::uuid, s.tenant_id, p_site, (e->>'componentId')::uuid, e->>'kind', (e->>'at')::timestamptz, (e->>'unitId')::uuid, e->>'position',
    (e->>'smu')::numeric, e->>'reason', (e->>'flagId')::uuid, e->>'workOrder', e->>'vendor', e->>'reference', e->>'receivedAs',
    (e->>'warrantyHours')::numeric, (e->>'warrantyMonths')::int, (e->>'coreDueBy')::date, e->>'claim', e->>'note'
  from sites s where s.id = p_site;
  if e->>'cost' is not null then
    insert into component_event_costs (event_id, tenant_id, site_id, cost)
    select (e->>'id')::uuid, s.tenant_id, p_site, (e->>'cost')::numeric from sites s where s.id = p_site;
  end if;
end $$;

-- Target life is asked for like a KPI target (docs/approvals.md): a reliability engineer or
-- superintendent asks, and a superintendent who did not ask approves and applies it.
alter table change_requests drop constraint change_requests_kind_check;
alter table change_requests add constraint change_requests_kind_check check (kind in ('target', 'life_target', 'role_grant', 'acting_role'));
drop policy change_requests_insert on change_requests;
create policy change_requests_insert on change_requests for insert with check (
  requested_by = auth.uid() and (
    (kind in ('target', 'life_target') and site_role(site_id) in ('reliability_engineer', 'superintendent'))
    or (kind in ('role_grant', 'acting_role') and site_role(site_id) = 'admin')
  )
);

-- A decision and what it applies, in one transaction. A target life is built from the request
-- itself; only the new record's id comes from the app.
create or replace function app_decide_request(p_site uuid, p_id uuid, p_decision text, p_note text, p_target jsonb default null) returns void
language plpgsql security invoker set search_path = public as $$
declare r change_requests;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'Unknown decision'; end if;
  update change_requests set status = p_decision, decision_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_id and site_id = p_site and status = 'pending'
  returning * into r;
  if not found then raise exception 'Request not found or already decided.' using errcode = 'no_data_found'; end if;
  if p_decision = 'rejected' then return; end if;

  if r.kind = 'target' then
    if p_target is null then raise exception 'The target to apply is missing.'; end if;
    insert into targets (id, tenant_id, site_id, kpi, fleet_name, model, target, amber, effective_from, reason, set_at, created_by, request_id)
    values ((p_target->>'id')::uuid, r.tenant_id, p_site, p_target->>'kpi', p_target->>'fleet', p_target->>'model', (p_target->>'value')::numeric,
      (p_target->>'amber')::numeric, (p_target->>'effectiveFrom')::timestamptz, r.reason, now(), r.requested_by, r.id);
    update change_requests set applied_id = (p_target->>'id')::uuid where id = r.id;
  elsif r.kind = 'life_target' then
    if p_target is null then raise exception 'The target life to apply is missing.'; end if;
    insert into life_targets (id, tenant_id, site_id, model, kind, hours, effective_from, reason, request_id)
    values ((p_target->>'id')::uuid, r.tenant_id, p_site, r.payload->'input'->>'model', r.payload->'input'->>'kind', (r.payload->'input'->>'hours')::int,
      (r.payload->'input'->>'effectiveFrom')::date, r.reason, r.id);
    update change_requests set applied_id = (p_target->>'id')::uuid where id = r.id;
  elsif r.kind = 'role_grant' then
    update site_members set role = (r.payload->>'role')::app_role where site_id = p_site and user_id = (r.payload->>'userId')::uuid and retired_at is null;
    if not found then raise exception 'That user is no longer active.'; end if;
    update change_requests set applied_id = (r.payload->>'userId')::uuid where id = r.id;
  else
    update site_members set acting_role = (r.payload->>'role')::app_role, acting_until = (r.payload->>'until')::timestamptz
    where site_id = p_site and user_id = (r.payload->>'userId')::uuid and retired_at is null;
    if not found then raise exception 'That user is no longer active.'; end if;
    update change_requests set applied_id = (r.payload->>'userId')::uuid where id = r.id;
  end if;
end $$;

-- Costs come back only where row-level security lets this person read them.
create or replace function app_load_components(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'components', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', c.id, 'serial', c.serial, 'kind', c.kind, 'partNumber', c.part_number,
      'models', to_jsonb(c.models), 'hoursAtEntry', c.hours_at_entry, 'rebuildsAtEntry', c.rebuilds_at_entry, 'createdBy', c.created_by, 'createdAt', c.created_at))
      order by c.created_at) from components c where c.site_id = p_site), '[]'),
    'events', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', e.id, 'componentId', e.component_id, 'kind', e.kind, 'at', e.at,
      'unitId', e.unit_id, 'position', e.position, 'smu', e.smu, 'reason', e.reason, 'flagId', e.flag_id, 'workOrder', e.work_order, 'vendor', e.vendor,
      'reference', e.reference, 'receivedAs', e.received_as, 'cost', k.cost, 'warrantyHours', e.warranty_hours, 'warrantyMonths', e.warranty_months,
      'coreDueBy', e.core_due_by, 'claim', e.claim, 'note', e.note, 'enteredBy', e.entered_by, 'enteredAt', e.entered_at,
      'voidedBy', e.voided_by, 'voidedAt', e.voided_at, 'voidReason', e.void_reason))
      order by e.at, e.entered_at) from component_events e left join component_event_costs k on k.event_id = e.id where e.site_id = p_site), '[]'),
    'targets', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', t.id, 'model', t.model, 'kind', t.kind, 'hours', t.hours, 'effectiveFrom', t.effective_from,
      'reason', t.reason, 'setBy', t.set_by, 'setAt', t.set_at, 'requestId', t.request_id, 'approvedBy', t.approved_by)) order by t.set_at) from life_targets t where t.site_id = p_site), '[]'));
$$;

grant execute on function app_save_component, app_save_component_event, app_load_components to authenticated;
