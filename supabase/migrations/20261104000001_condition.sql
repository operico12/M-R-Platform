-- Phase 3: condition monitoring (docs/condition-monitoring.md). Oil samples
-- are entered once and never edited; a wrong one is voided with a reason.
-- Each sample keeps the severity the app worked out when it was entered.
-- Responses are one per alert, entered once, timed by the database.
-- The app runs the rules in packages/core/src/condition.ts; these are the
-- backstop.

create table oil_samples (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  unit_id uuid not null references assets(id) on delete restrict,
  compartment text not null check (compartment in ('engine', 'transmission', 'torque_converter', 'differential', 'final_drive_lh', 'final_drive_rh', 'hydraulic')),
  taken_at timestamptz not null,
  reported_at timestamptz check (reported_at is null or reported_at >= taken_at),
  smu numeric check (smu is null or smu >= 0),
  oil_hours numeric check (oil_hours is null or oil_hours >= 0),
  lab_ref text check (lab_ref is null or length(trim(lab_ref)) between 1 and 60),
  lab_severity text check (lab_severity in ('normal', 'monitor', 'action', 'critical')),
  readings jsonb not null default '{}' check (jsonb_typeof(readings) = 'object'),
  comment text,
  severity text not null check (severity in ('normal', 'monitor', 'action', 'critical')),
  reasons jsonb not null default '[]' check (jsonb_typeof(reasons) = 'array'),
  entered_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now(),
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  check ((voided_at is null) = (void_reason is null)),
  check (void_reason is null or length(trim(void_reason)) > 0)
);
create unique index oil_samples_lab_ref on oil_samples (site_id, lab_ref) where lab_ref is not null;
create index oil_samples_site on oil_samples (site_id, taken_at);
create index oil_samples_unit on oil_samples (unit_id, compartment, taken_at);

create table cm_responses (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  sample_id uuid not null unique references oil_samples(id) on delete restrict,
  action text not null check (action in ('resample', 'inspect', 'work_order', 'component_change', 'no_action')),
  work_order text,
  note text not null check (length(trim(note)) > 0),
  responded_by uuid not null default auth.uid(),
  responded_at timestamptz not null default now(),
  check (action <> 'work_order' or length(trim(coalesce(work_order, ''))) > 0)
);
create index cm_responses_site on cm_responses (site_id, responded_at);

create or replace function sev_rank(s text) returns int language sql immutable as $$
  select case s when 'normal' then 0 when 'monitor' then 1 when 'action' then 2 when 'critical' then 3 else -1 end;
$$;

-- Samples: entered as the person signed in, now; never edited; voided once with a reason,
-- by the person who entered it or a superintendent.
create or replace function oil_sample_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_role app_role := site_role(new.site_id);
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    if (select site_id from assets where id = new.unit_id) is distinct from new.site_id then
      raise exception 'That unit is not at this site.' using errcode = 'check_violation';
    end if;
    if new.taken_at > now() + interval '10 minutes' or new.reported_at > now() + interval '10 minutes' then
      raise exception 'The sample date is in the future.' using errcode = 'check_violation';
    end if;
    if sev_rank(new.severity) < sev_rank(new.lab_severity) then
      raise exception 'A sample cannot be rated better than the lab rated it.' using errcode = 'check_violation';
    end if;
    new.entered_by := auth.uid(); new.entered_at := now();
    new.voided_by := null; new.voided_at := null; new.void_reason := null;
    return new;
  end if;
  if (to_jsonb(new) - array['voided_by', 'voided_at', 'void_reason']) is distinct from (to_jsonb(old) - array['voided_by', 'voided_at', 'void_reason']) then
    raise exception 'A sample cannot be changed. Void it and enter it again.' using errcode = 'insufficient_privilege';
  end if;
  if old.voided_at is not null then raise exception 'It is already voided.' using errcode = 'insufficient_privilege'; end if;
  if new.void_reason is null or length(trim(new.void_reason)) = 0 then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  if not ((old.entered_by = auth.uid() and v_role in ('supervisor', 'reliability_engineer', 'superintendent')) or v_role = 'superintendent') then
    raise exception 'Only the person who entered it, or a superintendent, voids a sample.' using errcode = 'insufficient_privilege';
  end if;
  new.voided_by := auth.uid(); new.voided_at := now();
  return new;
end $$;

