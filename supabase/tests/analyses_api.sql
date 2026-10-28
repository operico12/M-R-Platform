-- Saved analyses API test: who can save, fixed once saved, void with a reason,
-- links stay inside the site, never deleted.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver'),
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Other mine', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values
  ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT107'),
  ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'HT900');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-00000000000a', 'reliability_engineer', '{*}', 'Oz', 'oz@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- A technician cannot save an analysis.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_save_analysis('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000009", "calculator": "inherent_availability",
    "version": 1, "title": "x", "inputs": {}, "result": {}}'::jsonb);
  raise exception 'technician saved an analysis';
exception when insufficient_privilege then null; end $$;

-- A link to a unit at another site is refused.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  perform app_save_analysis('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000008", "calculator": "weibull",
    "version": 1, "title": "x", "inputs": {}, "result": {}, "links": {"unitId": "10000000-0000-0000-0000-000000000006"}}'::jsonb);
  raise exception 'linked a unit at another site';
exception when insufficient_privilege then null; end $$;

-- The reliability engineer saves one; author and time come from the database.
select app_save_analysis('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000001", "calculator": "weibull", "version": 1,
  "title": "HT107 wheel motor", "inputs": {"data": [{"t": 1200, "failed": true}]}, "result": {"beta": 2.155, "eta": 4868}, "sentence": "Wearing out.",
  "dataNote": "Typed in", "links": {"unitId": "10000000-0000-0000-0000-000000000005"}, "createdBy": "a0000000-0000-0000-0000-00000000000d"}'::jsonb);
do $$ begin
  if (select created_by from saved_analyses where id = '40000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000e' then raise exception 'author not set'; end if;
end $$;

-- It cannot be edited or deleted.
do $$ begin
  update saved_analyses set title = 'Changed' where id = '40000000-0000-0000-0000-000000000001';
  raise exception 'analysis was edited';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from saved_analyses where id = '40000000-0000-0000-0000-000000000001';
  if found then raise exception 'analysis was deleted'; end if;
exception when insufficient_privilege then null; end $$;

-- A viewer at the site reads it; someone from another site does not.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  if jsonb_array_length(app_load_analyses('10000000-0000-0000-0000-000000000002')) <> 1 then raise exception 'viewer cannot read'; end if;
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  if jsonb_array_length(app_load_analyses('10000000-0000-0000-0000-000000000002')) <> 0 then raise exception 'outsider can read'; end if;
end $$;

-- Voiding needs a reason; once voided it is fixed.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  perform app_save_analysis('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000001", "voidedAt": "2026-10-28T00:00:00Z", "voidReason": "  "}'::jsonb);
  raise exception 'voided without a reason';
exception when check_violation or insufficient_privilege then null; end $$;
select app_save_analysis('10000000-0000-0000-0000-000000000002', '{"id": "40000000-0000-0000-0000-000000000001", "voidedAt": "2026-10-28T00:00:00Z", "voidReason": "Wrong unit"}'::jsonb);
do $$ begin
  if (select voided_by from saved_analyses where id = '40000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000e' then raise exception 'void not recorded'; end if;
  update saved_analyses set void_reason = 'Other' where id = '40000000-0000-0000-0000-000000000001';
  raise exception 'voided analysis changed';
exception when insufficient_privilege then null; end $$;

reset role;
do $$ declare n int; begin
  select count(*) into n from audit_log where entity = 'saved_analyses';
  if n < 2 then raise exception 'expected at least 2 audit entries, got %', n; end if;
end $$;
rollback;
\o
\echo saved analyses API test passed
