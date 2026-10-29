# Wait tags

Ope, 29 Oct 2026: a down unit can wait for several things at once, such as labour and parts together, or a
tow. Each wait is tracked on its own with the time it has been on. Ope chose "stage plus timed wait tags":
the down flag keeps one stage at a time (A7 section 4), and any number of timed wait tags run on top of it.
Code: `packages/core/src/waits.ts` (tested in `test/waits.test.ts` and the golden tests).

## What a wait tag is

- It belongs to an open down flag (scheduled or unscheduled). It has a kind, a start and an end, and an
  optional note. An open tag has no end yet.
- It records who set it and when it was entered. It is never typed as a duration (rule 4).
- Tags can overlap: a unit can wait for labour and parts at the same time.
- The kinds are in `DEFAULT_WAIT_KINDS`: tow or recovery, lowboy or transport, parts or materials, labour,
  field crew, shop line or bay, tools or equipment, specialist (OEM or contractor), engineering or
  information, approval or permit, access or safety clearance, and other (a note is required).
- Nothing is deleted (rule 5). A wrong tag is voided with a reason. Each change goes to the audit log.

## Why the stage stays

The stage answers "what is happening to the unit now" and its intervals add up to the down time, which the
downline queue, the repair-time split and A7 section 10 rely on. Wait tags answer "what is it waiting for, and
for how long". Their hours can overlap, so they are never added into down time.

## Rules

- A tag can only be raised on a unit with an open down flag.
- One open tag of each kind per unit. Ending it and raising it again later is fine.
- A tag cannot start before the stop started (`downSince`), in the future, or more than 7 days back.
- When the unit is released and no down flag is left open, its open tags end at the release time.
  A type switch keeps the stop going, so the tags stay open.
- When the down flag is voided and no down flag is left open, the open tags raised under it are voided too.

## Hours (KPI-046)

- **Wait hours by kind**: Σ each tag's hours, clipped to the period and to now. Overlapping tags of different
  kinds each count in full, so the kinds can add up to more than the down time.
- **Down time waiting**: the hours in which at least one tag was open (overlaps counted once), and its share of
  down time. This is the part of the stop that better planning, parts and labour could take out.

## Who can raise one (permission `set_waits`)

It follows "Update repair stage" (plan 11.2):

| Role | Wait tags |
|---|---|
| Technician, Supervisor | Own area |
| Reliability engineer, Superintendent | Yes |
| Viewer, Admin | No |

## Where they show

- **Status board**: each down unit's card lists its open tags with how long each has been on, under the stage.
- **Unit sheet**: "Waiting for" lists the open tags with "Done" to end one, and chips to start another, with an
  optional start time and note.
- **Performance**: wait hours by kind and the share of down time spent waiting, last 4 weeks.
