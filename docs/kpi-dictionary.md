# KPI dictionary, tier 1 (A2 draft)

From build plan 3.3 and A7 section 9. Code: `packages/core/src/kpis.ts`. All hours come from timed
flag intervals and SMU readings; nothing is typed in. Fleet figures are ratios of sums.

| ID | KPI | Formula | Notes |
| --- | --- | --- | --- |
| KPI-001 | Physical availability (PA) | (calendar h − maintenance downtime h) ÷ calendar h | Scheduled and unscheduled flags count; standby does not. Parked or decommissioned time is out of calendar hours (R2). Voided and proposed flags never count. |
| KPI-002 | Utilisation | operating h (SMU) ÷ available h | SMU includes idle. Only time covered by SMU readings is used. |
| KPI-003 | Effective utilisation | operating h ÷ calendar h | = PA × utilisation; consistency check. |
| KPI-004 | Mechanical availability | operating h ÷ (operating h + downtime h) | Optional, not a headline. |
| KPI-005 | MTBF | operating h ÷ failures | Failure = downtime event that starts unscheduled and lasts ≥ D1 (15 min). PM-found defects are not failures by default (D5). Failures count in the period the event starts. |
| KPI-006 | MTTR | In repair h ÷ repairs | Field diagnosis counts (D11). "Repairs" is an open question (see a7-open-questions R8). |
| KPI-007 | Mean downtime (MDT) | unscheduled downtime h ÷ failures | Open question C7. MDT − MTTR = logistics. |
| KPI-008 | Downline queue | units now Waiting for crew, In transit or Waiting for a line | |
| KPI-009 | Shop line occupancy | occupied line-h ÷ (open line-h × capacity) | Closed time excluded. |
| KPI-010 | Time to first wrench | event start → first In repair | |
| KPI-011 | Wait for a line | time in Waiting for a line | |
| KPI-012 | Shop release vs plan | releases on or before the first ETA ÷ releases with an ETA | D10. |
| KPI-013 | Field repair share | unscheduled events released from Down in field ÷ unscheduled events released | |
| KPI-014 | Repair duration | flag start → release, by repair type | Show median and spread (next). |
| KPI-015 | Action effect (phase 2) | (after − before) ÷ before, on matching down h per 1,000 calendar h | Plan 7.7. Same filters as the action's slice, date range ignored. Equal windows either side of the done time: up to 28 days, cut to the time since done. Judged after 7 days. A change within ±10% reads "no clear change". Code: `actionEffect`, `effectVerdict` in `improve.ts`. |
| KPI-016 | Project benefit (phase 2) | (baseline rate − after rate) × after calendar h, rates in matching down h per 1,000 calendar h | Plan 8. Baseline: 90 days before the project went in progress. After: since it closed, up to 365 days; early reading under 28 days. Downtime during the project is left out. Per year = avoided ÷ after days × 365. Value = avoided h × the project's value per down hour. Code: `projectBenefit` in `projects.ts`. |
| KPI-017 | Project status (phase 2) | Late, at risk or on track, from the records | Late: past its end date, or an open task past due (site date). At risk: a task due within 7 days not started, actual + forecast over budget, an open issue or a risk scoring ≥ 6 (likelihood × impact, 1 to 3 each), or a change request waiting. Code: `projectHealth`. |

## Work and PM, tier 2 (phase 2, plan 3.3 tier 2 table)

From the ERP work orders; settings in `WorkSettings` (`packages/core/src/work.ts`), changed in Console, Work.
Code: `work.ts`. Hours are the work order's actual labour hours, else its estimate.

| ID | KPI | Formula | Notes |
| --- | --- | --- | --- |
| KPI-018 | PM compliance | PMs done by their due date + tolerance ÷ PMs due | Due = target finish (TARGCOMPDATE) in the period, site date. Tolerance: `pmToleranceDays` (default 3, site to agree; plan suggests ±10% of interval once intervals are loaded). A PM still inside its tolerance is left out until it is done or the tolerance ends. Cancelled PMs are left out. |
| KPI-019 | Schedule compliance | scheduled work done by its scheduled finish day ÷ scheduled work | Scheduled = scheduled start (SCHEDSTART) in the week. Measured weekly, Monday 00:00 site time. |
| KPI-020 | Planned work % | (work h − emergency work h) ÷ work h, for work finished in the period | Emergency = work type in `emergencyTypes` (default EM, BD) or priority in `emergencyPriorities` (default 1). Emergency work % shown beside it. |
| KPI-021 | Backlog (weeks) | open work h ÷ `craftHoursPerWeek` | Split ready to schedule from waiting (approval, parts, shutdown) using the status map. Shown only once craft hours per week is set. Work orders with no estimate are counted and listed. |
| KPI-022 | Work from inspections % | corrective work raised from a PM or inspection ÷ corrective work reported in the period | Raised from = origin work order (ORIGRECORDID) is a PM or inspection. |
| KPI-023 | Work order aging | open work orders by days since reported: 0–7, 8–30, 31–90, over 90 | By readiness. |

