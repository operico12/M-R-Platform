-- Spares and rebuild pool sizing (phase 3; docs/spares.md). No new tables: the
-- page works from the component history and the RCM library. This adds the
-- 'spares' site setting and the spares calculators C-16 to C-19 to saved analyses.

-- ---------- settings ----------

alter table site_settings drop constraint site_settings_key_check;
alter table site_settings add constraint site_settings_key_check check (key in ('work', 'alerts', 'condition', 'rcm', 'spares'));

-- edit_spares (packages/core/src/permissions.ts): reliability engineer and superintendent.
create or replace function can_write_setting(p_site uuid, p_key text) returns boolean
language sql stable security invoker set search_path = public as $$
  select case p_key
    when 'work' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'alerts' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'condition' then site_role(p_site) in ('reliability_engineer', 'superintendent', 'admin')
    when 'rcm' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    when 'spares' then site_role(p_site) in ('reliability_engineer', 'superintendent')
    else false end;
$$;

-- ---------- saved calculator results ----------

alter table saved_analyses drop constraint saved_analyses_calculator_check;
alter table saved_analyses add constraint saved_analyses_calculator_check check (calculator in ('inherent_availability', 'availability_target', 'downtime_cost',
  'mtbf_confidence', 'weibull', 'conditional_weibull', 'repair_times', 'risk_matrix', 'cost_per_hour', 'mtbf_rate', 'rebuild_or_replace',
  'pf_interval', 'optimal_replacement', 'failure_finding', 'strategy_cost',
  'poisson_spares', 'rebuild_pool', 'kit_stocking', 'lifetime_buy'));
