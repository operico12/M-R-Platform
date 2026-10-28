# RCM to PM job plans

Phase 3. This covers plan 7.4 ("RCM workflow that ends in PM job plans"), the maintenance strategy
calculators in 7.2, and the "FMEA / RCM" and "PM optimisation" rows of 7.1. The code is in
`packages/core/src/rcm.ts`. The interval calculators are C-12 to C-15 in `docs/calculators.md`.

The ERP stays the system of record for job plans (plan 1). The platform builds them, keeps every
issued version, and exports a file to load into Maximo. It never writes to Maximo.

Anything the plan does not fix is a site setting (`RcmSettings`), changed by people who can edit RCM,
with a reason and an audit entry.

## The workflow

1. **Failure mode library per model** (for example 793F, 797F). Each row is one failure mode.
2. **Consequence and task selection** for each mode, with questions in line with SAE JA1011 and
   JA1012. The page recommends a task type; a person can choose another one with a reason.
3. **Interval** from the P-F interval, optimal replacement or failure-finding calculators, or typed
   in with a note of where it came from.
4. **Packaging** by SMU interval into PM job plans (250, 500, 1000 and 2000 hours by default).
5. **Issue and export**: a person issues a version of each job plan, and exports it as a workbook to
   load into Maximo, with tasks, labour and parts.
6. **Review**: failures in the last year matched to each mode show which tasks are not working,
   and which failures are not in the library yet.

## Failure modes

| Field | Notes |
| --- | --- |
| Model | The library is per model (plan 7.4 "per asset class") |
| System, component | The same words as on down flags, so failures can be matched in the review |
| Function | What the item must do, for example "Cool the engine to below 95 °C at full load" |
| Functional failure | How it fails to do it, for example "Cannot hold below 95 °C" |
| Failure mode | What causes it, matching the failure mode list on flags, for example "Leak" |
| Effect | What happens when it fails: what the operator sees, downtime, damage, any safety risk |
| Consequence | Hidden, safety or environment, operational, non-operational (below) |
| Answers | The task selection answers (below) |
| Task type | Recommended and chosen. If they differ, a reason is needed |
| Task | What to do, in words a technician would use. Up to 100 characters go to Maximo as the task description; the rest goes to its long description |
| Interval | SMU hours. How it was set, for example "C-12: P-F 1000 h ÷ 2" |
| Labour | Craft, number of people and hours each |
| Parts | Item number, description, quantity |

**Nothing is edited in place.** Saving a change adds a new revision of the mode and keeps the old
one. A mode that no longer applies is retired with a reason. Job plans already issued keep the
revision they were built from.

## Consequence

The first question is whether the failure is **evident**: will the operators know it has happened
during normal work? If not, it is **hidden** (for example a failed fire suppression system or a stuck
pressure relief valve). Evident failures are then sorted by their worst effect:

- **Safety or environment**: it could hurt someone or breach an environmental rule.
- **Operational**: it stops or slows production (downtime, lost loads).
- **Non-operational**: only the repair cost.

## Task selection

Answer these for the mode. The page asks only the ones that apply.

| Question | Asked for |
| --- | --- |
| A. Is there a warning sign, such as a reading, a noise, wear or a leak, that can be found with enough time to act before the failure? | All |
| B. Does the failure become more likely after a certain age, with most items reaching that age? | All |
| C. Can rework restore the item's resistance to failure (rather than replacing it)? | When B is yes |
| D. Can a check find out whether the hidden failure has happened? | Hidden |
| E. Could the hidden failure, together with a second failure, hurt someone or breach an environmental rule? | Hidden |

The recommendation, taking the first that fits (JA1012 order of preference):

1. A yes: **condition-based task** (inspect or monitor for the warning sign).
2. B and C yes: **scheduled restoration**.
3. B yes, C no: **scheduled replacement**.
4. Hidden and D yes: **failure-finding task**.
5. Hidden, D no and E yes: **redesign** (a one-time change is required).
6. Safety or environment: **redesign**, because no task was found that is worth doing.
7. Otherwise: **run to failure**.

The questions decide whether a task is possible. Whether it is worth doing is a judgement: for
operational and non-operational modes, the strategy cost comparison (C-15) shows which costs less.
For safety and environment, a task must bring the risk down to a level the site accepts, or the mode
needs a redesign.

Condition-based, restoration, replacement and failure-finding tasks need an interval above 0. Run to
failure needs no task. Redesign needs no interval; it is listed on the Redesign tab with a link to
raise an improvement action.

## Intervals

