-- Phase 3b, fixed plant part 1 (docs/fixed-plant.md). Plant structure, process
-- delays and historian run signals. Plant equipment are assets with asset class
-- fixed_plant; their down flags use the existing flag tables. The app runs the
-- rules in packages/core/src/plant.ts; these are the backstop. Nothing is deleted.

-- ---------- plant structure ----------

create table plant_nodes (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  kind text not null check (kind in ('plant', 'area', 'circuit', 'group')),
  name text not null check (length(trim(name)) between 1 and 100),
  parent_id uuid references plant_nodes(id) on delete restrict,
  sort int not null default 0,
  needed int check (needed is null or needed between 1 and 100),
  functional_location text check (functional_location is null or length(trim(functional_location)) between 1 and 100),
  planned_rate_tph numeric check (planned_rate_tph is null or (planned_rate_tph > 0 and planned_rate_tph <= 1000000)),
  created_at timestamptz not null default now(), created_by uuid default auth.uid(),
  updated_at timestamptz not null default now(), updated_by uuid,
  retired_at timestamptz,
  retire_reason text,
  check ((retired_at is null) = (retire_reason is null)),
  check (retire_reason is null or length(trim(retire_reason)) > 0),
  check (parent_id is null or parent_id <> id)
);
create index plant_nodes_site on plant_nodes (site_id);

-- The parent is at the same site; a retired node stays retired; a node with active children cannot be retired.
create or replace function plant_node_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.parent_id is not null and not exists (select 1 from plant_nodes p where p.id = new.parent_id and p.site_id = new.site_id) then
    raise exception 'The parent must be at the same site.' using errcode = 'check_violation';
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

create trigger plant_nodes_guard before insert or update on plant_nodes for each row execute function plant_node_guard();
create trigger plant_nodes_no_delete before delete on plant_nodes for each row execute function refuse_delete();
create trigger plant_nodes_audit after insert or update on plant_nodes for each row execute function audit_row();

-- ---------- process delays (A7 section 11: their own records, not down flags) ----------

create table process_delays (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  node_id uuid not null references plant_nodes(id) on delete restrict,
  asset_id uuid references assets(id) on delete restrict,
  code text not null check (length(trim(code)) between 1 and 100),
  starts_at timestamptz not null,
  ends_at timestamptz,
  from_flag_ids uuid[] not null default '{}',
  notes text check (notes is null or length(notes) <= 2000),
  set_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  check (ends_at is null or ends_at > starts_at),
  check ((voided_at is null) = (void_reason is null)),
  check (void_reason is null or length(trim(void_reason)) > 0)
);
create index process_delays_site on process_delays (site_id, starts_at);

-- Insert: the node (and equipment) are at the same site; no time in the future; who and when are the
-- signed-in person and now. Update: only ending an open delay once, or voiding once with a reason.
create or replace function process_delay_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from plant_nodes n where n.id = new.node_id and n.site_id = new.site_id) then
      raise exception 'The plant node must be at the same site.' using errcode = 'check_violation';
    end if;
    if new.asset_id is not null and not exists (select 1 from assets a where a.id = new.asset_id and a.site_id = new.site_id and a.asset_class = 'fixed_plant') then
      raise exception 'The equipment must be fixed plant at the same site.' using errcode = 'check_violation';
    end if;
    if new.starts_at > now() + interval '5 minutes' or new.ends_at > now() + interval '5 minutes' then
      raise exception 'Times cannot be in the future.' using errcode = 'check_violation';
    end if;
    new.set_by := auth.uid(); new.entered_at := now();
    new.voided_at := null; new.voided_by := null; new.void_reason := null;
    return new;
  end if;
  if old.voided_at is not null then raise exception 'This delay is voided.' using errcode = 'insufficient_privilege'; end if;
  if (to_jsonb(new) - array['ends_at', 'voided_at', 'voided_by', 'void_reason']) is distinct from (to_jsonb(old) - array['ends_at', 'voided_at', 'voided_by', 'void_reason']) then
    raise exception 'A process delay cannot be changed. End it or void it.' using errcode = 'insufficient_privilege';
  end if;
  if new.ends_at is distinct from old.ends_at then
    if old.ends_at is not null then raise exception 'This delay has already ended.' using errcode = 'insufficient_privilege'; end if;
    if new.ends_at > now() + interval '5 minutes' then raise exception 'End cannot be in the future.' using errcode = 'check_violation'; end if;
  end if;
  if new.void_reason is not null then
    new.voided_at := now(); new.voided_by := auth.uid();
  end if;
  return new;
