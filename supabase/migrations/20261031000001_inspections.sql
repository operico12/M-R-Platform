-- Phase 2: inspections (docs/inspections.md). Forms are versioned and
-- retired, never edited or deleted. Drafts stay on the device; only
-- submitted inspections reach the database, through the app's outbox. Once
-- submitted, the answers are fixed: later steps are sign-off, void and
-- defect follow-up. The app runs the rules in
-- packages/core/src/inspections.ts; these are the backstop.

create table inspection_forms (
  id uuid not null,
  version int not null check (version >= 1),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  name text not null check (length(trim(name)) > 0),
  asset_class text not null check (asset_class in ('mobile', 'fixed_plant')),
  models text[] not null default '{}',
  every_n int not null check (every_n >= 1),
  every_unit text not null check (every_unit in ('days', 'smu_hours')),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  reason text not null check (length(trim(reason)) > 0),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_reason text,
  check (retired_at is null or length(trim(coalesce(retired_reason, ''))) > 0),
  primary key (id, version)
);
create index inspection_forms_site on inspection_forms (site_id);

create table inspections (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  form_id uuid not null,
  form_version int not null,
  unit_id uuid not null references assets(id) on delete restrict,
  smu numeric check (smu is null or smu >= 0),
  status text not null check (status in ('submitted', 'signed_off', 'voided')),
  answers jsonb not null check (jsonb_typeof(answers) = 'object'),
  defects jsonb not null default '[]' check (jsonb_typeof(defects) = 'array'),
  score numeric check (score is null or (score >= 0 and score <= 1)),
  result text check (result in ('pass', 'defects', 'fail')),
  started_by uuid not null default auth.uid(),
  started_at timestamptz not null,
  submitted_at timestamptz not null default now(),
  signed_off_by uuid,
  signed_off_at timestamptz,
  sign_off_note text,
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  foreign key (form_id, form_version) references inspection_forms(id, version) on delete restrict,
  check (status <> 'signed_off' or (signed_off_by is not null and signed_off_by <> started_by)),
  check (status <> 'voided' or length(trim(coalesce(void_reason, ''))) > 0)
);
create index inspections_site on inspections (site_id, submitted_at);
create index inspections_unit on inspections (unit_id, form_id);

create table inspection_photos (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  inspection_id uuid not null references inspections(id) on delete restrict,
  item_id text not null,
  -- A downscaled JPEG as a data URL. Later: object storage (plan 6.1).
  data text not null check (data like 'data:image/%' and length(data) <= 600000),
  taken_by uuid not null default auth.uid(),
  taken_at timestamptz not null default now()
);
create index inspection_photos_inspection on inspection_photos (inspection_id);

-- ---------- guards ----------

create or replace function inspection_form_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now(); new.retired_at := null; return new; end if;
  -- A form version is fixed. The only change is retiring it.
  if (new.id, new.version, new.tenant_id, new.site_id, new.name, new.asset_class, new.models, new.every_n, new.every_unit, new.items, new.reason, new.created_by, new.created_at)
     is distinct from (old.id, old.version, old.tenant_id, old.site_id, old.name, old.asset_class, old.models, old.every_n, old.every_unit, old.items, old.reason, old.created_by, old.created_at)
     or old.retired_at is not null then
    raise exception 'A form version cannot be changed. Save a new version instead.' using errcode = 'insufficient_privilege';
  end if;
  new.retired_at := now();
  return new;
end $$;

create or replace function inspection_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_role app_role := site_role(new.site_id); v_me uuid := auth.uid();
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    -- Arrives submitted, from the person who did it, entered now.
    new.status := 'submitted'; new.started_by := v_me; new.submitted_at := now();
    new.signed_off_by := null; new.signed_off_at := null; new.sign_off_note := null; new.voided_by := null; new.voided_at := null; new.void_reason := null;
    if new.started_at > now() then new.started_at := now(); end if;
    -- The form and the unit belong to this site, and the form version is in use.
    if not exists (select 1 from inspection_forms f where f.id = new.form_id and f.version = new.form_version and f.site_id = new.site_id and f.retired_at is null) then
      raise exception 'That form version is not in use at this site.' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from assets a where a.id = new.unit_id and a.site_id = new.site_id) then
      raise exception 'That unit is not at this site.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.id, new.tenant_id, new.site_id, new.form_id, new.form_version, new.unit_id, new.smu, new.answers, new.score, new.result, new.started_by, new.started_at, new.submitted_at)
     is distinct from (old.id, old.tenant_id, old.site_id, old.form_id, old.form_version, old.unit_id, old.smu, old.answers, old.score, old.result, old.started_by, old.started_at, old.submitted_at) then
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

  -- Defects are followed up, never removed.
  if exists (select 1 from jsonb_array_elements(old.defects) o where not exists (select 1 from jsonb_array_elements(new.defects) x where x->>'id' = o->>'id')) then
    raise exception 'Defects are closed with a note, never removed.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create or replace function inspection_photo_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  new.taken_by := auth.uid(); new.taken_at := now();
  if not exists (select 1 from inspections i where i.id = new.inspection_id and i.site_id = new.site_id and i.started_by = auth.uid()) then
    raise exception 'Only the inspector adds photos to an inspection.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

create trigger inspection_forms_guard before insert or update on inspection_forms for each row execute function inspection_form_guard();
create trigger inspections_guard before insert or update on inspections for each row execute function inspection_guard();
create trigger inspection_photos_guard before insert on inspection_photos for each row execute function inspection_photo_guard();
create or replace function refuse_photo_change() returns trigger language plpgsql as $$
begin
  raise exception 'Photos are kept as taken.' using errcode = 'insufficient_privilege';
