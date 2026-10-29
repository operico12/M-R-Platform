-- Assist questions API test: who may ask, the daily limit, closing only your own question once, and who reads the log.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Test tenant');
insert into sites (id, tenant_id, name, time_zone) values ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Test mine', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000e', 'reliability_engineer', '{*}', 'Rae', 'rae@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'supervisor', '{*}', 'Sam', 'sam@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Tia', 'tia@example.com'),
  ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com');
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true), set_config('request.jwt.claims', json_build_object('sub', p_id)::text, true);
$$;
set local role authenticated;

-- A technician and an admin cannot ask.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin
  perform app_assist_start('10000000-0000-0000-0000-000000000002', 'Why was PA low?');
  raise exception 'technician asked';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a');
do $$ begin
  perform app_assist_start('10000000-0000-0000-0000-000000000002', 'Why was PA low?');
  raise exception 'admin asked';
exception when insufficient_privilege then null; end $$;

-- Sam asks and closes his question once; Rae cannot close it; nobody can write the table directly.
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
create temp table q as select app_assist_start('10000000-0000-0000-0000-000000000002', ' Why was PA low? ') as id;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin
  perform app_assist_finish((select id from q), 'answered', '{"x [KPI-001]"}', '{KPI-001}', 'm', 1, 1);
  raise exception 'Rae closed Sam''s question';
exception when insufficient_privilege then null; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b');
select app_assist_finish((select id from q), 'answered', '{"PA was 90.5% [KPI-001]"}', '{KPI-001}', 'claude-opus-5-5', 3000, 120);
do $$ begin
  perform app_assist_finish((select id from q), 'answered', '{"again [KPI-001]"}', '{KPI-001}', 'm', 1, 1);
  raise exception 'closed twice';
exception when insufficient_privilege then null; end $$;
do $$ begin
  insert into assist_questions (tenant_id, site_id, user_id, question) values ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-00000000000b', 'x');
  raise exception 'direct insert allowed';
exception when insufficient_privilege then null; end $$;

-- The daily limit: 19 more are fine, the 21st is refused.
do $$ begin
  for i in 1..19 loop perform app_assist_start('10000000-0000-0000-0000-000000000002', 'q' || i); end loop;
end $$;
do $$ begin
  perform app_assist_start('10000000-0000-0000-0000-000000000002', 'one too many');
  raise exception 'limit not enforced';
exception when raise_exception then
  if sqlerrm not like 'Daily limit%' then raise; end if;
end $$;

-- Who reads: Sam sees his own 20, the technician none, Rae all.
do $$ begin if (select count(*) from assist_questions) <> 20 then raise exception 'Sam sees %', (select count(*) from assist_questions); end if; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c');
do $$ begin if (select count(*) from assist_questions) <> 0 then raise exception 'technician sees questions'; end if; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e');
do $$ begin if (select count(*) from assist_questions) <> 20 then raise exception 'Rae sees %', (select count(*) from assist_questions); end if; end $$;
reset role;
do $$ begin
  if (select question from assist_questions where id = (select id from q)) <> 'Why was PA low?' then raise exception 'question not trimmed'; end if;
  if (select outcome from assist_questions where id = (select id from q)) <> 'answered' then raise exception 'not closed'; end if;
  if (select count(*) from audit_log where entity = 'assist_questions') < 21 then raise exception 'not audited'; end if;
end $$;
do $$ begin
  delete from assist_questions where id = (select id from q);
  raise exception 'deleted';
exception when others then if sqlerrm = 'deleted' then raise; end if; end $$;
rollback;
\o
\echo Assist questions API test passed
