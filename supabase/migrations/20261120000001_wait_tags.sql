-- Wait tags (docs/wait-tags.md, KPI-046): what a down unit is waiting for, several at once,
-- each timed on its own. Never typed as durations (rule 4), never deleted (rule 5), audited.

create table wait_tags (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  down_flag_id uuid not null references down_flags(id) on delete restrict,
  kind text not null check (kind ~ '^[A-Z0-9_]{1,30}$'),
  starts_at timestamptz not null,
  ends_at timestamptz,
  state text not null default 'open' check (state in ('open', 'ended', 'voided')),
  note text check (note is null or length(note) <= 300),
  set_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now(),
  ended_by uuid,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  check (ends_at is null or ends_at > starts_at),
  check ((state = 'open') = (ends_at is null) or state = 'voided'),
  check ((state = 'voided') = (void_reason is not null)),
  check (void_reason is null or length(trim(void_reason)) between 1 and 300),
  check (kind <> 'OTHER' or state = 'voided' or length(trim(coalesce(note, ''))) > 0)
);
create index wait_tags_site on wait_tags (site_id, starts_at);
-- One open tag of each kind per unit; different kinds can run at once.
create unique index wait_tags_one_open on wait_tags (asset_id, kind) where state = 'open';

-- Insert: an open tag needs an open down flag on the same unit and site; the start is not in the
-- future, not more than 7 days back, and not before that flag started; who and when are the
-- signed-in person and now. Update: only ending an open tag once, or voiding once with a reason.
create or replace function wait_guard() returns trigger
language plpgsql set search_path = public as $$
declare f down_flags;
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    select * into f from down_flags where id = new.down_flag_id;
    if f.id is null or f.asset_id <> new.asset_id or f.site_id <> new.site_id or f.tenant_id <> new.tenant_id then
      raise exception 'The wait must belong to a down flag on the same unit.' using errcode = 'check_violation';
    end if;
    if new.state = 'open' and f.state <> 'open' then
      raise exception 'A wait needs an open down flag.' using errcode = 'check_violation';
    end if;
    if new.starts_at > now() + interval '5 minutes' or new.ends_at > now() + interval '5 minutes' then
      raise exception 'Times cannot be in the future.' using errcode = 'check_violation';
    end if;
    if new.starts_at < now() - interval '7 days' then
      raise exception 'A wait can start up to 7 days back.' using errcode = 'check_violation';
    end if;
    -- A type switch keeps the stop going, so the earliest linked flag counts (docs/wait-tags.md).
    if new.starts_at < (
      with recursive chain as (
        select d.id, d.starts_at, d.linked_from_flag_id from down_flags d where d.id = f.id
        union all
        select d.id, d.starts_at, d.linked_from_flag_id from down_flags d join chain c on d.id = c.linked_from_flag_id where d.state <> 'voided'
      ) select min(starts_at) from chain
    ) then
      raise exception 'A wait cannot start before the unit went down.' using errcode = 'check_violation';
    end if;
    new.set_by := auth.uid(); new.entered_at := now();
    if new.state = 'voided' then new.voided_at := now(); new.voided_by := auth.uid();
    else new.voided_at := null; new.voided_by := null; new.void_reason := null; end if;
    if new.state = 'ended' then new.ended_by := auth.uid(); else new.ended_by := null; end if;
    return new;
  end if;
  if old.state = 'voided' then raise exception 'This wait is voided.' using errcode = 'insufficient_privilege'; end if;
  if (to_jsonb(new) - array['ends_at', 'state', 'ended_by', 'voided_at', 'voided_by', 'void_reason'])
     is distinct from (to_jsonb(old) - array['ends_at', 'state', 'ended_by', 'voided_at', 'voided_by', 'void_reason']) then
    raise exception 'A wait cannot be changed. End it or void it.' using errcode = 'insufficient_privilege';
  end if;
  if new.state = 'ended' and old.state = 'ended' and new.ends_at is distinct from old.ends_at then
    raise exception 'This wait has already ended.' using errcode = 'insufficient_privilege';
  end if;
  if new.state = 'open' and old.state <> 'open' then
    raise exception 'An ended wait cannot be reopened.' using errcode = 'insufficient_privilege';
  end if;
  if new.ends_at is distinct from old.ends_at and new.ends_at > now() + interval '5 minutes' then
    raise exception 'The end cannot be in the future.' using errcode = 'check_violation';
  end if;
  if new.state = 'ended' and old.state = 'open' then new.ended_by := auth.uid(); end if;
  if new.state = 'voided' then new.voided_at := now(); new.voided_by := auth.uid(); end if;
  return new;
end $$;

create trigger wait_tags_guard before insert or update on wait_tags for each row execute function wait_guard();
create trigger wait_tags_no_delete before delete on wait_tags for each row execute function refuse_delete();
create trigger wait_tags_audit after insert or update on wait_tags for each row execute function audit_row();

alter table wait_tags enable row level security;
create policy wait_tags_read on wait_tags for select using (site_id in (select my_site_ids()));
-- Permission set_waits (packages/core/src/permissions.ts) follows update_stage: technician and
-- supervisor in their area (checked in the app, as for stage intervals), reliability engineer, superintendent.
create policy wait_tags_insert on wait_tags for insert with check (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
create policy wait_tags_update on wait_tags for update using (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'))
  with check (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
grant select, insert, update on wait_tags to authenticated;

-- Wait tags as the core commands return them: new ones are inserted, known ones may only be
-- ended or voided (the guard allows nothing else).
create or replace function app_save_waits(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select e from jsonb_array_elements(p_rows) e loop
    insert into wait_tags (id, tenant_id, site_id, asset_id, down_flag_id, kind, starts_at, ends_at, state, note, void_reason)
    select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'unitId')::uuid, (r->>'downFlagId')::uuid, r->>'kind', (r->>'start')::timestamptz,
      (r->>'end')::timestamptz, r->>'state', nullif(trim(r->>'note'), ''), nullif(trim(r->>'voidReason'), '')
    from sites s where s.id = p_site
    on conflict (id) do update set ends_at = excluded.ends_at, state = excluded.state, void_reason = excluded.void_reason
    where wait_tags.site_id = p_site;
  end loop;
end $$;

create or replace function app_load_waits(p_site uuid, p_since timestamptz default now() - interval '400 days') returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', w.id, 'tenantId', w.tenant_id, 'siteId', w.site_id, 'unitId', w.asset_id, 'downFlagId', w.down_flag_id, 'kind', w.kind,
    'start', w.starts_at, 'end', w.ends_at, 'state', w.state, 'note', w.note, 'setBy', w.set_by, 'enteredAt', w.entered_at,
    'endedBy', w.ended_by, 'voidedBy', w.voided_by, 'voidedAt', w.voided_at, 'voidReason', w.void_reason
  )) order by w.starts_at), '[]')
  from wait_tags w where w.site_id = p_site and (w.ends_at is null or w.ends_at >= p_since);
$$;

revoke execute on function wait_guard, app_save_waits, app_load_waits from public, anon;
grant execute on function app_save_waits, app_load_waits to authenticated;

notify pgrst, 'reload schema';
