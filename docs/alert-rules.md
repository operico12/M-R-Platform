# Reliability and threshold alerts

Phase 2 alerts module (build plan v10, section 4 "Alerts and notifications", appendix "Rule-based
reliability alerts" and section 11.4 "alert rules in the console"). These are plain rules that people
can read: each alert says in words what was found, the numbers behind it and how many events it is
based on. There is no black box.

The flag checks from A7 section 8 (no ETA, ETA passed, waiting line, waiting parts, SMU rising while
down, no SMU reading, PM overrun, flag open long) are separate. They live in `alerts.ts`, take their
thresholds from the flag rules (`rules.alerts`), and are changed under the flag-rules permission.

Every number here is a setting (`AlertSettings` in `packages/core/src/alerting.ts`). The defaults
below are starting points for the site to agree, not plan decisions. Change this document before
changing a rule.

## Shared definitions

- **Failure**: a downtime event that counts as a failure for MTBF (A7 R9, D1, D5), from `buildEvents`.
- **System**: the event's system (KPI dictionary, same as the Pareto).
- **Now**: the app's clock. Day and week boundaries use the site time zone, never the browser's.
- **Down hours** of an open event run to now.

## Reliability alerts

| ID | Rule | Default | Fires when | Goes to |
| --- | --- | --- | --- | --- |
| RA-1 | Repeat offender | 3 failures, 30 days | One unit has at least N failures on the same system that started in the last D days | Reliability engineer, supervisor |
| RA-2 | MTBF drop | 28-day window, 90-day baseline, 25% drop, 5 failures | A model's MTBF in the last W days is at least X% below its MTBF in the B days before that, and the recent window has at least the minimum failures | Reliability engineer, superintendent |
| RA-3 | Repair time spike | 3 × median, 90-day baseline, 5 events, 7 days | A failure (open, or ended in the last 7 days) has down hours at least M times the median down hours of failures on the same system in the B days before it started, with at least the minimum baseline events | Reliability engineer, supervisor |
| RA-4 | Failure cluster | 3 units, 7 days | At least N different units had a failure on the same system and component in the last D days. Component comes from the release; failures with no specific component (still open, or "Other") are left out | Reliability engineer |
| RA-5 | Chronic unscheduled | 28 days, 2 × model median, 10% | A unit's unscheduled down hours in the last W days are at least F times the median unit of the same model, and at least P% of its calendar hours | Reliability engineer, superintendent |
| RA-6 | Silent unit | 24 h, 0.5 h | A mobile unit that is not flagged down has SMU readings covering the last H hours that rose less than R hours in total. Either it is on standby or it should be flagged down | Supervisor |

## Threshold alerts

| ID | Rule | Default | Fires when | Goes to |
| --- | --- | --- | --- | --- |
| TA-1 | PM overdue | PM tolerance from the work settings (KPI-018) | An open PM work order is past its due date plus the tolerance | Planner, supervisor |
| TA-2 | KPI below target | From midnight 7 days ago, site time | A fleet's PA, utilisation, MTBF, MTTR or mean downtime over that time is red against its target (amber band from the Targets page) | Superintendent, reliability engineer |
| TA-3 | Sync failure | | Later: needs the connectors (phase 1b). Not built | |

## Alert identity

Each alert has a key. Answering an alert applies to that key only, so a new occurrence comes back:

- RA-1 and RA-4: the newest failure in the group. A further failure makes a new alert.
- RA-2, RA-5 and TA-2: the site week (Monday) of now, so they come back at most once a week.
- RA-3: the event. RA-6: the site day. TA-1: the work order.

## Answering an alert

Supervisors, reliability engineers and superintendents answer alerts (same people who raise
improvement actions, plan 11.2 "create actions"). Each answer is stored with who, when and a note, is
never deleted, and goes to the audit log.

- **Noted**: hidden for the snooze days (default 7). It shows again from midnight site time on the day that many days after the answer, if it is still true.
- **Not a problem**: hidden for good for that key. Needs a note saying why.
- **Action raised**: hidden for good for that key, linked to the improvement action.

## Who changes the rules

Plan 11.2 "Edit alert rules and thresholds": reliability engineer, superintendent and admin (data
owner), with a reason. Each change goes to the audit log.

## Not in this phase

Email, Teams and push notifications need IT approval and connectors (phase 1b). Alerts show in the
app, on the Alerts page, with a count in the menu. The tier 3 KPI "condition monitoring response"
(alerts answered within target time) can be built on the stored answers later.
