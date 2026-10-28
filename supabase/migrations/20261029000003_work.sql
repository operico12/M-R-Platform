-- Phase 2: work and PM view (KPI-018 to 023). Planning fields on work
-- orders, as the ERP holds them (A3 mapping), and a site settings row for
-- the work settings. The ERP stays the system of record; these are copies.

alter table work_orders
  add column target_start timestamptz,
  add column target_finish timestamptz,
  add column scheduled_start timestamptz,
  add column scheduled_finish timestamptz,
  add column estimated_hours numeric check (estimated_hours >= 0),
  add column actual_labour_hours numeric check (actual_labour_hours >= 0),
  add column pm_number text,
  add column origin_work_order text;
create index work_orders_open on work_orders (site_id, is_open);

create or replace function app_save_work_orders(p_site uuid, p_rows jsonb) returns int
language sql security invoker set search_path = public as $$
  with up as (
    insert into work_orders (id, tenant_id, site_id, asset_id, source_system, source_id, number, number_normalised, external_asset_id, wo_type,
      work_class, status, is_open, priority, description, reported_at, completed_at, source_modified_at,
      target_start, target_finish, scheduled_start, scheduled_finish, estimated_hours, actual_labour_hours, pm_number, origin_work_order, created_by)
    select (w->>'id')::uuid, s.tenant_id, p_site, (w->>'assetId')::uuid, w->>'sourceSystem', w->>'sourceId', w->>'number', w->>'numberNormalised',
      w->>'externalAssetId', w->>'woType', coalesce(w->>'workClass', 'other'), w->>'status', coalesce((w->>'open')::boolean, true), w->>'priority',
      w->>'description', (w->>'reportedAt')::timestamptz, (w->>'completedAt')::timestamptz, (w->>'sourceModifiedAt')::timestamptz,
      (w->>'targetStart')::timestamptz, (w->>'targetFinish')::timestamptz, (w->>'scheduledStart')::timestamptz, (w->>'scheduledFinish')::timestamptz,
      (w->>'estimatedHours')::numeric, (w->>'actualLabourHours')::numeric, w->>'pmNumber', w->>'originWorkOrder', auth.uid()
    from jsonb_array_elements(p_rows) w, sites s where s.id = p_site
    on conflict (site_id, source_system, source_id) do update set asset_id = excluded.asset_id, number = excluded.number,
      number_normalised = excluded.number_normalised, external_asset_id = excluded.external_asset_id, wo_type = excluded.wo_type,
      work_class = excluded.work_class, status = excluded.status, is_open = excluded.is_open, priority = excluded.priority,
      description = excluded.description, reported_at = excluded.reported_at, completed_at = excluded.completed_at,
      source_modified_at = excluded.source_modified_at, target_start = excluded.target_start, target_finish = excluded.target_finish,
      scheduled_start = excluded.scheduled_start, scheduled_finish = excluded.scheduled_finish, estimated_hours = excluded.estimated_hours,
      actual_labour_hours = excluded.actual_labour_hours, pm_number = excluded.pm_number, origin_work_order = excluded.origin_work_order
    returning 1)
  select count(*)::int from up;
$$;

-- One row per site; each key (for example "work") holds one settings object.
create table site_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  key text not null check (key in ('work')),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  unique (site_id, key)
);
create trigger site_settings_updated before update on site_settings for each row execute function set_updated();
create trigger site_settings_no_delete before delete on site_settings for each row execute function refuse_delete();
create trigger site_settings_audit after insert or update on site_settings for each row execute function audit_row();
alter table site_settings enable row level security;
create policy site_settings_read on site_settings for select using (is_site_member(site_id));
-- Plan 11.2 "KPI targets and thresholds": reliability engineer and superintendent.
create policy site_settings_insert on site_settings for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent'));
create policy site_settings_update on site_settings for update using (site_role(site_id) in ('reliability_engineer', 'superintendent'));

create or replace function app_save_setting(p_site uuid, p_key text, p_value jsonb, p_reason text) returns void
language sql security invoker set search_path = public as $$
  insert into site_settings (tenant_id, site_id, key, value, reason, created_by)
  select s.tenant_id, p_site, p_key, p_value, p_reason, auth.uid() from sites s where s.id = p_site
  on conflict (site_id, key) do update set value = excluded.value, reason = excluded.reason
  where site_settings.site_id = p_site;
$$;

-- Planning fields by work order id, and the site settings, read beside app_load.
create or replace function app_load_work(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'plans', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', w.id, 'targetStart', w.target_start, 'targetFinish', w.target_finish,
        'scheduledStart', w.scheduled_start, 'scheduledFinish', w.scheduled_finish, 'estimatedHours', w.estimated_hours,
        'actualLabourHours', w.actual_labour_hours, 'pmNumber', w.pm_number, 'originWorkOrder', w.origin_work_order)))
      from work_orders w where w.site_id = p_site
        and (w.target_finish is not null or w.scheduled_start is not null or w.estimated_hours is not null or w.actual_labour_hours is not null
             or w.pm_number is not null or w.origin_work_order is not null)), '[]'),
    'settings', coalesce((select jsonb_object_agg(s.key, s.value) from site_settings s where s.site_id = p_site), '{}'));
$$;

grant execute on function app_save_setting, app_load_work to authenticated;
grant select, insert, update on site_settings to authenticated;
