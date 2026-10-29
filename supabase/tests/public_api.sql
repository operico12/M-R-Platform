-- Public API test (docs/public-api.md): only the Admin makes and revokes keys; the
-- key is returned once and only its hash is kept; api_v1 reads only the key's
-- site and scopes; bad, revoked and expired keys get the same answer; 60 calls a minute.
\set QUIET on
\o /dev/null
begin;
grant usage on schema public to anon;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver'),
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Mine B', 'America/Edmonton');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'superintendent', '{*}', 'Sol', 'sol@example.com');
insert into assets (id, tenant_id, site_id, unit_number) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT101'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT102'),
  ('20000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'B900');
insert into down_flags (id, tenant_id, site_id, asset_id, flag_type, state, reason_code, starts_at, ends_at, void_reason) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'unscheduled', 'open', 'BRK', '2026-10-28T10:00:00Z', null, null),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'scheduled', 'released', 'PM', '2026-10-01T10:00:00Z', '2026-10-01T20:00:00Z', null),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'unscheduled', 'voided', 'BRK', '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z', 'Entered twice'),
  ('40000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000009', 'unscheduled', 'released', 'BRK', '2026-10-01T10:00:00Z', '2026-10-01T12:00:00Z', null);
insert into flag_stage_intervals (tenant_id, site_id, flag_id, stage, starts_at) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'waiting_crew', '2026-10-28T10:00:00Z');
insert into work_orders (id, tenant_id, site_id, asset_id, source_system, source_id, number, number_normalised, wo_type, status, labour_cost)
select ('50000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001', 'maximo', 'WO' || i, 'WO' || i, i::text, 'CM', 'APPR', 1000
from generate_series(1, 5) i;

create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
create function pg_temp.with_key(p_key text) returns void language sql as $$
  select set_config('request.headers', json_build_object('x-mr-api-key', p_key)::text, true);
$$;
create temp table made (site text, key text, id uuid);
grant all on made to anon, authenticated;

set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_create_api_key('10000000-0000-0000-0000-000000000002', 'Dashboard', array['units'], 365);
  raise exception 'a superintendent made a key';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_create_api_key('10000000-0000-0000-0000-000000000003', 'Dashboard', array['units'], 365);
  raise exception 'a key was made for a site the admin is not admin of';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_create_api_key('10000000-0000-0000-0000-000000000002', 'Dashboard', array['cost'], 365);
  raise exception 'an unknown scope was allowed';
exception when check_violation then null; end $$;
do $$ begin
  perform app_create_api_key('10000000-0000-0000-0000-000000000002', 'Dashboard', array['units'], 731);
  raise exception 'a 731-day key was allowed';
exception when check_violation then null; end $$;
insert into made select 'a', r->>'key', (r->>'id')::uuid from (select app_create_api_key('10000000-0000-0000-0000-000000000002', 'Dashboard', array['units', 'flags', 'units'], 365) r) x;
insert into made select 'wo', r->>'key', (r->>'id')::uuid from (select app_create_api_key('10000000-0000-0000-0000-000000000002', 'Warehouse', array['work_orders', 'smu'], 30) r) x;
do $$ begin
  if (select key from made where site = 'a') !~ '^mrk_[0-9a-f]{64}$' then raise exception 'bad key format'; end if;
  if (select count(*) from app_api_keys('10000000-0000-0000-0000-000000000002')) <> 2 then raise exception 'the admin should see 2 keys'; end if;
  if (select scopes from app_api_keys('10000000-0000-0000-0000-000000000002') where name = 'Dashboard') <> array['flags', 'units'] then raise exception 'scopes not cleaned'; end if;
end $$;
do $$ begin
  perform key_hash from api_keys;
  raise exception 'the app can read key hashes';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  if (select count(*) from app_api_keys('10000000-0000-0000-0000-000000000002')) <> 0 then raise exception 'a non-admin sees keys'; end if;
end $$;

-- Other systems call as anon.
set local role anon;
select pg_temp.as_user('');
do $$ begin
  perform 1 from api_keys;
  raise exception 'anon can read keys';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform 1 from down_flags;
  raise exception 'anon can read flags';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform app_create_api_key('10000000-0000-0000-0000-000000000002', 'x', array['units'], 1);
  raise exception 'anon made a key';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform api_v1('units');
  raise exception 'no key was accepted';
exception when sqlstate 'PT401' then null; end $$;
select pg_temp.with_key('mrk_' || repeat('0', 64));
do $$ begin
  perform api_v1('units');
  raise exception 'an unknown key was accepted';
exception when sqlstate 'PT401' then null; end $$;
select pg_temp.with_key((select key from made where site = 'a'));
do $$
declare r jsonb := api_v1('units');
begin
  if jsonb_array_length(r->'data') <> 2 then raise exception 'units should be 2 (this site only), got %', r->'data'; end if;
  if r->'data'->0->>'status' <> 'down' or r->'data'->0->'down_flag'->>'stage' <> 'waiting_crew' then raise exception 'HT101 should be down, waiting for crew: %', r->'data'->0; end if;
  if r->'data'->1->>'status' <> 'up' then raise exception 'HT102 should be up'; end if;
  if r->'site'->>'time_zone' <> 'America/Vancouver' or (r->>'api_version')::int <> 1 then raise exception 'bad envelope %', r; end if;
end $$;
do $$
declare r jsonb := api_v1('flags', '{"from": "2026-10-01T00:00:00Z", "to": "2026-10-29T00:00:00-07:00"}');
begin
  if jsonb_array_length(r->'data') <> 2 then raise exception 'flags: voided and other-site flags must be left out, got %', r->'data'; end if;
  if r->'data'->1->'stages'->0->>'stage' <> 'waiting_crew' then raise exception 'stages missing'; end if;
end $$;
do $$ begin
  perform api_v1('flags', '{"from": "2026-10-01", "to": "2026-10-29T00:00:00Z"}');
  raise exception 'a time without an offset was allowed';
exception when sqlstate 'PT400' then null; end $$;
do $$ begin
  perform api_v1('flags', '{"from": "2026-01-01T00:00:00Z", "to": "2026-06-01T00:00:00Z"}');
  raise exception 'a 151-day window was allowed';
exception when sqlstate 'PT400' then null; end $$;
do $$ begin
  perform api_v1('work_orders', '{"changed_since": "2026-01-01T00:00:00Z"}');
  raise exception 'a key read outside its scopes';
exception when sqlstate 'PT403' then null; end $$;
select pg_temp.with_key((select key from made where site = 'wo'));
do $$
declare r jsonb := api_v1('work_orders', '{"changed_since": "2026-01-01T00:00:00Z", "limit": 2}');
declare n int := jsonb_array_length(r->'data');
declare seen text[] := array[]::text[];
begin
  seen := seen || array(select x->>'number' from jsonb_array_elements(r->'data') x);
  while r->>'next_cursor' is not null loop
    r := api_v1('work_orders', jsonb_build_object('changed_since', '2026-01-01T00:00:00Z', 'limit', 2, 'cursor', r->>'next_cursor'));
    seen := seen || array(select x->>'number' from jsonb_array_elements(r->'data') x);
  end loop;
  if cardinality(seen) <> 5 or (select count(distinct x) from unnest(seen) x) <> 5 then raise exception 'pages should give 5 different orders, got %', seen; end if;
  if r->'data'->0 ? 'labour_cost' then raise exception 'cost was returned'; end if;
end $$;
-- 3 calls so far with this key (three pages); 57 more fit in the minute, the next is refused.
do $$ begin
  for i in 1..57 loop perform api_v1('smu', '{"from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00Z"}'); end loop;
end $$;
do $$ begin
  perform api_v1('smu', '{"from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00Z"}');
  raise exception 'call 61 in a minute was allowed';
exception when sqlstate 'PT429' then null; end $$;

-- Revoked and expired keys get the same answer as unknown ones.
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_revoke_api_key((select id from made where site = 'a'), ' ');
  raise exception 'a revoke without a reason was allowed';
exception when check_violation then null; end $$;
select app_revoke_api_key((select id from made where site = 'a'), 'Dashboard retired');
set local role anon;
select pg_temp.as_user('');
select pg_temp.with_key((select key from made where site = 'a'));
do $$ begin
  perform api_v1('units');
  raise exception 'a revoked key was accepted';
exception when sqlstate 'PT401' then null; end $$;
reset role;
update api_keys set expires_at = now() - interval '1 second' where id = (select id from made where site = 'wo');
set local role anon;
select pg_temp.with_key((select key from made where site = 'wo'));
do $$ begin
  perform api_v1('smu', '{"from": "2026-10-01T00:00:00Z", "to": "2026-10-02T00:00:00Z"}');
  raise exception 'an expired key was accepted';
exception when sqlstate 'PT401' then null; end $$;
reset role;
do $$ begin
  if (select count(*) from api_keys) <> 2 then raise exception 'keys must never be deleted'; end if;
  if exists (select 1 from api_keys k join made m on m.id = k.id where k.prefix <> left(m.key, 12) or k.key_hash <> sha256(convert_to(m.key, 'UTF8'))) then raise exception 'hash or prefix wrong'; end if;
  if exists (select 1 from audit_log where after::text like '%' || (select key from made where site = 'a') || '%') then raise exception 'the key is in the audit log'; end if;
  if (select count(*) from audit_log where entity = 'api_key') <> 3 then raise exception 'expected 3 api key audit rows'; end if;
  if (select count(*) from api_calls) <> 62 then raise exception 'expected 62 logged calls (2 + 60; refused calls are not logged), got %', (select count(*) from api_calls); end if;
end $$;
rollback;
\o
\echo Public API test passed
