-- Audit page API test: the full log for superintendent and admin only.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');
-- Adding the members above wrote site_members rows to the audit log. Add a flag change as well.
insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after)
values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'release', 'down_flag', gen_random_uuid(), '{}', '{}');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ declare d jsonb := app_load_audit('10000000-0000-0000-0000-000000000002', now() - interval '1 day', now() + interval '1 day'); begin
  if not exists (select 1 from jsonb_array_elements(d) e where e->>'entity' = 'site_members') then raise exception 'admin cannot see user changes: %', d; end if;
  if not exists (select 1 from jsonb_array_elements(d) e where e->>'entity' = 'down_flag') then raise exception 'admin cannot see flag changes'; end if;
end $$;

select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ declare d jsonb := app_load_audit('10000000-0000-0000-0000-000000000002', now() - interval '1 day', now() + interval '1 day'); begin
  if exists (select 1 from jsonb_array_elements(d) e where e->>'entity' = 'site_members') then raise exception 'viewer can see user changes'; end if;
  if jsonb_array_length(d) <> 1 or d->0->>'entity' <> 'down_flag' then raise exception 'viewer should see flag history only: %', d; end if;
end $$;
rollback;
\o
\echo audit API test passed
