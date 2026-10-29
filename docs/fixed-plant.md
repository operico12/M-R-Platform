# Fixed plant

Phase 3b. This covers plan 4.3 and A7 section 11 for a processing plant such as a concentrator.
Part 1: plant structure and words, redundancy groups, circuit and plant availability, process delays,
throughput lost, the plant overview board (Figure 7), historian run and stop signals from a file, and
the plant KPIs. Part 2: the structure editor, shutdown tracking, and operator rounds and lube routes.

The code is in `packages/core/src/plant.ts`, kept apart from the mobile code (plan 4.3 rule: one
shared core, plant-only logic in its own module). Plant equipment uses the same down flags, stages,
audit, roles and KPI engine as the haul trucks.

## Words on screen

Each asset's class sets the words (plan 4.3). Code: `wordsFor`.

| Mobile | Fixed plant |
| --- | --- |
| Unit | Equipment |
| Fleet | Circuit |
| SMU | Run hours |
| Shop line | Work location |

## Plant structure

Site, plant, area, circuit, group, equipment (plan 4.3, data model Circuit and RedundancyGroup).

- A **plant node** is a plant, area, circuit or redundancy group. Each has a name, a parent, a place in
  process order among its siblings, and optionally a functional location (Maximo location or SAP
  functional location) and a planned rate in tonnes an hour.
