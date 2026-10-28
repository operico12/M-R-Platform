-- Phase 2: reliability and threshold alerts (docs/alert-rules.md).
-- The alerts themselves are worked out by packages/core/src/alerting.ts from
-- the records, so only two things are stored: the site's alert rules (a
-- site setting) and people's answers to alerts. Answers are never changed or
-- deleted; a later answer to the same alert takes over.

-- ---------- alert rules: a site setting ----------

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts'));

-- Plan 11.2: "KPI targets and thresholds" (work settings) is reliability
-- engineer and superintendent; "Edit alert rules and thresholds" adds admin.
create or replace function can_write_setting(p_site uuid, p_key text) returns boolean
language sql stable security invoker set search_path = public as $$
  select case p_key
    when 'work' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    else false end;
$$;
drop policy site_settings_insert on site_settings;
drop policy site_settings_update on site_settings;
create policy site_settings_insert on site_settings for insert with check (can_write_setting(site_id, key));
create policy site_settings_update on site_settings for update using (can_write_setting(site_id, key)) with check (can_write_setting(site_id, key));

-- ---------- answers to alerts ----------

create table alert_answers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  site_id uuid not null references sites(id) on delete restrict,
  -- The alert's key from alerting.ts, for example repeat_offender:<unit>:<system>:<event>.
  alert_key text not null check (length(alert_key) between 1 and 300),
  kind text not null check (kind in ('repeat_offender', 'mtbf_drop', 'repair_spike', 'cluster', 'chronic', 'silent', 'pm_overdue', 'kpi_below')),
  unit_id uuid references assets(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  decision text not null check (decision in ('noted', 'not_a_problem', 'action_raised')),
  note text not null default '',
  action_id uuid references improvement_actions(id) on delete restrict,
  check (decision <> 'not_a_problem' or length(trim(note)) > 0),
  check (decision <> 'action_raised' or action_id is not null),
  -- The real entry time and person, set here, never by the app.
  answered_at timestamptz not null default now(),
  answered_by uuid not null default auth.uid()
);
create index alert_answers_site on alert_answers (site_id, alert_key, answered_at);

create trigger alert_answers_no_delete before delete on alert_answers for each row execute function refuse_delete();
create or replace function refuse_answer_change() returns trigger language plpgsql as $$
begin
  raise exception 'An answer to an alert cannot be changed. Add a new answer instead.' using errcode = 'insufficient_privilege';
end $$;
create trigger alert_answers_no_update before update on alert_answers for each row execute function refuse_answer_change();
create trigger alert_answers_audit after insert on alert_answers for each row execute function audit_row();
alter table alert_answers enable row level security;
create policy alert_answers_read on alert_answers for select using (is_site_member(site_id));
-- Same people who raise improvement actions (plan 11.2), answering as themselves.
create policy alert_answers_insert on alert_answers for insert with check (
  site_role(site_id) in ('supervisor', 'reliability_engineer', 'superintendent') and answered_by = auth.uid()
);

create or replace function app_save_alert_answer(p_site uuid, p_answer jsonb) returns void
language sql security invoker set search_path = public as $$
  insert into alert_answers (id, tenant_id, site_id, alert_key, kind, unit_id, title, decision, note, action_id)
  select (p_answer->>'id')::uuid, s.tenant_id, p_site, p_answer->>'alertKey', p_answer->>'kind', (p_answer->>'unitId')::uuid,
    p_answer->>'title', p_answer->>'decision', coalesce(p_answer->>'note', ''), (p_answer->>'actionId')::uuid
  from sites s where s.id = p_site;
$$;

create or replace function app_load_alert_answers(p_site uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', a.id, 'alertKey', a.alert_key, 'kind', a.kind, 'unitId', a.unit_id,
    'title', a.title, 'decision', a.decision, 'note', a.note, 'actionId', a.action_id, 'answeredBy', a.answered_by, 'answeredAt', a.answered_at))
    order by a.answered_at), '[]')
  from alert_answers a where a.site_id = p_site;
$$;

grant execute on function can_write_setting, app_save_alert_answer, app_load_alert_answers to authenticated;
grant select, insert on alert_answers to authenticated;
