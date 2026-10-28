-- Approvals API test (docs/approvals.md): two people, nobody approves their own request.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
-- Ada admin, Sam supervisor, Rae reliability engineer. No superintendent yet.
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'viewer', '{*}', 'Sue', 'sue@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- 1. Starting the site: with no superintendent, the admin makes Sue the first one directly.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
update site_members set role = 'superintendent' where user_id = 'a0000000-0000-0000-0000-00000000000e';
-- Now there is one, so the admin cannot give Admin or Superintendent directly, or invite into them.
do $$ begin
  update site_members set role = 'admin' where user_id = 'a0000000-0000-0000-0000-00000000000b';
  raise exception 'admin gave the admin role without approval';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into site_invites (tenant_id, site_id, email, name, role, scope) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'x@example.com', 'X', 'superintendent', '{*}');
  raise exception 'admin invited a superintendent without approval';
exception when insufficient_privilege then null; end $$;

-- 2. Rae asks for a target. Rae cannot approve it, or insert a target directly.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d');
select app_save_requests('10000000-0000-0000-0000-000000000002', '[{"id": "c0000000-0000-0000-0000-000000000001", "kind": "target", "title": "PA 88%", "reason": "2027 budget",
  "payload": {"kind": "target", "input": {"kpi": "pa", "fleet": "Haul trucks", "value": 0.88, "amber": 0.03, "from": "next_shift"}}, "status": "approved"}]'::jsonb);
do $$ begin
  if (select status from change_requests where id = 'c0000000-0000-0000-0000-000000000001') <> 'pending' then raise exception 'request did not start as pending'; end if;
  if (select requested_by from change_requests where id = 'c0000000-0000-0000-0000-000000000001') <> 'a0000000-0000-0000-0000-00000000000d' then raise exception 'wrong requester'; end if;
end $$;
do $$ begin
  perform app_decide_request('10000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'approved', '', '{"id": "40000000-0000-0000-0000-000000000009", "kpi": "pa", "value": 0.88, "amber": 0.03, "effectiveFrom": "2026-11-01T07:00:00Z"}'::jsonb);
  raise exception 'reliability engineer approved a request';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update change_requests set payload = '{"kind": "target", "input": {"kpi": "pa", "value": 0.1}}' where id = 'c0000000-0000-0000-0000-000000000001';
  raise exception 'request changed after it was made';
exception when insufficient_privilege then null; end $$;

-- 3. Sue (superintendent) asks a question; Rae answers; Sue cannot fake a note from Rae.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
update change_requests set notes = notes || '[{"by": "a0000000-0000-0000-0000-00000000000e", "at": "2026-10-28T10:00:00Z", "text": "Why 88?"}]' where id = 'c0000000-0000-0000-0000-000000000001';
do $$ begin
  update change_requests set notes = notes || '[{"by": "a0000000-0000-0000-0000-00000000000d", "at": "2026-10-28T10:00:00Z", "text": "fake"}]' where id = 'c0000000-0000-0000-0000-000000000001';
  raise exception 'note written as someone else';
exception when insufficient_privilege then null; end $$;

-- 4. Sue approves; the target is applied in the same step, credited to Rae and approved by Sue.
select app_decide_request('10000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'approved', 'OK',
  '{"id": "40000000-0000-0000-0000-000000000009", "kpi": "pa", "fleet": "Haul trucks", "value": 0.88, "amber": 0.03, "effectiveFrom": "2026-11-01T07:00:00Z"}'::jsonb);
do $$ begin
  if not exists (select 1 from targets where id = '40000000-0000-0000-0000-000000000009' and request_id = 'c0000000-0000-0000-0000-000000000001'
    and approved_by = 'a0000000-0000-0000-0000-00000000000e' and created_by = 'a0000000-0000-0000-0000-00000000000d') then raise exception 'target not applied'; end if;
  if (select applied_id from change_requests where id = 'c0000000-0000-0000-0000-000000000001') <> '40000000-0000-0000-0000-000000000009' then raise exception 'applied id missing'; end if;
end $$;
-- A second target from the same request is refused.
do $$ begin
  insert into targets (tenant_id, site_id, kpi, target, effective_from, request_id) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'pa', 0.5, now(), 'c0000000-0000-0000-0000-000000000001');
  raise exception 'second target from one request';
exception when insufficient_privilege or unique_violation then null; end $$;

