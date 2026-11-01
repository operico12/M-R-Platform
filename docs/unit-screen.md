# Unit screen

Ope, 1 Nov 2026: "when a unit is clicked it should show a whole screen on that unit". The screen should allow:
- repair notes and comments
- assigning technicians
- raising flags
- the repair details: what system, what major component, what components
- marking the stop for an investigation
- the failure mode, if it was entered when the unit was marked down

For an up unit, the screen shows the history of notes and statuses.

Code: `packages/core/src/unit-notes.ts`, `unit-history.ts` and `flags.ts` (repair details, investigation),
tested in `test/unit-screen.test.ts`. Screen: `apps/web/src/screens/Units.tsx` (`UnitPage`).

## Opening it

Clicking a row on the status board opens the unit screen (`#/unit/<id>`) instead of the side sheet.
The flag sheet still opens from the screen's "Flag down" or "Update flag" button. On a TV board nothing opens.

## What the screen shows

1. **Header**: unit, model, fleet, status (Unscheduled, Scheduled or Operational), time down or up, and the
   buttons the person's role allows: Flag down or Update flag, Raise action, Start RCA.
2. **Now** (down units):
   - the stop: problem, stage, where it is, ETA, and the waits with their times
   - the repair details
   - the assigned technicians
   - whether the stop is marked for investigation

   An up unit shows its up time and any standby or parked time instead.
3. **Notes**: repair notes and comments, newest first, each with who wrote it and when. A note written while
   the unit is down belongs to that stop.
4. **History**: one list, newest first, of everything that happened to the unit. That covers each stop
   (down, stage changes, moves, ETAs, waits, technicians, details, investigation, release), standby and parked
   time, and the notes. Filters narrow it to stops and repairs, notes, or standby and parked time.
   For an up unit, the left side shows the last stop's repair details and investigation mark instead.
5. Below these, as before: KPIs for the last 28 days, the 7-day timeline, open work orders, components,
   condition and the list of stops.

## Notes

- Kinds: **repair note** (what was found or done) and **comment** (anything else).
- A note has its text, who wrote it, when it was entered, and the stop it belongs to (if the unit was down).
- Notes are added, never edited or deleted (rule 5). A wrong note is voided with a reason by the person who
  wrote it, or by a superintendent. A voided note stays in the history, struck through.
- Up to 2,000 characters. Empty notes are refused.
- Who: anyone who may add notes (technician, supervisor, reliability engineer, superintendent).

## Assigned technicians

- A down unit can have any number of people assigned. Each assignment is timed: from when they were assigned
  until they were taken off or the unit was released. Durations are calculated, never typed (rule 4).
- The list to pick from is the site's people whose access role or job title is technician, or who are
  supervisors. Retired people and people past their last day of access are left out.
- The same person cannot be assigned twice at once.
- When the unit is released and no down flag is left open, open assignments end at the release time.
  When the flag is voided, assignments made under it are voided too.
- Who: a supervisor in the area, a reliability engineer or a superintendent (`assign_technicians`).

## Repair details

- These fields can be filled in at any time while the stop is open:
  - system
  - major component (new)
  - component
  - failure mode
  - findings

  They are the same fields as the release checklist (A7 section 6), so the release form starts with them
  filled in and can still change them.
- The failure mode and system can be entered when the unit is first marked down. Both are optional there,
  and the release checklist still needs them.
- Who: anyone who may update the stage (`update_stage`).

## Mark for investigation

- A stop can be marked for investigation with a reason. It records who marked it and when. The mark can be
  cleared with a reason, never deleted. Both steps go to the audit log.
- Marked stops are listed on the RCA page under "Marked for investigation", each with a "Start RCA" link.
- Who: a supervisor, a reliability engineer or a superintendent (`mark_investigation`).
