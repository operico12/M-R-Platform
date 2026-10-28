// Core domain types. Names follow the A7 status, location and flag rules
// and section 6.5 of the build plan. All timestamps are ISO-8601 UTC strings.

export type Iso = string;

export type AssetClass = 'mobile' | 'fixed_plant';

/** Long-term status of an asset. Parked and decommissioned units are left out of calendar hours (A7 R2). */
export type AssetLifecycle = 'active' | 'parked' | 'decommissioned' | 'not_commissioned';

export interface Site {
  id: string;
  tenantId: string;
  name: string;
  /** IANA time zone, e.g. "America/Vancouver". Every day and shift boundary uses this, never the viewer's browser. */
  timeZone: string;
}

export interface Asset {
  id: string;
  tenantId: string;
  siteId: string;
  unitNumber: string;
  fleet: string;
  model: string;
  assetClass: AssetClass;
  serial?: string;
  /** Identity bridge to the ERP/CMMS (e.g. Maximo ASSETNUM). */
  externalAssetId?: string;
  functionalLocation?: string;
}

/** Effective-dated lifecycle status, so a unit parked mid-period changes calendar hours only from that point. */
export interface AssetLifecycleInterval {
  assetId: string;
  status: AssetLifecycle;
  start: Iso;
  end: Iso | null;
}

export type FlagType = 'scheduled' | 'unscheduled';

/** A7 section 3.1. */
export type FlagState = 'proposed' | 'open' | 'released' | 'voided' | 'process_delay';

/** A7 section 4. */
export type Stage =
  | 'waiting_crew'
  | 'in_transit'
  | 'waiting_line'
  | 'in_repair'
  | 'waiting_parts'
  | 'waiting_labour'
  | 'waiting_other'
  | 'ready_for_release';

export const STAGES: readonly Stage[] = [
  'waiting_crew',
  'in_transit',
  'waiting_line',
  'in_repair',
  'waiting_parts',
  'waiting_labour',
  'waiting_other',
  'ready_for_release',
] as const;

export const STAGE_LABELS: Record<Stage, string> = {
  waiting_crew: 'Waiting for crew',
  in_transit: 'In transit',
  waiting_line: 'Waiting for a line',
  in_repair: 'In repair',
  waiting_parts: 'Waiting parts',
  waiting_labour: 'Waiting labour',
  waiting_other: 'Waiting other',
  ready_for_release: 'Ready for release',
};

/** A7 section 5. */
export type LocationKind = 'field' | 'towing' | 'shop_yard' | 'shop_line' | 'in_place';

export const LOCATION_LABELS: Record<LocationKind, string> = {
  field: 'Down in field',
  towing: 'Towing',
  shop_yard: 'Shop yard',
  shop_line: 'Shop line',
  in_place: 'In place',
};

export interface ShopLine {
  id: string;
  siteId: string;
  shop: string;
  /** Optional: lines can be numbered, named, or both. */
  number?: number;
  name?: string;
  lineType: 'general' | 'pm' | 'tyre' | 'weld' | 'wash' | 'lube';
  capacity: number;
  /** Models that fit; empty means any. */
  fits: string[];
}

/** A line closed for a period (e.g. crane inspection). Closed time is excluded from occupancy. */
export interface ShopLineClosure {
  lineId: string;
  start: Iso;
  end: Iso | null;
  reason: string;
}

export interface Actor {
  userId: string;
  role: Role;
  /** Areas or fleets the user may act on. '*' means all. */
  scope: string[];
}

/** Phase 1a roles (plan 11.7). Technician and superintendent arrive in 1b and 2 but are modelled now. */
export type Role =
  | 'viewer'
  | 'technician'
  | 'supervisor'
  | 'reliability_engineer'
  | 'superintendent'
  | 'admin';

export interface StageInterval {
  stage: Stage;
  start: Iso;
  end: Iso | null;
  /** Required for waiting_other (S5). */
  reason?: string;
  /** Optional for waiting_parts (S5). */
  partOrWorkOrder?: string;
  setBy: string;
  enteredAt: Iso;
}

export interface LocationInterval {
  kind: LocationKind;
  start: Iso;
  end: Iso | null;
  shopLineId?: string;
  fieldLocation?: string;
  functionalLocation?: string;
  reason?: string;
  setBy: string;
  enteredAt: Iso;
}

