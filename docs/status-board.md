# Status board

Plan 4.2, Figure 1. The board answers "what is down, why, for how long, and when is it back?"
Code: `packages/core/src/board.ts` (pure, tested in `test/board.test.ts`) and `apps/web/src/screens/Board.tsx`.

## Layout: exceptions first

1. The fleet bar shows the share of units in each status.
2. The status counts are Up, Scheduled down, Down, No update and Parked, plus the Downline queue and Alerts.
3. The filters are model chips and a search box. They are hidden in TV mode.
4. **Needs attention** lists the down and scheduled down units, longest down first. Each row shows:
   - the reason and where the unit is;
   - the stage;
   - how long it has been down;
   - the ETA. An ETA that has passed is shown in red, and NO ETA is shown once the ETA rule applies.
5. **No update** lists units with no open flag and no hour meter reading for over 14 h. Each shows the age of its last reading.
6. **Running** lists each unit with how long it has been up.
7. **Parked** lists units whose lifecycle status is not active.
8. The downline queue table follows.

## Times (rule 4: always calculated, never typed)

- **Down for** is now minus `downSince(flag)`. A type switch or a linked reopen continues the same stop, so the
  time counts from the first flag in the `linkedFromFlagId` chain. Voided flags are skipped.
- **Up** is now minus `upSince(unit)`, the latest end of a released flag at or before now. A unit with no
  released flag shows "no stops on record".
- These are elapsed calendar hours, not KPI hours. They do not change any KPI in `kpi-dictionary.md`.

## Filters

- Pressing a status count shows only those units. Pressing it again undoes it, and several counts can be on together.
- Model chips work the same way. "All models" clears them.
- The search matches the unit number, the model, the reason, the location and the stage.
- The counts are worked out after the model and search filters but before the status filter. So a count always
  equals what pressing it would show.
- The filter is kept in the address (`#/board?status=down,sched&model=793F&q=brake`), so a filtered board can be
  shared or reloaded. The address is replaced, not pushed, so typing does not fill the back button.
