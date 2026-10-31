-- Admin full control (docs/access.md section 4): only an Admin, only in test mode, only with no other
-- role picked. Passes role checks (flags, approvals of their own request); the data rules still hold.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver');
insert into assets (id, tenant_id, site_id, unit_number) values ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'HT107');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'superintendent', '{*}', 'Sue', 'sue@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id, 'aal', 'aal1')::text, true);
$$;
create function pg_temp.flag(p_id text) returns jsonb language sql as $$
  select format('[{"id": "%s", "siteId": "10000000-0000-0000-0000-000000000002", "unitId": "10000000-0000-0000-0000-000000000005",
    "type": "unscheduled", "state": "open", "reasonCode": "Hydraulics", "start": "2026-10-26T15:02:00Z",
    "stages": [{"stage": "waiting_crew", "start": "2026-10-26T15:02:00Z"}],
    "locations": [{"kind": "field", "start": "2026-10-26T15:02:00Z", "fieldLocation": "Pit 2"}], "etas": [], "workOrders": []}]', p_id)::jsonb;
$$;
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');

-- Test mode off: the Admin keeps the matrix, so cannot flag a unit down.
do $$ begin
  if admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'full control with test mode off'; end if;
  perform app_save_flags('10000000-0000-0000-0000-000000000002', pg_temp.flag('20000000-0000-0000-0000-000000000001'));
  raise exception 'Admin flagged down with test mode off';
exception when insufficient_privilege then null; end $$;

-- Test mode on: full control. Flags a unit down, and a superintendent-only setting is open.
insert into site_settings (tenant_id, site_id, key, value, reason) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'access',
  '{"requestDomains": [], "adminMfa": false, "sessionDays": 30, "idleDays": 7, "testMode": true}', 'Testing');
do $$ begin
  if not admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'no full control in test mode'; end if;
  if not can_write_setting('10000000-0000-0000-0000-000000000002', 'work') then raise exception 'work settings closed'; end if;
end $$;
select app_save_flags('10000000-0000-0000-0000-000000000002', pg_temp.flag('20000000-0000-0000-0000-000000000001'));
do $$ begin
  if not exists (select 1 from down_flags where id = '20000000-0000-0000-0000-000000000001') then raise exception 'flag not saved'; end if;
end $$;

-- One account asks for a target and approves it.
select app_save_requests('10000000-0000-0000-0000-000000000002', '[{"id": "c0000000-0000-0000-0000-000000000001", "kind": "target", "title": "PA 88%", "reason": "Test",
  "payload": {"kind": "target", "input": {"kpi": "pa", "fleet": "Haul trucks", "value": 0.88, "amber": 0.03, "from": "next_shift"}}}]'::jsonb);
update change_requests set status = 'approved' where id = 'c0000000-0000-0000-0000-000000000001';
do $$ begin
  if (select status::text || decided_by::text from change_requests where id = 'c0000000-0000-0000-0000-000000000001') <> 'approveda0000000-0000-0000-0000-00000000000a' then
    raise exception 'own approval not recorded';
  end if;
end $$;

-- The data rules still hold: a decided request stays decided, nothing is deleted, the change is audited.
do $$ begin
  update change_requests set status = 'pending' where id = 'c0000000-0000-0000-0000-000000000001';
  raise exception 'reopened a decided request';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from down_flags where id = '20000000-0000-0000-0000-000000000001';
  raise exception 'deleted a flag';
exception when insufficient_privilege then null; end $$;
reset role;
do $$ begin
  if not exists (select 1 from down_flags where id = '20000000-0000-0000-0000-000000000001') then raise exception 'flag deleted'; end if;
  if not exists (select 1 from audit_log where entity_id = 'c0000000-0000-0000-0000-000000000001' and user_id = 'a0000000-0000-0000-0000-00000000000a') then raise exception 'approval not audited'; end if;
end $$;
set local role authenticated;

-- Testing as another role ends full control until the Admin goes back.
select app_set_test_role('10000000-0000-0000-0000-000000000002', 'supervisor');
do $$ begin
  if admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'full control while testing as a supervisor'; end if;
  if can_write_setting('10000000-0000-0000-0000-000000000002', 'work') then raise exception 'supervisor wrote work settings'; end if;
end $$;
select app_set_test_role('10000000-0000-0000-0000-000000000002', null);
do $$ begin
  if not admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'full control not back'; end if;
end $$;

-- Nobody else gets it, in test mode or not.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
do $$ begin
  if admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'a supervisor has full control'; end if;
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  if admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'a superintendent has full control'; end if;
end $$;

-- Two-step sign-in comes first, and test mode off ends it.
reset role;
update site_settings set value = value || '{"adminMfa": true}' where key = 'access';
set local role authenticated;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  if admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'full control before the code check'; end if;
end $$;
reset role;
update site_settings set value = value || '{"adminMfa": false, "testMode": false}' where key = 'access';
set local role authenticated;
do $$ begin
  if admin_full('10000000-0000-0000-0000-000000000002') then raise exception 'full control after test mode off'; end if;
  if can_write_setting('10000000-0000-0000-0000-000000000002', 'work') then raise exception 'Admin wrote work settings after test mode off'; end if;
end $$;

rollback;
\o
\echo Admin full control API test passed
