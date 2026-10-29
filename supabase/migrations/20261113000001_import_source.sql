-- SAP PM file imports (phase 4 part 2, docs/field-mapping.md). The site setting
-- `imports` says which ERP the files come from (maximo or sap_pm) and the site
-- value they use. Only the data owner (manage_imports: Admin in phase 1a) sets it.

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts', 'condition', 'rcm', 'spares', 'assist', 'plant', 'imports'));
alter table site_settings add constraint site_settings_imports_shape check (
  key <> 'imports' or (value->>'sourceSystem' in ('maximo', 'sap_pm') and coalesce(length(value->>'siteValue'), 0) <= 40)
);

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
    when 'imports' then site_role(p_site) = 'admin'
    else false end;
$$;

-- An asset import names its fleet; a new fleet name needs a fleets row. There was no insert
-- policy on fleets, so importing assets under a new fleet name failed for the Admin.
create policy fleets_write on fleets for insert with check (site_role(site_id) = 'admin');

-- New assets record the ERP they came from (was always maximo).
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
      a->>'externalAssetId', a->>'functionalLocation', coalesce(nullif(a->>'sourceSystem', ''), 'maximo'), auth.uid())
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

notify pgrst, 'reload schema';
