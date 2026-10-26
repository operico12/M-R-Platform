-- M&R platform core schema, phase 1a.
--
-- Rules from build plan 16.3 and A7:
--   * Every business table has tenant_id and site_id, created/updated by and at.
--   * No cascade deletes. Foreign keys are ON DELETE RESTRICT, and history
--     tables refuse DELETE outright. Records are voided or retired instead.
--   * Status is stored as timed intervals; durations are never stored.
--   * Times are timestamptz (UTC); the site time zone decides days and shifts.
--
-- Supabase provides the auth schema and auth.uid(). Row-level security limits
-- every row to the sites a user is a member of.

create extension if not exists btree_gist;
create extension if not exists pgcrypto;

-- ---------- enums ----------

create type asset_class as enum ('mobile', 'fixed_plant');
create type asset_lifecycle as enum ('active', 'parked', 'decommissioned', 'not_commissioned');
create type flag_type as enum ('scheduled', 'unscheduled');
create type flag_state as enum ('proposed', 'open', 'released', 'voided', 'process_delay');
create type repair_stage as enum (
  'waiting_crew', 'in_transit', 'waiting_line', 'in_repair',
  'waiting_parts', 'waiting_labour', 'waiting_other', 'ready_for_release'
);
create type location_kind as enum ('field', 'towing', 'shop_yard', 'shop_line', 'in_place');
create type flag_source as enum ('app', 'erp', 'fleet_system', 'historian');
create type app_role as enum ('viewer', 'technician', 'supervisor', 'reliability_engineer', 'superintendent', 'admin');
create type detection_method as enum ('operator', 'pm', 'inspection', 'condition_monitoring', 'alarm', 'other');

-- ---------- helpers ----------

create or replace function set_updated() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

create or replace function refuse_delete() returns trigger language plpgsql as $$
begin
  raise exception 'Records in % are never deleted. Void or retire them instead.', tg_table_name;
end $$;

-- Standard audit columns, added to every business table below.
-- created_by / updated_by reference auth users but are not foreign keys, so
-- removing a user never touches history.

-- ---------- tenancy and people ----------

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table sites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  name text not null,
  time_zone text not null,                       -- IANA, e.g. America/Vancouver
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz
);

create table site_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  user_id uuid not null,                         -- auth.users.id
  role app_role not null default 'viewer',       -- least privilege: everyone starts as viewer
  scope text[] not null default '{}',            -- areas or fleets; '{*}' = whole site
  acting_role app_role,
  acting_until timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz,
  unique (site_id, user_id)
);

create or replace function is_site_member(p_site uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from site_members m
    where m.site_id = p_site and m.user_id = auth.uid() and m.retired_at is null
  );
$$;

create or replace function site_role(p_site uuid) returns app_role
language sql stable security definer set search_path = public as $$
  select case when m.acting_role is not null and m.acting_until > now() then m.acting_role else m.role end
  from site_members m
  where m.site_id = p_site and m.user_id = auth.uid() and m.retired_at is null;
$$;

-- ---------- shift calendar and periods ----------

create table shift_calendars (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  shifts jsonb not null,                         -- [{name, startLocal}]
  rotation jsonb,                                -- {anchorDate, pattern}
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  locked_at timestamptz,                         -- set when the weekly pack is published (R5)
  locked_by uuid,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (ends_at > starts_at)
);

-- Effective-dated flag rules (A7 D1–D12 and open questions C1–C7).
create table flag_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  rules jsonb not null,                          -- FlagRulesConfig from packages/core
  effective_from timestamptz not null,
  approved_by uuid,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

-- ---------- assets ----------

create table fleets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz,
  unique (site_id, name)
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  unit_number text not null,
  asset_class asset_class not null default 'mobile',
  serial text,
  external_asset_id text,                        -- identity bridge, e.g. Maximo ASSETNUM
  functional_location text,
  source_system text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz,
  unique (site_id, unit_number)
);

-- Attributes that change over time are effective-dated (plan 6.4).
create table asset_attributes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  fleet_id uuid references fleets(id) on delete restrict,
  model text,
  area text,
  lifecycle asset_lifecycle not null default 'active',
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (effective_to is null or effective_to > effective_from),
  exclude using gist (asset_id with =, tstzrange(effective_from, effective_to) with &&)
);

-- ---------- shops and locations ----------

create table shops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz
);

create table shop_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  shop_id uuid not null references shops(id) on delete restrict,
  number int,                                    -- optional: lines can be numbered, named, or both
  name text,
  line_type text not null default 'general',
  capacity int not null default 1 check (capacity > 0),
  fits text[] not null default '{}',             -- models that fit; empty = any
  sort_order int not null default 0,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz,
  check (number is not null or name is not null)
);

create table shop_line_closures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  shop_line_id uuid not null references shop_lines(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz,
  reason text not null,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (ends_at is null or ends_at > starts_at),
  exclude using gist (shop_line_id with =, tstzrange(starts_at, ends_at) with &&)
);

create table field_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  name text not null,
  kind text,                                     -- pit, bench, ramp, dump, haul road, crusher pad
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz
);

-- ---------- code lists (versioned, external codes, retired not deleted) ----------