create or replace function cm_response_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then raise exception 'A response cannot be changed.' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from oil_samples s where s.id = new.sample_id and s.site_id = new.site_id and s.voided_at is null and s.severity in ('action', 'critical')) then
    raise exception 'Only samples at Action or Critical need a response.' using errcode = 'check_violation';
  end if;
  new.responded_by := auth.uid(); new.responded_at := now();
  return new;
end $$;

create trigger oil_samples_guard before insert or update on oil_samples for each row execute function oil_sample_guard();
create trigger oil_samples_no_delete before delete on oil_samples for each row execute function refuse_delete();
create trigger oil_samples_audit after insert or update on oil_samples for each row execute function audit_row();
create trigger cm_responses_guard before insert or update on cm_responses for each row execute function cm_response_guard();
create trigger cm_responses_no_delete before delete on cm_responses for each row execute function refuse_delete();
create trigger cm_responses_audit after insert or update on cm_responses for each row execute function audit_row();

alter table oil_samples enable row level security;
alter table cm_responses enable row level security;
create policy oil_samples_read on oil_samples for select using (is_site_member(site_id));
create policy oil_samples_insert on oil_samples for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy oil_samples_update on oil_samples for update using (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy cm_responses_read on cm_responses for select using (is_site_member(site_id));
create policy cm_responses_insert on cm_responses for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
grant select, insert, update on oil_samples to authenticated;
grant select, insert on cm_responses to authenticated;

-- ---------- settings: a site setting, like alert rules ----------

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts', 'condition'));
create or replace function can_write_setting(p_site uuid, p_key text) returns boolean
language sql stable security invoker set search_path = public as $$
  select case p_key
    when 'work' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'condition' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    else false end;
$$;

-- ---------- API ----------

-- New samples (one typed in, or a lab file). Rows whose lab reference is already held are skipped.
create or replace function app_save_oil_samples(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  insert into oil_samples (id, tenant_id, site_id, unit_id, compartment, taken_at, reported_at, smu, oil_hours, lab_ref, lab_severity, readings, comment, severity, reasons)
  select (x->>'id')::uuid, s.tenant_id, p_site, (x->>'unitId')::uuid, x->>'compartment', (x->>'takenAt')::timestamptz, (x->>'reportedAt')::timestamptz,
    (x->>'smu')::numeric, (x->>'oilHours')::numeric, nullif(trim(x->>'labRef'), ''), x->>'labSeverity', coalesce(x->'readings', '{}'), x->>'comment',
    x->>'severity', coalesce(x->'reasons', '[]')
  from jsonb_array_elements(p_rows) x cross join sites s where s.id = p_site
  on conflict do nothing;
end $$;

create or replace function app_void_oil_sample(p_site uuid, p_id uuid, p_reason text) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update oil_samples set void_reason = p_reason, voided_at = now() where id = p_id and site_id = p_site;
  if not found then raise exception 'Sample not found.' using errcode = 'insufficient_privilege'; end if;
end $$;

create or replace function app_save_cm_response(p_site uuid, r jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  insert into cm_responses (id, tenant_id, site_id, sample_id, action, work_order, note)
  select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'sampleId')::uuid, r->>'action', nullif(trim(r->>'workOrder'), ''), r->>'note'
  from sites s where s.id = p_site;
end $$;

-- Samples taken since p_since (the app asks for two years), and their responses.
create or replace function app_load_condition(p_site uuid, p_since timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'samples', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', o.id, 'unitId', o.unit_id, 'compartment', o.compartment, 'takenAt', o.taken_at,
      'reportedAt', o.reported_at, 'smu', o.smu, 'oilHours', o.oil_hours, 'labRef', o.lab_ref, 'labSeverity', o.lab_severity, 'readings', o.readings,
      'comment', o.comment, 'severity', o.severity, 'reasons', o.reasons, 'enteredBy', o.entered_by, 'enteredAt', o.entered_at,
      'voidedBy', o.voided_by, 'voidedAt', o.voided_at, 'voidReason', o.void_reason)) order by o.taken_at)
      from oil_samples o where o.site_id = p_site and o.taken_at >= p_since), '[]'),
    'responses', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', r.id, 'sampleId', r.sample_id, 'action', r.action, 'workOrder', r.work_order,
      'note', r.note, 'by', r.responded_by, 'at', r.responded_at)) order by r.responded_at)
      from cm_responses r join oil_samples o on o.id = r.sample_id where r.site_id = p_site and o.taken_at >= p_since), '[]'));
$$;

grant execute on function sev_rank, app_save_oil_samples, app_void_oil_sample, app_save_cm_response, app_load_condition to authenticated;