| Task type | Calculator |
| --- | --- |
| Condition-based | C-12 P-F interval: half the P-F interval by default, and leave enough of it to plan the repair |
| Scheduled restoration or replacement | C-13 optimal replacement interval, from a Weibull fit (C-05) and the costs of a planned and an unplanned change |
| Failure-finding | C-14 failure-finding interval: 2 × tolerated unavailability × MTBF of the protective device |
| Any | C-15 strategy cost comparison, to check the task is worth doing |

The mode page opens the right calculator with the inputs it can fill. The interval is then typed into
the mode with a note of where it came from.

## Packaging into job plans

PM levels (setting `packages`): 250, 500, 1000 and 2000 SMU hours.

- Each task goes into the **largest PM level that is no longer than its interval**, so it is never
  done less often than intended. A 750 h task goes into the 500 h PM.
- A task longer than the largest level goes into a level at the largest multiple of it that is no
  longer than the interval. A 5000 h task makes a 4000 h job plan.
- A task shorter than the smallest level is not packaged. It is listed as "shorter than the smallest
  PM": do it as an operator check or a daily inspection (Inspections module).
- **Nested PMs** (setting `nested`, on by default): a PM also holds the tasks of every smaller level
  it is a multiple of. The 1000 h PM holds the 250, 500 and 1000 h tasks. Turn this off where
  Maximo uses PM sequences to call each level separately.
- Tasks are in order of system, then component, then failure mode. They are numbered 10, 20, 30 and
  so on.

Job plan number (Maximo JPNUM): the prefix (setting `prefix`, blank by default), then the model, a
dash, and the hours, for example `793F-500`. Maximo allows 10 characters by default, so the page warns
when a number is longer. Description: "793F PM 500 h (RCM)".

### Issuing

A job plan shows as **not issued**, **issued (revision n)**, or **changed since revision n**.
Issuing keeps a copy of the tasks, labour and parts as revision n + 1, with a note, who issued it and
when. A revision is never changed or deleted. Issuing a job plan that has not changed is refused.

### Maximo export

One Excel workbook with a sheet per Maximo object, and the column names as Maximo's attribute names,
ready for MXLoader or Maximo's data import:

| Sheet | Columns |
| --- | --- |
| JOBPLAN | ORGID, SITEID, JPNUM, DESCRIPTION, JPDURATION, STATUS |
| JOBTASK | ORGID, SITEID, JPNUM, JPTASK, DESCRIPTION, DESCRIPTION_LONGDESCRIPTION, TASKDURATION |
| JPLABOR | ORGID, SITEID, JPNUM, JPTASK, CRAFT, QUANTITY, LABORHRS |
| JPMATERIAL | ORGID, SITEID, JPNUM, JPTASK, ITEMNUM, DESCRIPTION, ITEMQTY |
| About | The platform revision of each job plan, who issued it, and when |

- ORGID and SITEID come from settings `maximoOrgId` and `maximoSiteId`. They are blank until set.
- STATUS is DRAFT, so a planner checks and activates each job plan in Maximo.
- JPDURATION is the sum of the task durations. Tasks done at the same time make the real duration
  shorter, so planners adjust it in Maximo.
- LABORHRS is the hours each person works on the task; QUANTITY is the number of people.
- Only issued revisions are exported.
- A job plan that was issued but no longer has any task (its tasks moved to another level or were
  retired) is listed as **no longer needed** and left out of the export, so a planner can set it
  inactive in Maximo.

## Review (plan 7.4 "review effectiveness")

For each mode in the library, the failures in the last 365 days (setting `reviewDays`) on units of
that model whose release details match the mode's system, component and failure mode (any of the
flag's failure modes, ignoring case). Failures are counted as A7 R9 counts them.

- **Found in operation**: detection method operator, alarm, other or not recorded.
- **Found by maintenance**: detection method PM, inspection or condition monitoring.

Each mode gets a verdict:

| Verdict | When |
| --- | --- |
| Review the task | It has a condition-based, restoration, replacement or failure-finding task, and 2 or more (setting `reviewFailures`) failures were found in operation |
| Check run to failure | It is run to failure and has 2 or more failures. A task may now be worth doing |
| No failures | No failures |
| Working | Anything else |

Below that, **failures not in the library**: failures on the model's units whose system, component
and failure mode match no mode, grouped and counted, most first. These are the candidates to add.
Failures with an unknown or missing failure mode are counted on one line, because they cannot be
matched (KPI-027 coding quality).

## Who can do what

| Action | Roles |
| --- | --- |
| See the library, job plans and review | Everyone at the site |
| Add, change and retire failure modes, change RCM settings | Reliability engineer, superintendent (`edit_rcm`) |
| Issue a job plan revision | Reliability engineer, superintendent (`issue_job_plans`) |
| Export to Maximo | Supervisor, reliability engineer, superintendent, admin (`export_reports`) |

Plan 11.2 has no row for RCM. These follow "Lead root cause analyses", the nearest analysis row.
