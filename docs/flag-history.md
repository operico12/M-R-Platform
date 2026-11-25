# Flag history: what changed, and where the time went

Ope, 8 Dec 2026: for each event, see how its status and location changed over time and who changed them, how long it
sat in each stage, location and shop line, how long it waited for each thing, and what was edited. Code:
`packages/core/src/flag-history.ts` (tested in `test/flag-history.test.ts`). Nothing here is stored separately: it is
all calculated from the flag's timed stage and location intervals, its wait tags and the audit log (rules 4 and 5).

## Time breakdown (per down flag)

Every number is a sum of the flag's timed intervals, up to its end or now, never a typed value.

- **Down**: start to end (or now).
- **By stage**: hours in each stage (A7 section 4). *In repair* is time someone was working on it; every other stage is
  waiting. **Not in repair** = down minus In repair, the same split as the "In repair" and "Waiting" columns.
- **By location kind**: down in field, towing, shop yard, shop line, in place.
- **By shop line**: hours on each line, so "how long was it in Line 6" and "how long was it in Line 9 after it was moved"
  are read straight off. A line the unit came back to later adds to the same line.
- **Time to first wrench**: from the start of the *event* to the first In repair, the same as KPI-010. It is not
  shown for a flag that is linked from an earlier one (a type switch), where the event started earlier.
- **Waits**: hours for each wait tag kind that was on during the flag (KPI-046). Tags overlap, so the kinds can add up to
  more than the down time; **Waiting on something** counts the hours with at least one tag open, once.
- **Moves**: the sequence of locations with when each began and how long it lasted, and who moved the unit.
  Stage changes the same way, with who made each.

## Change log (per down flag)

- Built from the audit entries the app writes for the flag (`down_flag`: flag, stage, move, ETA, switch type,
  release, void, reopen), newest last. Each shows when, who, the action, the reason they gave, and the fields that
  changed with before and after.
- Fields compared: type, reason code, system, and from the release: system, component, failure modes, repair summary,
  work order, PM or work order, findings, cause code, detection method, SMU at failure; plus work orders, planned
  hours, notes, state, void reason and the ETA. Stage and location changes are shown as the moves above, not as
  fields.
- The back-dated time ("effective at") is shown when a change was entered for an earlier time.
- A new flag lists what it was raised with. A change that alters none of these fields is left out.
- The database's own row changes (written by triggers) are not repeated: the app entries carry the same facts plus the
  action and reason.
- In the demo the log holds this session's changes. Live, it is read from the audit log for the flag's dates
  (every site member can read flag history, `audit_log_read_work`).

## Where it shows

Unit page, **Down flags** table: open a row. The row now has three tabs: **Comments** (docs/flag-comments.md),
**Time** and **Changes**.