create table codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  list text not null check (list in ('reason', 'system', 'component', 'failure_mode', 'cause', 'waiting_other', 'process_delay')),
  code text not null,
  label text not null,
  parent_id uuid references codes(id) on delete restrict,
  external_code text,                            -- e.g. Maximo failure class / problem code
  version int not null default 1,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz,
  unique (site_id, list, code, version)
);

-- ---------- work orders (ERP owns them; the platform keeps a copy) ----------

create table work_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid references assets(id) on delete restrict,
  source_system text not null,
  source_id text not null,
  number_normalised text not null,
  wo_type text,
  status text,
  priority text,
  description text,
  reported_at timestamptz,
  completed_at timestamptz,
  labour_cost numeric, parts_cost numeric, contractor_cost numeric,
  source_modified_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  unique (site_id, source_system, source_id)
);

-- ---------- down flags (A7) ----------

create table down_flags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  flag_type flag_type not null,
  state flag_state not null,
  reason_code text not null,
  system text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  linked_from_flag_id uuid references down_flags(id) on delete restrict,
  link_kind text check (link_kind in ('type_switch', 'reopen')),
  planned_duration_hours numeric,
  -- release checklist (A7 section 6)
  component text,
  failure_modes text[],
  repair_summary text,
  findings text,
  cause_code text,
  detection_method detection_method,
  smu_at_failure numeric,
  false_release boolean not null default false,
  void_reason text,
  restated boolean not null default false,
  source flag_source not null default 'app',
  set_by uuid,
  entered_at timestamptz not null default now(),  -- the real entry time, kept when back-dated (R4)
  released_by uuid,
  notes text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (ends_at is null or ends_at > starts_at),
  check (state <> 'open' or ends_at is null),
  check (state <> 'released' or ends_at is not null),
  check (state not in ('voided') or void_reason is not null)
);

-- R1: one open flag per unit.
create unique index down_flags_one_open on down_flags (asset_id) where state = 'open';

-- R3: counting flags for one unit cannot overlap.
alter table down_flags add constraint down_flags_no_overlap
  exclude using gist (asset_id with =, tstzrange(starts_at, ends_at) with &&)
  where (state in ('open', 'released'));

create index down_flags_site_time on down_flags (site_id, starts_at);

create table flag_stage_intervals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  flag_id uuid not null references down_flags(id) on delete restrict,
  stage repair_stage not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  reason text,                                   -- required for waiting_other (S5)
  part_or_work_order text,
  set_by uuid,
  entered_at timestamptz not null default now(),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (ends_at is null or ends_at >= starts_at),
  check (stage <> 'waiting_other' or reason is not null)
);
create unique index flag_stage_one_open on flag_stage_intervals (flag_id) where ends_at is null;

create table flag_location_intervals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  flag_id uuid not null references down_flags(id) on delete restrict,
  kind location_kind not null,
  shop_line_id uuid references shop_lines(id) on delete restrict,
  field_location text,
  functional_location text,
  reason text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  set_by uuid,
  entered_at timestamptz not null default now(),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (ends_at is null or ends_at >= starts_at),
  check (kind <> 'shop_line' or shop_line_id is not null)
);
create unique index flag_location_one_open on flag_location_intervals (flag_id) where ends_at is null;
create index flag_location_line on flag_location_intervals (shop_line_id) where kind = 'shop_line';

create table flag_etas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  flag_id uuid not null references down_flags(id) on delete restrict,
  eta timestamptz not null,
  set_at timestamptz not null default now(),
  set_by uuid,
  created_at timestamptz not null default now(), created_by uuid
);

create table flag_reopen_gaps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  flag_id uuid not null references down_flags(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  counts_as text not null check (counts_as in ('downtime', 'available')),
  created_at timestamptz not null default now(), created_by uuid
);

create table flag_work_orders (
  flag_id uuid not null references down_flags(id) on delete restrict,
  work_order_number text not null,
  work_order_id uuid references work_orders(id) on delete restrict,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  created_at timestamptz not null default now(), created_by uuid,
  primary key (flag_id, work_order_number)
);

-- ---------- meters ----------

create table smu_readings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  read_at timestamptz not null,
  hours numeric not null check (hours >= 0),
  source text not null default 'upload',
  voided_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  unique (asset_id, read_at, source)
);

-- ---------- data flow: land, sync, quality (plan 6.2, 6.3) ----------

create table raw_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  source_system text not null,
  object_type text not null,
  source_id text not null,
  payload jsonb not null,
  loaded_at timestamptz not null default now(),
  sync_run_id uuid
);

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  source_system text not null,
  kind text not null,                            -- file_import, incremental, full_reconcile
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_read int not null default 0,
  records_written int not null default 0,
  records_failed int not null default 0,
  created_by uuid
);

create table sync_errors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  sync_run_id uuid not null references sync_runs(id) on delete restrict,
  raw_record_id uuid references raw_records(id) on delete restrict,
  message text not null,
  replayed_at timestamptz,
  created_at timestamptz not null default now()
);

create table data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  rule text not null,
  entity text not null,
  entity_id uuid,
  message text not null,
  owner uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

