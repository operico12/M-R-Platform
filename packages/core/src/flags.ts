// Down flag state machine (A7 sections 3 to 7).
//
// Every command is a pure function: it takes the current records and returns
// either the new records plus audit entries, or a list of errors. Nothing is
// mutated and nothing is deleted. The same functions run in the browser, the
// server and the tests.

import type { FlagRulesConfig } from './config.js';
import { can, canPropose, hasRole } from './permissions.js';
import { hoursBetween, ms, shiftAt, shiftsBetween, toIso, type ShiftCalendar } from './time.js';
import type {
  Actor,
  Asset,
  AssetLifecycle,
  AuditEntry,
  DownFlag,
  EtaEntry,
  FlagType,
  Iso,
  LocationInterval,
  LocationKind,
  ReleaseDetails,
  ShopLine,
  ShopLineClosure,
  Stage,
  StageInterval,
} from './types.js';

export interface FlagContext {
  now: Iso;
  actor: Actor;
  rules: FlagRulesConfig;
  calendar: ShiftCalendar;
  asset: Asset;
  /** Area the asset belongs to, for scope checks. Defaults to the fleet. */
  area?: string;
  /** Lifecycle status of the asset now (A7 R2). */
  lifecycle?: AssetLifecycle;
  /** All flags for this unit (any state), used for one-open-flag and overlap rules. */
  unitFlags: DownFlag[];
  /** All open flags at the site, used for line capacity. */
  siteOpenFlags?: DownFlag[];
  shopLines?: ShopLine[];
  lineClosures?: ShopLineClosure[];
  /** Start of the earliest unlocked period. Anything before it is locked (R5). */
  openPeriodStart?: Iso;
  newId: () => string;
  offline?: boolean;
}

export type CommandResult =
  | { ok: true; flags: DownFlag[]; audit: AuditEntry[]; warnings: string[] }
  | { ok: false; errors: string[] };

const fail = (...errors: string[]): CommandResult => ({ ok: false, errors });

export interface LocationInput {
  kind: LocationKind;
  shopLineId?: string;
  fieldLocation?: string;
  functionalLocation?: string;
  reason?: string;
  /** Supervisor override for a line type mismatch (D8). */
  overrideReason?: string;
}

// ---------- helpers ----------

function areaOf(ctx: FlagContext): string {
  return ctx.area ?? ctx.asset.fleet;
}

function audit(ctx: FlagContext, action: string, before: DownFlag | null, after: DownFlag, reason?: string, effectiveAt?: Iso): AuditEntry {
  return {
    at: ctx.now,
    userId: ctx.actor.userId,
    action,
    entity: 'down_flag',
    entityId: after.id,
    before,
    after,
    reason,
    effectiveAt: effectiveAt && effectiveAt !== ctx.now ? effectiveAt : undefined,
    offline: ctx.offline || undefined,
  };
}

function closeLast<T extends { end: Iso | null }>(list: T[], at: Iso): T[] {
  return list.map((x, i) => (i === list.length - 1 && x.end === null ? { ...x, end: at } : x));
}

export function currentStage(flag: DownFlag): StageInterval | undefined {
  return flag.stages[flag.stages.length - 1];
}

export function currentLocation(flag: DownFlag): LocationInterval | undefined {
  return flag.locations[flag.locations.length - 1];
}

export function openFlagFor(flags: DownFlag[]): DownFlag | undefined {
  return flags.find((f) => f.state === 'open');
}

/** S1: first stage from the location. */
export function firstStageFor(kind: LocationKind): Stage {
  switch (kind) {
    case 'field':
    case 'in_place':
      return 'waiting_crew';
    case 'shop_yard':
      return 'waiting_line';
    case 'shop_line':
      return 'in_repair';
    case 'towing':
      return 'in_transit';
  }
}

/** A7 5.2 move matrix. 'start' is flag down; 'released' is the release step. */
const MOVES: Record<LocationKind | 'start', Partial<Record<LocationKind | 'released', boolean>>> = {
  start: { field: true, towing: false, shop_yard: true, shop_line: true, in_place: true },
  field: { field: true, towing: true, shop_yard: true, shop_line: true, released: true },
  towing: { field: true, shop_yard: true, shop_line: true, released: false },
  shop_yard: { field: false, towing: false, shop_line: true, released: true },
  shop_line: { field: false, towing: false, shop_yard: true, shop_line: true, released: true },
  in_place: { in_place: false, released: true },
};

