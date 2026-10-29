-- Assist, the first AI features (phase 3; docs/ai-assist.md). No new tables:
-- suggestions and drafts are worked out in the app from records the person can
-- already read, and nothing is written by assist itself. This adds the
-- 'assist' site setting.

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts', 'condition', 'rcm', 'spares', 'assist'));

-- edit_assist (packages/core/src/permissions.ts): reliability engineer and superintendent.
create or replace function can_write_setting(p_site uuid, p_key text) returns boolean
language sql stable security invoker set search_path = public as $$
  select case p_key
    when 'work' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'condition' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'rcm' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'spares' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'assist' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    else false end;
$$;
