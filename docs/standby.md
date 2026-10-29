# Standby flags

Ope, 29 Oct 2026: a unit is in use unless a flag says otherwise. Down flags say it is not available
(PA, KPI-001). Standby flags say it is available but not in use, such as a shift change, a crib break,
or waiting for an operator. These hours are tracked so improvements to both PA and utilisation can be measured.
Code: `packages/core/src/standby.ts` (tested in `test/standby.test.ts` and the golden tests).

## What a standby flag is

- It has a unit, a reason, a start and an end. An open flag has no end yet.
- Like down flags, it records who set it and when it was entered. It is never typed as a duration (rule 4).
- Each reason has a kind:
  - **Operating delay**: part of the shift's routine, such as a shift change, crib break, refuelling or a dispatch hold.
  - **Standby**: the unit could work but is not asked to, such as waiting for an operator, no work, weather, blasting, or a road or dump closed.
- The reasons are a site setting. The defaults are in `DEFAULT_STANDBY_REASONS`.
- Nothing is deleted (rule 5). A wrong flag is voided with a reason, and a time is corrected with a reason. Each change goes to the audit log.

## Rules

- A unit has at most one open standby flag.
- A standby flag cannot start while the unit has an open down flag.
- Flagging a unit down ends its open standby at the down start.
- A standby flag cannot start in the future, end before it starts, or start more than 7 days back.
- Standby counts only while the unit is available. Time it overlaps a counting down flag, and parked time, is left out.
  Down wins over standby, so PA never moves.
- Standby flags on one unit that overlap count once.

## KPIs

- **Utilisation (time)** (KPI-044) = (available h − standby h) ÷ available h.
- **Standby hours** (KPI-045) are shown by reason and by kind.
- Utilisation from the hour meter (KPI-002) stays as a check. Where the two disagree, either flags are not being raised or readings are missing.

## Who can raise one (permission `set_standby`)

| Role | Standby flags |
|---|---|
| Technician, Supervisor, Reliability engineer, Superintendent | Yes |
| Viewer, Admin | No |

Dispatchers and operators can be given the Technician role if they should raise standby.

## On the status board

- Standby is a sub-status of **Operational** (docs/status-board.md), shown in blue-grey with its own count.
- Each standby unit's card shows its reason and how long it has been on standby.
- Up time counts from the end of the last stop or standby.
- Phase 1b will fill standby from the fleet management system. Flags made in the app stay as the record of what was entered by hand.
