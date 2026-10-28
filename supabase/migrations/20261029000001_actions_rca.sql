-- Phase 2: improvement actions and root cause analyses (RCA).
-- Same rules as the rest of the schema: tenant and site on every row, read by
-- site members, never deleted, every change in the audit log. The app runs
-- the permission rules in packages/core/src/improve.ts; the policies and the
-- trigger below are the backstop.

create table improvement_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  detail text,
  owner_id uuid not null,
  due date not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  -- Where it came from: { kind, query, unitId, flagId, rcaId, label }.
  source jsonb not null,
  started_at timestamptz,
  done_at timestamptz,
  done_note text,
  cancelled_at timestamptz,
  cancel_reason text,
  check (status <> 'done' or (done_at is not null and length(trim(coalesce(done_note, ''))) > 0)),
  check (status <> 'cancelled' or length(trim(coalesce(cancel_reason, ''))) > 0),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);
create index improvement_actions_site on improvement_actions (site_id, status, due);

create table rcas (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  problem text not null check (length(trim(problem)) > 0),
  source jsonb not null,
  flag_ids uuid[] not null default '{}',
  whys jsonb not null default '[]' check (jsonb_typeof(whys) = 'array' and jsonb_array_length(whys) <= 7),
  fishbone jsonb not null default '{}' check (jsonb_typeof(fishbone) = 'object'),
  root_cause text,
  status text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  lead_id uuid not null,
  closed_at timestamptz,
  close_note text,
  cancel_reason text,
  check (status <> 'closed' or (closed_at is not null and length(trim(coalesce(root_cause, ''))) > 0 and length(trim(coalesce(close_note, ''))) > 0)),
  check (status <> 'cancelled' or length(trim(coalesce(cancel_reason, ''))) > 0),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);
create index rcas_site on rcas (site_id, status);

do $$
declare t text;
begin
  foreach t in array array['improvement_actions', 'rcas'] loop
    execute format('create trigger %I_updated before update on %I for each row execute function set_updated()', t, t);
    execute format('create trigger %I_no_delete before delete on %I for each row execute function refuse_delete()', t, t);
    execute format('create trigger %I_audit after insert or update on %I for each row execute function audit_row()', t, t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I_read on %I for select using (is_site_member(site_id))', t, t);
  end loop;
end $$;

-- Actions: supervisors, reliability engineers and superintendents raise and
-- manage them. The owner, whatever their role, may update their own action.
create policy actions_insert on improvement_actions for insert with check (
  site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy actions_update on improvement_actions for update using (
  site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent')
  or (owner_id = auth.uid() and is_site_member(site_id)));

-- An owner who cannot manage actions may only start or close their own: no
-- change of title, owner, due date or source, no cancelling and no reopening.
create or replace function action_owner_limits() returns trigger
language plpgsql set search_path = public as $$
begin
  if site_role(new.site_id) in ('supervisor', 'reliability_engineer', 'superintendent') then return new; end if;
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
end $$;
create trigger improvement_actions_owner before update on improvement_actions for each row execute function action_owner_limits();

create policy rcas_insert on rcas for insert with check (site_role(site_id) in ('reliability_engineer', 'superintendent'));
create policy rcas_update on rcas for update using (site_role(site_id) in ('reliability_engineer', 'superintendent'));

-- ---------- app API ----------

create or replace function app_load_improve(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'actions', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', a.id, 'title', a.title, 'detail', a.detail, 'owner', a.owner_id, 'due', a.due,
        'status', a.status, 'source', a.source, 'createdBy', a.created_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
        'startedAt', a.started_at, 'doneAt', a.done_at, 'doneNote', a.done_note, 'cancelledAt', a.cancelled_at, 'cancelReason', a.cancel_reason))
        order by a.created_at)
      from improvement_actions a where a.site_id = p_site), '[]'),
    'rcas', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', r.id, 'title', r.title, 'problem', r.problem, 'source', r.source,
        'flagIds', to_jsonb(r.flag_ids), 'whys', r.whys, 'fishbone', r.fishbone, 'rootCause', r.root_cause, 'status', r.status,
        'lead', r.lead_id, 'createdBy', r.created_by, 'createdAt', r.created_at, 'updatedAt', r.updated_at,
        'closedAt', r.closed_at, 'closeNote', r.close_note, 'cancelReason', r.cancel_reason))
        order by r.created_at)
      from rcas r where r.site_id = p_site), '[]'));
$$;

-- Saves whole records as the core commands return them. Who may change what
-- is decided by the policies and trigger above, not by this function.
-- Update first and insert only new rows: an owner who cannot raise actions
-- may update their own, and must never pass the insert policy.
create or replace function app_save_actions(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare a jsonb;
begin
  for a in select e from jsonb_array_elements(p_rows) e loop
    update improvement_actions set title = a->>'title', detail = a->>'detail', owner_id = (a->>'owner')::uuid, due = (a->>'due')::date,
      status = a->>'status', source = a->'source', started_at = (a->>'startedAt')::timestamptz, done_at = (a->>'doneAt')::timestamptz,
      done_note = a->>'doneNote', cancelled_at = (a->>'cancelledAt')::timestamptz, cancel_reason = a->>'cancelReason'
    where id = (a->>'id')::uuid and site_id = p_site;
    if not found then
      -- A new id, or one that belongs to another site (then the key clash refuses it).
      insert into improvement_actions (id, tenant_id, site_id, title, detail, owner_id, due, status, source,
        started_at, done_at, done_note, cancelled_at, cancel_reason, created_by)
      select (a->>'id')::uuid, s.tenant_id, p_site, a->>'title', a->>'detail', (a->>'owner')::uuid, (a->>'due')::date, a->>'status', a->'source',
        (a->>'startedAt')::timestamptz, (a->>'doneAt')::timestamptz, a->>'doneNote', (a->>'cancelledAt')::timestamptz, a->>'cancelReason', auth.uid()
      from sites s where s.id = p_site;
    end if;
  end loop;
end $$;

create or replace function app_save_rcas(p_site uuid, p_rows jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into rcas (id, tenant_id, site_id, title, problem, source, flag_ids, whys, fishbone, root_cause, status, lead_id,
    closed_at, close_note, cancel_reason, created_by)
  select (r->>'id')::uuid, s.tenant_id, p_site, r->>'title', r->>'problem', r->'source',
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(r->'flagIds') x), '{}'),
    coalesce(r->'whys', '[]'), coalesce(r->'fishbone', '{}'), r->>'rootCause', r->>'status', (r->>'lead')::uuid,
    (r->>'closedAt')::timestamptz, r->>'closeNote', r->>'cancelReason', auth.uid()
  from jsonb_array_elements(p_rows) r, sites s where s.id = p_site
  on conflict (id) do update set title = excluded.title, problem = excluded.problem, source = excluded.source, flag_ids = excluded.flag_ids,
    whys = excluded.whys, fishbone = excluded.fishbone, root_cause = excluded.root_cause, status = excluded.status, lead_id = excluded.lead_id,
    closed_at = excluded.closed_at, close_note = excluded.close_note, cancel_reason = excluded.cancel_reason
  where rcas.site_id = p_site;
$$;

grant execute on function app_load_improve, app_save_actions, app_save_rcas to authenticated;
grant select, insert, update on improvement_actions, rcas to authenticated;
