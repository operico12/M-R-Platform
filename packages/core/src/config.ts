// Flag rules configuration.
//
// Every number and every choice in A7 that is not yet signed off lives here,
// so the code never hard-codes an answer. Two kinds of setting:
//
//   D1–D12  A7 section 12 decisions. Defaults are A7's proposed defaults.
//   C1–C7   Conflicts found in the A7 review (docs/a7-open-questions.md).
//           Defaults follow the A7 text as written; each one is OPEN until
//           Ope and the superintendent decide, and the UI shows them as such.
//
// When a decision is made, change the default here, update
// docs/a7-open-questions.md, and the golden tests will show what moved.

import type { LocationKind, Role, Stage } from './types.js';

export interface FlagRulesConfig {
  /** D1: minimum unscheduled event length (minutes) that counts as a failure for MTBF. Shorter is a minor stop. */
  minFailureMinutes: number;
  /** D2: hours down after which an ETA becomes required / alert fires. */
  etaRequiredAfterHours: number;
  /** D3: reopen window (hours) on the same system. */
  reopenWindowHours: number;
  /** D4: PM overrun switch point. */
  pmOverrunSwitchAt: 'defect_work_start' | 'planned_end';
  /** D5: does an unscheduled flag linked from a PM (defect found at PM) count as a failure? */
  pmFoundDefectCountsAsFailure: boolean;
  /** D6: gap between a false release and the reopen counts as available if SMU rose more than this many hours; otherwise downtime. */
  reopenGapSmuThresholdHours: number;
  /** D7: may technicians move a unit's location? */
  technicianCanMoveLocation: boolean;
  /** D8: line type mismatch handling. */
  lineMismatch: 'warn_override_with_reason' | 'block';
  /** D9: back-dating limits per role. */
  backdating: Record<Role, 'none' | 'previous_shift' | 'open_period' | 'any'>;
  /** D10: which ETA counts for shop release vs plan. */
  shopReleaseEta: 'first' | 'last_before_due';
  /** D11: does diagnosis in the field count as repair time? */
  fieldDiagnosisIsRepair: boolean;
  /** D12: reasons for Waiting other. */
  waitingOtherReasons: string[];

  /** C1 (review #1): allowed stage moves. A7 S3 says any stage can follow any other except In transit; Diagram 1 draws fewer. */
  stageMoves: 'S3_any' | { allowed: Partial<Record<Stage, Stage[]>> };
  /** C2 (review #2): a rejected fixed-plant stop becomes Voided (T3) or a process delay record (section 11). */
  rejectedFixedPlantProposal: 'voided' | 'process_delay';
  /** C3 (review #3): location moves that need a reason. Matrix text vs Diagram 2 dashed arrows differ. */
  movesNeedingReason: Array<[LocationKind | 'start', LocationKind | 'released']>;
  /** C4 (review #4): stages a flag may be released from (S4). Shop yard release is allowed by the move matrix. */
  releaseFromStages: Stage[];
  /** C5 (review #5): supervisor void window. T10 says same shift; R4 back-dating says previous shift. */
  supervisorVoidWindow: 'same_shift' | 'previous_shift';
  /** C6 (review #6): reopen continues the same flag (T11) or opens a new flag linked to it (section 6), or asks. */
  reopenMode: 'continue_same_flag' | 'link_new_flag';
  /** C7 (review #7): mean downtime numerator. A7 text: all downtime event duration ÷ failures. */
  meanDowntime: 'all_downtime_per_failure' | 'failure_events_per_failure' | 'per_event';
  /** Review #8: MTTR denominator. */
  mttrDenominator: 'failures' | 'unscheduled_events_with_repair' | 'all_events_with_repair';
  /** Review #10: exclude Ready for release from the SMU-rising-while-down check (test runs). */
  smuCheckExcludesReadyForRelease: boolean;

