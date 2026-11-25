-- Flag comments API test (docs/flag-comments.md): who may add them, open or released flags only, the wait tag
-- must be on the same flag, never edited, voided once with a reason by the author or a supervisor, never
-- deleted, author and time set by the database, audited.
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
  ('d0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000006', 'unscheduled', 'proposed', 'ENG', now() - interval '1 hour', null);
insert into wait_tags (id, tenant_id, site_id, asset_id, down_flag_id, kind, starts_at, state, set_by) values
  ('e0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000002', 'PARTS', now() - interval '2 hours', 'open', 'a0000000-0000-0000-0000-00000000000c'),
  ('e0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000001', 'TOW', now() - interval '5 hours', 'open', 'a0000000-0000-0000-0000-00000000000c');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'technician', '{*}', 'Tom', 'tom@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000f', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'viewer', '{*}', 'Vic', 'vic@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
create function pg_temp.row(p_id text, p_flag text, p_text text, p_wait text default null, p_state text default 'active') returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'unitId', (select asset_id from down_flags where id = p_flag::uuid), 'downFlagId', p_flag,
    'waitTagId', p_wait, 'text', p_text, 'state', p_state, 'voidReason', case when p_state = 'voided' then 'Wrong truck' end));
$$;
create function pg_temp.save(p jsonb) returns void language sql as $$ select app_save_comments('10000000-0000-0000-0000-000000000002', jsonb_build_array(p)); $$;
set local role authenticated;

-- A viewer and an admin cannot comment.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  perform pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'hello'));
  raise exception 'viewer commented';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'hello'));
  raise exception 'admin commented';
exception when insufficient_privilege then null; end $$;

-- A technician comments on the open flag, on its wait tag, and on a released flag.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'Lowboy booked for 14:00'));
select pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'Part 1234 on the 14:00 truck', 'e0000000-0000-0000-0000-000000000001'));
select pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000001', 'Root cause confirmed by the lab'));

-- Not on a proposed flag, not on a wait tag of another flag, not empty.
do $$ begin
  perform pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000003', 'x'));
  raise exception 'comment on a proposed flag';
exception when check_violation then null; end $$;
do $$ begin
  perform pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002', 'x', 'e0000000-0000-0000-0000-000000000002'));
  raise exception 'wait tag of another flag';
exception when check_violation then null; end $$;
do $$ begin
  perform pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000002', '   '));
  raise exception 'empty comment';
exception when check_violation then null; end $$;

-- A comment cannot be edited, even by its author.
do $$ begin
  update flag_comments set body = 'changed' where id = 'c0000000-0000-0000-0000-000000000001';
  raise exception 'comment edited';
exception when insufficient_privilege then null; end $$;

-- Another technician cannot void it; the author can; a supervisor can void someone else's.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  perform pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'Lowboy booked for 14:00', null, 'voided'));
  raise exception 'a stranger voided it';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
select pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002', 'Lowboy booked for 14:00', null, 'voided'));
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000f');
select pg_temp.save(pg_temp.row('c0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'Part 1234 on the 14:00 truck', 'e0000000-0000-0000-0000-000000000001', 'voided'));

-- Voiding needs a reason, and a voided comment never changes or reopens. Nothing is deleted.
do $$ begin
  update flag_comments set state = 'voided', void_reason = null where id = 'c0000000-0000-0000-0000-000000000003';
  raise exception 'voided without a reason';
exception when check_violation then null; end $$;
do $$ begin
  update flag_comments set void_reason = 'changed' where id = 'c0000000-0000-0000-0000-000000000001';
  raise exception 'voided comment changed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update flag_comments set state = 'active', void_reason = null, voided_by = null where id = 'c0000000-0000-0000-0000-000000000001';
  raise exception 'reopened';
exception when insufficient_privilege or check_violation then null; end $$;
do $$ begin
  delete from flag_comments where id = 'c0000000-0000-0000-0000-000000000003';
  raise exception 'deleted';
exception when others then if sqlerrm = 'deleted' then raise; end if; end $$;

-- The viewer reads the whole thread, voided ones included; author, time and void details are set by the database; audited.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
do $$ begin
  if jsonb_array_length(app_load_comments('10000000-0000-0000-0000-000000000002')) <> 3 then raise exception 'viewer loads %', jsonb_array_length(app_load_comments('10000000-0000-0000-0000-000000000002')); end if;
end $$;
reset role;
do $$ begin
  if (select set_by from flag_comments where id = 'c0000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000c' then raise exception 'set_by not the signed-in person'; end if;
  if (select voided_by from flag_comments where id = 'c0000000-0000-0000-0000-000000000002') <> 'a0000000-0000-0000-0000-00000000000f' then raise exception 'voided_by not the supervisor'; end if;
  if (select voided_at from flag_comments where id = 'c0000000-0000-0000-0000-000000000001') is null then raise exception 'voided_at not set'; end if;
  if (select count(*) from audit_log where entity = 'flag_comments') < 5 then raise exception 'not audited'; end if;
end $$;
rollback;
\o
\echo Flag comments API test passed
