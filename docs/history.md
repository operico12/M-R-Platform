# History: every downtime event, searchable

Ope, 26 Nov 2026: "M&R does not have history." Each unit page already lists that unit's down flags, but there was no
place to look across the fleet at past events, find one, and open what happened. Bay Watch Ops has a History page and so does
the company site (Ore-Tech "Asset Historical Records"). Code: `packages/core/src/event-history.ts` (tested in
`test/event-history.test.ts`) and the History page under Analyse.

It is a view over the flags (rule 4): it adds no record and no rule. Every duration is calculated, in the same way as
the Down flags table and the KPIs.

## Rows

One row per **downtime event** (R7): linked flags with no gap between them (a type switch) are one event, as in
`buildEvents`. Open events are included and run to now. Voided and proposed flags are never shown.

| Column | From |
|---|---|
| Unit, model, fleet | Asset |
| Start, end | The event's first flag start and its last flag end (open: "open") |
| Down | Down hours of the event's flags, with reopen gaps that count as available left out (the KPI rule) |
| Type | The flags' types in order, for example "scheduled → unscheduled" |
| Reason, system, component, failure mode | The first flag's reason code; the system, component and failure modes from the release (the last flag that has them) |
| Where | Where the unit ended up: the shop line by name, or down in field |
| In repair, waiting, to 1st wrench | Stage intervals: In repair, the rest, and event start to the first In repair (KPI-010) |
| Work orders | All the event's flags' work orders |
| State | open or released |
| Failure | Whether it counts as a failure (R9, D1) or is a minor stop |

## Controls

- **Dates** are site dates (rule 7), inclusive: an event is in range when it **starts** on or after From and on or before To,
  in the site time zone. Leave both blank for everything.
- **Search** over unit, model, reason, system, component, failure mode, where and work orders.
- **Filters**: type (scheduled or unscheduled start), state, system, model, failures only, minimum and maximum down hours.
- **Sort** by unit, model, start, end, down hours or system. Default: newest first.
- **Paging**: 25, 50 or 100 rows a page.
- **Download CSV**: all rows matching the filters, not just the page, with site-time dates.
- **Open a row** to see each flag in the event with its tabs: Comments, Time (stage, location, shop line and wait
  breakdown, moves in order) and Changes (docs/flag-history.md).

## Limits

- Read-only; anyone who can view status can see it.
- The page loads the flags the app holds (live: the last 400 days, as for the rest of the app). Older events need the audit log or an export.
