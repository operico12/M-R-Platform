-- Phase 2: saved explorer views (docs/analytics-explorer.md). A view is a
-- name and a page link, private or shared with the site. Never deleted:
-- retired with a reason.

create table saved_views (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 120),
  query text not null default '' check (length(query) <= 4000),
  shared boolean not null default false,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  retired_by uuid,
  retired_at timestamptz,
  retired_reason text,
  check (retired_at is null or length(trim(coalesce(retired_reason, ''))) > 0)
);
create index saved_views_site on saved_views (site_id, created_at);

create or replace function saved_view_guard() returns trigger
language plpgsql set search_path = public as $$
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
  if not (old.created_by = auth.uid() or (old.shared and site_role(old.site_id) = 'superintendent')) then
    raise exception 'Only the author retires a view (or a superintendent, for a shared one).' using errcode = 'insufficient_privilege';
  end if;
  new.retired_by := auth.uid(); new.retired_at := now();
  return new;
end $$;

create trigger saved_views_guard before insert or update on saved_views for each row execute function saved_view_guard();
create trigger saved_views_no_delete before delete on saved_views for each row execute function refuse_delete();
create trigger saved_views_audit after insert or update on saved_views for each row execute function audit_row();
alter table saved_views enable row level security;
-- Shared views: everyone at the site. Private views: their author only.
create policy saved_views_read on saved_views for select using (is_site_member(site_id) and (shared or created_by = auth.uid()));
-- Plan 11.2 "Run calculators and analyses".
create policy saved_views_insert on saved_views for insert with check (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));
create policy saved_views_update on saved_views for update using (site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent'));

create or replace function app_save_view(p_site uuid, v jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update saved_views set retired_reason = v->>'retiredReason'
  where id = (v->>'id')::uuid and site_id = p_site and v->>'retiredAt' is not null;
  if not found then
    insert into saved_views (id, tenant_id, site_id, name, query, shared)
    select (v->>'id')::uuid, s.tenant_id, p_site, v->>'name', coalesce(v->>'query', ''), coalesce((v->>'shared')::boolean, false)
    from sites s where s.id = p_site;
  end if;
end $$;

create or replace function app_load_views(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', x.id, 'name', x.name, 'query', x.query, 'shared', x.shared,
    'createdBy', x.created_by, 'createdAt', x.created_at, 'retiredBy', x.retired_by, 'retiredAt', x.retired_at, 'retiredReason', x.retired_reason))
    order by x.created_at), '[]')
  from saved_views x where x.site_id = p_site;
$$;

grant execute on function app_save_view, app_load_views to authenticated;
grant select, insert, update on saved_views to authenticated;

-- Private views stay private: view history is not added to the site-wide
-- audit page policy (the full audit log stays superintendent and admin).