end $$;

create trigger process_delays_guard before insert or update on process_delays for each row execute function process_delay_guard();
create trigger process_delays_no_delete before delete on process_delays for each row execute function refuse_delete();
create trigger process_delays_audit after insert or update on process_delays for each row execute function audit_row();

-- ---------- historian run and stop signals (file-based in phase 1a) ----------

create table run_signals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  at timestamptz not null,
  running boolean not null,
  source text not null default 'file' check (source in ('file', 'historian')),
  created_at timestamptz not null default now(), created_by uuid default auth.uid(),
  unique (asset_id, at)
);
create index run_signals_site on run_signals (site_id, at);

create or replace function run_signal_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then raise exception 'A run signal cannot be changed.' using errcode = 'insufficient_privilege'; end if;
  if not exists (select 1 from assets a where a.id = new.asset_id and a.site_id = new.site_id and a.asset_class = 'fixed_plant') then
    raise exception 'Run signals are for fixed plant equipment at the same site.' using errcode = 'check_violation';
  end if;
  if new.at > now() + interval '5 minutes' then raise exception 'Times cannot be in the future.' using errcode = 'check_violation'; end if;
  new.created_by := auth.uid(); new.created_at := now();
  return new;
end $$;

create trigger run_signals_guard before insert or update on run_signals for each row execute function run_signal_guard();
create trigger run_signals_no_delete before delete on run_signals for each row execute function refuse_delete();
create trigger run_signals_audit after insert on run_signals for each row execute function audit_row();

-- ---------- row-level security ----------