  /** Alert thresholds (A7 section 8). */
  alerts: {
    etaPassedGraceMinutes: number;
    proposalUnconfirmedMinutes: number;
    waitingLineHours: number;
    waitingPartsHours: number;
    smuRiseWhileDownHours: number;
    flagOpenDays: number;
  };
  /** First-time fix and repeat failure window (days). */
  repeatWindowDays: number;
}

export const DEFAULT_FLAG_RULES: FlagRulesConfig = {
  minFailureMinutes: 15,
  etaRequiredAfterHours: 1,
  reopenWindowHours: 2,
  pmOverrunSwitchAt: 'defect_work_start',
  pmFoundDefectCountsAsFailure: false,
  reopenGapSmuThresholdHours: 0.5,
  technicianCanMoveLocation: false,
  lineMismatch: 'warn_override_with_reason',
  backdating: {
    viewer: 'none',
    technician: 'none',
    supervisor: 'previous_shift',
    reliability_engineer: 'open_period',
    superintendent: 'open_period',
    admin: 'none',
  },
  shopReleaseEta: 'first',
  fieldDiagnosisIsRepair: true,
  waitingOtherReasons: ['Engineering decision', 'OEM', 'Crane', 'Tooling', 'Weather', 'Access'],

  stageMoves: 'S3_any',
  rejectedFixedPlantProposal: 'voided',
  movesNeedingReason: [
    ['towing', 'field'],
    ['shop_yard', 'released'],
  ],
  releaseFromStages: ['in_repair', 'ready_for_release'],
  supervisorVoidWindow: 'same_shift',
  reopenMode: 'continue_same_flag',
  meanDowntime: 'all_downtime_per_failure',
  mttrDenominator: 'failures',
  smuCheckExcludesReadyForRelease: false,

  alerts: {
    etaPassedGraceMinutes: 30,
    proposalUnconfirmedMinutes: 30,
    waitingLineHours: 2,
    waitingPartsHours: 24,
    smuRiseWhileDownHours: 0.5,
    flagOpenDays: 7,
  },
  repeatWindowDays: 30,
};

/** Settings that are still open questions in A7. The UI shows an "unsettled rule" marker next to anything that depends on them. */
export const OPEN_A7_SETTINGS: Array<{ key: keyof FlagRulesConfig; ref: string; question: string }> = [
  { key: 'stageMoves', ref: 'C1', question: 'Diagram 1 draws fewer stage moves than rule S3 allows. Which is right?' },
  { key: 'rejectedFixedPlantProposal', ref: 'C2', question: 'Does a rejected fixed-plant stop become Voided or a process delay?' },
  { key: 'movesNeedingReason', ref: 'C3', question: 'Which location moves need a reason: the matrix text or the dashed arrows?' },
  { key: 'releaseFromStages', ref: 'C4', question: 'Can a unit be released from the shop yard, and from which stages?' },
  { key: 'supervisorVoidWindow', ref: 'C5', question: 'Supervisor void window: same shift (T10) or previous shift (R4)?' },
  { key: 'reopenMode', ref: 'C6', question: 'Does a reopen continue the released flag or open a new linked flag?' },
  { key: 'meanDowntime', ref: 'C7', question: 'Mean downtime divides all downtime by failures only. Keep, or use failure events only, or per event?' },
  { key: 'mttrDenominator', ref: 'R8', question: 'What counts as a "repair" in MTTR?' },
  { key: 'smuCheckExcludesReadyForRelease', ref: 'R10', question: 'Should test runs in Ready for release be excluded from the SMU-rising check?' },
];

export function withRules(overrides: Partial<FlagRulesConfig> = {}): FlagRulesConfig {
  return {
    ...DEFAULT_FLAG_RULES,
    ...overrides,
    alerts: { ...DEFAULT_FLAG_RULES.alerts, ...(overrides.alerts ?? {}) },
    backdating: { ...DEFAULT_FLAG_RULES.backdating, ...(overrides.backdating ?? {}) },
  };
}
