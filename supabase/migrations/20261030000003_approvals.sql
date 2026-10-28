-- Phase 2: approvals (docs/approvals.md; plan 11.3 to 11.5).
-- Targets, Admin and Superintendent role grants and acting roles need a
-- superintendent who did not ask. The app runs these rules in
-- packages/core/src/approvals.ts; the policies and triggers here are the
-- backstop, so a request made outside the app gets the same answer.
-- The guards apply to signed-in clients only. Seeding and migrations run as
-- the database owner and are not affected.

create table change_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  kind text not null check (kind in ('target', 'role_grant', 'acting_role')),
  title text not null check (length(trim(title)) > 0),
  reason text not null check (length(trim(reason)) > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload->>'kind' = kind),
  impact jsonb not null default '[]' check (jsonb_typeof(impact) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  requested_by uuid not null default auth.uid(),
  requested_at timestamptz not null default now(),
  -- Questions and answers while pending: [{by, at, text}], added to only.
  notes jsonb not null default '[]' check (jsonb_typeof(notes) = 'array'),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  applied_id uuid,
  applied_at timestamptz,
  check (status = 'pending' or (decided_by is not null and decided_at is not null)),
  check (status not in ('approved', 'rejected') or decided_by <> requested_by),
  check (status <> 'rejected' or length(trim(coalesce(decision_note, ''))) > 0),
  check (applied_id is null or status = 'approved')
);
create index change_requests_site on change_requests (site_id, status, requested_at);

create or replace function is_client() returns boolean language sql stable as $$
  select current_user in ('authenticated', 'anon');
$$;

create or replace function change_request_guard() returns trigger
language plpgsql set search_path = public as $$
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
       or not (v_me = old.requested_by or v_role = 'superintendent') then
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
    if v_role is distinct from 'superintendent' then raise exception 'Only a superintendent can decide.' using errcode = 'insufficient_privilege'; end if;
    if v_me = old.requested_by then raise exception 'Nobody approves their own request.' using errcode = 'insufficient_privilege'; end if;
    new.decided_by := v_me; new.decided_at := now();
  else
    if new.decided_by is not null or new.decided_at is not null or new.decision_note is not null or new.applied_id is not null then
      raise exception 'A waiting request has no decision.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.applied_id is not null and old.applied_id is null then new.applied_at := now(); end if;
  return new;
end $$;

create trigger change_requests_guard before insert or update on change_requests for each row execute function change_request_guard();
create trigger change_requests_no_delete before delete on change_requests for each row execute function refuse_delete();
create trigger change_requests_audit after insert or update on change_requests for each row execute function audit_row();
alter table change_requests enable row level security;
create policy change_requests_read on change_requests for select using (
  site_role(site_id) in ('reliability_engineer', 'superintendent', 'admin') or requested_by = auth.uid()
);
create policy change_requests_insert on change_requests for insert with check (
  requested_by = auth.uid() and (
    (kind = 'target' and site_role(site_id) in ('reliability_engineer', 'superintendent'))
    or (kind in ('role_grant', 'acting_role') and site_role(site_id) = 'admin')
  )
);
create policy change_requests_update on change_requests for update
  using (site_role(site_id) = 'superintendent' or requested_by = auth.uid())
  with check (site_role(site_id) = 'superintendent' or requested_by = auth.uid());

-- ---------- targets: only from an approved request ----------

alter table targets add column request_id uuid unique references change_requests(id) on delete restrict, add column approved_by uuid;
drop policy targets_write on targets;
create policy targets_write on targets for insert with check (site_role(site_id) = 'superintendent');

create or replace function target_needs_approval() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if not exists (
    select 1 from change_requests r
    where r.id = new.request_id and r.site_id = new.site_id and r.kind = 'target' and r.status = 'approved'
      and r.decided_by = auth.uid() and (r.applied_id is null or r.applied_id = new.id)
  ) then
    raise exception 'A target needs an approved request, applied by the superintendent who approved it.' using errcode = 'insufficient_privilege';
  end if;
  new.approved_by := auth.uid();
  return new;
end $$;
create trigger targets_need_approval before insert on targets for each row execute function target_needs_approval();

-- ---------- members: governed roles and acting roles ----------

create or replace function site_has_superintendent(p_site uuid, p_except uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from site_members m
    where m.site_id = p_site and m.retired_at is null and m.id is distinct from p_except
      and (m.role = 'superintendent' or (m.acting_role = 'superintendent' and m.acting_until > now()))
  );
$$;

create or replace function member_role_guard() returns trigger
language plpgsql set search_path = public as $$
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
     and not exists (
       select 1 from change_requests r
       where r.site_id = new.site_id and r.kind = 'acting_role' and r.status = 'approved' and r.decided_by = auth.uid()
         and r.payload->>'userId' = new.user_id::text and r.payload->>'role' = new.acting_role::text
         and (r.payload->>'until')::timestamptz = new.acting_until
     ) then
    raise exception 'An acting role needs a superintendent''s approval.' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' and new.acting_role is not null then
    raise exception 'An acting role needs a superintendent''s approval.' using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.acting_role is null and old.acting_role is not null and v_role is distinct from 'admin' then
    raise exception 'Only the Admin ends an acting role early.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger site_members_role_guard before insert or update on site_members for each row execute function member_role_guard();
