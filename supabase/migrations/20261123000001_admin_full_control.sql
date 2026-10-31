-- Admin full control in test mode (docs/access.md section 4). Development only.
--
-- Ope, 31 Oct 2026: "admin should have full control for now, how can i design something and not
-- able to test on one account?" While the site's testMode is on and an Admin has not picked another
-- role to test as, admin_full() is true for them, and every role check below accepts it: all row
-- rules that test site_role(), and the role and "someone else" checks in the guards and functions.
-- The data rules stay: nothing is deleted, records are voided not edited, closed stays closed, the
-- site keeps a superintendent, and every change is audited under the Admin's own name.
-- Turning test mode off ends it at once.

create or replace function admin_full(p_site uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    own_site_role(p_site) = 'admin'
    and coalesce((access_setting(p_site)->>'testMode')::boolean, false)
    and not exists (select 1 from admin_test_roles t where t.site_id = p_site and t.user_id = auth.uid() and t.role is not null),
    false);
$$;
revoke execute on function admin_full from public, anon;
grant execute on function admin_full to authenticated;

-- Every row rule that checks a role also accepts admin_full. Each role test
--   site_role(site_id) = ANY (ARRAY[...])  or  site_role(site_id) = '...'::app_role
-- becomes (admin_full(site_id) OR <that test>); the rest of the rule is unchanged.
do $$
declare
  p record;
  pat constant text := '(site_role\(site_id\) = (ANY \(ARRAY\[[^]]*\]\)|''[a-z_]+''::app_role))';
  q text; c text; stmt text;
begin
  for p in select tablename, policyname, qual, with_check from pg_policies
           where schemaname = 'public' and coalesce(qual, '') || coalesce(with_check, '') like '%site_role(%'
             and coalesce(qual, '') || coalesce(with_check, '') not like '%admin_full(%'
  loop
    q := regexp_replace(p.qual, pat, '(admin_full(site_id) OR \1)', 'g');
    c := regexp_replace(p.with_check, pat, '(admin_full(site_id) OR \1)', 'g');
    if coalesce(q, '') || coalesce(c, '') ~ 'site_role\(' and (coalesce(q, '') || coalesce(c, '')) !~ 'admin_full\(' then
      raise exception 'Policy %.% has a role test this migration does not understand.', p.tablename, p.policyname;
    end if;
    stmt := format('alter policy %I on %I', p.policyname, p.tablename);
    if q is not null then stmt := stmt || format(' using (%s)', q); end if;
    if c is not null then stmt := stmt || format(' with check (%s)', c); end if;
    execute stmt;
  end loop;
end $$;

-- Two table checks also refused "the same person" outright, which made approvals and sign-offs
-- impossible to test on one account. The guards (change_request_guard, inspection_guard) already
-- refuse it for everyone signed in, and now let admin_full through; the table checks keep the rest.
do $$
declare c record;
begin
  for c in select conrelid::regclass::text t, conname from pg_constraint
           where contype = 'c' and connamespace = 'public'::regnamespace
             and conrelid in ('change_requests'::regclass, 'inspections'::regclass)
             and (pg_get_constraintdef(oid) like '%decided_by <> requested_by%' or pg_get_constraintdef(oid) like '%signed_off_by <> started_by%')
  loop
    execute format('alter table %s drop constraint %I', c.t, c.conname);
  end loop;
end $$;
alter table inspections add constraint inspections_signed_off_by check (status <> 'signed_off' or signed_off_by is not null);

-- Guards and functions: the same functions as before, with admin_full added to each role check.

