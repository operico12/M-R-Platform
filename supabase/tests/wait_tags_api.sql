-- Wait tags API test (docs/wait-tags.md): only on a down unit, several kinds at once, one open
-- per kind, not before the stop, only ended or voided afterwards, never deleted, and audited.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values
  ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT101'),
  ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT102');
insert into down_flags (id, tenant_id, site_id, asset_id, flag_type, state, reason_code, starts_at, ends_at) values
  ('d0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', 'scheduled', 'released', 'PM', now() - interval '6 hours', now() - interval '3 hours'),
  ('d0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', 'unscheduled', 'open', 'ENG', now() - interval '3 hours', null),
  ('d0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000006', 'unscheduled', 'released', 'ENG', now() - interval '5 hours', now() - interval '4 hours');
update down_flags set linked_from_flag_id = 'd0000000-0000-0000-0000-000000000001', link_kind = 'type_switch' where id = 'd0000000-0000-0000-0000-000000000002';
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'viewer', '{*}', 'Vic', 'vic@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
create function pg_temp.row(p_id text, p_flag text, p_kind text, p_state text, p_start interval, p_end interval, p_note text default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'unitId', (select asset_id from down_flags where id = p_flag::uuid), 'downFlagId', p_flag,
    'kind', p_kind, 'start', now() - p_start, 'end', case when p_end is null then null else now() - p_end end, 'state', p_state, 'note', p_note,
    'voidReason', case when p_state = 'voided' then 'Wrong unit' end));
$$;
create function pg_temp.save(p jsonb) returns void language sql as $$ select app_save_waits('10000000-0000-0000-0000-000000000002', jsonb_build_array(p)); $$;
set local role authenticated;

-- A viewer and an admin cannot raise a wait.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'PARTS', 'open', '1 hour', null));
  raise exception 'viewer raised a wait';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'PARTS', 'open', '1 hour', null));
  raise exception 'admin raised a wait';
exception when insufficient_privilege then null; end $$;

-- A technician raises parts and labour at once; a second open parts wait fails.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'PARTS', 'open', '1 hour', null));
select pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'LABOUR', 'open', '30 minutes', null));
do $$ begin
  perform pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002', 'PARTS', 'open', '10 minutes', null));
  raise exception 'two open parts waits';
exception when unique_violation then null; end $$;

-- A type switch keeps the stop: a wait from before the second flag but after the first is fine.
select pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002', 'TOW', 'ended', '5 hours', '4 hours'));

-- Not on a released flag, not before the stop, not in the future, not more than 7 days back, Other needs a note.
do $$ begin
  perform pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000003', 'PARTS', 'open', '30 minutes', null));
  raise exception 'wait on a unit that is up';
exception when check_violation then null; end $$;
do $$ begin
  perform pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000002', 'TOOLS', 'open', '7 hours', null));
  raise exception 'wait before the stop';
exception when check_violation then null; end $$;
do $$ begin
  perform pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000002', 'TOOLS', 'open', '-1 hour', null));
  raise exception 'wait in the future';
exception when check_violation then null; end $$;
do $$ begin
  perform pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000002', 'OTHER', 'open', '10 minutes', null));
  raise exception 'Other with no note';
exception when check_violation then null; end $$;
select pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000002', 'OTHER', 'open', '10 minutes', null, 'Waiting on the client'));

-- Ending once works; the start cannot change, it cannot reopen, the end cannot move again.
select pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'PARTS', 'ended', '1 hour', '5 minutes'));
do $$ begin
  update wait_tags set starts_at = now() - interval '2 hours' where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'start changed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update wait_tags set state = 'open', ends_at = null where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'reopened';
exception when insufficient_privilege or check_violation then null; end $$;
do $$ begin
  update wait_tags set ends_at = now() - interval '1 minute' where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'end moved';
exception when insufficient_privilege then null; end $$;

-- Voiding with a reason works; after that nothing changes, and it is never deleted.
select pg_temp.save(pg_temp.row('b0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'LABOUR', 'voided', '30 minutes', null));
do $$ begin
  update wait_tags set void_reason = 'changed' where id = 'b0000000-0000-0000-0000-000000000002';
  raise exception 'voided wait changed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from wait_tags where id = 'b0000000-0000-0000-0000-000000000001';
  raise exception 'deleted';
exception when others then if sqlerrm = 'deleted' then raise; end if; end $$;

-- The viewer reads them; who and when are set by the database; audited.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  if jsonb_array_length(app_load_waits('10000000-0000-0000-0000-000000000002')) <> 4 then raise exception 'viewer loads %', jsonb_array_length(app_load_waits('10000000-0000-0000-0000-000000000002')); end if;
end $$;
reset role;
do $$ begin
  if (select set_by from wait_tags where id = 'b0000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000c' then raise exception 'set_by not the signed-in person'; end if;
  if (select ended_by from wait_tags where id = 'b0000000-0000-0000-0000-000000000001') is null then raise exception 'ended_by not set'; end if;
  if (select voided_by from wait_tags where id = 'b0000000-0000-0000-0000-000000000002') is null then raise exception 'voided_by not set'; end if;
  if (select count(*) from audit_log where entity = 'wait_tags') < 6 then raise exception 'not audited'; end if;
end $$;
rollback;
\o
\echo Wait tags API test passed