export function moveAllowed(from: LocationKind | 'start', to: LocationKind | 'released', assetClass: Asset['assetClass']): boolean {
  // L6: fixed plant is In place only.
  if (assetClass === 'fixed_plant') return (from === 'start' && to === 'in_place') || (from === 'in_place' && to === 'released');
  if (to === 'in_place' || from === 'in_place') return false;
  return MOVES[from][to] === true;
}

function moveNeedsReason(rules: FlagRulesConfig, from: LocationKind | 'start', to: LocationKind | 'released'): boolean {
  return rules.movesNeedingReason.some(([f, t]) => f === from && t === to);
}

function stageMoveAllowed(rules: FlagRulesConfig, from: Stage, to: Stage): boolean {
  if (to === 'in_transit') return false; // S3: only Towing sets it.
  if (rules.stageMoves === 'S3_any') return true;
  return rules.stageMoves.allowed[from]?.includes(to) ?? false;
}

function lineIsClosed(ctx: FlagContext, lineId: string, at: Iso): boolean {
  return (ctx.lineClosures ?? []).some(
    (c) => c.lineId === lineId && ms(c.start) <= ms(at) && (c.end === null || ms(at) < ms(c.end)),
  );
}

function unitsInLine(ctx: FlagContext, lineId: string, excludeUnit: string): number {
  return (ctx.siteOpenFlags ?? []).filter((f) => {
    if (f.unitId === excludeUnit || f.state !== 'open') return false;
    const loc = currentLocation(f);
    return loc?.kind === 'shop_line' && loc.shopLineId === lineId;
  }).length;
}

/** Validates a location and returns warnings (line mismatch) or errors. */
function checkLocation(ctx: FlagContext, loc: LocationInput, at: Iso): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (loc.kind === 'shop_line') {
    const line = (ctx.shopLines ?? []).find((l) => l.id === loc.shopLineId);
    if (!line) errors.push('Choose a shop line.');
    else {
      if (lineIsClosed(ctx, line.id, at)) errors.push(`${lineName(line)} is closed (L2).`);
      if (unitsInLine(ctx, line.id, ctx.asset.id) >= line.capacity) errors.push(`${lineName(line)} is full (L1).`);
      if (line.fits.length > 0 && !line.fits.includes(ctx.asset.model)) {
        if (ctx.rules.lineMismatch === 'block') errors.push(`${ctx.asset.model} does not fit ${lineName(line)}.`);
        else if (!loc.overrideReason) errors.push(`${ctx.asset.model} does not fit ${lineName(line)}. A supervisor can override with a reason (D8).`);
        else warnings.push(`Line type override: ${loc.overrideReason}`);
      }
    }
  }
  if (loc.kind === 'field' && !loc.fieldLocation) errors.push('Choose the field location.');
  if (loc.kind === 'in_place' && !(loc.functionalLocation ?? ctx.asset.functionalLocation)) errors.push('Functional location is missing for this equipment.');
  return { errors, warnings };
}

export function lineName(l: ShopLine): string {
  if (l.number !== undefined && l.name) return `Line ${l.number} (${l.name})`;
  if (l.number !== undefined) return `Line ${l.number}`;
  return l.name ?? l.id;
}