-- action_owner_limits
CREATE OR REPLACE FUNCTION public.action_owner_limits()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if admin_full(new.site_id) or site_role(new.site_id) in ('supervisor', 'reliability_engineer', 'superintendent') then return new; end if;
  if auth.uid() is null then return new; end if; -- database owner, migrations and seed
  if new.title is distinct from old.title or new.detail is distinct from old.detail or new.owner_id is distinct from old.owner_id
     or new.due is distinct from old.due or new.source is distinct from old.source or new.site_id is distinct from old.site_id
     or new.tenant_id is distinct from old.tenant_id then
    raise exception 'Only someone who can raise actions can change this one.' using errcode = 'insufficient_privilege';
  end if;
  if not ((old.status = 'open' and new.status = 'in_progress') or (old.status in ('open', 'in_progress') and new.status = 'done')
          or old.status = new.status) or old.status in ('done', 'cancelled') then
    raise exception 'The owner can only start or complete an action.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $function$;

-- saved_view_guard
CREATE OR REPLACE FUNCTION public.saved_view_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now(); new.retired_by := null; new.retired_at := null; new.retired_reason := null;
    return new;
  end if;
  if old.retired_at is not null then raise exception 'This view is retired.' using errcode = 'insufficient_privilege'; end if;
  if (new.id, new.tenant_id, new.site_id, new.name, new.query, new.shared, new.created_by, new.created_at)
     is distinct from (old.id, old.tenant_id, old.site_id, old.name, old.query, old.shared, old.created_by, old.created_at)
     or new.retired_reason is null then
    raise exception 'A saved view cannot be changed. Retire it with a reason and save a new one.' using errcode = 'insufficient_privilege';
  end if;
  -- Its author retires it, or a superintendent retires a shared one.
  if not (old.created_by = auth.uid() or (old.shared and site_role(old.site_id) = 'superintendent') or admin_full(old.site_id)) then
    raise exception 'Only the author retires a view (or a superintendent, for a shared one).' using errcode = 'insufficient_privilege';
  end if;
  new.retired_by := auth.uid(); new.retired_at := now();
  return new;
end $function$;