alter table plant_nodes enable row level security;
alter table process_delays enable row level security;
alter table run_signals enable row level security;
create policy plant_nodes_read on plant_nodes for select using (is_site_member(site_id));
-- Plan 11.2 "Edit shops, shop lines, field locations, plant structure": admin.
create policy plant_nodes_insert on plant_nodes for insert with check (site_role(site_id) = 'admin');
create policy plant_nodes_update on plant_nodes for update using (site_role(site_id) = 'admin');
create policy process_delays_read on process_delays for select using (is_site_member(site_id));
-- Same roles as setting and clearing down flags.
create policy process_delays_insert on process_delays for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy process_delays_update on process_delays for update using (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy run_signals_read on run_signals for select using (is_site_member(site_id));
-- Imports are the data owner's (manage_imports); in phase 1a that is the admin.
create policy run_signals_insert on run_signals for insert with check (site_role(site_id) = 'admin');
grant select, insert, update on plant_nodes, process_delays to authenticated;
grant select, insert on run_signals to authenticated;

-- ---------- settings ----------

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts', 'condition', 'rcm', 'spares', 'assist', 'plant'));

-- edit_plant_settings (packages/core/src/permissions.ts): reliability engineer, superintendent, admin.
create or replace function can_write_setting(p_site uuid, p_key text) returns boolean
language sql stable security invoker set search_path = public as $$
  select case p_key
    when 'work' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'condition' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'rcm' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'spares' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'assist' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'plant' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    else false end;
$$;

-- ---------- API ----------

create or replace function app_save_plant_node(p_site uuid, n jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  insert into plant_nodes (id, tenant_id, site_id, kind, name, parent_id, sort, needed, functional_location, planned_rate_tph)
  select (n->>'id')::uuid, s.tenant_id, p_site, n->>'kind', n->>'name', (n->>'parentId')::uuid, coalesce((n->>'order')::int, 0), (n->>'needed')::int,
    nullif(trim(n->>'functionalLocation'), ''), (n->>'plannedRateTph')::numeric
  from sites s where s.id = p_site
  on conflict (id) do update set name = excluded.name, parent_id = excluded.parent_id, sort = excluded.sort, needed = excluded.needed,
    functional_location = excluded.functional_location, planned_rate_tph = excluded.planned_rate_tph,
    retired_at = case when n->>'retireReason' is not null then coalesce(plant_nodes.retired_at, now()) else plant_nodes.retired_at end,
    retire_reason = coalesce(plant_nodes.retire_reason, nullif(trim(n->>'retireReason'), ''))
  where plant_nodes.site_id = p_site;
end $$;

-- A new delay, or the end or void of an existing one. The guard allows nothing else.
create or replace function app_save_process_delay(p_site uuid, d jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  insert into process_delays (id, tenant_id, site_id, node_id, asset_id, code, starts_at, ends_at, from_flag_ids, notes)
  select (d->>'id')::uuid, s.tenant_id, p_site, (d->>'nodeId')::uuid, (d->>'assetId')::uuid, d->>'code', (d->>'start')::timestamptz,
    (d->>'end')::timestamptz, coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(d->'fromFlagIds') x), '{}'), nullif(trim(d->>'notes'), '')
  from sites s where s.id = p_site
  on conflict (id) do update set ends_at = excluded.ends_at, void_reason = nullif(trim(d->>'voidReason'), ''),
    voided_at = case when nullif(trim(d->>'voidReason'), '') is not null then now() else process_delays.voided_at end
  where process_delays.site_id = p_site;
end $$;

-- New signals only; one already loaded for the same equipment and time is skipped, so loading a file again changes nothing.
create or replace function app_save_run_signals(p_site uuid, rows jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare v int;
begin
  insert into run_signals (tenant_id, site_id, asset_id, at, running)
  select s.tenant_id, p_site, (x->>'assetId')::uuid, (x->>'at')::timestamptz, (x->>'running')::boolean
  from sites s, jsonb_array_elements(rows) x where s.id = p_site
  on conflict (asset_id, at) do nothing;
  get diagnostics v = row_count;
  return v;
end $$;

create or replace function app_load_plant(p_site uuid, p_since timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'nodes', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', n.id, 'tenantId', n.tenant_id, 'siteId', n.site_id, 'kind', n.kind,
      'name', n.name, 'parentId', n.parent_id, 'order', n.sort, 'needed', n.needed, 'functionalLocation', n.functional_location,
      'plannedRateTph', n.planned_rate_tph, 'retiredAt', n.retired_at, 'retireReason', n.retire_reason)) order by n.sort, n.name)
      from plant_nodes n where n.site_id = p_site), '[]'),
    'delays', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', d.id, 'tenantId', d.tenant_id, 'siteId', d.site_id, 'nodeId', d.node_id,
      'assetId', d.asset_id, 'code', d.code, 'start', d.starts_at, 'end', d.ends_at, 'fromFlagIds', case when cardinality(d.from_flag_ids) > 0 then to_jsonb(d.from_flag_ids) end,
      'notes', d.notes, 'setBy', d.set_by, 'enteredAt', d.entered_at, 'voidedAt', d.voided_at, 'voidedBy', d.voided_by, 'voidReason', d.void_reason)) order by d.starts_at)
      from process_delays d where d.site_id = p_site and (d.ends_at is null or d.ends_at >= p_since)), '[]'),
    -- The last signal before the window too, so the state at its start is known.
    'signals', coalesce((select jsonb_agg(jsonb_build_object('assetId', r.asset_id, 'at', r.at, 'running', r.running) order by r.at)
      from run_signals r where r.site_id = p_site and (r.at >= p_since or r.id in (
        select distinct on (b.asset_id) b.id from run_signals b where b.site_id = p_site and b.at < p_since order by b.asset_id, b.at desc))), '[]'));
$$;

grant execute on function app_save_plant_node, app_save_process_delay, app_save_run_signals, app_load_plant to authenticated;

notify pgrst, 'reload schema';
