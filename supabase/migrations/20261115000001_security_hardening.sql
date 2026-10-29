-- Security review (phase 4 part 4, docs/a6-security.md). Findings fixed here:
-- S-1  Four "for all" policies let a site's Admin hard-delete codes, shop lines,
--      members and invites through the REST API (CLAUDE.md rule 5: nothing is
--      deleted). They become insert and update policies.
-- S-2  Belt and braces for rule 5: the app roles cannot delete or truncate any table.
-- S-3  The anon role (anyone with the public key) had table privileges and could
--      run every function. It now reaches only api_v1, which checks an API key.
--      Row-level security already returned nothing to anon; this removes the surface.
-- S-4  site_has_superintendent answered for any site id; it now answers only members.
-- The schema-wide checks in supabase/tests/security_audit.sql keep these true.

-- S-1
drop policy if exists admin_codes on codes;
create policy admin_codes_insert on codes for insert with check (site_role(site_id) = 'admin');
create policy admin_codes_update on codes for update using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');
drop policy if exists admin_lines on shop_lines;
create policy admin_lines_insert on shop_lines for insert with check (site_role(site_id) = 'admin');
create policy admin_lines_update on shop_lines for update using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');
drop policy if exists members_admin on site_members;
create policy members_admin_insert on site_members for insert with check (site_role(site_id) = 'admin');
create policy members_admin_update on site_members for update using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');
drop policy if exists site_invites_admin on site_invites;
create policy site_invites_admin_insert on site_invites for insert with check (site_role(site_id) = 'admin');
create policy site_invites_admin_update on site_invites for update using (site_role(site_id) = 'admin') with check (site_role(site_id) = 'admin');

-- S-2
revoke delete, truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke delete, truncate on tables from anon, authenticated;

-- S-3
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema public grant execute on functions to authenticated;
grant execute on function api_v1(text, jsonb) to anon;

-- S-4
create or replace function site_has_superintendent(p_site uuid, p_except uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_site_member(p_site) and exists (
    select 1 from site_members m
    where m.site_id = p_site and m.retired_at is null and m.id is distinct from p_except
      and (m.role = 'superintendent' or (m.acting_role = 'superintendent' and m.acting_until > now()))
  );
$$;
revoke execute on function site_has_superintendent(uuid, uuid) from public, anon;
grant execute on function site_has_superintendent(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