-- app_assist_start
CREATE OR REPLACE FUNCTION public.app_assist_start(p_site uuid, p_question text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tz text;
  v_tenant uuid;
  v_count integer;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if not admin_full(p_site) and coalesce(site_role(p_site)::text, '') not in ('supervisor', 'reliability_engineer', 'superintendent') then
    raise exception 'Your role cannot ask questions here.' using errcode = '42501';
  end if;
  select time_zone, tenant_id into v_tz, v_tenant from sites where id = p_site;
  select count(*) into v_count from assist_questions
    where site_id = p_site and user_id = auth.uid()
      and asked_at >= (date_trunc('day', now() at time zone v_tz) at time zone v_tz);
  if v_count >= 20 then raise exception 'Daily limit reached: 20 questions a day.' using errcode = 'P0001'; end if;
  insert into assist_questions (tenant_id, site_id, user_id, question)
    values (v_tenant, p_site, auth.uid(), trim(p_question)) returning id into v_id;
  return v_id;
end $function$;

-- project_limits
CREATE OR REPLACE FUNCTION public.project_limits()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  k text;
  is_super boolean := admin_full(new.site_id) or site_role(new.site_id) = 'superintendent';
begin
  if auth.uid() is null then return new; end if; -- database owner, migrations and seed
  if new.site_id is distinct from old.site_id or new.tenant_id is distinct from old.tenant_id then
    raise exception 'A project cannot move site.' using errcode = 'insufficient_privilege';
  end if;
  foreach k in array array['stages', 'tasks', 'risks', 'decisions', 'costs', 'changes'] loop
    if jsonb_array_length(to_jsonb(new) -> k) < jsonb_array_length(to_jsonb(old) -> k) then
      raise exception 'Nothing in a project is deleted (%).', k using errcode = 'insufficient_privilege';
    end if;
  end loop;
  if not is_super then
    if new.stage is distinct from old.stage and (new.stage in ('approved', 'benefits_confirmed', 'stopped') or old.stage in ('closed', 'benefits_confirmed', 'stopped')) then
      raise exception 'Only the superintendent approves, stops or reopens a project.' using errcode = 'insufficient_privilege';
    end if;
    if old.stage <> 'idea' and (new.budget is distinct from old.budget or new.ends_on is distinct from old.ends_on or new.starts_on is distinct from old.starts_on) then
      raise exception 'After approval, budget and dates change through a change request.' using errcode = 'insufficient_privilege';
    end if;
    -- A change request is decided by the superintendent only.
    if exists (
      select 1 from jsonb_array_elements(new.changes) c
      where c->>'status' <> 'proposed'
        and not exists (select 1 from jsonb_array_elements(old.changes) o where o->>'id' = c->>'id' and o->>'status' = c->>'status')
    ) then
      raise exception 'Only the superintendent decides change requests.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $function$;

-- change_request_guard
CREATE OR REPLACE FUNCTION public.change_request_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_me uuid := auth.uid();
  v_role app_role := site_role(new.site_id);
  v_old_len int;
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    -- Always starts as a waiting request from the person signed in, entered now.
    new.status := 'pending'; new.requested_by := v_me; new.requested_at := now(); new.notes := '[]';
    new.decided_by := null; new.decided_at := null; new.decision_note := null; new.applied_id := null; new.applied_at := null;
    return new;
  end if;

  if (new.id, new.tenant_id, new.site_id, new.kind, new.title, new.reason, new.payload, new.impact, new.requested_by, new.requested_at)
     is distinct from (old.id, old.tenant_id, old.site_id, old.kind, old.title, old.reason, old.payload, old.impact, old.requested_by, old.requested_at) then
    raise exception 'A request cannot be changed once made. Withdraw it and ask again.' using errcode = 'insufficient_privilege';
  end if;

  -- Notes are added to, never changed, and only by the asker or an approver, as themselves.
  v_old_len := jsonb_array_length(old.notes);
  if new.notes is distinct from old.notes then
    if old.status <> 'pending' then raise exception 'The request is closed.' using errcode = 'insufficient_privilege'; end if;
    if jsonb_array_length(new.notes) < v_old_len
       or coalesce((select jsonb_agg(e order by i) from jsonb_array_elements(new.notes) with ordinality t(e, i) where i <= v_old_len), '[]') <> old.notes
       or exists (select 1 from jsonb_array_elements(new.notes) with ordinality t(e, i) where i > v_old_len and e->>'by' is distinct from v_me::text)
       or not (v_me = old.requested_by or v_role = 'superintendent' or admin_full(new.site_id)) then
      raise exception 'Notes can only be added, by the person who asked or an approver.' using errcode = 'insufficient_privilege';
    end if;
  end if;

  if old.status <> 'pending' then
    -- Closed. The only later step is recording what an approval made, once, by the approver.
    if new.status <> old.status or new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at
       or new.decision_note is distinct from old.decision_note
       or (new.applied_id is distinct from old.applied_id and (old.applied_id is not null or v_me is distinct from old.decided_by)) then
      raise exception 'This request is already decided.' using errcode = 'insufficient_privilege';
    end if;
  elsif new.status = 'withdrawn' then
    if v_me is distinct from old.requested_by then raise exception 'Only the person who asked can withdraw it.' using errcode = 'insufficient_privilege'; end if;
    new.decided_by := v_me; new.decided_at := now();
  elsif new.status in ('approved', 'rejected') then
    if v_role is distinct from 'superintendent' and not admin_full(new.site_id) then raise exception 'Only a superintendent can decide.' using errcode = 'insufficient_privilege'; end if;
    if v_me = old.requested_by and not admin_full(new.site_id) then raise exception 'Nobody approves their own request.' using errcode = 'insufficient_privilege'; end if;
    new.decided_by := v_me; new.decided_at := now();
  else
    if new.decided_by is not null or new.decided_at is not null or new.decision_note is not null or new.applied_id is not null then
      raise exception 'A waiting request has no decision.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.applied_id is not null and old.applied_id is null then new.applied_at := now(); end if;
  return new;
end $function$;

-- member_role_guard
CREATE OR REPLACE FUNCTION public.member_role_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_role app_role := site_role(new.site_id);
begin
  if not is_client() then return new; end if;

  -- A superintendent applying an approval changes the role fields and nothing else.
  if tg_op = 'UPDATE' and v_role is distinct from 'admin'
     and (new.user_id, new.scope, new.name, new.email, new.retired_at, new.retired_reason, new.site_id, new.tenant_id)
         is distinct from (old.user_id, old.scope, old.name, old.email, old.retired_at, old.retired_reason, old.site_id, old.tenant_id) then
    raise exception 'Only the Admin changes users.' using errcode = 'insufficient_privilege';
  end if;

  -- Anyone but the Admin changes a role only to apply an approved request.
  if tg_op = 'UPDATE' and v_role is distinct from 'admin' and new.role is distinct from old.role
     and not exists (
       select 1 from change_requests r
       where r.site_id = new.site_id and r.kind = 'role_grant' and r.status = 'approved' and r.decided_by = auth.uid()
         and r.payload->>'userId' = new.user_id::text and r.payload->>'role' = new.role::text
     ) then
    raise exception 'Only the Admin changes roles, apart from applying an approval.' using errcode = 'insufficient_privilege';
  end if;

  -- Once a site has a superintendent it keeps one, so the starting rule below cannot be used again
  -- by removing them first. Give the role to someone else (with approval) before they go.
  if tg_op = 'UPDATE' and old.role = 'superintendent' and old.retired_at is null
     and (new.role is distinct from 'superintendent' or new.retired_at is not null)
     and not site_has_superintendent(new.site_id, old.id) then
    raise exception 'The site must keep a superintendent. Give the role to someone else first.' using errcode = 'insufficient_privilege';
  end if;

  -- Giving the Admin or Superintendent role: approved by a superintendent, or a site with none yet.
  if new.role in ('admin', 'superintendent') and (tg_op = 'INSERT' or new.role is distinct from old.role)
     and site_has_superintendent(new.site_id, new.id)
     and not admin_full(new.site_id)
     and not exists (
       select 1 from change_requests r
       where r.site_id = new.site_id and r.kind = 'role_grant' and r.status = 'approved' and r.decided_by = auth.uid()
         and r.payload->>'userId' = new.user_id::text and r.payload->>'role' = new.role::text
     ) then
    raise exception 'Giving the % role needs a superintendent''s approval.', new.role using errcode = 'insufficient_privilege';
  end if;

  -- Starting or changing an acting role needs an approved request; the Admin may end one early.
  if tg_op = 'UPDATE' and new.acting_role is not null
     and (new.acting_role, new.acting_until) is distinct from (old.acting_role, old.acting_until)
     and not admin_full(new.site_id)
     and not exists (
       select 1 from change_requests r
       where r.site_id = new.site_id and r.kind = 'acting_role' and r.status = 'approved' and r.decided_by = auth.uid()
         and r.payload->>'userId' = new.user_id::text and r.payload->>'role' = new.acting_role::text
         and (r.payload->>'until')::timestamptz = new.acting_until
     ) then
    raise exception 'An acting role needs a superintendent''s approval.' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' and new.acting_role is not null and not admin_full(new.site_id) then
    raise exception 'An acting role needs a superintendent''s approval.' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.acting_role is null and old.acting_role is not null and v_role is distinct from 'admin' then
    raise exception 'Only the Admin ends an acting role early.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $function$;

-- inspection_guard
CREATE OR REPLACE FUNCTION public.inspection_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_role app_role := site_role(new.site_id); v_me uuid := auth.uid();
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'submitted'; new.started_by := v_me; new.submitted_at := now();
    new.signed_off_by := null; new.signed_off_at := null; new.sign_off_note := null; new.voided_by := null; new.voided_at := null; new.void_reason := null;
    if new.started_at > now() then new.started_at := now(); end if;
    if not exists (select 1 from inspection_forms f where f.id = new.form_id and f.version = new.form_version and f.site_id = new.site_id and f.retired_at is null) then
      raise exception 'That form version is not in use at this site.' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from assets a where a.id = new.unit_id and a.site_id = new.site_id) then
      raise exception 'That unit is not at this site.' using errcode = 'insufficient_privilege';
    end if;
    if new.round_id is not null then
      if not exists (select 1 from rounds r join inspection_forms f on f.id = r.form_id and f.version = r.form_version
                     where r.id = new.round_id and r.site_id = new.site_id and r.started_by = v_me and r.status = 'submitted'
                       and r.form_id = new.form_id and r.form_version = new.form_version and f.route->'stops' ? new.unit_id::text) then
        raise exception 'That stop is not part of your round.' using errcode = 'insufficient_privilege';
      end if;
    elsif exists (select 1 from inspection_forms f where f.id = new.form_id and f.version = new.form_version and f.route is not null) then
      raise exception 'A route is done as a round.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (new.id, new.tenant_id, new.site_id, new.form_id, new.form_version, new.unit_id, new.round_id, new.smu, new.answers, new.score, new.result, new.started_by, new.started_at, new.submitted_at)
     is distinct from (old.id, old.tenant_id, old.site_id, old.form_id, old.form_version, old.unit_id, old.round_id, old.smu, old.answers, old.score, old.result, old.started_by, old.started_at, old.submitted_at) then
    raise exception 'A submitted inspection''s answers cannot be changed. Void it and do it again.' using errcode = 'insufficient_privilege';
  end if;
  if old.status = 'voided' then raise exception 'This inspection is voided.' using errcode = 'insufficient_privilege'; end if;

  if new.status is distinct from old.status then
    if v_role not in ('supervisor', 'superintendent') and not admin_full(new.site_id) then raise exception 'A supervisor or superintendent signs off and voids inspections.' using errcode = 'insufficient_privilege'; end if;
    if new.status = 'signed_off' and old.status = 'submitted' then
      if v_me = old.started_by and not admin_full(new.site_id) then raise exception 'Someone other than the inspector signs it off.' using errcode = 'insufficient_privilege'; end if;
      new.signed_off_by := v_me; new.signed_off_at := now();
    elsif new.status = 'voided' then
      new.voided_by := v_me; new.voided_at := now();
    else
      raise exception 'That change of status is not allowed.' using errcode = 'insufficient_privilege';
    end if;
  elsif (new.signed_off_by, new.signed_off_at, new.sign_off_note, new.voided_by, new.voided_at, new.void_reason)
        is distinct from (old.signed_off_by, old.signed_off_at, old.sign_off_note, old.voided_by, old.voided_at, old.void_reason) then
    raise exception 'Sign-off and void details are set by those steps only.' using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from jsonb_array_elements(old.defects) o where not exists (select 1 from jsonb_array_elements(new.defects) x where x->>'id' = o->>'id')) then
    raise exception 'Defects are closed with a note, never removed.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $function$;