## Reliability analysis (phase 2, plan 7 downtime analysis)

Code: `packages/core/src/reliability.ts`. All use the downtime analysis filters, so they follow the same slice.

| ID | Measure | Formula | Notes |
| --- | --- | --- | --- |
| KPI-024 | Jack-knife chart | Per group (system, component, failure mode or unit): failure events against mean down h per event, log scales. Failures only (unscheduled events); planned work such as PMs is left out | Limits (Knights 2001): event limit = total events ÷ number of groups; duration limit = total down h ÷ total events. Above both = acute and chronic; events only = chronic; duration only = acute. Down hours = events × mean, so diagonals are equal downtime. |
| KPI-025 | Repeat failures | Failures on the same unit and system within N days of the last release on that unit and system ÷ failures | Plan tier 3. N default 30 (plan text), set on the page. SMU-based windows come later. |
| KPI-026 | Failure coding quality | Released failure flags with complete, specific, consistent coding ÷ released failure flags | Checks: component not "Other"; failure mode not "Unknown"; component belongs to the system (A9 reference list); cause code given. Shown by crew and shift, never by named person (plan 11.2). |
| KPI-027 | Bad actors | Units ranked by matching down h in the period | With failures, repeat failures and the top system for each. |

## Analytics explorer (phase 2, plan 7.5 and 7.6)

| ID | Measure | Formula | Notes |
| --- | --- | --- | --- |
| KPI-028 | Explorer compare (phase 2) | Slice A vs slice B on each measure; difference and % change | Outside normal variation when two-sided p < 0.05 and both sides have ≥ 5 events. Failure rate: conditional binomial test (normal approximation). Per-event durations: Mann-Whitney U (normal approximation, tie correction). Counts and sums are not tested. Code: `compareSlices` in `explorer.ts`; docs/analytics-explorer.md. |
| KPI-029 | Control chart (phase 2) | XmR on a weekly value (down h, events or failures): centre = mean, limits = mean ± 2.66 × mean moving range, lower limit ≥ 0 | At least 6 weeks. A week outside the limits is flagged. Code: `controlChart` in `explorer.ts`. |

## Component life (phase 3, plan 3.3 tier 2 and 4.2)

| ID | KPI | Formula | Notes |
| --- | --- | --- | --- |
| KPI-030 | Component life ratio (phase 3) | Hours at the end of a component life ÷ target life for that model and kind, over lives that ended in the period | Lag. Shown separately for failures and planned removals (suspensions). Also: % of lives reaching target (ratio ≥ 1) and early failures (failed lives with ratio < 0.25). A life runs from Received or Back from rebuild to Sent to rebuild or Scrapped. Code: `lifeRatio` in `components.ts`; docs/component-life.md. |
| KPI-031 | Cost per hour of component life (phase 3) | (Purchase or rebuild cost that started each life − warranty recovered) ÷ hours of that life, summed over ended lives | Cost roles only (plan 11.2). Same formula as calculator C-09. Code: `costPerLifeHour` in `components.ts`. |
| KPI-032 | Condition monitoring response (phase 3, plan 3.3) | Oil alerts responded to within the target time ÷ oil alerts whose target time ended in the period | Lead. An alert is a sample at Action or Critical, not voided. Target time: Critical 24 h, Action 72 h from the lab report (settings). Alerts still inside their time are left out until it ends; late or missing answers count against. Code: `cmResponse` in `condition.ts`; docs/condition-monitoring.md. |

## Worked examples encoded as tests

- KPI-032: four alerts ending in the week, two answered in time, one 10 h late, one not answered → 50%.
- Plan 3.2, one 12-hour shift: PA 62.5%, utilisation 90.7%, standby 0.7 h, effective utilisation 56.7%.
- Plan Appendix A: one truck, one week, 28 h down → PA 83.3%, unchanged by 10 h standby.
- KPI-015, one truck: 20 h hydraulic down in the 28 days before, 5 h after → −75%, failures 2 → 1; a 6 h
  tyre stop is outside the slice but still lowers PA before (646 ÷ 672).
- KPI-016, one truck: 54 h hydraulic down in the 90 days before work (25 per 1,000 h), 9 h in the 30 days after
  closing (12.5 per 1,000 h) → 9 h avoided, 109.5 h a year; 100 h down during the project is left out.
- A7 section 10, HT107: 10 h 08 down (9 h 58 day, 10 min night), repair 4 h 55, waiting 5 h 13 by stage,
  locations 1 h 28 / 45 / 50 / 7 h 05, first wrench 38 min, missed first ETA.