export interface EtaEntry {
  eta: Iso;
  setAt: Iso;
  setBy: string;
}

export interface ReleaseDetails {
  system?: string;
  component?: string;
  failureModes?: string[];
  repairSummary?: string;
  workOrder?: string;
  pmOrWorkOrder?: string;
  findings?: string;
  causeCode?: string;
  detectionMethod?: DetectionMethod;
  smuAtFailure?: number;
}

export type DetectionMethod = 'operator' | 'pm' | 'inspection' | 'condition_monitoring' | 'alarm' | 'other';

export type FlagSource = 'app' | 'erp' | 'fleet_system' | 'historian';

export interface DownFlag {
  id: string;
  tenantId: string;
  siteId: string;
  unitId: string;
  type: FlagType;
  state: FlagState;
  reasonCode: string;
  system?: string;
  start: Iso;
  end: Iso | null;
  /** Previous flag in the same downtime event (type switch, or reopen in link mode). */
  linkedFromFlagId?: string;
  linkKind?: 'type_switch' | 'reopen';
  /** Planned duration for scheduled flags, used by the PM overrun prompt (R8). */
  plannedDurationHours?: number;
  stages: StageInterval[];
  locations: LocationInterval[];
  etas: EtaEntry[];
  release?: ReleaseDetails;
  /** Set when a release was later found to be false (T11). */
  falseRelease?: boolean;
  /** Gaps inside a reopened flag (continue-same-flag mode). Each is either downtime or available per D6. */
  reopenGaps?: { start: Iso; end: Iso; countsAs: 'downtime' | 'available' }[];
  workOrders: string[];
  source: FlagSource;
  setBy: string;
  enteredAt: Iso;
  releasedBy?: string;
  voidReason?: string;
  restated?: boolean;
  notes?: string;
}

export interface SmuReading {
  unitId: string;
  at: Iso;
  hours: number;
}

export interface AuditEntry {
  at: Iso;
  userId: string;
  action: string;
  entity: 'down_flag' | 'import_run' | 'target' | 'user' | 'code' | 'action' | 'rca' | 'project' | 'settings' | 'alert' | 'approval' | 'inspection' | 'inspection_form' | 'analysis' | 'view';
  entityId: string;
  before: unknown;
  after: unknown;
  reason?: string;
  /** The time the user said it happened, when back-dated. */
  effectiveAt?: Iso;
  offline?: boolean;
}

/** How a work order type is treated in analysis. The ERP's own codes map to these (A3). */
export type WorkClass = 'pm' | 'corrective' | 'inspection' | 'project' | 'other';

/** Whether open work can be scheduled (KPI-021). The ERP's statuses map to these in the import mapping. */
export type WorkReadiness = 'ready' | 'in_progress' | 'waiting_approval' | 'waiting_parts' | 'waiting_shutdown' | 'unknown';

/**
 * A work order copied from the ERP. The ERP stays the system of record (plan 6.3):
 * the platform only reads these, keyed by source system plus source ID.
 */
export interface WorkOrder {
  id: string;
  tenantId: string;
  siteId: string;
  /** Linked unit, if the work order's asset matched one. */
  assetId?: string;
  sourceSystem: string;
  sourceId: string;
  /** As shown in the ERP. */
  number: string;
  /** Trimmed, upper case, without a "WO-" prefix or leading zeros. Used to link flags. */
  numberNormalised: string;
  /** The ERP asset number given on the work order. */
  externalAssetId?: string;
  woType?: string;
  workClass: WorkClass;
  status?: string;
  /** False once the ERP status is one of the closed statuses. */
  open: boolean;
  priority?: string;
  description?: string;
  reportedAt?: Iso;
  completedAt?: Iso;
  sourceModifiedAt?: Iso;
  /** Phase 2 work and PM view (KPI-018 to 023). All optional: older exports work without them. */
  targetStart?: Iso;
  /** The due date for a PM. */
  targetFinish?: Iso;
  scheduledStart?: Iso;
  scheduledFinish?: Iso;
  estimatedHours?: number;
  actualLabourHours?: number;
  /** The PM record that generated it. */
  pmNumber?: string;
  /** The work order it was raised from, for example a PM that found a defect. */
  originWorkOrder?: string;
}