-- oil_sample_guard
CREATE OR REPLACE FUNCTION public.oil_sample_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_role app_role := site_role(new.site_id);
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    if (select site_id from assets where id = new.unit_id) is distinct from new.site_id then
      raise exception 'That unit is not at this site.' using errcode = 'check_violation';
    end if;
    if new.taken_at > now() + interval '10 minutes' or new.reported_at > now() + interval '10 minutes' then
      raise exception 'The sample date is in the future.' using errcode = 'check_violation';
    end if;
    if sev_rank(new.severity) < sev_rank(new.lab_severity) then
      raise exception 'A sample cannot be rated better than the lab rated it.' using errcode = 'check_violation';
    end if;
    new.entered_by := auth.uid(); new.entered_at := now();
    new.voided_by := null; new.voided_at := null; new.void_reason := null;
    return new;
  end if;
  if (to_jsonb(new) - array['voided_by', 'voided_at', 'void_reason']) is distinct from (to_jsonb(old) - array['voided_by', 'voided_at', 'void_reason']) then
    raise exception 'A sample cannot be changed. Void it and enter it again.' using errcode = 'insufficient_privilege';
  end if;
  if old.voided_at is not null then raise exception 'It is already voided.' using errcode = 'insufficient_privilege'; end if;
  if new.void_reason is null or length(trim(new.void_reason)) = 0 then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  if not ((old.entered_by = auth.uid() and v_role in ('supervisor', 'reliability_engineer', 'superintendent')) or v_role = 'superintendent' or admin_full(new.site_id)) then
    raise exception 'Only the person who entered it, or a superintendent, voids a sample.' using errcode = 'insufficient_privilege';
  end if;
  new.voided_by := auth.uid(); new.voided_at := now();
  return new;
