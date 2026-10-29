-- Public API version 1, read-only (phase 4 part 3, docs/public-api.md).
-- Keys per site, made and revoked by the site's Admin. Only the SHA-256 hash and
-- the first 12 characters of a key are kept. api_v1 is the only way the anon role
-- reaches site rows: it checks the key, the scope and the per-minute limit, logs
-- the call, and reads only the key's site.

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  name text not null check (length(trim(name)) between 1 and 80),
  prefix text not null,
  key_hash bytea not null unique,
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ array['units', 'flags', 'work_orders', 'smu']),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  check (revoked_at is null or nullif(trim(revoke_reason), '') is not null)
);
create index api_keys_site on api_keys (site_id);

create table api_calls (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  site_id uuid not null,
  key_id uuid not null references api_keys(id) on delete restrict,
  resource text not null,
  at timestamptz not null default clock_timestamp(),
  row_count int not null default 0
);
create index api_calls_key_at on api_calls (key_id, at desc);

alter table api_keys enable row level security;
alter table api_calls enable row level security;
-- The site's Admin sees its keys and calls. Nobody writes to them except through the functions below.
create policy api_keys_read on api_keys for select using (site_role(site_id) = 'admin');
create policy api_calls_read on api_calls for select using (site_role(site_id) = 'admin');
revoke all on api_keys, api_calls from public, anon, authenticated;
-- The hash is never readable from the app.
grant select (id, tenant_id, site_id, name, prefix, scopes, expires_at, created_at, created_by, revoked_at, revoked_by, revoke_reason) on api_keys to authenticated;
grant select on api_calls to authenticated;

-- ---------- keys (the Admin, from the app) ----------

create or replace function app_create_api_key(p_site uuid, p_name text, p_scopes text[], p_days int default 365) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := (select tenant_id from sites where id = p_site and retired_at is null);
  v_key text := 'mrk_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid := gen_random_uuid();
  v_scopes text[] := (select array_agg(distinct s order by s) from unnest(p_scopes) s);
  v_exp timestamptz := now() + make_interval(days => coalesce(p_days, 365));
begin
  if auth.uid() is null or v_tenant is null or site_role(p_site) is distinct from 'admin' then
    raise exception 'The site''s Admin makes API keys.' using errcode = 'insufficient_privilege';
  end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'Name the system that uses the key (1 to 80 characters).' using errcode = 'check_violation'; end if;
  if v_scopes is null or not v_scopes <@ array['units', 'flags', 'work_orders', 'smu'] then raise exception 'Choose what the key can read.' using errcode = 'check_violation'; end if;
  if coalesce(p_days, 365) not between 1 and 730 then raise exception 'A key lasts 1 to 730 days.' using errcode = 'check_violation'; end if;
  insert into api_keys (id, tenant_id, site_id, name, prefix, key_hash, scopes, expires_at, created_by)
  values (v_id, v_tenant, p_site, trim(p_name), left(v_key, 12), sha256(convert_to(v_key, 'UTF8')), v_scopes, v_exp, auth.uid());
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after, reason)
  values (v_tenant, p_site, auth.uid(), 'create_api_key', 'api_key', v_id, null,
    jsonb_build_object('name', trim(p_name), 'prefix', left(v_key, 12), 'scopes', v_scopes, 'expiresAt', v_exp), 'New API key');
  -- The full key is returned this once and kept nowhere.
  return jsonb_build_object('id', v_id, 'key', v_key, 'prefix', left(v_key, 12), 'scopes', v_scopes, 'expiresAt', v_exp);
end $$;

