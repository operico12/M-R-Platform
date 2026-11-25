-- Flag comments (docs/flag-comments.md): a thread on a down flag, and optionally on one of its wait tags,
-- readable later. Never edited, never deleted (rule 5); a wrong one is voided with a reason. Audited.

create table flag_comments (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  asset_id uuid not null references assets(id) on delete restrict,
  down_flag_id uuid not null references down_flags(id) on delete restrict,
  wait_tag_id uuid references wait_tags(id) on delete restrict,
  body text not null check (length(trim(body)) between 1 and 1000),
  set_by uuid not null default auth.uid(),
  entered_at timestamptz not null default now(),
  state text not null default 'active' check (state in ('active', 'voided')),
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  check ((state = 'voided') = (void_reason is not null)),
  check (void_reason is null or length(trim(void_reason)) between 1 and 300)
);
create index flag_comments_flag on flag_comments (down_flag_id, entered_at);
create index flag_comments_site on flag_comments (site_id, entered_at);

-- Insert: the flag and the optional wait tag belong to the same unit, site and tenant; the flag is open
-- or released; the author and the time are the signed-in person and now. Update: only voiding once, with
-- a reason, by the author or a supervisor, reliability engineer or superintendent.
create or replace function flag_comment_guard() returns trigger
language plpgsql set search_path = public as $$
declare f down_flags; w wait_tags;
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    select * into f from down_flags where id = new.down_flag_id;
    if f.id is null or f.asset_id <> new.asset_id or f.site_id <> new.site_id or f.tenant_id <> new.tenant_id then
      raise exception 'The comment must belong to a down flag on the same unit.' using errcode = 'check_violation';
    end if;
    if f.state not in ('open', 'released') then
      raise exception 'Comments can be added to an open or released flag.' using errcode = 'check_violation';
    end if;
    if new.wait_tag_id is not null then
      select * into w from wait_tags where id = new.wait_tag_id;
      if w.id is null or w.down_flag_id <> new.down_flag_id or w.state = 'voided' then
        raise exception 'The wait must be on this flag and not voided.' using errcode = 'check_violation';
      end if;
    end if;
    new.set_by := auth.uid(); new.entered_at := now(); new.state := 'active';
    new.voided_by := null; new.voided_at := null; new.void_reason := null;
    return new;
  end if;
  if old.state = 'voided' then raise exception 'This comment is voided.' using errcode = 'insufficient_privilege'; end if;
  if (to_jsonb(new) - array['state', 'voided_by', 'voided_at', 'void_reason'])
     is distinct from (to_jsonb(old) - array['state', 'voided_by', 'voided_at', 'void_reason']) then
    raise exception 'A comment cannot be changed. Void it with a reason.' using errcode = 'insufficient_privilege';
  end if;
  if new.state = 'voided' then
    if old.set_by <> auth.uid() and not admin_full(old.site_id) and site_role(old.site_id) not in ('supervisor', 'reliability_engineer', 'superintendent') then
      raise exception 'Only the author or a supervisor can void a comment.' using errcode = 'insufficient_privilege';
    end if;
    new.voided_by := auth.uid(); new.voided_at := now();
  end if;
  return new;
end $$;

create trigger flag_comments_guard before insert or update on flag_comments for each row execute function flag_comment_guard();
create trigger flag_comments_no_delete before delete on flag_comments for each row execute function refuse_delete();
create trigger flag_comments_audit after insert or update on flag_comments for each row execute function audit_row();

alter table flag_comments enable row level security;
create policy flag_comments_read on flag_comments for select using (site_id in (select my_site_ids()));
-- Permission add_notes (packages/core/src/permissions.ts): technician, supervisor, reliability engineer, superintendent.
-- admin_full is the Admin's test-mode override (docs/access.md section 4); every role test accepts it.
create policy flag_comments_insert on flag_comments for insert with check (admin_full(site_id) or site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
create policy flag_comments_update on flag_comments for update using (admin_full(site_id) or site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'))
  with check (admin_full(site_id) or site_role(site_id) in ('technician', 'supervisor', 'reliability_engineer', 'superintendent'));
grant select, insert, update on flag_comments to authenticated;

-- Comments as the core commands return them: a new one is inserted, a known one may only be voided.
-- A known comment is updated directly (not by insert ... on conflict), so the insert guard, which
-- always starts a comment as active, never sees it.
create or replace function app_save_comments(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select e from jsonb_array_elements(p_rows) e loop
    if exists (select 1 from flag_comments where id = (r->>'id')::uuid and site_id = p_site) then
      update flag_comments set state = r->>'state', void_reason = nullif(trim(r->>'voidReason'), '')
      where id = (r->>'id')::uuid and site_id = p_site;
    else
      insert into flag_comments (id, tenant_id, site_id, asset_id, down_flag_id, wait_tag_id, body)
      select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'unitId')::uuid, (r->>'downFlagId')::uuid, nullif(r->>'waitTagId', '')::uuid, r->>'text'
      from sites s where s.id = p_site;
    end if;
  end loop;
end $$;

create or replace function app_load_comments(p_site uuid, p_since timestamptz default now() - interval '400 days') returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', c.id, 'tenantId', c.tenant_id, 'siteId', c.site_id, 'unitId', c.asset_id, 'downFlagId', c.down_flag_id, 'waitTagId', c.wait_tag_id,
    'text', c.body, 'setBy', c.set_by, 'enteredAt', c.entered_at, 'state', c.state,
    'voidedBy', c.voided_by, 'voidedAt', c.voided_at, 'voidReason', c.void_reason
  )) order by c.entered_at), '[]')
  from flag_comments c where c.site_id = p_site and c.entered_at >= p_since;
$$;

revoke execute on function flag_comment_guard, app_save_comments, app_load_comments from public, anon;
grant execute on function app_save_comments, app_load_comments to authenticated;

notify pgrst, 'reload schema';
