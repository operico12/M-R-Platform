# Status board

Plan 4.2, Figure 1. The board answers "what is down, why, for how long, and when is it back?"
Code: `packages/core/src/board.ts` (pure, tested in `test/board.test.ts`) and `apps/web/src/screens/Board.tsx`.

## Layout: three statuses (Ope, 29 Oct 2026)

Every unit is in one of three broad statuses. What it is doing inside that status is a sub-status, taken
from what is already recorded, never typed twice:

| Status | When | Sub-statuses |
| --- | --- | --- |
| **Operational** | No down flag is open. Being operational does not mean in use. | In use, on standby with its reason (docs/standby.md), or parked |
| **Scheduled down** | An open scheduled down flag | The flag's current stage (waiting for crew, in repair, waiting parts...) |
| **Unscheduled down** | An open unscheduled down flag | The flag's current stage |

Waiting parts or waiting crew on a down unit is the stage of its down flag, not a second flag, so the hours are
counted once. **Parked** (lifecycle status not active) is a tag, not a fourth status (Ope, 29 Oct 2026): a parked
unit with no open down flag is Operational with the sub-status Parked; a parked unit with an open down flag sits
under that flag's status and its row is tagged Parked. Parked time still leaves available time as before
(KPI-001); only the board changed.

1. The fleet bar shows the share of units in use, on standby, scheduled down, unscheduled down and parked.
2. Four tiles sit on top (Ope, 29 Oct 2026): **Operational**, **Unscheduled down**, **Scheduled down** and
   **Alerts**. Each status tile shows its count, its share of the fleet and its largest sub-statuses
   (for example "35 in use · 2 standby · 1 parked"). Pressing the Alerts tile goes to the alerts list, which sits
   at the bottom of the board in place of the old downline queue (Ope, 29 Oct 2026). The queue's content, units
   waiting for a crew, a tow or a line, now shows on each down unit's row as its stage and wait tags.
   - The alerts list shows each alert in plain words, most urgent kind first, then the longest on: the unit, what
     it is ("ETA passed"), what it means, the next step and who it goes to, and how long it has been on. Tapping
     one opens the unit. The words are `ALERT_PLAIN` in `packages/core/src/alerts.ts`; the order is `sortAlerts`.
   - A missing hour meter reading is shown on the unit's row, not counted as an alert.
3. The filters are model chips and a search box. They are hidden in TV mode.
4. **The units are one table** (Ope, 31 Oct 2026, replacing the columns of cards). Above it, one chip per
   sub-status with its count, coloured by its status; pressing one filters the table.
5. **Every unit is a row.** Columns: Unit (number and model), Status (a coloured pill: Operational, Standby,
   Unscheduled down or Scheduled down), Where (the down location, or "In the field"), Problem (the reason),
   Stage (the current stage and its time), Time ("down" or "up" and how long), and Flags: everything open on
   the unit as chips, each with how long it has been on:
   - down units: each open wait tag (docs/wait-tags.md) and the ETA. An ETA that has passed is red, and
     No ETA is shown once the ETA rule applies;
   - operational units: a standby flag with its reason, a proposed down flag waiting for a supervisor;
   - any unit: Parked with how long it has been parked (a parked operational unit is an ordinary
     Operational row, Ope, 30 Oct 2026), its active alerts, and "no hour meter reading" after 14 h. A missing
     reading does not change the status; it leaves those hours out of utilisation.
   On a phone each row folds into a short block with only the filled-in fields. Tapping a row opens the unit.
6. Row order: unscheduled down (longest first), scheduled down (longest first), then operational with
   something open first (standby longest first, then other open items, then parked), then the rest by unit number.
7. The alerts list follows the table.
8. Every flag, stage, wait tag, standby reason, location, status and alert has a small icon
   (`apps/web/src/components/FlagIcon.tsx`). The label is always shown beside it; the icon never stands alone.

## Times (rule 4: always calculated, never typed)

- **Down for** is now minus `downSince(flag)`. A type switch or a linked reopen continues the same stop, so the
  time counts from the first flag in the `linkedFromFlagId` chain. Voided flags are skipped.
- **Up** is now minus `upSince(unit)`, the latest end of a released flag or a standby flag at or before now. A unit with no
  released flag shows "no stops on record".
- **In stage** is now minus the start of the flag's current stage interval (`stageSince`). **On standby** is now
  minus the standby flag's start.
- These are elapsed calendar hours, not KPI hours. They do not change any KPI in `kpi-dictionary.md`.

## Filters

- Pressing a status tile shows only those units. Pressing it again undoes it, and several tiles can be on together.
- Pressing a sub-status in a column header (for example "Waiting parts 3") shows only those units, the same way.
- Model chips work the same way. "All models" clears them.
- The search matches the unit number, the model, the reason, the location and the stage.
- The counts are worked out after the model and search filters but before the status and sub-status filters. So
  a count always equals what pressing it would show.
- The filter is kept in the address (`#/board?status=unsched,sched&sub=unsched:waiting_parts&model=793F&q=brake`), so a filtered board can be
  shared or reloaded. The address is replaced, not pushed, so typing does not fill the back button.
- Old links with `status=run`, `standby`, `parked` or `down` still work: they open Operational or Unscheduled down.