function backdateErrors(ctx: FlagContext, at: Iso): string[] {
  const errs: string[] = [];
  if (ms(at) > ms(ctx.now)) errs.push('Time cannot be in the future (R3).');
  const allowed = ctx.actor.fullAccess ? 'any' : ctx.rules.backdating[ctx.actor.role];
  // Small grace so "now" from a slow device is not treated as back-dating.
  if (ms(ctx.now) - ms(at) <= 5 * 60_000) return errs;
  if (allowed === 'any') return errs;
  if (allowed === 'none') {
    errs.push('Your role cannot back-date (R4).');
  } else if (allowed === 'previous_shift') {
    const cur = shiftAt(ctx.calendar, ctx.now);
    const prev = shiftsBetween(ctx.calendar, toIso(ms(cur.start) - 1), cur.start).at(-1);
    const limit = prev ? prev.start : cur.start;
    if (ms(at) < ms(limit)) errs.push('Supervisors can back-date to the start of the previous shift only (R4, D9).');
  } else if (allowed === 'open_period') {
    if (ctx.openPeriodStart && ms(at) < ms(ctx.openPeriodStart)) errs.push('That time is in a locked period. It needs a change request (R5).');
  }
  if (ctx.openPeriodStart && ms(at) < ms(ctx.openPeriodStart) && !errs.some((e) => e.includes('locked'))) {
    errs.push('That time is in a locked period. It needs a change request (R5).');
  }
  return errs;
}

function overlapErrors(ctx: FlagContext, start: Iso, excludeId?: string): string[] {
  for (const f of ctx.unitFlags) {
    if (f.id === excludeId || f.state === 'voided' || f.state === 'proposed' || f.state === 'process_delay') continue;
    const fEnd = f.end === null ? Infinity : ms(f.end);
    if (ms(start) < fEnd && ms(f.start) < ms(ctx.now)) {
      return [`This overlaps another flag on ${ctx.asset.unitNumber} starting ${f.start} (R3).`];
    }
  }
  return [];
}

// ---------- T1 propose ----------

export interface ProposeInput {
  reasonCode: string;
  start: Iso;
  location: LocationInput;
  typeSuggestion?: FlagType;
  notes?: string;
  source?: DownFlag['source'];
}

export function proposeDown(ctx: FlagContext, input: ProposeInput): CommandResult {
  const src = input.source ?? 'app';
  if (src === 'app' && !canPropose(ctx.actor, 'set_clear_flag', areaOf(ctx))) return fail('You cannot propose a down flag for this unit.');
  if (openFlagFor(ctx.unitFlags)) return fail(`${ctx.asset.unitNumber} already has an open flag (R1).`);
  if (!input.reasonCode) return fail('Reason is required.');
  if (ms(input.start) > ms(ctx.now)) return fail('Time cannot be in the future (R3).');
  const flag: DownFlag = {
    id: ctx.newId(),
    tenantId: ctx.asset.tenantId,
    siteId: ctx.asset.siteId,
    unitId: ctx.asset.id,
    type: input.typeSuggestion ?? 'unscheduled',
    state: 'proposed',
    reasonCode: input.reasonCode,
    start: input.start,
    end: null,
    stages: [],
    locations: [locationRow(ctx, input.location, input.start)],
    etas: [],
    workOrders: [],
    source: src,
    setBy: ctx.actor.userId,
    enteredAt: ctx.now,
    notes: input.notes,
  };
  return { ok: true, flags: [flag], audit: [audit(ctx, 'propose', null, flag, undefined, input.start)], warnings: [] };
}

function locationRow(ctx: FlagContext, loc: LocationInput, at: Iso): LocationInterval {
  return {
    kind: loc.kind,
    start: at,
    end: null,
    shopLineId: loc.shopLineId,
    fieldLocation: loc.fieldLocation,
    functionalLocation: loc.kind === 'in_place' ? (loc.functionalLocation ?? ctx.asset.functionalLocation) : undefined,
    reason: loc.reason ?? loc.overrideReason,
    setBy: ctx.actor.userId,
    enteredAt: ctx.now,
  };
}

function stageRow(ctx: FlagContext, stage: Stage, at: Iso, extra: Partial<StageInterval> = {}): StageInterval {
  return { stage, start: at, end: null, setBy: ctx.actor.userId, enteredAt: ctx.now, ...extra };
}

// ---------- T2 confirm / T3 reject ----------