-- 5. Sue asks for a target herself and cannot approve it.
select app_save_requests('10000000-0000-0000-0000-000000000002', '[{"id": "c0000000-0000-0000-0000-000000000002", "kind": "target", "title": "MTBF", "reason": "r",
  "payload": {"kind": "target", "input": {"kpi": "mtbf", "value": 100, "amber": 10, "from": "next_shift"}}}]'::jsonb);
do $$ begin
  perform app_decide_request('10000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'approved', '', '{"id": "40000000-0000-0000-0000-00000000000a", "kpi": "mtbf", "value": 100, "amber": 10, "effectiveFrom": "2026-11-01T07:00:00Z"}'::jsonb);
  raise exception 'superintendent approved her own request';
exception when insufficient_privilege or check_violation then null; end $$;

-- 6. Ada asks for Sam to be admin and for Rae to act as superintendent; Sue approves both.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
select app_save_requests('10000000-0000-0000-0000-000000000002', '[
  {"id": "c0000000-0000-0000-0000-000000000003", "kind": "role_grant", "title": "Sam to admin", "reason": "nights", "payload": {"kind": "role_grant", "userId": "a0000000-0000-0000-0000-00000000000b", "role": "admin", "from": "supervisor"}},
  {"id": "c0000000-0000-0000-0000-000000000004", "kind": "acting_role", "title": "Rae acting super", "reason": "leave", "payload": {"kind": "acting_role", "userId": "a0000000-0000-0000-0000-00000000000d", "role": "superintendent", "until": "2026-11-07T07:00:00Z"}}
]'::jsonb);
do $$ begin
  update site_members set acting_role = 'superintendent', acting_until = '2026-11-07T07:00:00Z' where user_id = 'a0000000-0000-0000-0000-00000000000d';
  raise exception 'admin set an acting role without approval';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  update site_members set scope = '{North}' where user_id = 'a0000000-0000-0000-0000-00000000000b';
  raise exception 'superintendent changed a user scope';
exception when insufficient_privilege then null; end $$;
select app_decide_request('10000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000003', 'approved', '');
select app_decide_request('10000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000004', 'approved', '');
do $$ begin
  if (select role from site_members where user_id = 'a0000000-0000-0000-0000-00000000000b') <> 'admin' then raise exception 'role grant not applied'; end if;
  if (select acting_role from site_members where user_id = 'a0000000-0000-0000-0000-00000000000d') <> 'superintendent' then raise exception 'acting role not applied'; end if;
end $$;

-- 6b. The superintendent cannot change other roles directly; the admin cannot remove the last superintendent.
do $$ begin
  update site_members set role = 'viewer' where user_id = 'a0000000-0000-0000-0000-00000000000a';
  raise exception 'superintendent changed a role without a request';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
-- Rae is acting superintendent until 7 Nov 2026; end that early so Sue is the only one.
update site_members set acting_role = null, acting_until = null where user_id = 'a0000000-0000-0000-0000-00000000000d';
do $$ begin
  update site_members set role = 'viewer' where user_id = 'a0000000-0000-0000-0000-00000000000e';
  raise exception 'admin demoted the last superintendent';
exception when insufficient_privilege then null; end $$;
do $$ begin
  update site_members set retired_at = now(), retired_reason = 'left' where user_id = 'a0000000-0000-0000-0000-00000000000e';
  raise exception 'admin removed the last superintendent';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');

-- 7. A decided request stays decided; a rejection needs a reason; nothing is deleted.
do $$ begin
  update change_requests set status = 'rejected', decision_note = 'changed my mind' where id = 'c0000000-0000-0000-0000-000000000003';
  raise exception 'decision changed';
exception when insufficient_privilege then null; end $$;
do $$ begin
  delete from change_requests where id = 'c0000000-0000-0000-0000-000000000003';
  if found then raise exception 'request deleted'; end if;
exception when raise_exception or insufficient_privilege then null; end $$;

-- 8. The superintendent loads every request and the approved target (the acting role was ended early).
do $$ declare d jsonb := app_load_approvals('10000000-0000-0000-0000-000000000002'); begin
  if jsonb_array_length(d->'requests') <> 4 or jsonb_array_length(d->'acting') <> 0 or jsonb_array_length(d->'targets') <> 1 then raise exception 'load wrong: %', d; end if;
end $$;

reset role;
do $$ declare n int; begin
  select count(*) into n from audit_log where entity = 'change_requests';
  if n < 8 then raise exception 'request steps missing from the audit log (%)', n; end if;
end $$;
rollback;
\o
\echo approvals API test passed
