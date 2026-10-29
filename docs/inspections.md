# Inspections

Phase 2 module (build plan v10 section 4 "Inspections", 16.1 "Inspections: forms, recurrence,
scoring, photos, sign-off, defects turned into follow-ups, offline drafts and an outbox that
retries"). Rules live in `packages/core/src/inspections.ts`; defaults below are starting points.

## Forms

- A form has sections of items and applies to an asset class, and optionally to some models.
- Item kinds:
  - **Pass / fail**
  - **Rating 1 to 5**, where 1 is bad and 5 is good. A rating of 2 or less counts as a fail.
  - **Reading**: a number with lower and upper limits. Outside the limits counts as a fail.
  - **Note**: text only, not scored.
  - **Task**: Done or Missed, for lube points and other routine jobs. Missed counts as a fail.
- Any item can be marked **critical**, given a **weight** (default 1), and set to **need a photo when
  it fails**.
- Every item allows N/A unless it is critical.
- Forms are never edited in place. Saving a change makes a new version, so past inspections keep the
  questions they were answered against. Forms are retired, never deleted.
- Recurrence is every N site days or every N SMU hours. Plant routes can also be due every N shifts.

## Score and result

- **Score** = Σ(weight × item score) ÷ Σ(weight), over answered, scored items. N/A and notes are left
  out.
- **Item score:**
  - Pass/fail: pass 1, fail 0.
  - Rating: (r − 1) ÷ 4.
  - Reading: within limits 1, outside 0.
  - Task: done 1, missed 0.
- **Result:**
  - **Fail**: any critical item failed.
  - **Defects found**: any other item failed.
  - **Pass**: no item failed.
- The score is shown beside the result but does not decide it. One critical fail is enough.

## Doing one

- **Who:** technicians, supervisors, reliability engineers and superintendents. This uses the same
  permission as "add notes, photos and defects" (plan 11.2).
- **Drafts and the outbox:**
  - A draft saves on the device as it is filled in, so it survives losing signal or closing the
    tablet.
  - Submitting puts it in an outbox that sends it when there is a connection and retries until it is
    saved.
- **Before submitting:**
  - Every required item must be answered.
  - A failed item needs a note.
  - A failed item that needs a photo must have one.
- **Defects:** each failed item becomes a defect. A failed critical item is a high-severity defect;
  any other failed item is medium. The inspector can change the severity and add more defects.
- **Times:** start and submit times are the real entry times. The SMU reading is optional.

## Sign-off

- A supervisor or superintendent signs off a submitted inspection. They cannot sign off one they did
  themselves. This mirrors "sign shift handover" in plan 11.2.
- Signing off with a note closes the inspection for editing.
- A wrong inspection is voided with a reason. It is never deleted.

## Defects to follow-up

The ERP stays the system of record (no write-back), so a defect is followed up in one of these ways:

- **Raise an improvement action**, which links the action.
- **Work order raised in Maximo**: the person enters the work order number, and it links when the work
  order is imported.
- **Flag the unit down**: for a defect that stops the unit. This opens the unit page.
- **Close with a note**: for example, fixed on the spot.

## Due list

- **Due:** each unit the form applies to is due N days, or N SMU hours, after its last submitted
  inspection.
- **Due soon:** within 2 days, or within 10% of the interval in hours. For a form due every 2 days or
  less, the window is shorter (interval minus one day), so a daily pre-start is due soon only on the day
  it is due, not every day.
- **Never done:** a unit with no inspection yet is shown as never done, not as overdue.

## Who changes forms

Reliability engineers, superintendents and the admin (data owner), with a reason.

## Plant routes

Operator rounds and lube routes for fixed plant are inspection forms with a route: a node, stops in
walking order, and items that each belong to a stop. They are done from the Plant page, one round at a
time, and make one inspection per stop done. Rules: `docs/fixed-plant.md`, "Operator rounds and lube
routes". Route forms are not in the unit due list on this page.