-- ---------- targets ----------

create table targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  kpi text not null,                             -- KPI dictionary id, e.g. KPI-001
  fleet_id uuid references fleets(id) on delete restrict,
  model text,
  target numeric not null,
  amber numeric,
  red numeric,
  effective_from timestamptz not null,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

-- ---------- KPI summary by unit and shift (plan 6.2 "serve") ----------

create table kpi_unit_shift (
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  shift_date date not null,
  shift text not null,
  crew text,
  calendar_hours numeric not null,
  scheduled_down_hours numeric not null,
  unscheduled_down_hours numeric not null,
  operating_hours numeric not null,
  failures int not null,
  repair_hours numeric not null,
  calculated_at timestamptz not null default now(),
  rules_id uuid references flag_rules(id) on delete restrict,
  primary key (asset_id, shift_date, shift)
);

-- ---------- audit log (R12) ----------

create table audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  site_id uuid not null,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  effective_at timestamptz,                      -- the time the user said it happened, if back-dated
  device text,
  offline boolean not null default false
);

-- Write a row for every insert/update on governed tables.
create or replace function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after)
  values (
    coalesce(new.tenant_id, old.tenant_id),
    coalesce(new.site_id, old.site_id),
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(new.id, old.id),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new)
  );
  return new;
end $$;

-- ---------- triggers ----------

do $$
declare t text;
begin
  -- updated_at / updated_by on every table that has them
  foreach t in array array[
    'sites','site_members','shift_calendars','periods','flag_rules','fleets','assets','asset_attributes',
    'shops','shop_lines','shop_line_closures','field_locations','codes','work_orders','down_flags',
    'flag_stage_intervals','flag_location_intervals','data_quality_issues','targets'
  ] loop
    execute format('create trigger %I_updated before update on %I for each row execute function set_updated()', t, t);
  end loop;

  -- history is never deleted
  foreach t in array array[
    'sites','site_members','assets','asset_attributes','shop_lines','shop_line_closures','codes','work_orders',
    'down_flags','flag_stage_intervals','flag_location_intervals','flag_etas','flag_reopen_gaps','flag_work_orders',
    'smu_readings','raw_records','sync_runs','sync_errors','targets','flag_rules','periods','audit_log'
  ] loop
    execute format('create trigger %I_no_delete before delete on %I for each row execute function refuse_delete()', t, t);
  end loop;

  -- audit trail
  foreach t in array array[
    'down_flags','flag_stage_intervals','flag_location_intervals','flag_etas','flag_reopen_gaps',
    'site_members','targets','flag_rules','codes','shop_lines','shop_line_closures','periods','smu_readings'
  ] loop
    execute format('create trigger %I_audit after insert or update on %I for each row execute function audit_row()', t, t);
  end loop;
end $$;

-- The audit log itself cannot be edited.
create or replace function refuse_update() returns trigger language plpgsql as $$
begin
  raise exception 'The audit log cannot be changed.';
end $$;
create trigger audit_log_no_update before update on audit_log for each row execute function refuse_update();

-- ---------- row-level security ----------
-- Read: any member of the site. Write: through the API using the core
-- permission rules; the policies below are the backstop.

do $$
declare t text;
begin
  foreach t in array array[
    'sites','site_members','shift_calendars','periods','flag_rules','fleets','assets','asset_attributes',
    'shops','shop_lines','shop_line_closures','field_locations','codes','work_orders','down_flags',
    'flag_stage_intervals','flag_location_intervals','flag_etas','flag_reopen_gaps','flag_work_orders',
    'smu_readings','raw_records','sync_runs','sync_errors','data_quality_issues','targets','kpi_unit_shift','audit_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    if t = 'sites' then
      execute 'create policy sites_read on sites for select using (is_site_member(id))';
    else
      execute format('create policy %I_read on %I for select using (is_site_member(site_id))', t, t);
    end if;
  end loop;
end $$;

-- Flag writes: supervisor and above (technicians may only insert proposals).
create policy down_flags_insert on down_flags for insert with check (
  is_site_member(site_id) and (
    site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent')
    or (site_role(site_id) = 'technician' and state = 'proposed')
  )
);
create policy down_flags_update on down_flags for update using (
  site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent')
);

do $$
declare t text;
begin
  foreach t in array array['flag_stage_intervals','flag_location_intervals','flag_etas','flag_reopen_gaps','flag_work_orders'] loop
    execute format(
      'create policy %I_write on %I for insert with check (site_role(site_id) in (''technician'',''supervisor'',''reliability_engineer'',''superintendent''))', t, t);
    execute format(
      'create policy %I_update on %I for update using (site_role(site_id) in (''technician'',''supervisor'',''reliability_engineer'',''superintendent''))', t, t);
  end loop;
end $$;

create policy smu_insert on smu_readings for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent', 'admin'));
create policy admin_codes on codes for all using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');
create policy admin_lines on shop_lines for all using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');
create policy lines_close on shop_line_closures for insert with check (site_role(site_id) in ('supervisor', 'superintendent', 'admin'));
create policy targets_write on targets for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent'));
create policy members_admin on site_members for all using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');
