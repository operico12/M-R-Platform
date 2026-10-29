-- Schema-wide security checks (docs/a6-security.md). They run over every table,
-- policy and function, so a new migration that breaks a rule fails here.
\set QUIET on
\o /dev/null
do $$
declare bad text;
begin
  -- Rule 6: row-level security on every table, and tenant and site IDs (tenants and sites are the roots).
  select string_agg(c.relname, ', ') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then raise exception 'Tables without row-level security: %', bad; end if;
  select string_agg(t.table_name, ', ') into bad from information_schema.tables t
  where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name not in ('tenants', 'sites')
    and (not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'site_id')
      or not exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'tenant_id'));
  if bad is not null then raise exception 'Tables without tenant_id and site_id: %', bad; end if;

  -- Rule 5: nothing is deleted. No delete policies, no delete or truncate rights for the app roles, no cascades.
  select string_agg(tablename || '.' || policyname, ', ') into bad from pg_policies where schemaname = 'public' and cmd in ('DELETE', 'ALL');
  if bad is not null then raise exception 'Policies that allow deletes: %', bad; end if;
  select string_agg(distinct table_name || ' (' || grantee || ')', ', ') into bad from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('DELETE', 'TRUNCATE');
  if bad is not null then raise exception 'App roles that can delete: %', bad; end if;
  select string_agg(conrelid::regclass::text || '.' || conname, ', ') into bad from pg_constraint
  where contype = 'f' and connamespace = 'public'::regnamespace and confdeltype in ('c', 'n', 'd');
  if bad is not null then raise exception 'Foreign keys that cascade or clear on delete: %', bad; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'audit_log'::regclass and tgname = 'audit_log_no_update') then
    raise exception 'The audit log can be edited.';
  end if;

  -- Rule 8: deny by default. No policy is open to everyone.
  select string_agg(tablename || '.' || policyname, ', ') into bad from pg_policies
  where schemaname = 'public' and (coalesce(qual, '') in ('', 'true') and coalesce(with_check, '') in ('', 'true'));
  if bad is not null then raise exception 'Policies open to everyone: %', bad; end if;

  -- Read rules check membership once per query, not once per row (S-11).
  select string_agg(tablename || '.' || policyname, ', ') into bad from pg_policies
  where schemaname = 'public' and (coalesce(qual, '') like '%is_site_member(site_id)%' or coalesce(with_check, '') like '%is_site_member(site_id)%');
  if bad is not null then raise exception 'Policies that call is_site_member per row (use site_id in (select my_site_ids())): %', bad; end if;

  -- Functions that run with the owner's rights fix their search path and check who is calling.
  select string_agg(p.proname, ', ') into bad from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) x where x like 'search_path=%');
  if bad is not null then raise exception 'Security definer functions without a search path: %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prorettype <> 'trigger'::regtype
    and p.prosrc !~ '(is_site_member|site_role|auth\.uid\(\)|key_hash)';
  if bad is not null then raise exception 'Security definer functions that do not check the caller: %', bad; end if;

  -- The public (anon) key reaches nothing but the API, which checks its own key.
  select string_agg(distinct table_name, ', ') into bad from information_schema.role_table_grants
  where table_schema = 'public' and grantee = 'anon';
  if bad is not null then raise exception 'Tables anon can reach: %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname <> 'api_v1' and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'Functions anon can run: %', bad; end if;
end $$;
\o
\echo Security audit passed