create or replace function app_revoke_api_key(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare k api_keys;
begin
  select * into k from api_keys where id = p_id for update;
  if auth.uid() is null or k.id is null or site_role(k.site_id) is distinct from 'admin' then
    raise exception 'The site''s Admin revokes API keys.' using errcode = 'insufficient_privilege';
  end if;
  if k.revoked_at is not null then raise exception 'That key is already revoked.' using errcode = 'check_violation'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'Give a reason.' using errcode = 'check_violation'; end if;
  update api_keys set revoked_at = now(), revoked_by = auth.uid(), revoke_reason = trim(p_reason) where id = p_id;
  insert into audit_log (tenant_id, site_id, user_id, action, entity, entity_id, before, after, reason)
  values (k.tenant_id, k.site_id, auth.uid(), 'revoke_api_key', 'api_key', p_id,
    jsonb_build_object('revokedAt', null), jsonb_build_object('revokedAt', now()), trim(p_reason));
end $$;

-- The site's keys with their use, for the API access page. Row-level security decides what is seen.
create or replace function app_api_keys(p_site uuid) returns table (
  id uuid, name text, prefix text, scopes text[], expires_at timestamptz, created_at timestamptz, created_by uuid,
  revoked_at timestamptz, revoked_by uuid, revoke_reason text, last_used_at timestamptz, calls_24h bigint
) language sql stable security invoker set search_path = public as $$
  select k.id, k.name, k.prefix, k.scopes, k.expires_at, k.created_at, k.created_by, k.revoked_at, k.revoked_by, k.revoke_reason,
    (select max(c.at) from api_calls c where c.key_id = k.id),
    (select count(*) from api_calls c where c.key_id = k.id and c.at > now() - interval '24 hours')
  from api_keys k where k.site_id = p_site order by k.revoked_at is not null, k.created_at desc;
$$;

-- ---------- the read API (other systems) ----------

create or replace function api_v1(resource text, params jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_raw text := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb->>'x-mr-api-key';
  k api_keys;
  s sites;
  v_data jsonb;
  v_next text;
  v_from timestamptz;
  v_to timestamptz;
  v_since timestamptz;
  v_limit int;
  v_cur_at timestamptz;
  v_cur_id uuid;
  p jsonb := coalesce(params, '{}');
begin
  if v_raw is null or v_raw !~ '^mrk_[0-9a-f]{64}$' then raise exception 'API key not accepted.' using errcode = 'PT401'; end if;
  select * into k from api_keys where key_hash = sha256(convert_to(v_raw, 'UTF8')) for update;
  if k.id is null or k.revoked_at is not null or k.expires_at <= now() then raise exception 'API key not accepted.' using errcode = 'PT401'; end if;
  select * into s from sites where id = k.site_id;
  if s.retired_at is not null then raise exception 'API key not accepted.' using errcode = 'PT401'; end if;
  if resource is null or resource not in ('units', 'flags', 'work_orders', 'smu') then
    raise exception 'Unknown resource. Use units, flags, work_orders or smu.' using errcode = 'PT400';
  end if;
  if not resource = any (k.scopes) then raise exception 'This key cannot read %.', resource using errcode = 'PT403'; end if;
  -- 60 calls per key in a rolling minute. The row lock above makes calls with one key take turns.
  if (select count(*) from api_calls c where c.key_id = k.id and c.at > clock_timestamp() - interval '1 minute') >= 60 then
    raise exception 'Too many calls. At most 60 a minute per key.' using errcode = 'PT429';
  end if;

  if resource in ('flags', 'smu') then
    begin
      if coalesce(p->>'from', '') !~ 'T.*(Z|[+-]\d{2}:?\d{2})$' or coalesce(p->>'to', '') !~ 'T.*(Z|[+-]\d{2}:?\d{2})$' then raise exception using errcode = '22007'; end if;
      v_from := (p->>'from')::timestamptz;
      v_to := (p->>'to')::timestamptz;
    exception when others then
      raise exception 'Give from and to as ISO 8601 times with an offset.' using errcode = 'PT400';
    end;
    if v_to <= v_from then raise exception 'to must be after from.' using errcode = 'PT400'; end if;
    if v_to - v_from > interval '92 days' then raise exception 'At most 92 days per call.' using errcode = 'PT400'; end if;
  end if;

  if resource = 'units' then
    select coalesce(jsonb_agg(u order by u->>'unit_number'), '[]') into v_data from (
      select jsonb_build_object(
        'id', a.id, 'unit_number', a.unit_number, 'asset_class', a.asset_class, 'external_asset_id', a.external_asset_id,
        'fleet', f.name, 'model', at.model, 'lifecycle', coalesce(at.lifecycle::text, 'active'),
        'status', case when df.id is null then 'up' else 'down' end,
        'down_flag', case when df.id is null then null else jsonb_build_object(
          'id', df.id, 'type', df.flag_type, 'reason_code', df.reason_code, 'starts_at', df.starts_at,
          'stage', (select st.stage from flag_stage_intervals st where st.flag_id = df.id and st.ends_at is null),
          'location', (select l.kind from flag_location_intervals l where l.flag_id = df.id and l.ends_at is null)) end) u
      from assets a
      left join asset_attributes at on at.asset_id = a.id and at.effective_from <= now() and (at.effective_to is null or at.effective_to > now())
      left join fleets f on f.id = at.fleet_id
      left join lateral (select * from down_flags d where d.asset_id = a.id and d.state = 'open' order by d.starts_at desc limit 1) df on true
      where a.site_id = k.site_id and a.retired_at is null
    ) x;
  elsif resource = 'flags' then
    select coalesce(jsonb_agg(x.j order by x.starts_at, x.id), '[]') into v_data from (
      select d.id, d.starts_at, jsonb_build_object(
        'id', d.id, 'unit_id', d.asset_id, 'unit_number', a.unit_number, 'type', d.flag_type, 'state', d.state,
        'reason_code', d.reason_code, 'system', d.system, 'component', d.component, 'cause_code', d.cause_code,
        'starts_at', d.starts_at, 'ends_at', d.ends_at, 'entered_at', d.entered_at, 'false_release', d.false_release,
        'stages', (select coalesce(jsonb_agg(jsonb_build_object('stage', st.stage, 'starts_at', st.starts_at, 'ends_at', st.ends_at) order by st.starts_at), '[]')
                   from flag_stage_intervals st where st.flag_id = d.id),
        'locations', (select coalesce(jsonb_agg(jsonb_build_object('kind', l.kind, 'shop_line_id', l.shop_line_id, 'field_location', l.field_location, 'starts_at', l.starts_at, 'ends_at', l.ends_at) order by l.starts_at), '[]')
                      from flag_location_intervals l where l.flag_id = d.id)) j
      from down_flags d join assets a on a.id = d.asset_id
      where d.site_id = k.site_id and d.state <> 'voided' and d.starts_at < v_to and (d.ends_at is null or d.ends_at > v_from)
    ) x;
  elsif resource = 'smu' then
    select coalesce(jsonb_agg(jsonb_build_object('unit_id', r.asset_id, 'unit_number', a.unit_number, 'read_at', r.read_at, 'hours', r.hours, 'source', r.source) order by r.read_at, r.id), '[]')
    into v_data
    from smu_readings r join assets a on a.id = r.asset_id
    where r.site_id = k.site_id and r.voided_at is null and r.read_at >= v_from and r.read_at < v_to;
  else
    begin
      v_since := (p->>'changed_since')::timestamptz;
      v_limit := coalesce((p->>'limit')::int, 500);
      if p ? 'cursor' and p->>'cursor' is not null then
        v_cur_at := split_part(p->>'cursor', '|', 1)::timestamptz;
        v_cur_id := split_part(p->>'cursor', '|', 2)::uuid;
      end if;
    exception when others then
      raise exception 'Give changed_since as an ISO 8601 time, and limit and cursor as returned.' using errcode = 'PT400';
    end;
    if v_since is null then raise exception 'Give changed_since as an ISO 8601 time.' using errcode = 'PT400'; end if;
    if v_limit not between 1 and 500 then raise exception 'limit is 1 to 500.' using errcode = 'PT400'; end if;
    with page as (
      select w.* from work_orders w
      where w.site_id = k.site_id and w.updated_at >= v_since
        and (v_cur_at is null or (w.updated_at, w.id) > (v_cur_at, v_cur_id))
      order by w.updated_at, w.id limit v_limit + 1
    ), shown as (select * from page order by updated_at, id limit v_limit)
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', w.id, 'number', w.number, 'source_system', w.source_system, 'unit_id', w.asset_id, 'unit_number', a.unit_number,
        'type', w.wo_type, 'status', w.status, 'priority', w.priority, 'description', w.description,
        'reported_at', w.reported_at, 'completed_at', w.completed_at, 'source_modified_at', w.source_modified_at, 'changed_at', w.updated_at
      ) order by w.updated_at, w.id), '[]'),
      case when (select count(*) from page) > v_limit then (select to_char(max(updated_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || (array_agg(id order by updated_at desc, id desc))[1] from shown) end
    into v_data, v_next
    from shown w left join assets a on a.id = w.asset_id;
  end if;

  insert into api_calls (tenant_id, site_id, key_id, resource, row_count) values (k.tenant_id, k.site_id, k.id, resource, jsonb_array_length(v_data));
  return jsonb_build_object('api_version', 1, 'site', jsonb_build_object('id', s.id, 'name', s.name, 'time_zone', s.time_zone),
    'resource', resource, 'generated_at', now(), 'data', v_data, 'next_cursor', v_next);
end $$;

revoke execute on function app_create_api_key, app_revoke_api_key, api_v1 from public;
grant execute on function app_create_api_key, app_revoke_api_key, app_api_keys to authenticated;
grant execute on function api_v1 to anon, authenticated;

notify pgrst, 'reload schema';
