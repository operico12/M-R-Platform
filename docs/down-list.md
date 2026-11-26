# Down list: the supervisor's first-minute view

Ope, 26 Nov 2026, after a read-only look at the company site (Ore-Tech "Asset View"): one table of every down unit with who
has it, what it is waiting for, the latest comment and when it is expected back, sortable, filterable and exportable.
Code: `packages/core/src/down-list.ts` (tested in `test/down-list.test.ts`) and the Down list page under Today.

It is a view over records that already exist (open down flags, stages, locations, wait tags, ETAs, flag comments). It adds
no record and no rule. Every duration is calculated (rule 4).

## Rows

One row per unit with an open down flag. Units that are up have no row.

| Column | From |
|---|---|
| Unit, model | Asset |
| Type | Flag type (scheduled or unscheduled) |
| Stage, and time in it | Current stage interval (A7 section 4) |
| Location | Current location: down in field (with field location), towing, shop yard, or the shop line by name |
| Reason / system | Reason code, with the system |
| Waiting for | Open wait tags (docs/wait-tags.md), by kind |
| Down | From the start of the event: a type switch keeps the first start (`downSince`) |
| Expected back | The latest ETA set on the flag. A scheduled flag with no ETA and a planned duration shows start plus the planned hours, marked as a plan. Late when it is before now. |
| Last comment | The newest active comment on the flag or an earlier flag in the same event (docs/flag-comments.md), with who and how long ago; voided comments are never shown here |
| Comments | Count of active comments on those flags |
| Work orders | The flag's work orders |

## Controls

- **Search** over unit, model, reason, system, location, waiting-for, work orders and the last comment.
- **Filters**: type, stage, "late (past expected back)", "no ETA", "no comment in 24 h".
- **Sort** by any column; default is longest down first.
- **Download CSV**: the rows as shown, with site-time dates, for the filters and sort in force.
- A row opens the unit page; the comment count opens the flag's Comments tab there.

## Limits

- Read-only. Anyone who can view status can see it.
- "No comment in 24 h" is a prompt to ask, not a rule; nothing is flagged or recorded.
- Expected back is what people entered. It is not a forecast, and it is not used in any KPI (shop release vs plan, KPI-012, keeps
  its own definition).
