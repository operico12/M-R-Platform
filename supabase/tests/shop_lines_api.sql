-- Shop lines API test (docs/shop-lines.md): only the Admin adds, edits and retires lines; a shop is made
-- when missing; two open lines cannot share a number; closures are opened by supervisors and up and may
-- only be ended once; nothing is deleted; everything is audited.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tia', 'tia@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
create function pg_temp.line(p_id text, p_number int, p_retired boolean default false) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('id', p_id, 'number', p_number, 'lineType', 'general', 'capacity', 1, 'fits', '[]'::jsonb, 'shop', 'Truck shop',
    'retiredAt', case when p_retired then now() end, 'retiredReason', case when p_retired then 'Bay rebuilt' end));
$$;
set local role authenticated;

-- A supervisor cannot add lines; the Admin can, and the shop is made.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  perform app_save_lines('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.line('c0000000-0000-0000-0000-000000000001', 1)));
  raise exception 'supervisor added a line';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_save_lines('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.line('c0000000-0000-0000-0000-000000000001', 1), pg_temp.line('c0000000-0000-0000-0000-000000000002', 2)));
do $$ begin
  if (select count(*) from shop_lines where retired_at is null) <> 2 then raise exception 'lines not added'; end if;
  if (select count(*) from shops) <> 1 or (select name from shops) <> 'Truck shop' then raise exception 'shop not made'; end if;
end $$;
-- Two open lines cannot share a number.
do $$ begin
  perform app_save_lines('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.line('c0000000-0000-0000-0000-000000000003', 2)));
  raise exception 'duplicate number allowed';
exception when unique_violation then null; end $$;
-- Retire line 2 with a reason; a retired line is not brought back or changed.
select app_save_lines('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.line('c0000000-0000-0000-0000-000000000002', 2, true)));
select app_save_lines('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.line('c0000000-0000-0000-0000-000000000002', 9)));
do $$ begin
  if (select retired_reason from shop_lines where id = 'c0000000-0000-0000-0000-000000000002') <> 'Bay rebuilt' then raise exception 'not retired'; end if;
  if (select number from shop_lines where id = 'c0000000-0000-0000-0000-000000000002') <> 2 then raise exception 'retired line changed'; end if;
end $$;
-- Its number can be used again by a new line.
select app_save_lines('10000000-0000-0000-0000-000000000002', jsonb_build_array(pg_temp.line('c0000000-0000-0000-0000-000000000003', 2)));

-- Closures: a technician cannot close a line; a supervisor can, and may only end it once.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_closures('10000000-0000-0000-0000-000000000002', jsonb_build_array(jsonb_build_object('id', 'd0000000-0000-0000-0000-000000000001',
    'lineId', 'c0000000-0000-0000-0000-000000000001', 'start', now(), 'reason', 'Crane')));
  raise exception 'technician closed a line';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_save_closures('10000000-0000-0000-0000-000000000002', jsonb_build_array(jsonb_build_object('id', 'd0000000-0000-0000-0000-000000000001',
  'lineId', 'c0000000-0000-0000-0000-000000000001', 'start', now() - interval '1 hour', 'reason', 'Crane inspection')));
select app_save_closures('10000000-0000-0000-0000-000000000002', jsonb_build_array(jsonb_build_object('id', 'd0000000-0000-0000-0000-000000000001',
  'lineId', 'c0000000-0000-0000-0000-000000000001', 'start', now() - interval '1 hour', 'end', now(), 'reason', 'Crane inspection')));
do $$ begin
  update shop_line_closures set ends_at = now() - interval '10 minutes';
  raise exception 'closure ended twice';
exception when check_violation then null; end $$;
do $$ begin
  if jsonb_array_length(app_load_closures('10000000-0000-0000-0000-000000000002')) <> 1 then raise exception 'closures not loaded'; end if;
end $$;

-- Nothing is deleted; every change audited.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  delete from shop_lines;
  if found then raise exception 'line deleted'; end if;
exception when insufficient_privilege then null; end $$;
reset role;
do $$ begin
  if (select count(*) from shop_lines) <> 3 then raise exception 'lines must never be deleted'; end if;
  if (select count(*) from audit_log where entity = 'shop_lines') < 4 then raise exception 'lines not audited (%)', (select count(*) from audit_log where entity = 'shop_lines'); end if;
  if (select count(*) from audit_log where entity = 'shop_line_closures') < 2 then raise exception 'closures not audited'; end if;
end $$;
rollback;
\o
\echo Shop lines API test passed
