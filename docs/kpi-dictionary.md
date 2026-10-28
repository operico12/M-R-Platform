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

## Worked examples encoded as tests

- Plan 3.2, one 12-hour shift: PA 62.5%, utilisation 90.7%, standby 0.7 h, effective utilisation 56.7%.
- Plan Appendix A: one truck, one week, 28 h down → PA 83.3%, unchanged by 10 h standby.
- KPI-015, one truck: 20 h hydraulic down in the 28 days before, 5 h after → −75%, failures 2 → 1; a 6 h
  tyre stop is outside the slice but still lowers PA before (646 ÷ 672).
- A7 section 10, HT107: 10 h 08 down (9 h 58 day, 10 min night), repair 4 h 55, waiting 5 h 13 by stage,
  locations 1 h 28 / 45 / 50 / 7 h 05, first wrench 38 min, missed first ETA.