create policy members_apply_approval on site_members for update
  using (site_role(site_id) = 'superintendent') with check (site_role(site_id) = 'superintendent');

-- Invites straight into a governed role only while the site has no superintendent.
create or replace function invite_role_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if new.role in ('admin', 'superintendent') and (tg_op = 'INSERT' or new.role is distinct from old.role)
     and site_has_superintendent(new.site_id, null) then
    raise exception 'Invite them as a viewer, then ask for the % role.', new.role using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger site_invites_role_guard before insert or update on site_invites for each row execute function invite_role_guard();

-- ---------- API ----------

-- New requests, notes and withdrawals. Update first, insert only new ids.
create or replace function app_save_requests(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select e from jsonb_array_elements(p_rows) e loop
    update change_requests set notes = coalesce(r->'notes', '[]'),
      status = case when r->>'status' = 'withdrawn' then 'withdrawn' else status end,
      decision_note = case when r->>'status' = 'withdrawn' then r->>'decisionNote' else decision_note end
    where id = (r->>'id')::uuid and site_id = p_site;
    if not found then
      insert into change_requests (id, tenant_id, site_id, kind, title, reason, payload, impact)
      select (r->>'id')::uuid, s.tenant_id, p_site, r->>'kind', r->>'title', r->>'reason', r->'payload', coalesce(r->'impact', '[]')
      from sites s where s.id = p_site;
    end if;
  end loop;
end $$;

-- A decision and what it applies, in one transaction.
create or replace function app_decide_request(p_site uuid, p_id uuid, p_decision text, p_note text, p_target jsonb default null) returns void
language plpgsql security invoker set search_path = public as $$
declare r change_requests;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'Unknown decision'; end if;
  update change_requests set status = p_decision, decision_note = nullif(trim(coalesce(p_note, '')), '')
  where id = p_id and site_id = p_site and status = 'pending'
  returning * into r;
  if not found then raise exception 'Request not found or already decided.' using errcode = 'no_data_found'; end if;
  if p_decision = 'rejected' then return; end if;

  if r.kind = 'target' then
    if p_target is null then raise exception 'The target to apply is missing.'; end if;
    insert into targets (id, tenant_id, site_id, kpi, fleet_name, model, target, amber, effective_from, reason, set_at, created_by, request_id)
    values ((p_target->>'id')::uuid, r.tenant_id, p_site, p_target->>'kpi', p_target->>'fleet', p_target->>'model', (p_target->>'value')::numeric,
      (p_target->>'amber')::numeric, (p_target->>'effectiveFrom')::timestamptz, r.reason, now(), r.requested_by, r.id);
    update change_requests set applied_id = (p_target->>'id')::uuid where id = r.id;
  elsif r.kind = 'role_grant' then
    update site_members set role = (r.payload->>'role')::app_role where site_id = p_site and user_id = (r.payload->>'userId')::uuid and retired_at is null;
    if not found then raise exception 'That user is no longer active.'; end if;
    update change_requests set applied_id = (r.payload->>'userId')::uuid where id = r.id;
  else
    update site_members set acting_role = (r.payload->>'role')::app_role, acting_until = (r.payload->>'until')::timestamptz
    where site_id = p_site and user_id = (r.payload->>'userId')::uuid and retired_at is null;
    if not found then raise exception 'That user is no longer active.'; end if;
    update change_requests set applied_id = (r.payload->>'userId')::uuid where id = r.id;
  end if;
end $$;

-- Requests the caller may see, acting roles, and which targets came from which approval.
create or replace function app_load_approvals(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'requests', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'reason', r.reason, 'payload', r.payload,
        'impact', r.impact, 'status', r.status, 'requestedBy', r.requested_by, 'requestedAt', r.requested_at, 'notes', r.notes,
        'decidedBy', r.decided_by, 'decidedAt', r.decided_at, 'decisionNote', r.decision_note, 'appliedId', r.applied_id)) order by r.requested_at)
      from change_requests r where r.site_id = p_site), '[]'),
    'acting', coalesce((
      select jsonb_agg(jsonb_build_object('userId', m.user_id, 'role', m.acting_role, 'until', m.acting_until))
      from site_members m where m.site_id = p_site and m.acting_role is not null), '[]'),
    'targets', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'requestId', t.request_id, 'approvedBy', t.approved_by))
      from targets t where t.site_id = p_site and t.request_id is not null), '[]'));
$$;

grant execute on function is_client, site_has_superintendent, app_save_requests, app_decide_request, app_load_approvals to authenticated;
grant select, insert, update on change_requests to authenticated;