end $$;
create trigger inspection_photos_no_update before update on inspection_photos for each row execute function refuse_photo_change();

do $$
declare t text;
begin
  foreach t in array array['inspection_forms', 'inspections', 'inspection_photos'] loop
    execute format('create trigger %I_no_delete before delete on %I for each row execute function refuse_delete()', t, t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_read on %I for select using (is_site_member(site_id))', t, t);
  end loop;
  -- Photos are large; the audit log records forms and inspections, which name the photo ids.
  foreach t in array array['inspection_forms', 'inspections'] loop
    execute format('create trigger %I_audit after insert or update on %I for each row execute function audit_row()', t, t);
  end loop;
end $$;

create policy inspection_forms_insert on inspection_forms for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent', 'admin'));
create policy inspection_forms_update on inspection_forms for update using (site_role(site_id) in ('reliability_engineer', 'superintendent', 'admin'));
-- Plan 11.2 "Add notes, photos and defects".
create policy inspections_insert on inspections for insert with check (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
create policy inspections_update on inspections for update using (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
create policy inspection_photos_insert on inspection_photos for insert with check (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));

-- ---------- API ----------

create or replace function app_save_form(p_site uuid, f jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update inspection_forms set retired_reason = f->>'retiredReason'
  where id = (f->>'id')::uuid and version = (f->>'version')::int and site_id = p_site and f->>'retiredAt' is not null and retired_at is null;
  if not found and not exists (select 1 from inspection_forms where id = (f->>'id')::uuid and version = (f->>'version')::int) then
    insert into inspection_forms (id, version, tenant_id, site_id, name, asset_class, models, every_n, every_unit, items, reason)
    select (f->>'id')::uuid, (f->>'version')::int, s.tenant_id, p_site, f->>'name', f->>'assetClass',
      coalesce((select array_agg(x) from jsonb_array_elements_text(f->'models') x), '{}'), (f->'every'->>'n')::int, f->'every'->>'unit', f->'items', f->>'reason'
    from sites s where s.id = p_site;
  end if;
end $$;

-- A submitted inspection (insert), or a later step on one (update).
create or replace function app_save_inspection(p_site uuid, i jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update inspections set status = i->>'status', defects = coalesce(i->'defects', '[]'), sign_off_note = i->>'signOffNote', void_reason = i->>'voidReason'
  where id = (i->>'id')::uuid and site_id = p_site;
  if not found then
    insert into inspections (id, tenant_id, site_id, form_id, form_version, unit_id, smu, status, answers, defects, score, result, started_at)
    select (i->>'id')::uuid, s.tenant_id, p_site, (i->>'formId')::uuid, (i->>'formVersion')::int, (i->>'unitId')::uuid, (i->>'smu')::numeric,
      'submitted', i->'answers', coalesce(i->'defects', '[]'), (i->>'score')::numeric, i->>'result', (i->>'startedAt')::timestamptz
    from sites s where s.id = p_site;
  end if;
end $$;

create or replace function app_save_photo(p_site uuid, p jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into inspection_photos (id, tenant_id, site_id, inspection_id, item_id, data)
  select (p->>'id')::uuid, s.tenant_id, p_site, (p->>'inspectionId')::uuid, p->>'itemId', p->>'data' from sites s where s.id = p_site
  on conflict (id) do nothing;
$$;

create or replace function app_load_inspections(p_site uuid, p_since timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'forms', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id, 'version', f.version, 'name', f.name, 'assetClass', f.asset_class,
      'models', to_jsonb(f.models), 'every', jsonb_build_object('n', f.every_n, 'unit', f.every_unit), 'items', f.items, 'reason', f.reason,
      'createdBy', f.created_by, 'createdAt', f.created_at, 'retiredAt', f.retired_at, 'retiredReason', f.retired_reason)) order by f.id, f.version)
      from inspection_forms f where f.site_id = p_site), '[]'),
    'inspections', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', i.id, 'formId', i.form_id, 'formVersion', i.form_version,
      'unitId', i.unit_id, 'smu', i.smu, 'status', i.status, 'answers', i.answers, 'defects', i.defects, 'score', i.score, 'result', i.result,
      'startedBy', i.started_by, 'startedAt', i.started_at, 'submittedAt', i.submitted_at, 'signedOffBy', i.signed_off_by, 'signedOffAt', i.signed_off_at,
      'signOffNote', i.sign_off_note, 'voidedBy', i.voided_by, 'voidedAt', i.voided_at, 'voidReason', i.void_reason)) order by i.submitted_at)
      from inspections i where i.site_id = p_site and (i.submitted_at >= p_since or exists (
        select 1 from jsonb_array_elements(i.defects) d where d->>'status' = 'open'))), '[]'));
$$;

create or replace function app_load_photo(p_site uuid, p_id uuid) returns text
language sql stable security invoker set search_path = public as $$
  select data from inspection_photos where site_id = p_site and id = p_id;
$$;

grant execute on function app_save_form, app_save_inspection, app_save_photo, app_load_inspections, app_load_photo to authenticated;
grant select, insert, update on inspection_forms, inspections to authenticated;
grant select, insert on inspection_photos to authenticated;

-- Inspections are everyday work records: everyone at the site sees their
-- history on the audit page, like flags and actions.
drop policy audit_log_read_work on audit_log;
create policy audit_log_read_work on audit_log for select using (
  is_site_member(site_id) and entity in (
    'down_flag', 'down_flags', 'flag_stage_intervals', 'flag_location_intervals', 'flag_etas', 'flag_reopen_gaps', 'flag_work_orders',
    'action', 'improvement_actions', 'rca', 'rcas', 'project', 'projects', 'alert', 'alert_answers',
    'inspection', 'inspections', 'inspection_form', 'inspection_forms'
  )
);