export function confirmProposal(
  ctx: FlagContext,
  flag: DownFlag,
  input: { type: FlagType; reasonCode?: string; location?: LocationInput },
): CommandResult {
  if (flag.state !== 'proposed') return fail('Only a proposed flag can be confirmed.');
  if (!can(ctx.actor, 'set_clear_flag', areaOf(ctx))) return fail('You cannot confirm flags for this unit.');
  if (openFlagFor(ctx.unitFlags.filter((f) => f.id !== flag.id))) return fail(`${ctx.asset.unitNumber} already has an open flag (R1).`);
  const errs = [...overlapErrors(ctx, flag.start, flag.id)];
  if (ctx.openPeriodStart && ms(flag.start) < ms(ctx.openPeriodStart)) errs.push('The proposed start is in a locked period. It needs a change request (R5).');
  const loc = input.location ?? (currentLocation(flag) as LocationInput);
  const lc = checkLocation(ctx, loc, flag.start);
  errs.push(...lc.errors);
  if (errs.length) return fail(...errs);
  const after: DownFlag = {
    ...flag,
    state: 'open',
    type: input.type,
    reasonCode: input.reasonCode ?? flag.reasonCode,
    locations: input.location ? [locationRow(ctx, input.location, flag.start)] : flag.locations,
    stages: [stageRow(ctx, firstStageFor(loc.kind), flag.start)],
  };
  return { ok: true, flags: [after], audit: [audit(ctx, 'confirm', flag, after)], warnings: lc.warnings };
}

export function rejectProposal(ctx: FlagContext, flag: DownFlag, reason: string): CommandResult {
  if (flag.state !== 'proposed') return fail('Only a proposed flag can be rejected.');
  if (!can(ctx.actor, 'set_clear_flag', areaOf(ctx))) return fail('You cannot reject flags for this unit.');
  if (!reason) return fail('A reason is required to reject.');
  // C2: open question. A rejected fixed-plant stop may become a process delay instead of a void.
  const asDelay = ctx.asset.assetClass === 'fixed_plant' && ctx.rules.rejectedFixedPlantProposal === 'process_delay';
  const after: DownFlag = { ...flag, state: asDelay ? 'process_delay' : 'voided', voidReason: reason };
  return { ok: true, flags: [after], audit: [audit(ctx, asDelay ? 'reject_to_process_delay' : 'reject', flag, after, reason)], warnings: [] };
}

// ---------- T4 flag down ----------

export interface FlagDownInput {
  type: FlagType;
  reasonCode: string;
  system?: string;
  start: Iso;
  location: LocationInput;
  eta?: Iso;
  plannedDurationHours?: number;
  workOrders?: string[];
  notes?: string;
}

export function flagDown(ctx: FlagContext, input: FlagDownInput): CommandResult {
  if (!can(ctx.actor, 'set_clear_flag', areaOf(ctx))) return fail('You cannot flag this unit down.');
  if (ctx.lifecycle && ctx.lifecycle !== 'active') return fail(`${ctx.asset.unitNumber} is ${ctx.lifecycle} and cannot be flagged (R2).`);
  if (openFlagFor(ctx.unitFlags)) return fail(`${ctx.asset.unitNumber} already has an open flag (R1).`);
  const errs: string[] = [];
  if (!input.type) errs.push('Type is required.');
  if (!input.reasonCode) errs.push('Reason is required.');
  if (!moveAllowed('start', input.location.kind, ctx.asset.assetClass)) errs.push(`A flag cannot start at ${input.location.kind}.`);
  if (moveNeedsReason(ctx.rules, 'start', input.location.kind) && !input.location.reason) errs.push('This location needs a reason.');
  errs.push(...backdateErrors(ctx, input.start), ...overlapErrors(ctx, input.start));
  const lc = checkLocation(ctx, input.location, input.start);
  errs.push(...lc.errors);
  if (errs.length) return fail(...errs);
  const etas: EtaEntry[] = input.eta ? [{ eta: input.eta, setAt: ctx.now, setBy: ctx.actor.userId }] : [];
  const flag: DownFlag = {
    id: ctx.newId(),
    tenantId: ctx.asset.tenantId,
    siteId: ctx.asset.siteId,
    unitId: ctx.asset.id,
    type: input.type,
    state: 'open',
    reasonCode: input.reasonCode,
    system: input.system,
    start: input.start,
    end: null,
    plannedDurationHours: input.plannedDurationHours,
    stages: [stageRow(ctx, firstStageFor(input.location.kind), input.start)],
    locations: [locationRow(ctx, input.location, input.start)],
    etas,
    workOrders: input.workOrders ?? [],
    source: 'app',
    setBy: ctx.actor.userId,
    enteredAt: ctx.now,
    notes: input.notes,
  };
  return { ok: true, flags: [flag], audit: [audit(ctx, 'flag_down', null, flag, undefined, input.start)], warnings: lc.warnings };
}

