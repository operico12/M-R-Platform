-- Access test (docs/access.md): account requests by email domain, the Admin's
-- answer, the 30-day cap on a sign-in, and two-step sign-in for Admins.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mine A', 'America/Vancouver'),
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Mine B', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example-mining.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000d', 'superintendent', '{*}', 'Sol', 'sol@example-mining.com');
-- Sign in as someone, with an email, an assurance level and a sign-in time (days ago).
create function pg_temp.as_user(p_id text, p_email text default 'x@example.com', p_aal text default 'aal1', p_days numeric default 0) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true),
    set_config('request.jwt.claims', json_build_object('sub', p_id, 'email', p_email, 'aal', p_aal,
      'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', floor(extract(epoch from now()) - p_days * 86400))))::text, true);
$$;
create temp table req (id uuid);
grant all on req to authenticated;
set local role authenticated;

-- The Admin lists the company domain. Only the Admin sets it.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d', 'sol@example-mining.com');
do $$ begin
  insert into site_settings (tenant_id, site_id, key, value, reason) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'access',
    '{"requestDomains": ["example-mining.com"], "adminMfa": false, "sessionDays": 30, "idleDays": 7}', 'Let staff ask');
  raise exception 'a superintendent set the access rules';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'ada@example-mining.com');
insert into site_settings (tenant_id, site_id, key, value, reason) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'access',
  '{"requestDomains": ["example-mining.com"], "adminMfa": false, "sessionDays": 30, "idleDays": 7}', 'Let staff ask');
do $$ begin
  update site_settings set value = value || '{"idleDays": 0}' where key = 'access';
  raise exception 'a zero idle limit was allowed';
exception when check_violation then null; end $$;

-- A newcomer from the company domain sees Mine A only (Mine B lists no domain); another domain sees nothing.
select pg_temp.as_user('b0000000-0000-0000-0000-000000000001', 'gmail.user@gmail.com');
do $$ begin
  if exists (select 1 from app_request_sites()) then raise exception 'another domain sees a site'; end if;
  perform app_request_access('10000000-0000-0000-0000-000000000002', 'Gus', null);
  raise exception 'another domain asked for access';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('b0000000-0000-0000-0000-000000000002', 'nia@example-mining.com');
do $$ begin
  if (select array_agg(site_name) from app_request_sites()) <> array['Mine A'] then raise exception 'newcomer should see Mine A only'; end if;
  if exists (select 1 from sites) then raise exception 'a newcomer can read the sites table'; end if;
end $$;
insert into req select app_request_access('10000000-0000-0000-0000-000000000002', ' Nia ', 'Haul truck technician, B crew');
do $$ begin
  perform app_request_access('10000000-0000-0000-0000-000000000002', 'Nia', null);
  raise exception 'a second waiting request was allowed';
exception when unique_violation then null; end $$;
do $$ begin
  if (select status from app_my_access_requests()) <> 'pending' or (select site_name from app_my_access_requests()) <> 'Mine A' then raise exception 'own request not shown'; end if;
end $$;

-- Three requests a day at most (withdrawn ones count).
select pg_temp.as_user('b0000000-0000-0000-0000-000000000003', 'ola@example-mining.com');
do $$ declare i int; v uuid; begin
  for i in 1..3 loop
    v := app_request_access('10000000-0000-0000-0000-000000000002', 'Ola', null);
    perform app_withdraw_access(v);
  end loop;
end $$;
do $$ begin
  perform app_request_access('10000000-0000-0000-0000-000000000002', 'Ola', null);
  raise exception 'a fourth request in a day was allowed';
exception when check_violation then null; end $$;

-- Only the Admin sees and answers; approving gives a requestable role only.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d', 'sol@example-mining.com');
do $$ begin
  if exists (select 1 from access_requests) then raise exception 'a superintendent sees requests'; end if;
  perform app_decide_access((select id from req), true, 'viewer', null);
  raise exception 'a superintendent approved';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'ada@example-mining.com');
do $$ begin
  if (select count(*) from access_requests where status = 'pending') <> 1 then raise exception 'admin should see 1 waiting request'; end if;
  perform app_decide_access((select id from req), true, 'admin', null);
  raise exception 'approved straight to Admin';
exception when check_violation then null; end $$;
do $$ begin
  perform app_decide_access((select id from req), false, null, ' ');
  raise exception 'declined without a reason';
exception when check_violation then null; end $$;
select app_decide_access((select id from req), true, 'technician', null);
select pg_temp.as_user('b0000000-0000-0000-0000-000000000002', 'nia@example-mining.com');
do $$ begin
  if site_role('10000000-0000-0000-0000-000000000002') <> 'technician' then raise exception 'approved person is not a technician'; end if;
  if (select status from app_my_access_requests()) <> 'approved' then raise exception 'request not approved'; end if;
  if exists (select 1 from app_request_sites()) then raise exception 'a member still sees the site to request'; end if;
end $$;
-- A sign-in older than 30 days reaches nothing.
select pg_temp.as_user('b0000000-0000-0000-0000-000000000002', 'nia@example-mining.com', 'aal1', 31);
do $$ begin
  if is_site_member('10000000-0000-0000-0000-000000000002') or site_role('10000000-0000-0000-0000-000000000002') is not null then raise exception 'a 31-day-old sign-in still counts'; end if;
  if exists (select 1 from sites) then raise exception 'a 31-day-old sign-in reads sites'; end if;
end $$;
select pg_temp.as_user('b0000000-0000-0000-0000-000000000002', 'nia@example-mining.com', 'aal1', 29);
do $$ begin
  if not is_site_member('10000000-0000-0000-0000-000000000002') then raise exception 'a 29-day-old sign-in was refused'; end if;
end $$;

-- Two-step for Admins: only an Admin who passed the code check turns it on; then aal1 Admins act as Viewers.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'ada@example-mining.com', 'aal1');
do $$ begin
  update site_settings set value = value || '{"adminMfa": true}' where key = 'access';
  raise exception 'turned on without the code check';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'ada@example-mining.com', 'aal2');
update site_settings set value = value || '{"adminMfa": true}' where key = 'access';
do $$ begin
  if site_role('10000000-0000-0000-0000-000000000002') <> 'admin' then raise exception 'aal2 admin lost the role'; end if;
  if (select mfa_required from app_my_sites() where site_id = '10000000-0000-0000-0000-000000000002') then raise exception 'aal2 admin asked again'; end if;
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'ada@example-mining.com', 'aal1');
do $$ begin
  if site_role('10000000-0000-0000-0000-000000000002') <> 'viewer' then raise exception 'aal1 admin should act as viewer'; end if;
  if not (select mfa_required from app_my_sites() where site_id = '10000000-0000-0000-0000-000000000002') then raise exception 'switcher should ask for the code'; end if;
  update site_settings set value = value || '{"adminMfa": false}' where key = 'access';
  if found then raise exception 'an aal1 admin turned it off'; end if;
exception when insufficient_privilege then null; end $$;
-- Other roles are not affected.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d', 'sol@example-mining.com', 'aal1');
do $$ begin
  if site_role('10000000-0000-0000-0000-000000000002') <> 'superintendent' then raise exception 'superintendent changed'; end if;
end $$;

reset role;
do $$ begin
  -- Nia's request and approval, Ola's three requests and three withdrawals.
  if (select count(*) from audit_log where entity = 'access_requests') <> 8 then raise exception 'requests not audited (%)', (select count(*) from audit_log where entity = 'access_requests'); end if;
  if (select count(*) from access_requests) <> 4 then raise exception 'requests must never be deleted'; end if;
end $$;
rollback;
\o
\echo Access API test passed
