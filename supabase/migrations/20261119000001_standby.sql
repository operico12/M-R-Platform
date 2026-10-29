-- Standby flags (docs/standby.md, KPI-044 and KPI-045): the unit was available but not in use.
-- Timed like down flags, never typed as durations (rule 4), never deleted (rule 5), audited.

create table standby_flags (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  reason_code text not null check (reason_code ~ '^[A-Z0-9_]{1,30}$'),
  kind text not null check (kind in ('operating_delay', 'standby')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  state text not null default 'open' check (state in ('open', 'ended', 'voided')),
  note text check (note is null or length(note) <= 300),
  set_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now(),
  ended_by uuid,
  ended_by_down_flag_id uuid references down_flags(id) on delete restrict,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  check (ends_at is null or ends_at > starts_at),
  check ((state = 'open') = (ends_at is null) or state = 'voided'),
  check ((state = 'voided') = (void_reason is not null)),
  check (void_reason is null or length(trim(void_reason)) between 1 and 300)
);
create index standby_flags_site on standby_flags (site_id, starts_at);
-- A unit has at most one open standby flag.
create unique index standby_flags_one_open on standby_flags (asset_id) where state = 'open';

-- Insert: the unit is a mobile asset at the same site with no open or proposed down flag; the start
-- is not in the future nor more than 7 days back; who and when are the signed-in person and now.
-- Update: only ending an open flag once, or voiding once with a reason.
create or replace function standby_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from assets a where a.id = new.asset_id and a.site_id = new.site_id and a.tenant_id = new.tenant_id) then
      raise exception 'The unit must be at the same site.' using errcode = 'check_violation';
    end if;
    if new.state = 'open' and exists (select 1 from down_flags f where f.asset_id = new.asset_id and f.state in ('open', 'proposed')) then
      raise exception 'A unit that is down is not on standby.' using errcode = 'check_violation';
    end if;
    if new.starts_at > now() + interval '5 minutes' or new.ends_at > now() + interval '5 minutes' then
      raise exception 'Times cannot be in the future.' using errcode = 'check_violation';
    end if;
    if new.starts_at < now() - interval '7 days' then
      raise exception 'A standby flag can start up to 7 days back.' using errcode = 'check_violation';
    end if;
    new.set_by := auth.uid(); new.entered_at := now();
    if new.state = 'voided' then new.voided_at := now(); new.voided_by := auth.uid();
    else new.voided_at := null; new.voided_by := null; new.void_reason := null; end if;
    return new;
  end if;
  if old.state = 'voided' then raise exception 'This standby flag is voided.' using errcode = 'insufficient_privilege'; end if;
  if (to_jsonb(new) - array['ends_at', 'state', 'ended_by', 'ended_by_down_flag_id', 'voided_at', 'voided_by', 'void_reason'])
     is distinct from (to_jsonb(old) - array['ends_at', 'state', 'ended_by', 'ended_by_down_flag_id', 'voided_at', 'voided_by', 'void_reason']) then
    raise exception 'A standby flag cannot be changed. End it or void it.' using errcode = 'insufficient_privilege';
  end if;
  if new.state = 'ended' and old.state = 'ended' and new.ends_at is distinct from old.ends_at then
    raise exception 'This standby flag has already ended.' using errcode = 'insufficient_privilege';
  end if;
  if new.state = 'open' and old.state <> 'open' then
    raise exception 'An ended standby flag cannot be reopened.' using errcode = 'insufficient_privilege';
  end if;
  if new.ends_at is distinct from old.ends_at and new.ends_at > now() + interval '5 minutes' then
    raise exception 'The end cannot be in the future.' using errcode = 'check_violation';
  end if;
  if new.state = 'ended' and old.state = 'open' then new.ended_by := auth.uid(); end if;
  if new.state = 'voided' then new.voided_at := now(); new.voided_by := auth.uid(); end if;
  return new;
end $$;

create trigger standby_flags_guard before insert or update on standby_flags for each row execute function standby_guard();
create trigger standby_flags_no_delete before delete on standby_flags for each row execute function refuse_delete();
create trigger standby_flags_audit after insert or update on standby_flags for each row execute function audit_row();

alter table standby_flags enable row level security;
create policy standby_flags_read on standby_flags for select using (site_id in (select my_site_ids()));
-- Permission set_standby (packages/core/src/permissions.ts): technician, supervisor, reliability engineer, superintendent.
create policy standby_flags_insert on standby_flags for insert with check (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
create policy standby_flags_update on standby_flags for update using (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'))
  with check (site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
grant select, insert, update on standby_flags to authenticated;

-- Standby flags as the core commands return them: new ones are inserted, known ones may only be
-- ended or voided (the guard allows nothing else).
create or replace function app_save_standby(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select e from jsonb_array_elements(p_rows) e loop
    insert into standby_flags (id, tenant_id, site_id, asset_id, reason_code, kind, starts_at, ends_at, state, note, ended_by_down_flag_id, void_reason)
    select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'unitId')::uuid, r->>'reasonCode', r->>'kind', (r->>'start')::timestamptz,
      (r->>'end')::timestamptz, r->>'state', nullif(trim(r->>'note'), ''), (r->>'endedByDownFlagId')::uuid, nullif(trim(r->>'voidReason'), '')
    from sites s where s.id = p_site
    on conflict (id) do update set ends_at = excluded.ends_at, state = excluded.state,
      ended_by_down_flag_id = coalesce(excluded.ended_by_down_flag_id, standby_flags.ended_by_down_flag_id), void_reason = excluded.void_reason
    where standby_flags.site_id = p_site;
  end loop;
end $$;

create or replace function app_load_standby(p_site uuid, p_since timestamptz default now() - interval '400 days') returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', b.id, 'tenantId', b.tenant_id, 'siteId', b.site_id, 'unitId', b.asset_id, 'reasonCode', b.reason_code, 'kind', b.kind,
    'start', b.starts_at, 'end', b.ends_at, 'state', b.state, 'note', b.note, 'setBy', b.set_by, 'enteredAt', b.entered_at,
    'endedBy', b.ended_by, 'endedByDownFlagId', b.ended_by_down_flag_id, 'voidedBy', b.voided_by, 'voidedAt', b.voided_at, 'voidReason', b.void_reason
  )) order by b.starts_at), '[]')
  from standby_flags b where b.site_id = p_site and (b.ends_at is null or b.ends_at >= p_since);
$$;

revoke execute on function standby_guard, app_save_standby, app_load_standby from public, anon;
grant execute on function app_save_standby, app_load_standby to authenticated;

notify pgrst, 'reload schema';
