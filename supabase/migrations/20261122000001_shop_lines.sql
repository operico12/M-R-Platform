-- Shop lines managed in the app (docs/shop-lines.md): the Admin adds, edits and retires lines; supervisors,
-- the superintendent and the Admin close a line and open it again. Nothing is deleted; every change is audited.

alter table shop_lines add column retired_reason text;
alter table shop_lines add constraint shop_lines_retire_check check (
  (retired_at is null) = (retired_reason is null)
  and (retired_reason is null or length(trim(retired_reason)) between 1 and 300)
  and (name is null or length(name) between 1 and 40)
  and capacity between 1 and 10
  and (number is null or number between 1 and 999)) not valid;
-- Two open lines at a site cannot share a number.
create unique index shop_lines_number_open on shop_lines (site_id, number) where retired_at is null and number is not null;

-- A closure may only be ended, once, not before it started and not in the future.
create or replace function closure_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not is_client() then return new; end if;
  if tg_op = 'INSERT' then
    if new.starts_at > now() + interval '5 minutes' then raise exception 'A line cannot be closed from a future time.' using errcode = 'check_violation'; end if;
    if length(trim(coalesce(new.reason, ''))) not between 1 and 300 then raise exception 'Give a reason for closing the line.' using errcode = 'check_violation'; end if;
    if exists (select 1 from flag_location_intervals li join down_flags d on d.id = li.flag_id
               where li.shop_line_id = new.shop_line_id and li.ends_at is null and d.state = 'open') then
      raise exception 'The line has a unit in it.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.ends_at is not null
     or (new.shop_line_id, new.starts_at, new.reason, new.site_id, new.tenant_id) is distinct from (old.shop_line_id, old.starts_at, old.reason, old.site_id, old.tenant_id)
     or new.ends_at is null or new.ends_at > now() + interval '5 minutes' then
    raise exception 'A closure can only be ended, once.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger shop_line_closures_guard before insert or update on shop_line_closures for each row execute function closure_guard();

create policy lines_reopen on shop_line_closures for update
  using (site_role(site_id) in ('supervisor', 'superintendent', 'admin'))
  with check (site_role(site_id) in ('supervisor', 'superintendent', 'admin'));
grant select, insert, update on shop_lines, shop_line_closures to authenticated;

-- The Admin's line changes. Creates the site's shop ("Main shop") if it has none; a line row names its shop.
create or replace function app_save_lines(p_site uuid, p_rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r jsonb; v_tenant uuid; v_shop uuid;
begin
  if site_role(p_site) is distinct from 'admin' then
    raise exception 'Only the site''s Admin adds or changes lines.' using errcode = 'insufficient_privilege';
  end if;
  select tenant_id into v_tenant from sites where id = p_site;
  for r in select e from jsonb_array_elements(p_rows) e loop
    if exists (select 1 from shop_lines l where l.id = (r->>'id')::uuid and l.site_id <> p_site) then
      raise exception 'That line belongs to another site.' using errcode = 'insufficient_privilege';
    end if;
    select id into v_shop from shops where site_id = p_site and retired_at is null
      and name = coalesce(nullif(r->>'shop', ''), name) order by created_at limit 1;
    if v_shop is null then
      select id into v_shop from shops where site_id = p_site and retired_at is null order by created_at limit 1;
    end if;
    if v_shop is null then
      insert into shops (tenant_id, site_id, name) values (v_tenant, p_site, coalesce(nullif(r->>'shop', ''), 'Main shop')) returning id into v_shop;
    end if;
    insert into shop_lines (id, tenant_id, site_id, shop_id, number, name, line_type, capacity, fits, sort_order, retired_at, retired_reason)
    values ((r->>'id')::uuid, v_tenant, p_site, v_shop, (r->>'number')::int, nullif(trim(r->>'name'), ''), r->>'lineType', (r->>'capacity')::int,
      coalesce((select array_agg(x) from jsonb_array_elements_text(r->'fits') x), '{}'), coalesce((r->>'number')::int, 500),
      (r->>'retiredAt')::timestamptz, nullif(trim(r->>'retiredReason'), ''))
    on conflict (id) do update set number = excluded.number, name = excluded.name, line_type = excluded.line_type,
      capacity = excluded.capacity, fits = excluded.fits, sort_order = excluded.sort_order,
      retired_at = coalesce(shop_lines.retired_at, excluded.retired_at), retired_reason = coalesce(shop_lines.retired_reason, excluded.retired_reason)
    where shop_lines.site_id = p_site and shop_lines.retired_at is null;
  end loop;
end $$;

-- Closures as the core commands return them: new ones are inserted, known ones may only be ended.
create or replace function app_save_closures(p_site uuid, p_rows jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare r jsonb;
begin
  for r in select e from jsonb_array_elements(p_rows) e loop
    insert into shop_line_closures (id, tenant_id, site_id, shop_line_id, starts_at, ends_at, reason)
    select (r->>'id')::uuid, s.tenant_id, p_site, (r->>'lineId')::uuid, (r->>'start')::timestamptz, (r->>'end')::timestamptz, r->>'reason'
    from sites s where s.id = p_site
    on conflict (id) do update set ends_at = excluded.ends_at where shop_line_closures.site_id = p_site;
  end loop;
end $$;

-- Closures now carry their id so the app can end them.
create or replace function app_load_closures(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'lineId', c.shop_line_id, 'start', c.starts_at, 'end', c.ends_at, 'reason', c.reason) order by c.starts_at), '[]')
  from shop_line_closures c where c.site_id = p_site;
$$;

revoke execute on function closure_guard, app_save_lines, app_save_closures, app_load_closures from public, anon;
grant execute on function app_save_lines, app_save_closures, app_load_closures to authenticated;

notify pgrst, 'reload schema';
