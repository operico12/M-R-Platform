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
under that flag's status and its card is tagged Parked. Parked time still leaves available time as before
(KPI-001); only the board changed.

1. The fleet bar shows the share of units in use, on standby, scheduled down, unscheduled down and parked.
2. Four tiles sit on top (Ope, 29 Oct 2026): **Operational**, **Unscheduled down**, **Scheduled down** and
   **Alerts**. Each status tile shows its count, its share of the fleet and its largest sub-statuses
   (for example "35 in use · 2 standby · 1 parked"). Pressing the Alerts tile goes to the alerts list, which sits
   at the bottom of the board in place of the old downline queue (Ope, 29 Oct 2026). The queue's content, units
   waiting for a crew, a tow or a line, now shows on each down unit's card as its stage and wait tags.
   - The alerts list shows each alert in plain words, most urgent kind first, then the longest on: the unit, what
     it is ("ETA passed"), what it means, the next step and who it goes to, and how long it has been on. Tapping
     one opens the unit. The words are `ALERT_PLAIN` in `packages/core/src/alerts.ts`; the order is `sortAlerts`.
   - A missing hour meter reading is shown on the unit's card, not counted as an alert.
3. The filters are model chips and a search box. They are hidden in TV mode.
4. Each status has a column of unit cards. On a wide screen the columns are side by side in the tile order;
   on a narrow screen they stack with Unscheduled first, then Scheduled, then Operational (exceptions first).
   Each column's header lists its sub-statuses with counts.
5. **Every unit has a card.** A card shows the unit, the model, the time in its status, and everything open on
   the unit, each with how long it has been on:
   - down units: the reason and where the unit is, the current stage with its time, each open wait tag with its
     time (docs/wait-tags.md), and the ETA. An ETA that has
     passed is red, and NO ETA is shown once the ETA rule applies;
   - operational units: a standby flag with its reason, a proposed down flag waiting for a supervisor, a
     Parked line with how long it has been parked, or "In use" when nothing is open. A parked operational unit
     looks like any other operational card (green edge, "up" time); Parked is one of its lines (Ope, 30 Oct 2026);
   - any unit: its active alerts, and "no hour meter reading" after 14 h. A missing reading does not change the
     status; it leaves those hours out of utilisation.
6. Down columns are sorted longest down first. The Operational column shows units with something open first
   (standby longest first), then parked units, then the rest by unit number, as smaller cards.
7. The alerts list follows the columns.
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
