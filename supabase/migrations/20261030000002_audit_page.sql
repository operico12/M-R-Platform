-- Phase 2: audit log page (plan 11.4). The full log is for the
-- superintendent and the admin (data owner and system admin), read-only.
-- Everyone else at the site keeps reading the history of the work records
-- they can already see (flags, actions, RCAs, projects, alert answers), so
-- those pages can show who changed what.

drop policy audit_log_read on audit_log;
create policy audit_log_read_full on audit_log for select using (site_role(site_id) in ('superintendent', 'admin'));
create policy audit_log_read_work on audit_log for select using (
  is_site_member(site_id) and entity in (
    'down_flag', 'down_flags', 'flag_stage_intervals', 'flag_location_intervals', 'flag_etas', 'flag_reopen_gaps', 'flag_work_orders',
    'action', 'improvement_actions', 'rca', 'rcas', 'project', 'projects', 'alert', 'alert_answers'
  )
);

-- Newest first, between two instants. Row-level security decides which rows come back.
create or replace function app_load_audit(p_site uuid, p_from timestamptz, p_to timestamptz, p_limit int default 5000) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(r order by (r->>'at') desc), '[]') from (
    select jsonb_strip_nulls(jsonb_build_object('id', a.id::text, 'at', a.at, 'userId', a.user_id, 'action', a.action, 'entity', a.entity,
      'entityId', a.entity_id, 'before', a.before, 'after', a.after, 'reason', a.reason, 'effectiveAt', a.effective_at, 'offline', a.offline)) r
    from audit_log a
    where a.site_id = p_site and a.at >= p_from and a.at < p_to
    order by a.at desc
    limit least(greatest(p_limit, 1), 20000)
  ) q;
$$;
grant execute on function app_load_audit to authenticated;
