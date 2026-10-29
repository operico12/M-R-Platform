-- Repairable system and system model calculators C-20 to C-24 (phase 3;
-- docs/calculators.md). Saved results only: no new tables.

alter table saved_analyses drop constraint saved_analyses_calculator_check;
alter table saved_analyses add constraint saved_analyses_calculator_check check (calculator in ('inherent_availability', 'availability_target', 'downtime_cost',
  'mtbf_confidence', 'weibull', 'conditional_weibull', 'repair_times', 'risk_matrix', 'cost_per_hour', 'mtbf_rate', 'rebuild_or_replace',
  'pf_interval', 'optimal_replacement', 'failure_finding', 'strategy_cost',
  'poisson_spares', 'rebuild_pool', 'kit_stocking', 'lifetime_buy',
  'crow_amsaa', 'trend_test', 'mcf', 'block_diagram', 'availability_sim'));