// ---------- T5 change stage ----------

export function changeStage(
  ctx: FlagContext,
  flag: DownFlag,
  input: { stage: Stage; at?: Iso; reason?: string; partOrWorkOrder?: string },
): CommandResult {
  if (flag.state !== 'open') return fail('Only an open flag can change stage.');
  if (!can(ctx.actor, 'update_stage', areaOf(ctx))) return fail('You cannot update the stage for this unit.');
  const at = input.at ?? ctx.now;
  const cur = currentStage(flag);
  const loc = currentLocation(flag);
  const errs: string[] = [];
  if (loc?.kind === 'towing') errs.push('The unit is being towed. End the tow by moving its location (S2).');
  if (cur && cur.stage === input.stage) errs.push('The unit is already in that stage.');
  if (cur && !stageMoveAllowed(ctx.rules, cur.stage, input.stage)) errs.push(`Cannot move from ${cur.stage} to ${input.stage} (S3).`);
  if (input.stage === 'waiting_other') {
    if (!input.reason) errs.push('Waiting other needs a reason (S5).');
    else if (!ctx.rules.waitingOtherReasons.includes(input.reason)) errs.push(`"${input.reason}" is not on the Waiting other list (D12).`);
  }
  if (cur && ms(at) < ms(cur.start)) errs.push('The change cannot be before the current stage started.');
  errs.push(...backdateErrors(ctx, at));
  if (errs.length) return fail(...errs);
  const after: DownFlag = {
    ...flag,
    stages: [...closeLast(flag.stages, at), stageRow(ctx, input.stage, at, { reason: input.reason, partOrWorkOrder: input.partOrWorkOrder })],
  };
  return { ok: true, flags: [after], audit: [audit(ctx, 'change_stage', flag, after, input.reason, at)], warnings: [] };
}

// ---------- T6 move location ----------

export function moveLocation(ctx: FlagContext, flag: DownFlag, input: LocationInput & { at?: Iso }): CommandResult {
  if (flag.state !== 'open') return fail('Only an open flag can move.');
  const techAllowed = ctx.actor.role === 'technician' && ctx.rules.technicianCanMoveLocation;
  if (!techAllowed && !can(ctx.actor, 'move_location', areaOf(ctx))) return fail('You cannot move this unit (D7).');
  const at = input.at ?? ctx.now;
  const from = currentLocation(flag);
  if (!from) return fail('The flag has no location.');
  const errs: string[] = [];
  const sameLine = from.kind === 'shop_line' && input.kind === 'shop_line' && from.shopLineId === input.shopLineId;
  if (sameLine) errs.push('The unit is already in that line.');
  if (!moveAllowed(from.kind, input.kind, ctx.asset.assetClass)) errs.push(`Cannot move from ${from.kind} to ${input.kind} (A7 5.2).`);
  if (moveNeedsReason(ctx.rules, from.kind, input.kind) && !input.reason) errs.push('This move needs a reason.');
  if (ms(at) < ms(from.start)) errs.push('The move cannot be before the unit arrived where it is.');
  errs.push(...backdateErrors(ctx, at));
  const lc = checkLocation(ctx, input, at);
  errs.push(...lc.errors);
  if (errs.length) return fail(...errs);

  // Stage follows the location for towing (S2).
  let stages = flag.stages;
  const cur = currentStage(flag);
  let nextStage: Stage | undefined;
  if (input.kind === 'towing') nextStage = 'in_transit';
  else if (from.kind === 'towing') {
    if (input.kind === 'shop_yard') nextStage = 'waiting_line';
    else if (input.kind === 'shop_line') nextStage = 'in_repair';
    else {
      // Tow cancelled back to the field. A7 does not say (review #15); return to the stage before the tow.
      const beforeTow = [...flag.stages].reverse().find((s) => s.stage !== 'in_transit');
      nextStage = beforeTow?.stage ?? 'waiting_crew';
    }
  } else if (input.kind === 'shop_line' && from.kind === 'shop_yard' && cur?.stage === 'waiting_line') nextStage = 'in_repair';
  if (nextStage && cur?.stage !== nextStage) {
    stages = [...closeLast(flag.stages, at), stageRow(ctx, nextStage, at)];
  }
  const after: DownFlag = { ...flag, stages, locations: [...closeLast(flag.locations, at), locationRow(ctx, input, at)] };
  return { ok: true, flags: [after], audit: [audit(ctx, 'move_location', flag, after, input.reason, at)], warnings: lc.warnings };
}

