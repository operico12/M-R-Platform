-- Row-level security on tenants too, so no table in the public schema is
-- readable through the Data API without a policy. A signed-in person sees only
-- the tenant of a site they belong to; nobody changes tenants from the app.
alter table tenants enable row level security;
create policy tenants_read on tenants for select using (
  exists (select 1 from sites s where s.tenant_id = tenants.id and is_site_member(s.id))
);
revoke insert, update, delete on tenants from anon, authenticated;