end $function$;

-- round_guard
CREATE OR REPLACE FUNCTION public.round_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_role app_role := site_role(new.site_id);
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    new.status := 'submitted'; new.started_by := auth.uid(); new.submitted_at := now();
    new.voided_by := null; new.voided_at := null; new.void_reason := null;
    if new.started_at > now() then new.started_at := now(); end if;
    if not exists (select 1 from inspection_forms f where f.id = new.form_id and f.version = new.form_version and f.site_id = new.site_id
                   and f.retired_at is null and f.route is not null and (f.route->>'nodeId')::uuid = new.node_id) then
      raise exception 'That route version is not in use at this site.' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'voided_by', 'voided_at', 'void_reason']) is distinct from (to_jsonb(old) - array['status', 'voided_by', 'voided_at', 'void_reason'])
     or old.status = 'voided' or new.status <> 'voided' then
    raise exception 'A submitted round is only ever voided.' using errcode = 'insufficient_privilege';
  end if;
  if v_role not in ('supervisor', 'superintendent') and not admin_full(new.site_id) then raise exception 'A supervisor or superintendent voids a round.' using errcode = 'insufficient_privilege'; end if;
  new.voided_by := auth.uid(); new.voided_at := now();
  return new;
end $function$;

-- component_event_guard
CREATE OR REPLACE FUNCTION public.component_event_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  last_ev component_events;
  comp components;