// ---------- T7 switch type ----------

export function switchType(ctx: FlagContext, flag: DownFlag, input: { at?: Iso; reason: string; reasonCode?: string; system?: string }): CommandResult {
  if (flag.state !== 'open') return fail('Only an open flag can switch type.');
  if (!can(ctx.actor, 'reclassify_flag', areaOf(ctx))) return fail('You cannot switch the flag type.');
  if (!input.reason) return fail('A reason is required to switch type.');
  const at = input.at ?? ctx.now;
  const errs = backdateErrors(ctx, at);
  if (ms(at) <= ms(flag.start)) errs.push('The switch must be after the flag started.');
  if (errs.length) return fail(...errs);
  const closed: DownFlag = {
    ...flag,
    state: 'released',
    end: at,
    stages: closeLast(flag.stages, at),
    locations: closeLast(flag.locations, at),
    notes: [flag.notes, `Closed by type switch: ${input.reason}`].filter(Boolean).join('\n'),
  };
  const cs = currentStage(flag);
  const cl = currentLocation(flag);
  const next: DownFlag = {
    id: ctx.newId(),
    tenantId: flag.tenantId,
    siteId: flag.siteId,
    unitId: flag.unitId,
    type: flag.type === 'scheduled' ? 'unscheduled' : 'scheduled',
    state: 'open',
    reasonCode: input.reasonCode ?? flag.reasonCode,
    system: input.system ?? flag.system,
    start: at,
    end: null,
    linkedFromFlagId: flag.id,
    linkKind: 'type_switch',
    stages: cs ? [stageRow(ctx, cs.stage, at, { reason: cs.reason, partOrWorkOrder: cs.partOrWorkOrder })] : [],
    locations: cl ? [{ ...cl, start: at, end: null, setBy: ctx.actor.userId, enteredAt: ctx.now }] : [],
    etas: flag.etas,
    workOrders: flag.workOrders,
    source: 'app',
    setBy: ctx.actor.userId,
    enteredAt: ctx.now,
  };
  return {
    ok: true,
    flags: [closed, next],
    audit: [audit(ctx, 'switch_type_close', flag, closed, input.reason, at), audit(ctx, 'switch_type_open', null, next, input.reason, at)],
    warnings: [],
  };
}

export function closedByTypeSwitch(f: DownFlag, all: DownFlag[]): boolean {
  return all.some((x) => x.linkedFromFlagId === f.id && x.linkKind === 'type_switch');
}

// ---------- T8 ETA ----------

export function setEta(ctx: FlagContext, flag: DownFlag, eta: Iso): CommandResult {
  if (flag.state !== 'open') return fail('Only an open flag takes an ETA.');
  if (!can(ctx.actor, 'set_clear_flag', areaOf(ctx))) return fail('You cannot set the ETA.');
  if (ms(eta) <= ms(flag.start)) return fail('The ETA must be after the flag started.');
  const after: DownFlag = { ...flag, etas: [...flag.etas, { eta, setAt: ctx.now, setBy: ctx.actor.userId }] };
  return { ok: true, flags: [after], audit: [audit(ctx, 'set_eta', flag, after)], warnings: [] };
}

// ---------- T9 release ----------