- **Equipment** is an asset with asset class fixed plant. It belongs to the node whose functional
  location is the longest prefix of its own functional location, compared segment by segment
  (`CON-GRD-CFP` holds `CON-GRD-CFP-PP01`, not `CON-GRD-CFP2-PP01`). Segments are split on `-`,
  `.` and `/`, ignoring case. To move an equipment, change the functional location of a node (or the
  equipment's own, in the ERP).
- Equipment with no functional location match is listed as unplaced and left out of the roll-up.
- Nodes are never deleted. A node that is no longer used is retired with a reason; its history stays.

Changing the structure follows plan 11.2 "Edit shops, shop lines, field locations, plant structure":
admin yes, reliability engineer propose. The editor is in "Structure editor" below.

## Redundancy and roll-up

Every node has a **needed** count: how many of its children must be available for the node to be
available. Left empty it means all of them (series). A duty and standby pump pair is a group with
2 children and needed 1. A plant with two grinding lines that can each carry the plant at a reduced
rate is not modelled as redundant; give it needed 2 and use the planned rates.

A stockpile or surge bin between two parts of the process is a buffer: a stop on one side does not
stop the other at once. Model the two sides as separate plants (for example a crushing plant and a
concentrator), so a crusher stop is not counted against the concentrator. The synthetic demo does this.

At every moment each equipment is in one state:

| State | When |
| --- | --- |
| Down | It has an open or released down flag covering that time (proposed, voided and process delay flags never count, A7 3.1) |
| Process delay | It is in a process delay record and not down |
| Running | The historian says it runs |
| Idle | None of the above: available but not running. An installed spare waiting is idle, never down (A7 section 11) |

A node takes its state from its children, with k = needed:

1. Running if at least k children are running.
2. Else idle (available) if at least k children are running or idle.
3. Else process delay if at least k children are running, idle or in process delay.
4. Else down.

So maintenance is only blamed when maintenance alone takes the node below k. A process delay
recorded on the node itself (for example "no feed" on a circuit) turns idle into process delay; it
never hides a down state and never overrides running.

Equipment with no historian signals is idle whenever it is not down or delayed, so availability still
works without a historian; utilisation is then left empty.

## Process delays

Process delays are their own records, not down flags, and do not reduce maintenance availability
(A7 section 11). Each has a code, a start, an end (empty while it runs), the node it stopped, and
optionally the equipment that showed the stop.

Starter codes (setting `delayCodes`, A9 reference list to review with the site):

| Code | Category |
| --- | --- |
| No feed | Process |
| Bins or stockpile full | Process |
| Upstream stop | Process |
| Downstream stop | Process |
| Ore change or hardness | Process |
| Water or reagent shortage | Process |
| Operator or control | Process |
| Power supply | External |
| Weather | External |

Category external covers the plan's "external (power)" downtime type. Both categories count only as
process delay time.

Rules (code: `recordDelay`, `endDelay`, `voidDelay`):

- Recording, ending and voiding use the flag permissions: set and clear flags (supervisor in their
  area, reliability engineer, superintendent; technicians cannot). A truck shop supervisor whose
  scope is the haul truck fleet cannot record delays for the plant (plan 11.3).
- Times cannot be in the future. The end must be after the start.
- A delay cannot overlap another delay on the same node and equipment.
- Nothing is deleted: a wrong delay is voided with a reason, and every change goes to the audit log.

## Downtime types

| Plan 4.3 type | Recorded as | Reduces maintenance availability |
| --- | --- | --- |
| Planned shutdown | Scheduled down flag | Yes |
| Unplanned maintenance (trips and breakdowns) | Unscheduled down flag | Yes |
| Process delay | Process delay record, category process | No |
| External (power) | Process delay record, category external | No |

## Historian run and stop signals

Phase 1a is file based: a CSV export from the historian (PI, IP.21 or the control system) is loaded on
the Plant page. The live connector is phase 1b work and needs IT approval.

File format, one row per state change:

| Column | Meaning |
| --- | --- |
| `tag` | The equipment number, its ERP asset number or its functional location, optionally followed by `.RUN`, `.STS` or `_RUN` |
| `timestamp` | ISO time with an offset, or local time `YYYY-MM-DD HH:mm[:ss]` in the site time zone (never the browser's) |
| `value` | `1`, `RUN`, `RUNNING`, `ON` or `TRUE` for running; `0`, `STOP`, `STOPPED`, `OFF` or `FALSE` for stopped |

Rows that do not match an equipment, have a bad time or value, or repeat an existing time are listed
as issues and skipped. A row that repeats the state before it is kept but changes nothing.

**Run hours.** The time between a running signal and the next stopped signal is run time. Run hours
replace SMU for plant equipment: utilisation, MTBF and rule R14 use them (A7 section 11). Code:
`runReadings` turns the signals into meter readings, so the tier 1 KPI engine is used unchanged.
R14 for plant (`runningWhileDown`): the historian shows the equipment running for more than the R14
threshold (`smuRiseWhileDownHours`, 0.5 h) inside a down flag; the flag is probably wrong.

**Stop detection** (code: `detectStops`). Each change from running to stopped is a stop. A stop
becomes a proposed down flag (source historian) for a person to classify unless:

- it lasted less than `minStopMinutes` (default 1 minute; chatter),
- the equipment already has a flag, a proposal (or rejected proposal) or a process delay (on it, or on
  a node above it) running at the stop or starting within 15 minutes after it (someone flagged it a
  little later),
- another equipment in the same circuit was flagged down within 2 minutes of the stop (the stop was a
  knock-on of that one), or
- the setting `coveredStops` is `skip` and enough other members of the equipment's redundancy group
  were running within `changeoverMinutes` (default 5) of the stop (a duty and standby change).
  The default is `propose`, so a duty pump trip is never missed; the classify card then says the
  standby took over.

The person classifies each proposed stop (Plant page, "Stops to classify"):

| Choice | Result |
| --- | --- |
| Maintenance | Confirms the proposal as an open down flag (A7 T2), unscheduled by default, In place at the equipment's functional location. If the historian already shows the equipment running again, the release form offers that time as the release time |
| Process delay, with a code | Creates a process delay record from the stop start to the run resume (or open), and rejects the proposal into the state set by C2 |
| Not a stop | Rejects the proposal with a reason (A7 T3), for example a planned duty and standby changeover |

C2 (`rejectedFixedPlantProposal`, open, docs/a7-open-questions.md) still decides whether the
rejected proposal is kept as Voided or in the Process delay state. Either way it never counts as
downtime, and in both settings choosing "Process delay" writes the separate process delay record
that A7 section 11 asks for. This is our reading of C2 until it is decided.

## Throughput lost

Throughput lost (tonnes) = hours the node is down or in process delay × the node's planned rate
(plan 4.3). Each moment is put against its causes:

- Down: the system (or reason) of each down flag holding the node below k, shared equally if more
  than one.
- Process delay: the code of each delay holding it below k, or the node's own delay.

Circuits are not added up into a plant total, because one stop shows in every circuit downstream.
The plant total is the plant node's own down and delay hours × the plant's planned rate. A node
with no planned rate shows hours only.

Downstream circuits that stop because an upstream circuit stopped are process delays (code Upstream
stop), so the maintenance cause is counted once, at the circuit where it happened.

## Plant overview board (Figure 7)

Circuits in process order, left to right (wrapping on a phone). Each circuit shows:

- its state now (running, available, process delay or down) in colour, shape and word,
- availability and process delay hours over the last 7 days, and throughput lost over the same days
  split into maintenance and process,
- each redundancy group as "needed of installed" with how many are available now, and
- each equipment as a tile: down (with stage, reason and hours), process delay (code), running, or
  idle (standby).

A process delay is drawn apart from maintenance: a striped purple tile and the word "Process delay",
never the red down colour. Stops waiting to be classified are listed above the board.

## Plant KPIs

KPI-033 to KPI-038 in `docs/kpi-dictionary.md`. MTBF and MTTR per equipment are KPI-005 and KPI-006
with run hours in place of SMU.

## Settings

Site setting `plant` (Console later; edited by reliability engineer, superintendent and admin):

| Setting | Default | Meaning |
| --- | --- | --- |
| `minStopMinutes` | 1 | Historian stops shorter than this are ignored |
| `changeoverMinutes` | 5 | How soon after a group member stops the others must be running for the stop to count as covered |
| `coveredStops` | `propose` | `propose` or `skip` covered stops of a group member |
| `delayCodes` | the starter list above | Process delay codes and categories. A code is retired, never removed, so old records keep it |
| `scopeFreezeDays` | 7 | Default scope freeze for a new shutdown, in days before the planned start |

## Worked examples encoded as tests

Plan Appendix E plant cases, one week (168 h):

- Duty and standby pump pair, needed 1 of 2. The duty pump fails and is down 6 h while the standby
  runs. Duty pump availability 162 ÷ 168 = 96.4%; standby 100%; circuit 100%; throughput lost 0.
  If the standby is also down for 2 h inside those 6 h, the circuit is down 2 h: 98.8%, and 2 h ×
  the planned rate is lost against both pumps' systems, shared equally.
- A conveyor stopped 3 h by a full stockpile, recorded as a process delay, on a circuit planned at
  1,000 t/h. Conveyor and circuit availability 100%; process delay 3 h; throughput lost 3,000 t,
  all against "Bins or stockpile full", none against maintenance.

## Structure editor (part 2)

On the Plant page, Structure tab. Code: `saveNode`, `retireNode`, `placementChanges` in
`packages/core/src/plant.ts`.

- **Who:** the admin (plan 11.2 "Edit shops, shop lines, field locations, plant structure": admin yes,
  reliability engineer propose). The permission is `edit_shop_structure`. A reliability engineer sees
  the editor read-only and asks the admin. There is no propose flow for structure yet.
- **What a node has:** kind, name, parent, place in process order, needed (groups and any node with
  redundancy), functional location, planned rate in t/h.
- **Where a node can sit:**

  | Kind | Parent |
  | --- | --- |
  | Plant | none (a plant is a root) |
  | Area | a plant |
  | Circuit | a plant or an area |
  | Redundancy group | a circuit or another group |

- **Checks:**
  - Name 1 to 100 characters.
  - A parent cannot be the node itself or anything under it.
  - A functional location is used by one active node only (compared by segments, ignoring case).
  - Needed is a whole number from 1 to 100. If it is above the number of children and equipment, the
    editor warns: the node is then down whenever any child is down, so it is probably a mistake.
  - A planned rate is above 0.
  - A kind change must still fit its parent and its children.
- **Retiring:** with a reason, and only once nothing active is under it. Its equipment then belongs to
  the next node up whose functional location matches, or becomes unplaced. The editor shows this before
  saving. A retired node is never brought back; add a new one.
- **Preview:** before saving, the editor lists the equipment that would change node and any that would
  become unplaced. The unplaced list on the tab shows equipment with no matching node.
- **Audit:** every save and retire, with the reason, entity `plant_node`.

## Shutdowns (part 2)

Plant shutdowns are planned work on many pieces of equipment at once. Code:
`packages/core/src/shutdowns.ts`. Words: a **shutdown** has a **plan** (planned start and end), a
**scope** (the work orders to do), a **scope freeze** time, and actual start and end.

- **Who:** supervisors, reliability engineers and superintendents (permission `run_shutdowns`; plan
  11.2 has no shutdown row, so this follows "Set or clear down flags" for supervisors without the area
  limit, because a shutdown crosses areas). Starting and ending also need `set_clear_flag` for each
  equipment, as for any flag.
- **Planning:** pick the node (a plant, area or circuit), name it, give the master work order (the
  ERP's shutdown work order), the planned start and end, and the equipment taking part (default: all
  equipment under the node). The scope freeze defaults to `scopeFreezeDays` (7) before the planned
  start. The plan can change until the shutdown starts, with a reason.
- **Scope:** work orders by number. The tab suggests open work orders on the shutdown's equipment that
  are waiting for a shutdown (readiness map) or whose target or scheduled start falls between one day
  before the planned start and the planned end. A work order added after the freeze is **work
  added** and needs a reason. A work order is taken out of scope with a reason; the record stays.
  Nothing is added after the shutdown ends.
- **Starting:** records the actual start (now or earlier, under the flag back-dating rules) and raises
  a scheduled down flag on each equipment taking part, In place, reason code `Shutdown` (or the
  site's code picked on the form), with the master work order and the planned hours, then moves it to
  In repair. Equipment that already has an open flag keeps its flag and is listed as a warning; its
  time counts as the flag it has.
- **Ending:** records the actual end and releases each shutdown flag still open, with the master work
  order, the summary "Shutdown <name> complete" and the findings given on the form. A flag that was
  already released by hand stays as it is. A flag in a stage that cannot be released (for example
  Waiting parts) stays open and is listed, so the supervisor deals with it on the equipment.
- **Cancelling:** only before it starts, with a reason.
- **Completed work:** a scope work order is done when the imported work order is closed in the ERP.
  The ERP stays the system of record; nothing is written back. A number not in the import yet is shown
  as "not imported".
- **Availability:** the shutdown flags are scheduled flags, so equipment and circuit availability count
  the shutdown as planned down (KPI-033, KPI-034), exactly as any PM.
- **Audit:** plan, plan change, scope add and removal, start, end and cancel, entity `shutdown`.

KPIs: KPI-039 to KPI-041 in `docs/kpi-dictionary.md`.

## Operator rounds and lube routes (part 2)

Rounds go through Inspections (`docs/inspections.md`): the same items, scoring, defects, sign-off,
photos and outbox. What a route adds:

- A **route** is an inspection form for fixed plant with a kind (**operator round** or **lube
  route**), a node, and **stops**: equipment under that node, in walking order. Each item belongs to
  one stop.
- **Lube points** use the item kind **task** (Done or Missed). Missed counts as a fail, so it becomes
  a defect like any failed item. Rounds use pass or fail, ratings and readings as any inspection.
- **How often:** every N shifts (site shift calendar) or every N site days.
- **Doing one:** a technician, supervisor, reliability engineer or superintendent starts the round,
  walks the stops and answers each stop's items. A stop can be **skipped with a reason** (for example
  the equipment is down or isolated); a skipped stop has no answers and no score. At least one stop is
  done. Submitting checks every stop not skipped, as for an inspection.
- **Records:** a round record (who, when, the form version, skipped stops) and one inspection per stop
  done, against that equipment, so the equipment's inspection history and its defects show the round.
  Defects follow up as any inspection defect, including flagging the equipment down.
- **Sign-off and void** as inspections: a supervisor or superintendent, not the person who did it.
  Voiding a round voids its inspections.
- **Due:** a route is due once per period of N shifts or N days after the last round started. It is
  **due now** in the shift (or day) it falls due, **overdue** after that, and **never done** before
  the first round. Route forms are left out of the unit due list on the Inspections page.
- **Compliance:** KPI-042.

## Later

- OEE where rate and quality data exist.
- Isolation status read-only from the permit system.
- Vibration, thermography and ultrasound for rotating equipment (condition monitoring).
- Live historian connector (phase 1b, needs IT approval).
- A propose flow for structure changes by reliability engineers.
