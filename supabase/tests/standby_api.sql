-- Standby flags API test (docs/standby.md): who may raise them, one open per unit, never while down,
-- only ending or voiding afterwards, never deleted, and audited.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values
  ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT101'),
  ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT102');
insert into down_flags (tenant_id, site_id, asset_id, flag_type, state, reason_code, starts_at) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000006', 'unscheduled', 'open', 'ENG', now() - interval '2 hours');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'viewer', '{*}', 'Vic', 'vic@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
create function pg_temp.row(p_id text, p_asset text, p_state text, p_start interval, p_end interval) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'unitId', p_asset, 'reasonCode', 'NO_OPERATOR', 'kind', 'standby',
    'start', now() - p_start, 'end', case when p_end is null then null else now() - p_end end, 'state', p_state,
    'voidReason', case when p_state = 'voided' then 'Wrong truck' end));
$$;
set local role authenticated;

-- A viewer and an admin cannot raise standby.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'open', '30 minutes', null)));
  raise exception 'viewer raised standby';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'open', '30 minutes', null)));
  raise exception 'admin raised standby';
exception when insufficient_privilege then null; end $$;

-- A technician raises one; a second open one on the same unit fails.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'open', '30 minutes', null)));
do $$ begin
  perform app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', 'open', '10 minutes', null)));
  raise exception 'two open standby flags';
exception when unique_violation then null; end $$;

-- Not while down, not in the future, not more than 7 days back.
do $$ begin
  perform app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000006', 'open', '10 minutes', null)));
  raise exception 'standby while down';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000005', 'ended', '-1 hour', '-2 hours')));
  raise exception 'standby in the future';
exception when check_violation then null; end $$;
do $$ begin
  perform app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000005', 'ended', '8 days', '7 days 23 hours')));
  raise exception 'standby 8 days back';
exception when check_violation then null; end $$;

-- Ending it once works; the start cannot change, it cannot reopen, and the end cannot move again.
select app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'ended', '30 minutes', '5 minutes')));
do $$ begin
  update standby_flags set starts_at = now() - interval '1 hour' where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'start changed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update standby_flags set state = 'open', ends_at = null where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'reopened';
exception when insufficient_privilege or check_violation then null; end $$;
do $$ begin
  update standby_flags set ends_at = now() - interval '1 minute' where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'end moved';
exception when insufficient_privilege then null; end $$;

-- Voiding it with a reason works; after that nothing changes, and it is never deleted.
select app_save_standby('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.row('b0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000005', 'voided', '30 minutes', '5 minutes')));
do $$ begin
  update standby_flags set void_reason = 'changed' where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'voided flag changed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from standby_flags where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'deleted';
exception when others then if sqlerrm = 'deleted' then raise; end if; end $$;

-- Who and when are set by the database; the viewer reads it; load returns it.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  if jsonb_array_length(app_load_standby('10000000-0000-0000-0000-000000000002')) <> 1 then raise exception 'viewer cannot load'; end if;
end $$;
reset role;
do $$ begin
  if (select set_by from standby_flags where id = 'b0000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000c' then raise exception 'set_by not the signed-in person'; end if;
  if (select voided_by from standby_flags where id = 'b0000000-0000-0000-0000-000000000001') is null then raise exception 'voided_by not set'; end if;
  if (select count(*) from audit_log where entity = 'standby_flags') < 3 then raise exception 'not audited'; end if;
end $$;
rollback;
\o
\echo Standby API test passed