/** A7 section 6: what the release checklist still needs. Empty means it passes. */
export function releaseChecklist(flag: DownFlag, details: ReleaseDetails): string[] {
  const missing: string[] = [];
  if (flag.type === 'unscheduled') {
    if (!details.system) missing.push('System');
    if (!details.component) missing.push('Component');
    if (!details.failureModes || details.failureModes.length === 0) missing.push('Failure mode');
    if (!details.repairSummary) missing.push('Repair summary');
    if (!details.workOrder && flag.workOrders.length === 0) missing.push('Work order');
  } else {
    if (!details.pmOrWorkOrder && flag.workOrders.length === 0) missing.push('PM or work order');
    if (!details.repairSummary) missing.push('Repair summary');
    if (details.findings === undefined) missing.push('Findings');
  }
  return missing;
}

export function release(ctx: FlagContext, flag: DownFlag, input: { at?: Iso; details: ReleaseDetails; reason?: string }): CommandResult {
  if (flag.state !== 'open') return fail('Only an open flag can be released.');
  if (!can(ctx.actor, 'set_clear_flag', areaOf(ctx))) return fail('You cannot release this unit.');
  const at = input.at ?? ctx.now;
  const errs: string[] = [];
  const cur = currentStage(flag);
  const loc = currentLocation(flag);
  if (!cur || !ctx.rules.releaseFromStages.includes(cur.stage)) errs.push(`Release is allowed only from ${ctx.rules.releaseFromStages.join(' or ')} (S4).`);
  if (loc && !moveAllowed(loc.kind, 'released', ctx.asset.assetClass)) errs.push(`A unit cannot be released while ${loc.kind} (A7 5.2).`);
  if (loc && moveNeedsReason(ctx.rules, loc.kind, 'released') && !input.reason) errs.push('Releasing from here needs a reason.');
  if (ms(at) <= ms(flag.start)) errs.push('End must be after start (R3).');
  if (cur && ms(at) < ms(cur.start)) errs.push('End cannot be before the current stage started.');
  errs.push(...backdateErrors(ctx, at));
  const missing = releaseChecklist(flag, input.details);
  if (missing.length) errs.push(`Release checklist incomplete: ${missing.join(', ')}.`);
  if (errs.length) return fail(...errs);

  let stages = flag.stages;
  // Releasing straight from In repair records a zero-length Ready for release stage (A7 diagram note).
  if (cur?.stage === 'in_repair') stages = [...closeLast(stages, at), { ...stageRow(ctx, 'ready_for_release', at), end: at }];
  else stages = closeLast(stages, at);
  const wo = input.details.workOrder ?? input.details.pmOrWorkOrder;
  const after: DownFlag = {
    ...flag,
    state: 'released',
    end: at,
    system: input.details.system ?? flag.system,
    stages,
    locations: closeLast(flag.locations, at),
    release: input.details,
    workOrders: wo && !flag.workOrders.includes(wo) ? [...flag.workOrders, wo] : flag.workOrders,
    releasedBy: ctx.actor.userId,
  };
  return { ok: true, flags: [after], audit: [audit(ctx, 'release', flag, after, input.reason, at)], warnings: [] };
}

// ---------- T10 void ----------

export function voidFlag(ctx: FlagContext, flag: DownFlag, reason: string): CommandResult {
  if (flag.state !== 'open' && flag.state !== 'released') return fail('Only an open or released flag can be voided.');
  if (!can(ctx.actor, 'void_flag', areaOf(ctx))) return fail('You cannot void this flag.');
  if (!reason) return fail('A reason is required to void.');
  if (ctx.openPeriodStart && ms(flag.start) < ms(ctx.openPeriodStart)) return fail('This flag is in a locked period. Voiding it needs a change request (T10, R5).');
  if (ctx.actor.role === 'supervisor') {
    const cur = shiftAt(ctx.calendar, ctx.now);
    let limit = cur.start;
    // C5: open question, same shift (T10) or previous shift (R4).
    if (ctx.rules.supervisorVoidWindow === 'previous_shift') {
      limit = shiftsBetween(ctx.calendar, toIso(ms(cur.start) - 1), cur.start).at(-1)?.start ?? cur.start;
    }
    if (ms(flag.enteredAt) < ms(limit)) return fail('Supervisors can void flags entered in the current shift only (T10).');
  }
  const after: DownFlag = { ...flag, state: 'voided', voidReason: reason };
  return { ok: true, flags: [after], audit: [audit(ctx, 'void', flag, after, reason)], warnings: [] };
}

// ---------- T11 reopen ----------

