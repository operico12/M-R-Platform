# Shift grid: what state each unit was in, hour by hour

Ope, 26 Nov 2026, after a read-only look at the company site (Ore-Tech "Shift Summary"): one row per down unit, one
cell per hour, coloured by what the unit was doing. The question it answers is "what state was every unit in, hour by
hour, today (or on this shift)". Code: `packages/core/src/shift-grid.ts` (tested in `test/shift-grid.test.ts`) and the
Shift grid page under Today.

Unlike the company site, nothing here is a separate record. Every cell is calculated from the flag's timed stage
intervals (rule 4), so the grid can never disagree with the status board, the Down flags table or the KPIs.

## Windows

- **Day**: a site calendar day, midnight to midnight in the site time zone (rule 7). A daylight-saving day has 23 or
  25 cells, not 24.
- **Shift**: one shift of the site's shift calendar (for example day 06:00 to 18:00), 12 cells on the default calendar.
- The date is a site date. The window can be any past day or shift; the current one shows cells up to now and leaves
  the rest blank.

## Rows

- A unit has a row when it had a counting down flag (scheduled or unscheduled; not proposed or voided) for any time
  inside the window. Units that were up all window are left out.
- Rows are sorted by down hours in the window, largest first, then unit number.
- Each row shows down hours and in-repair hours for the window, from the same intervals.

## Cells

Each cell is one hour (the cut-off cell at the end of a window may be shorter). The cell counts the minutes in each
of three states, from the flag's stage at that time:

- **In repair**: the stage is In repair. This is wrench time (A7 section 4).
- **Waiting**: any other stage (waiting for crew, in transit, waiting for a line, waiting parts, waiting labour,
  waiting other, ready for release).
- **Up**: no counting down flag.

The cell takes the state with the most minutes; on a tie, In repair beats Waiting beats Up. It also carries the flag
type (scheduled or unscheduled) of the flag that held most of the hour, so the colour shows both: unscheduled in
repair (red), unscheduled waiting (light red), scheduled in repair (amber), scheduled waiting (light amber), up (green).
A cell that was more than one state shows a mark, and its tooltip lists the exact minutes of each state and each stage.

## Rules and limits

- Read-only. It writes nothing and has no permission of its own beyond viewing status (`view_status`).
- Cells after "now" are blank, never "up".
- Down time before the window start is not shown, but the flag's stage at the start of the window is.
- If two counting flags overlap in time on one unit (a data problem), the earlier flag's minutes win and the overlap
  is not counted twice.