begin
  if not is_client() then return new; end if;
  if tg_op = 'UPDATE' then
    if old.voided_at is not null then raise exception 'This event is already voided.' using errcode = 'insufficient_privilege'; end if;
    if (new.id, new.tenant_id, new.site_id, new.component_id, new.kind, new.at, new.unit_id, new.position, new.smu, new.reason, new.flag_id, new.work_order,
        new.vendor, new.reference, new.received_as, new.warranty_hours, new.warranty_months, new.core_due_by, new.claim, new.note, new.entered_by, new.entered_at)
       is distinct from
       (old.id, old.tenant_id, old.site_id, old.component_id, old.kind, old.at, old.unit_id, old.position, old.smu, old.reason, old.flag_id, old.work_order,
        old.vendor, old.reference, old.received_as, old.warranty_hours, old.warranty_months, old.core_due_by, old.claim, old.note, old.entered_by, old.entered_at)
       or length(trim(coalesce(new.void_reason, ''))) = 0 then
      raise exception 'A component event cannot be changed. Void it with a reason and enter it again.' using errcode = 'insufficient_privilege';
    end if;
    if not (old.entered_by = auth.uid() or site_role(old.site_id) = 'superintendent' or admin_full(old.site_id)) then
      raise exception 'Only the person who entered it, or a superintendent, voids an event.' using errcode = 'insufficient_privilege';
    end if;
    if exists (select 1 from component_events x where x.component_id = old.component_id and x.voided_at is null and x.id <> old.id
               and (x.at, x.entered_at) > (old.at, old.entered_at)) then
      raise exception 'Only the latest event of a component can be voided.' using errcode = 'insufficient_privilege';
    end if;
    new.voided_by := auth.uid(); new.voided_at := now();
    return new;
  end if;
  -- Insert.
  new.entered_by := auth.uid(); new.entered_at := now(); new.voided_by := null; new.voided_at := null; new.void_reason := null;
  select * into comp from components where id = new.component_id;
  if comp.site_id is distinct from new.site_id then raise exception 'Component not found at this site.' using errcode = 'insufficient_privilege'; end if;
  if new.at > now() + interval '5 minutes' then raise exception 'The date cannot be in the future.' using errcode = 'check_violation'; end if;
  select * into last_ev from component_events where component_id = new.component_id and voided_at is null order by at desc, entered_at desc limit 1;
  if last_ev.id is null and new.kind <> 'received' then raise exception 'A component starts with Received.' using errcode = 'check_violation'; end if;
  if last_ev.id is not null and new.kind = 'received' then raise exception 'This component is already received.' using errcode = 'check_violation'; end if;
  if last_ev.id is not null and new.at < last_ev.at then raise exception 'An event cannot be dated before the previous one.' using errcode = 'check_violation'; end if;
  if last_ev.kind = 'scrapped' then raise exception 'This component is scrapped.' using errcode = 'check_violation'; end if;
  if new.unit_id is not null and not exists (select 1 from assets a where a.id = new.unit_id and a.site_id = new.site_id) then
    raise exception 'Unit not found at this site.' using errcode = 'insufficient_privilege';
  end if;
  if new.kind = 'installed' and exists (
    select 1 from (
      select distinct on (e.component_id) e.component_id, e.kind, e.unit_id, e.position
      from component_events e
      where e.site_id = new.site_id and e.voided_at is null and e.component_id <> new.component_id
        and e.kind in ('installed', 'removed', 'scrapped')
      order by e.component_id, e.at desc, e.entered_at desc
    ) cur where cur.kind = 'installed' and cur.unit_id = new.unit_id and cur.position = new.position
  ) then
    raise exception 'That position is not empty. Remove the component there first.' using errcode = 'check_violation';
  end if;
  return new;