export interface ReopenInput {
  at?: Iso;
  reason: string;
  system: string;
  /** SMU hours gained between the release and the reopen, for D6. */
  smuGainedSinceRelease?: number;
}

export function reopen(ctx: FlagContext, flag: DownFlag, input: ReopenInput): CommandResult {
  if (flag.state !== 'released' || !flag.end) return fail('Only a released flag can be reopened.');
  if (!can(ctx.actor, 'set_clear_flag', areaOf(ctx)) || !hasRole(ctx.actor, 'supervisor', 'reliability_engineer')) {
    return fail('Only a supervisor or reliability engineer can reopen a flag (T11).');
  }
  if (!input.reason) return fail('A reason is required to reopen.');
  const at = input.at ?? ctx.now;
  const errs: string[] = [];
  if (openFlagFor(ctx.unitFlags)) errs.push(`${ctx.asset.unitNumber} already has an open flag (R1).`);
  const releasedSystem = flag.release?.system ?? flag.system;
  if (releasedSystem && input.system !== releasedSystem) errs.push('A reopen must be on the same system (T11).');
  if (hoursBetween(flag.end, at) > ctx.rules.reopenWindowHours) errs.push(`The reopen window of ${ctx.rules.reopenWindowHours} h has passed (D3). Start a new flag instead.`);
  if (ms(at) < ms(flag.end)) errs.push('The reopen cannot be before the release.');
  errs.push(...backdateErrors(ctx, at));
  if (errs.length) return fail(...errs);

  // D6: the gap counts as available if the unit ran (SMU rose past the threshold), otherwise downtime.
  const countsAs: 'available' | 'downtime' =
    (input.smuGainedSinceRelease ?? 0) > ctx.rules.reopenGapSmuThresholdHours ? 'available' : 'downtime';
  const lastLoc = currentLocation(flag);

  if (ctx.rules.reopenMode === 'continue_same_flag') {
    const after: DownFlag = {
      ...flag,
      state: 'open',
      end: null,
      falseRelease: true,
      reopenGaps: [...(flag.reopenGaps ?? []), { start: flag.end, end: at, countsAs }],
      stages: [...flag.stages, stageRow(ctx, 'waiting_crew', at)],
      locations: lastLoc ? [...flag.locations, { ...lastLoc, start: at, end: null, setBy: ctx.actor.userId, enteredAt: ctx.now }] : flag.locations,
    };
    return { ok: true, flags: [after], audit: [audit(ctx, 'reopen', flag, after, input.reason, at)], warnings: [] };
  }

  // link_new_flag: the released flag is marked false and a new flag continues it.
  const marked: DownFlag = { ...flag, falseRelease: true };
  const startAt = countsAs === 'downtime' ? flag.end : at;
  const next: DownFlag = {
    id: ctx.newId(),
    tenantId: flag.tenantId,
    siteId: flag.siteId,
    unitId: flag.unitId,
    type: 'unscheduled',
    state: 'open',
    reasonCode: flag.reasonCode,
    system: input.system,
    start: startAt,
    end: null,
    linkedFromFlagId: flag.id,
    linkKind: 'reopen',
    stages: [stageRow(ctx, 'waiting_crew', startAt)],
    locations: lastLoc ? [{ ...lastLoc, start: startAt, end: null, setBy: ctx.actor.userId, enteredAt: ctx.now }] : [],
    etas: [],
    workOrders: flag.workOrders,
    source: 'app',
    setBy: ctx.actor.userId,
    enteredAt: ctx.now,
  };
  return {
    ok: true,
    flags: [marked, next],
    audit: [audit(ctx, 'mark_false_release', flag, marked, input.reason), audit(ctx, 'reopen_linked', null, next, input.reason, at)],
    warnings: [],
  };
}

// ---------- R8 PM overrun ----------

/** True when a scheduled flag has passed its planned duration and the supervisor should be prompted. */
export function pmOverrunDue(flag: DownFlag, now: Iso): boolean {
  if (flag.state !== 'open' || flag.type !== 'scheduled' || !flag.plannedDurationHours) return false;
  return hoursBetween(flag.start, now) > flag.plannedDurationHours;
}
