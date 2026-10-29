-- People test (docs/people.md): job title, crew and access end date. Only the Admin sets them,
-- an end date in the past shuts the person out of every read and write rule, and an invite
-- past its end date is not used.
\set QUIET on
\o /dev/null
begin;
insert into tenants (id, name) values ('20000000-0000-0000-0000-000000000001', 'People tenant');
insert into sites (id, tenant_id, name, time_zone) values ('20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Mine P', 'America/Vancouver');
insert into site_members (tenant_id, site_id, user_id, role, scope, name, email) values
  ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-00000000000a', 'admin', '{*}', 'Ada', 'ada@example.com'),
  ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-00000000000d', 'superintendent', '{*}', 'Sol', 'sol@example.com'),
  ('20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-00000000000c', 'technician', '{*}', 'Cy', 'cy@example.com');
create function pg_temp.as_user(p_id text, p_email text default 'x@example.com') returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_id, true),
    set_config('request.jwt.claims', json_build_object('sub', p_id, 'email', p_email, 'aal', 'aal1',
      'amr', json_build_array(json_build_object('method', 'otp', 'timestamp', floor(extract(epoch from now())))))::text, true);
$$;
set local role authenticated;

-- The Admin gives the contractor a title, crew and end date next month.
select pg_temp.as_user('c0000000-0000-0000-0000-00000000000a', 'ada@example.com');
select app_save_users('20000000-0000-0000-0000-000000000002', jsonb_build_array(jsonb_build_object(
  'id', 'c0000000-0000-0000-0000-00000000000c', 'name', 'Cy', 'email', 'cy@example.com', 'role', 'technician', 'scope', '["*"]'::jsonb,
  'jobTitle', 'contractor', 'crew', 'B', 'accessUntil', (now() + interval '30 days')::text)));
do $$ begin
  if (select p->>'jobTitle' from jsonb_array_elements(app_load_people('20000000-0000-0000-0000-000000000002')) p where p->>'id' = 'c0000000-0000-0000-0000-00000000000c') <> 'contractor'
    then raise exception 'title not saved'; end if;
end $$;
do $$ begin
  update site_members set job_title = 'Bad Title!' where user_id = 'c0000000-0000-0000-0000-00000000000c';
  raise exception 'a bad title was stored';
exception when check_violation then null; end $$;

-- Before the end date the contractor reads the site.
select pg_temp.as_user('c0000000-0000-0000-0000-00000000000c', 'cy@example.com');
do $$ begin
  if not exists (select 1 from sites) or site_role('20000000-0000-0000-0000-000000000002') <> 'technician' then raise exception 'contractor shut out too early'; end if;
end $$;

-- A superintendent cannot change someone's end date.
select pg_temp.as_user('c0000000-0000-0000-0000-00000000000d', 'sol@example.com');
do $$ begin
  update site_members set access_until = now() + interval '900 days' where user_id = 'c0000000-0000-0000-0000-00000000000c';
  if found then raise exception 'a superintendent changed an end date'; end if;
exception when insufficient_privilege then null; end $$;

-- After the end date: no site, no role, no rows.
reset role;
update site_members set access_until = now() - interval '1 minute' where user_id = 'c0000000-0000-0000-0000-00000000000c';
set local role authenticated;
select pg_temp.as_user('c0000000-0000-0000-0000-00000000000c', 'cy@example.com');
do $$ begin
  if exists (select 1 from sites) then raise exception 'ended access still reads sites'; end if;
  if exists (select 1 from my_site_ids()) then raise exception 'ended access still a member'; end if;
  if site_role('20000000-0000-0000-0000-000000000002') is not null then raise exception 'ended access still has a role'; end if;
  if is_site_member('20000000-0000-0000-0000-000000000002') then raise exception 'ended access still is_site_member'; end if;
  if exists (select 1 from app_my_sites()) then raise exception 'ended access still in the site switcher'; end if;
end $$;

-- An invite past its end date is not used when the person signs in.
select pg_temp.as_user('c0000000-0000-0000-0000-00000000000a', 'ada@example.com');
select app_save_users('20000000-0000-0000-0000-000000000002', jsonb_build_array(
  jsonb_build_object('id', 'c1000000-0000-0000-0000-000000000001', 'name', 'Oli', 'email', 'oli@example.com', 'role', 'viewer', 'scope', '["*"]'::jsonb,
    'jobTitle', 'consultant', 'accessUntil', (now() + interval '10 days')::text),
  jsonb_build_object('id', 'c1000000-0000-0000-0000-000000000002', 'name', 'Old', 'email', 'old@example.com', 'role', 'viewer', 'scope', '["*"]'::jsonb,
    'jobTitle', 'consultant', 'accessUntil', (now() + interval '10 days')::text)));
reset role;
update site_invites set access_until = now() - interval '1 day' where email = 'old@example.com';
set local role authenticated;
select pg_temp.as_user('c2000000-0000-0000-0000-000000000001', 'oli@example.com');
do $$ begin
  if app_join() <> 1 then raise exception 'current invite not used'; end if;
  if (select job_title from site_members where user_id = 'c2000000-0000-0000-0000-000000000001') <> 'consultant' then raise exception 'invite title not carried'; end if;
end $$;
select pg_temp.as_user('c2000000-0000-0000-0000-000000000002', 'old@example.com');
do $$ begin
  if app_join() <> 0 then raise exception 'an ended invite was used'; end if;
end $$;
rollback;
\o
\echo 'people_api: ok'
