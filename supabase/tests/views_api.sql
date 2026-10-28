-- Saved views API test: who can save, private stays private, fixed once saved,
-- retired (not deleted) by the author or a superintendent for a shared view.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000010', 'superintendent', '{*}', 'Sid', 'sid@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'viewer', '{*}', 'Vic', 'vic@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- A viewer cannot save a view.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_save_view('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000009", "name": "x", "query": ""}'::jsonb);
  raise exception 'viewer saved a view';
exception when insufficient_privilege then null; end $$;

-- Rae saves one private and one shared view.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
select app_save_view('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000001", "name": "Mine", "query": "shift=night", "shared": false}'::jsonb);
select app_save_view('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000002", "name": "Night vs day", "query": "shift=night", "shared": true}'::jsonb);

-- Sam sees only the shared one, and cannot retire it.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  if jsonb_array_length(app_load_views('10000000-0000-0000-0000-000000000002')) <> 1 then raise exception 'private view visible to another user'; end if;
end $$;
do $$ begin
  perform app_save_view('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000002", "retiredAt": "x", "retiredReason": "mine now"}'::jsonb);
  if (select retired_at from saved_views where id = '50000000-0000-0000-0000-000000000002') is not null then raise exception 'non-author retired a view'; end if;
exception when insufficient_privilege then null; end $$;

-- A view cannot be edited or deleted.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  update saved_views set name = 'Changed' where id = '50000000-0000-0000-0000-000000000001';
  raise exception 'view was edited';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from saved_views where id = '50000000-0000-0000-0000-000000000001';
  if found then raise exception 'view was deleted'; end if;
exception when insufficient_privilege then null; end $$;

-- The superintendent retires the shared view with a reason.
select pg_temp.as_user('a0000000-0000-0000-0000-000000000010');
select app_save_view('10000000-0000-0000-0000-000000000002', '{"id": "50000000-0000-0000-0000-000000000002", "retiredAt": "x", "retiredReason": "Replaced"}'::jsonb);
reset role;
do $$ begin
  if (select retired_by from saved_views where id = '50000000-0000-0000-0000-000000000002') <> 'a0000000-0000-0000-0000-000000000010' then raise exception 'retire not recorded'; end if;
  if (select count(*) from saved_views) <> 2 then raise exception 'a view went missing'; end if;
end $$;
rollback;
\o
\echo saved views API test passed
