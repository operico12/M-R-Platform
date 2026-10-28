# A7 open questions and how the code handles them

A7 draft 0.1 (26 Oct 2026) was reviewed and found to contain conflicts the code would have to choose
between. None is decided yet. Each is a setting in `packages/core/src/config.ts`; the default follows
the A7 text as written. The Flag rules page in the app lists them as "open".

When one is decided: change the default in `DEFAULT_FLAG_RULES`, update this table, and add a test.

| Ref | Question | Setting | Current default | Options |
| --- | --- | --- | --- | --- |
| C1 | Diagram 1 draws fewer stage moves than rule S3 (e.g. no In repair → In transit) | `stageMoves` | `S3_any`: any stage to any, except In transit, which only Towing sets | `S3_any` or an explicit allow-list |
| C2 | A rejected fixed-plant stop: Voided (T3) or a process delay (section 11)? | `rejectedFixedPlantProposal` | `voided` | `voided`, `process_delay` |
| C3 | Moves that need a reason: matrix text or Diagram 2 dashed arrows? | `movesNeedingReason` | Matrix text: tow cancelled (Towing → Field), release from Shop yard | Any list of from/to pairs |
| C4 | Release from the shop yard vs S4 (release only from In repair or Ready for release) | `releaseFromStages` | `in_repair`, `ready_for_release`; yard release allowed by the matrix with a reason | Any list of stages |
| C5 | Supervisor void window: same shift (T10) or previous shift (R4)? | `supervisorVoidWindow` | `same_shift` | `same_shift`, `previous_shift` |
| C6 | Reopen: same flag continues (T11) or a new linked flag (section 6)? | `reopenMode` | `continue_same_flag` (gap stored on the flag, counted per D6) | `continue_same_flag`, `link_new_flag` |
| C7 | Mean downtime divides all unscheduled downtime by failures only, so minor stops and PM-found defects inflate it | `meanDowntime` | `all_downtime_per_failure` (plan 3.3 formula) | `failure_events_per_failure`, `per_event` |
| R8 | What is "a repair" in MTTR? | `mttrDenominator` | `failures` | `unscheduled_events_with_repair`, `all_events_with_repair` |
| R10 | Test runs in Ready for release can raise the SMU-rising check | `smuCheckExcludesReadyForRelease` | `false` | `true` |

Other gaps from the review that the code fills with a stated assumption:

- **Tow cancelled** (review #15): the stage returns to the one before the tow.
- **Shop release vs plan** (review #9): only releases that had an ETA count as "due"; per flag, not per downtime event.
- **SMU check** (R14): readings arrive once a shift, so the check compares the shift's SMU rise with the hours the unit was not flagged down in that shift.
- **Utilisation in a shift still in progress**: hours after a unit's last SMU reading are left out of utilisation rather than counted as standby.