end $function$;

-- app_save_component_event
CREATE OR REPLACE FUNCTION public.app_save_component_event(p_site uuid, e jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if e->>'voidedAt' is not null then
    update component_events set void_reason = e->>'voidReason' where id = (e->>'id')::uuid and site_id = p_site;
    if not found then raise exception 'Event not found.' using errcode = 'insufficient_privilege'; end if;
    return;
  end if;
  if e->>'cost' is not null and not admin_full(p_site) and site_role(p_site) not in ('reliability_engineer', 'superintendent') then
    raise exception 'Only cost roles enter costs.' using errcode = 'insufficient_privilege';
  end if;
  insert into component_events (id, tenant_id, site_id, component_id, kind, at, unit_id, position, smu, reason, flag_id, work_order, vendor, reference,
    received_as, warranty_hours, warranty_months, core_due_by, claim, note)
  select (e->>'id')::uuid, s.tenant_id, p_site, (e->>'componentId')::uuid, e->>'kind', (e->>'at')::timestamptz, (e->>'unitId')::uuid, e->>'position',
    (e->>'smu')::numeric, e->>'reason', (e->>'flagId')::uuid, e->>'workOrder', e->>'vendor', e->>'reference', e->>'receivedAs',
    (e->>'warrantyHours')::numeric, (e->>'warrantyMonths')::int, (e->>'coreDueBy')::date, e->>'claim', e->>'note'
  from sites s where s.id = p_site;
  if e->>'cost' is not null then
    insert into component_event_costs (event_id, tenant_id, site_id, cost)
    select (e->>'id')::uuid, s.tenant_id, p_site, (e->>'cost')::numeric from sites s where s.id = p_site;
  end if;
end $function$;

-- can_write_setting
CREATE OR REPLACE FUNCTION public.can_write_setting(p_site uuid, p_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case p_key
    when 'work' then admin_full(p_site) or site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then admin_full(p_site) or site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'condition' then admin_full(p_site) or site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'rcm' then admin_full(p_site) or site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'spares' then admin_full(p_site) or site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'assist' then admin_full(p_site) or site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'plant' then admin_full(p_site) or site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'imports' then admin_full(p_site) or site_role(p_site) = 'admin'
    when 'access' then admin_full(p_site) or site_role(p_site) = 'admin'
    else false end;
$function$;


notify pgrst, 'reload schema';
