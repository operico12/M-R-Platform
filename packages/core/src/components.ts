// Component life and rebuilds (phase 3; docs/component-life.md). A component
// is tracked by serial through events that are entered once and never edited.
// Status, hours, lives, warranty and core returns are all worked out from the
// events. Pure functions; the app and the database store what they return.

import { DateTime } from 'luxon';
import type { ConsoleContext } from './console.js';
import { can, permission } from './permissions.js';
import { HOUR_MS, ms } from './time.js';
import type { Asset, AssetLifecycleInterval, AuditEntry, Iso, SmuReading } from './types.js';
import { weibull, type LifeTime, type WeibullFit } from './calculators.js';

// ---------- reference ----------

export type ComponentKind = 'engine' | 'transmission' | 'torque_converter' | 'differential' | 'final_drive' | 'front_strut' | 'rear_strut';

export const COMPONENT_KINDS: ComponentKind[] = ['engine', 'transmission', 'torque_converter', 'differential', 'final_drive', 'front_strut', 'rear_strut'];

export const KIND_LABELS: Record<ComponentKind, string> = {
  engine: 'Engine', transmission: 'Transmission', torque_converter: 'Torque converter', differential: 'Differential',
  final_drive: 'Final drive', front_strut: 'Front strut', rear_strut: 'Rear strut',
};

export interface Position { id: string; label: string; short: string; kind: ComponentKind }

/** Haul truck positions (docs/component-life.md "Positions"). */
export const POSITIONS: Position[] = [
  { id: 'engine', label: 'Engine', short: 'Eng', kind: 'engine' },
  { id: 'transmission', label: 'Transmission', short: 'Trans', kind: 'transmission' },
  { id: 'torque_converter', label: 'Torque converter', short: 'TC', kind: 'torque_converter' },
  { id: 'differential', label: 'Differential', short: 'Diff', kind: 'differential' },
  { id: 'final_drive_lh', label: 'Final drive LH', short: 'FD L', kind: 'final_drive' },
  { id: 'final_drive_rh', label: 'Final drive RH', short: 'FD R', kind: 'final_drive' },
  { id: 'front_strut_lh', label: 'Front strut LH', short: 'FS L', kind: 'front_strut' },
  { id: 'front_strut_rh', label: 'Front strut RH', short: 'FS R', kind: 'front_strut' },
  { id: 'rear_strut_lh', label: 'Rear strut LH', short: 'RS L', kind: 'rear_strut' },
  { id: 'rear_strut_rh', label: 'Rear strut RH', short: 'RS R', kind: 'rear_strut' },
];
export const positionById = (id: string) => POSITIONS.find((p) => p.id === id);

export interface Component {
  id: string;
  serial: string;
  kind: ComponentKind;
  partNumber?: string;
  /** Models it fits; empty means any. */
  models: string[];
  /** Hours since rebuild (or new) when first registered, for a used component. */
  hoursAtEntry: number;
  rebuildsAtEntry: number;
  createdBy: string;
  createdAt: Iso;
}

export type EventKind = 'received' | 'installed' | 'removed' | 'sent_rebuild' | 'returned_rebuild' | 'core_returned' | 'warranty_claim' | 'scrapped';
export type RemovalReason = 'failure' | 'planned' | 'other';
export type ReceivedAs = 'new' | 'exchange' | 'used';
export type ClaimStep = 'opened' | 'accepted' | 'rejected';

export const EVENT_LABELS: Record<EventKind, string> = {
  received: 'Received', installed: 'Installed', removed: 'Removed', sent_rebuild: 'Sent to rebuild', returned_rebuild: 'Back from rebuild',
  core_returned: 'Core returned', warranty_claim: 'Warranty claim', scrapped: 'Scrapped',
};
export const REMOVAL_LABELS: Record<RemovalReason, string> = { failure: 'Failure', planned: 'Planned', other: 'Other (access or swap)' };

export interface ComponentEvent {
  id: string;
  componentId: string;
  kind: EventKind;
  at: Iso;
  unitId?: string;
  position?: string;
  smu?: number;
  reason?: RemovalReason;
  flagId?: string;
  workOrder?: string;
  vendor?: string;
  reference?: string;
  receivedAs?: ReceivedAs;
  /** Purchase or rebuild cost, claim amount, or core credit. Cost roles only. */
  cost?: number;
  warrantyHours?: number;
  warrantyMonths?: number;
  /** Site date the core is due back, for an exchange component. */
  coreDueBy?: string;
  claim?: ClaimStep;
  note?: string;
  enteredBy: string;
  enteredAt: Iso;
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export interface LifeTarget {
  id: string;
  model: string;
  kind: ComponentKind;
  hours: number;
  /** Site date it applies from. */
  effectiveFrom: string;
  reason: string;
  /** The person who asked for it. */
  setBy: string;
  setAt: Iso;
  /** The approval request it came from, and the superintendent who approved it. */
  requestId?: string;
  approvedBy?: string;
}

/** Board colours (docs/component-life.md): below the first is green, below the second amber, then red, then past target. */
export const DEFAULT_LIFE_BANDS: [number, number] = [0.75, 0.9];

export type Ok<T> = { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] };
export type No = { ok: false; errors: string[] };
const no = (...errors: string[]): No => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, entity: 'component' | 'life_target', id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, reason });

// ---------- SMU ----------

export type SmuIndex = Map<string, SmuReading[]>;

export function smuIndex(smu: SmuReading[]): SmuIndex {
  const m: SmuIndex = new Map();
  for (const r of smu) {
    const l = m.get(r.unitId);
    if (l) l.push(r); else m.set(r.unitId, [r]);
  }
  for (const l of m.values()) l.sort((a, b) => ms(a.at) - ms(b.at));
  return m;
}

/** The unit's SMU at a time: the last reading at or before it. */
export function unitSmuAt(idx: SmuIndex, unitId: string, at: Iso): number | undefined {
  const l = idx.get(unitId);
  if (!l?.length) return undefined;
  const t = ms(at);
  let lo = 0;
  let hi = l.length - 1;
  if (ms(l[0]!.at) > t) return undefined;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms(l[mid]!.at) <= t) lo = mid; else hi = mid - 1;
  }
  return l[lo]!.hours;
}

// ---------- replay ----------

export type ComponentStatus = 'in_store' | 'installed' | 'at_rebuild' | 'scrapped' | 'void';

export const STATUS_LABELS: Record<ComponentStatus, string> = { in_store: 'In stores', installed: 'Installed', at_rebuild: 'At rebuild', scrapped: 'Scrapped', void: 'Voided' };

export interface Life {
  componentId: string;
  serial: string;
  kind: ComponentKind;
  /** Model of the last unit it ran on. */
  model?: string;
  start: Iso;
  /** Sent to rebuild or scrapped; null while open. */
  end: Iso | null;
  hours: number;
  /** The last removal in the life was for failure. */
  failed: boolean;
  startedBy: 'received' | 'rebuild';
  /** Rebuild vendor that started the life. */
  vendor?: string;
  cost?: number;
  /** Accepted warranty claims against this life. */
  recovered: number;
  lastUnitId?: string;
}

export interface ComponentState {
  component: Component;
  status: ComponentStatus;
  unitId?: string;
  position?: string;
  installedAt?: Iso;
  installSmu?: number;
  /** Hours since rebuild (or new), now. */
  hours: number;
  rebuilds: number;
  lives: Life[];
  /** Vendor holding it now, or the vendor of the last rebuild. */
  vendor?: string;
  sentAt?: Iso;
  warranty?: { from: Iso; fromHours: number; hours?: number; months?: number };
  /** A failure under warranty with no closing claim. */
  claimDue?: { at: Iso; eventId: string };
  core?: { dueBy: string; returnedAt?: Iso };
  lastEvent?: ComponentEvent;
  events: ComponentEvent[];
}

const active = (e: ComponentEvent) => !e.voidedAt;
const byTime = (a: ComponentEvent, b: ComponentEvent) => ms(a.at) - ms(b.at) || ms(a.enteredAt) - ms(b.enteredAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function underWarranty(w: ComponentState['warranty'], at: Iso, hoursNow: number): boolean {
  if (!w || (w.hours === undefined && w.months === undefined)) return false;
  if (w.hours !== undefined && hoursNow - w.fromHours >= w.hours) return false;
  if (w.months !== undefined && ms(at) >= DateTime.fromISO(w.from, { zone: 'utc' }).plus({ months: w.months }).toMillis()) return false;
  return true;
}

/** Replays one component's events. `modelOf` gives a unit's model; `smuNow` the unit's SMU now. */
export function replay(c: Component, events: ComponentEvent[], modelOf: (unitId: string) => string | undefined, smuNow: (unitId: string) => number | undefined): ComponentState {
  const evs = events.filter((e) => e.componentId === c.id && active(e)).sort(byTime);
  const s: ComponentState = { component: c, status: 'void', hours: c.hoursAtEntry, rebuilds: c.rebuildsAtEntry, lives: [], events: evs };
  let life: Life | undefined;
  let lastRemoval: RemovalReason | undefined;
  let installAt: number | undefined;
  const endLife = (at: Iso) => {
    if (!life) return;
    life.end = at;
    life.hours = s.hours;
    life.failed = lastRemoval === 'failure';
    life = undefined;
  };
  for (const e of evs) {
    s.lastEvent = e;
    switch (e.kind) {
      case 'received':
        if (s.status !== 'void') break;
        s.status = 'in_store';
        life = { componentId: c.id, serial: c.serial, kind: c.kind, start: e.at, end: null, hours: s.hours, failed: false, startedBy: 'received', cost: e.cost, recovered: 0 };
        s.lives.push(life);
        s.warranty = e.warrantyHours !== undefined || e.warrantyMonths !== undefined ? { from: e.at, fromHours: s.hours, hours: e.warrantyHours, months: e.warrantyMonths } : undefined;
        if (e.coreDueBy) s.core = { dueBy: e.coreDueBy };
        break;
      case 'installed':
        s.status = 'installed';
        s.unitId = e.unitId;
        s.position = e.position;
        s.installedAt = e.at;
        s.installSmu = e.smu;
        installAt = e.smu;
        if (life && e.unitId) { life.model = modelOf(e.unitId); life.lastUnitId = e.unitId; }
        break;
      case 'removed':
        if (installAt !== undefined && e.smu !== undefined) s.hours += Math.max(0, e.smu - installAt);
        installAt = undefined;
        if (e.reason === 'failure' || e.reason === 'planned') lastRemoval = e.reason;
        else if (lastRemoval === undefined) lastRemoval = 'other';
        if (e.reason === 'failure' && underWarranty(s.warranty, e.at, s.hours)) s.claimDue = { at: e.at, eventId: e.id };
        s.status = 'in_store';
        s.unitId = undefined;
        s.position = undefined;
        s.installedAt = undefined;
        s.installSmu = undefined;
        if (life) life.hours = s.hours;
        break;
      case 'sent_rebuild':
        endLife(e.at);
        s.status = 'at_rebuild';
        s.vendor = e.vendor;
        s.sentAt = e.at;
        break;
      case 'returned_rebuild':
        s.status = 'in_store';
        s.rebuilds += 1;
        s.hours = 0;
        lastRemoval = undefined;
        life = { componentId: c.id, serial: c.serial, kind: c.kind, start: e.at, end: null, hours: 0, failed: false, startedBy: 'rebuild', vendor: s.vendor, cost: e.cost, recovered: 0 };
        s.lives.push(life);
        s.sentAt = undefined;
        s.warranty = e.warrantyHours !== undefined || e.warrantyMonths !== undefined ? { from: e.at, fromHours: 0, hours: e.warrantyHours, months: e.warrantyMonths } : undefined;
        break;
      case 'core_returned':
        if (s.core) s.core = { ...s.core, returnedAt: e.at };
        break;
      case 'warranty_claim':
        if (e.claim === 'accepted' || e.claim === 'rejected') {
          if (e.claim === 'accepted' && e.cost) {
            // Credit the life that held the failure: the last life that started before it.
            const at = s.claimDue ? ms(s.claimDue.at) : ms(e.at);
            const l = [...s.lives].reverse().find((x) => ms(x.start) <= at);
            if (l) l.recovered += e.cost;
          }
          s.claimDue = undefined;
        }
        break;
      case 'scrapped':
        endLife(e.at);
        s.status = 'scrapped';
        s.unitId = undefined;
        s.position = undefined;
        break;
    }
  }
  if (s.status === 'installed' && s.unitId && installAt !== undefined) {
    const now = smuNow(s.unitId);
    if (now !== undefined) s.hours += Math.max(0, now - installAt);
    if (life) life.hours = s.hours;
  }
  if (life) life.failed = false;
  return s;
}

export function componentStates(components: Component[], events: ComponentEvent[], assets: Asset[], smu: SmuIndex, now: Iso): ComponentState[] {
  const model = new Map(assets.map((a) => [a.id, a.model]));
  const byComp = new Map<string, ComponentEvent[]>();
  for (const e of events) {
    const l = byComp.get(e.componentId);
    if (l) l.push(e); else byComp.set(e.componentId, [e]);
  }
  return components.map((c) => replay(c, byComp.get(c.id) ?? [], (u) => model.get(u), (u) => unitSmuAt(smu, u, now)));
}

// ---------- targets ----------

/** The target that applied on a site date for a model and kind. */
export function lifeTargetFor(targets: LifeTarget[], model: string | undefined, kind: ComponentKind, siteDate: string): LifeTarget | undefined {
  if (!model) return undefined;
  let best: LifeTarget | undefined;
  for (const t of targets) {
    if (t.model !== model || t.kind !== kind || t.effectiveFrom > siteDate) continue;
    if (!best || t.effectiveFrom > best.effectiveFrom || (t.effectiveFrom === best.effectiveFrom && ms(t.setAt) > ms(best.setAt))) best = t;
  }
  return best;
}

export interface LifeTargetInput { model: string; kind: ComponentKind; hours: number; effectiveFrom: string; reason: string }

/** Checks and builds a target life. A reliability engineer asks for it and a superintendent approves it (proposeLifeTarget, decideRequest). */
export function setLifeTarget(ctx: ConsoleContext, targets: LifeTarget[], input: LifeTargetInput): Ok<LifeTarget> | No {
  const p = permission(ctx.actor.role, 'edit_life_targets');
  if (p !== 'propose' && p !== 'approve') return no('Your role cannot set target life.');
  const e: string[] = [];
  if (!input.model.trim()) e.push('Pick the model.');
  if (!COMPONENT_KINDS.includes(input.kind)) e.push('Pick the component kind.');
  if (!(Number.isFinite(input.hours) && input.hours >= 100 && input.hours <= 200000)) e.push('Target life is between 100 and 200,000 hours.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) e.push('Give the date it applies from.');
  if (!input.reason.trim()) e.push('Give a reason.');
  if (e.length) return no(...e);
  const before = lifeTargetFor(targets, input.model.trim(), input.kind, input.effectiveFrom);
  const t: LifeTarget = { id: ctx.newId(), model: input.model.trim(), kind: input.kind, hours: Math.round(input.hours), effectiveFrom: input.effectiveFrom, reason: input.reason.trim(), setBy: ctx.actor.userId, setAt: ctx.now };
  return { ok: true, records: [...targets, t], audit: [log(ctx, 'set_life_target', 'life_target', t.id, before ?? null, t, t.reason)], warnings: [] };
}

// ---------- recording ----------

export interface RegisterInput {
  serial: string;
  kind: ComponentKind;
  partNumber?: string;
  models: string[];
  hoursAtEntry: number;
  rebuildsAtEntry: number;
  at: Iso;
  receivedAs: ReceivedAs;
  vendor?: string;
  cost?: number;
  warrantyHours?: number;
  warrantyMonths?: number;
  coreDueBy?: string;
  note?: string;
}

export interface EventInput {
  kind: Exclude<EventKind, 'received'>;
  at: Iso;
  unitId?: string;
  position?: string;
  smu?: number;
  reason?: RemovalReason;
  flagId?: string;
  workOrder?: string;
  vendor?: string;
  reference?: string;
  cost?: number;
  warrantyHours?: number;
  warrantyMonths?: number;
  claim?: ClaimStep;
  note?: string;
}

export interface ComponentData {
  components: Component[];
  events: ComponentEvent[];
  assets: Asset[];
  smu: SmuIndex;
}

export type RecordResult = No | { ok: true; components: Component[]; events: ComponentEvent[]; audit: AuditEntry[]; warnings: string[] };

const SMU_TOLERANCE = 50;
const clean = (s?: string) => (s?.trim() ? s.trim() : undefined);

function costCheck(ctx: ConsoleContext, cost: number | undefined, e: string[]) {
  if (cost === undefined) return;
  if (permission(ctx.actor.role, 'view_cost') !== 'yes') e.push('Only cost roles enter costs.');
  else if (!(Number.isFinite(cost) && cost >= 0)) e.push('Cost must be 0 or more.');
}
function warrantyCheck(i: { warrantyHours?: number; warrantyMonths?: number }, e: string[]) {
  if (i.warrantyHours !== undefined && !(Number.isFinite(i.warrantyHours) && i.warrantyHours > 0)) e.push('Warranty hours must be above 0.');
  if (i.warrantyMonths !== undefined && !(Number.isInteger(i.warrantyMonths) && i.warrantyMonths > 0 && i.warrantyMonths <= 120)) e.push('Warranty months are a whole number from 1 to 120.');
}

export function registerComponent(ctx: ConsoleContext, data: ComponentData, input: RegisterInput): RecordResult {
  if (!can(ctx.actor, 'record_components')) return no('Your role cannot record components.');
  const e: string[] = [];
  const serial = input.serial.trim().toUpperCase();
  if (!serial) e.push('Enter the serial.');
  if (serial && data.components.some((c) => c.serial === serial && c.kind === input.kind)) e.push(`${KIND_LABELS[input.kind]} ${serial} is already registered.`);
  if (!COMPONENT_KINDS.includes(input.kind)) e.push('Pick the component kind.');
  if (!(Number.isFinite(input.hoursAtEntry) && input.hoursAtEntry >= 0)) e.push('Hours at entry must be 0 or more.');
  if (!(Number.isInteger(input.rebuildsAtEntry) && input.rebuildsAtEntry >= 0)) e.push('Rebuilds at entry must be a whole number, 0 or more.');
  if (input.receivedAs === 'new' && (input.hoursAtEntry > 0 || input.rebuildsAtEntry > 0)) e.push('A new component starts at 0 hours and 0 rebuilds.');
  if (ms(input.at) > ms(ctx.now)) e.push('The date cannot be in the future.');
  if (input.coreDueBy && input.receivedAs !== 'exchange') e.push('Only an exchange component has a core due back.');
  if (input.coreDueBy && !/^\d{4}-\d{2}-\d{2}$/.test(input.coreDueBy)) e.push('Give the core due date as a date.');
  costCheck(ctx, input.cost, e);
  warrantyCheck(input, e);
  if (e.length) return no(...e);
  const c: Component = {
    id: ctx.newId(), serial, kind: input.kind, partNumber: clean(input.partNumber), models: input.models.map((m) => m.trim()).filter(Boolean),
    hoursAtEntry: input.hoursAtEntry, rebuildsAtEntry: input.rebuildsAtEntry, createdBy: ctx.actor.userId, createdAt: ctx.now,
  };
  const ev: ComponentEvent = {
    id: ctx.newId(), componentId: c.id, kind: 'received', at: input.at, receivedAs: input.receivedAs, vendor: clean(input.vendor), cost: input.cost,
    warrantyHours: input.warrantyHours, warrantyMonths: input.warrantyMonths, coreDueBy: input.coreDueBy, note: clean(input.note), enteredBy: ctx.actor.userId, enteredAt: ctx.now,
  };
  return { ok: true, components: [...data.components, c], events: [...data.events, ev], audit: [log(ctx, 'register_component', 'component', c.id, null, { component: c, event: { ...ev, cost: undefined } })], warnings: [] };
}

/** Install intervals of every component, for position checks. */
function occupancy(data: ComponentData, except: string): Array<{ componentId: string; unitId: string; position: string; from: number; to: number | null; smuOut?: number }> {
  const out: Array<{ componentId: string; unitId: string; position: string; from: number; to: number | null; smuOut?: number }> = [];
  const open = new Map<string, (typeof out)[number]>();
  for (const e of data.events.filter(active).sort(byTime)) {
    if (e.componentId === except) continue;
    if (e.kind === 'installed' && e.unitId && e.position) {
      const r = { componentId: e.componentId, unitId: e.unitId, position: e.position, from: ms(e.at), to: null as number | null };
      out.push(r);
      open.set(e.componentId, r);
    } else if (e.kind === 'removed' || e.kind === 'scrapped') {
      const r = open.get(e.componentId);
      if (r) { r.to = ms(e.at); if (e.kind === 'removed') (r as { smuOut?: number }).smuOut = e.smu; open.delete(e.componentId); }
    }
  }
  return out;
}

export function recordEvent(ctx: ConsoleContext, data: ComponentData, componentId: string, input: EventInput): RecordResult {
  if (!can(ctx.actor, 'record_components')) return no('Your role cannot record components.');
  const c = data.components.find((x) => x.id === componentId);
  if (!c) return no('Component not found.');
  const model = new Map(data.assets.map((a) => [a.id, a.model]));
  const st = replay(c, data.events, (u) => model.get(u), (u) => unitSmuAt(data.smu, u, ctx.now));
  const e: string[] = [];
  const w: string[] = [];
  const t = ms(input.at);
  if (!Number.isFinite(t)) return no('Give the date and time.');
  if (t > ms(ctx.now)) e.push('The date cannot be in the future.');
  if (st.lastEvent && t < ms(st.lastEvent.at)) e.push(`It cannot be before the last event (${EVENT_LABELS[st.lastEvent.kind]}).`);
  if (st.status === 'void') e.push('This component has no history; register it again.');
  if (st.status === 'scrapped') e.push('This component is scrapped.');
  costCheck(ctx, input.cost, e);
  const smuCheck = (unitId: string) => {
    if (input.smu === undefined || !(Number.isFinite(input.smu) && input.smu >= 0)) { e.push('Enter the unit SMU hours.'); return; }
    const reading = unitSmuAt(data.smu, unitId, input.at);
    if (reading !== undefined && Math.abs(reading - input.smu) > SMU_TOLERANCE) w.push(`The SMU entered (${input.smu}) is ${Math.round(Math.abs(reading - input.smu))} h from the unit's reading then (${reading}). Check it.`);
  };
  const ev: ComponentEvent = { id: ctx.newId(), componentId, kind: input.kind, at: input.at, enteredBy: ctx.actor.userId, enteredAt: ctx.now, note: clean(input.note) };
  switch (input.kind) {
    case 'installed': {
      const unit = data.assets.find((a) => a.id === input.unitId);
      const pos = positionById(input.position ?? '');
      if (st.status !== 'in_store') e.push(`Only a component in stores can be installed; this one is ${STATUS_LABELS[st.status].toLowerCase()}.`);
      if (!unit) e.push('Pick the unit.');
      if (!pos) e.push('Pick the position.');
      if (pos && pos.kind !== c.kind) e.push(`This ${KIND_LABELS[c.kind].toLowerCase()} cannot go in the ${pos.label.toLowerCase()} position.`);
      if (unit && c.models.length && !c.models.includes(unit.model)) e.push(`This component fits ${c.models.join(', ')}, not ${unit.model}.`);
      if (unit && pos) {
        const occ = occupancy(data, componentId).filter((o) => o.unitId === unit.id && o.position === pos.id);
        if (occ.some((o) => o.to === null || o.to > t)) e.push(`${unit.unitNumber} ${pos.label} is not empty at that time. Remove the component there first.`);
        const prev = occ.filter((o) => o.to !== null && o.to <= t).sort((a, b) => b.to! - a.to!)[0];
        if (prev?.smuOut !== undefined && input.smu !== undefined && input.smu < prev.smuOut) e.push(`The SMU is below the unit's SMU at the last removal from that position (${prev.smuOut}).`);
        smuCheck(unit.id);
      }
      Object.assign(ev, { unitId: unit?.id, position: pos?.id, smu: input.smu, workOrder: clean(input.workOrder) });
      break;
    }
    case 'removed': {
      if (st.status !== 'installed') e.push('Only an installed component can be removed.');
      if (!input.reason) e.push('Give the reason it came off: failure, planned or other.');
      if (st.unitId) smuCheck(st.unitId);
      if (st.installSmu !== undefined && input.smu !== undefined && input.smu < st.installSmu) e.push(`The SMU is below the SMU at install (${st.installSmu}).`);
      if (input.reason === 'failure' && !input.flagId) w.push('Link the down flag, so the failure counts the same everywhere.');
      Object.assign(ev, { unitId: st.unitId, position: st.position, smu: input.smu, reason: input.reason, flagId: clean(input.flagId), workOrder: clean(input.workOrder) });
      break;
    }
    case 'sent_rebuild':
      if (st.status !== 'in_store') e.push('Only a component in stores can be sent to rebuild.');
      if (!clean(input.vendor)) e.push('Name the rebuild vendor.');
      Object.assign(ev, { vendor: clean(input.vendor), reference: clean(input.reference) });
      break;
    case 'returned_rebuild':
      if (st.status !== 'at_rebuild') e.push('Only a component at rebuild can come back from rebuild.');
      warrantyCheck(input, e);
      Object.assign(ev, { vendor: st.vendor, reference: clean(input.reference), cost: input.cost, warrantyHours: input.warrantyHours, warrantyMonths: input.warrantyMonths });
      break;
    case 'core_returned':
      if (!st.core) e.push('This component has no core due back.');
      else if (st.core.returnedAt) e.push('The core is already returned.');
      Object.assign(ev, { reference: clean(input.reference), cost: input.cost });
      break;
    case 'warranty_claim': {
      if (!input.claim) e.push('Say whether the claim is opened, accepted or rejected.');
      const opened = st.events.some((x) => x.kind === 'warranty_claim' && x.claim === 'opened' && (!st.claimDue || ms(x.at) >= ms(st.claimDue.at)));
      if (input.claim && input.claim !== 'opened' && !st.claimDue) e.push('There is no warranty claim waiting on this component.');
      if (input.claim === 'opened' && !st.claimDue) w.push('This failure was not under warranty by the recorded limits.');
      if (input.claim === 'opened' && opened && st.claimDue) e.push('A claim is already open.');
      if (input.claim === 'accepted' && input.cost === undefined && permission(ctx.actor.role, 'view_cost') === 'yes') w.push('Enter the amount recovered, so cost per hour is right.');
      Object.assign(ev, { claim: input.claim, reference: clean(input.reference), cost: input.cost });
      break;
    }
    case 'scrapped':
      if (st.status === 'installed') e.push('Remove it from the unit before scrapping it.');
      if (!clean(input.note)) e.push('Say why it is scrapped.');
      break;
    default:
      e.push('Unknown event.');
  }
  if (e.length) return no(...e);
  const after = replay(c, [...data.events, ev], (u) => model.get(u), (u) => unitSmuAt(data.smu, u, ctx.now));
  if (input.kind === 'removed' && after.claimDue?.eventId === ev.id) w.push('This failure is under warranty: open a warranty claim.');
  return { ok: true, components: data.components, events: [...data.events, ev], audit: [log(ctx, `component_${input.kind}`, 'component', componentId, null, { ...ev, cost: undefined }, ev.note)], warnings: w };
}

/** Voids the component's latest event. Whoever entered it, or a superintendent. */
export function voidEvent(ctx: ConsoleContext, data: ComponentData, eventId: string, reason: string): RecordResult {
  const ev = data.events.find((x) => x.id === eventId);
  if (!ev || ev.voidedAt) return no('Event not found.');
  if (!(ev.enteredBy === ctx.actor.userId && can(ctx.actor, 'record_components')) && ctx.actor.role !== 'superintendent') return no('Only the person who entered it, or a superintendent, voids an event.');
  const latest = data.events.filter((x) => x.componentId === ev.componentId && active(x)).sort(byTime).at(-1);
  if (latest?.id !== ev.id) return no('Only the latest event of a component can be voided. Void the later ones first.');
  if (!reason.trim()) return no('Give a reason.');
  const after: ComponentEvent = { ...ev, voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  return { ok: true, components: data.components, events: data.events.map((x) => (x.id === eventId ? after : x)), audit: [log(ctx, 'void_component_event', 'component', ev.componentId, { ...ev, cost: undefined }, { ...after, cost: undefined }, reason.trim())], warnings: [] };
}

/** Removes costs for roles that may not see them (plan 11.2). The database does the same. */
export const withoutCosts = (events: ComponentEvent[]): ComponentEvent[] => events.map((e) => (e.cost === undefined ? e : { ...e, cost: undefined }));

// ---------- board ----------

export type LifeBand = 'green' | 'amber' | 'red' | 'past' | 'none';

export const bandOf = (ratio: number | null, bands: [number, number] = DEFAULT_LIFE_BANDS): LifeBand =>
  ratio === null ? 'none' : ratio < bands[0] ? 'green' : ratio < bands[1] ? 'amber' : ratio < 1 ? 'red' : 'past';

export interface BoardCell { position: Position; state?: ComponentState; target?: number; ratio: number | null; band: LifeBand }
export interface BoardRow { unit: Asset; cells: BoardCell[] }

export function lifeBoard(states: ComponentState[], assets: Asset[], targets: LifeTarget[], siteDate: string, bands: [number, number] = DEFAULT_LIFE_BANDS): BoardRow[] {
  const at = new Map<string, ComponentState>();
  for (const s of states) if (s.status === 'installed' && s.unitId && s.position) at.set(`${s.unitId}|${s.position}`, s);
  return assets.filter((a) => a.assetClass === 'mobile').map((unit) => ({
    unit,
    cells: POSITIONS.map((position) => {
      const state = at.get(`${unit.id}|${position.id}`);
      const target = lifeTargetFor(targets, unit.model, position.kind, siteDate)?.hours;
      const ratio = state && target ? state.hours / target : null;
      return { position, state, target, ratio, band: bandOf(ratio, bands) };
    }),
  }));
}

// ---------- forecast ----------

export interface BurnRate { unitId: string; perDay: number | null; days: number; source: 'unit' | 'model' | 'parked' | 'none' }

/** SMU hours per site day over the last 28 days (docs/component-life.md "Change-out forecast"). */
export function burnRates(assets: Asset[], smu: SmuIndex, lifecycle: AssetLifecycleInterval[], now: Iso, tz: string, window = 28, minDays = 7): Map<string, BurnRate> {
  const from = DateTime.fromISO(now, { zone: tz }).minus({ days: window }).toMillis();
  const t = ms(now);
  const own = new Map<string, BurnRate>();
  for (const a of assets) {
    const parked = lifecycle.some((l) => l.assetId === a.id && l.status !== 'active' && ms(l.start) <= t && (l.end === null || ms(l.end) > t));
    if (parked) { own.set(a.id, { unitId: a.id, perDay: null, days: 0, source: 'parked' }); continue; }
    const rs = (smu.get(a.id) ?? []).filter((r) => ms(r.at) >= from && ms(r.at) <= t);
    const days = new Set(rs.map((r) => DateTime.fromISO(r.at, { zone: tz }).toISODate())).size;
    if (rs.length < 2 || days < minDays) { own.set(a.id, { unitId: a.id, perDay: null, days, source: 'none' }); continue; }
    const first = rs[0]!;
    const last = rs[rs.length - 1]!;
    const span = (ms(last.at) - ms(first.at)) / (24 * HOUR_MS);
    own.set(a.id, { unitId: a.id, perDay: span > 0 ? Math.max(0, last.hours - first.hours) / span : null, days, source: 'unit' });
  }
  const byModel = new Map<string, number[]>();
  for (const a of assets) {
    const r = own.get(a.id)!;
    if (r.source === 'unit' && r.perDay !== null) byModel.set(a.model, [...(byModel.get(a.model) ?? []), r.perDay]);
  }
  for (const a of assets) {
    const r = own.get(a.id)!;
    if (r.source !== 'none') continue;
    const xs = byModel.get(a.model);
    if (xs?.length) own.set(a.id, { ...r, perDay: xs.reduce((s, x) => s + x, 0) / xs.length, source: 'model' });
  }
  return own;
}

export interface ForecastRow { state: ComponentState; unit: Asset; position: Position; target: number; remaining: number; rate: BurnRate; due: Iso | null; dueNow: boolean }

export function changeoutForecast(states: ComponentState[], assets: Asset[], targets: LifeTarget[], rates: Map<string, BurnRate>, now: Iso, tz: string): ForecastRow[] {
  const unit = new Map(assets.map((a) => [a.id, a]));
  const siteDate = DateTime.fromISO(now, { zone: tz }).toISODate()!;
  const out: ForecastRow[] = [];
  for (const s of states) {
    if (s.status !== 'installed' || !s.unitId || !s.position) continue;
    const u = unit.get(s.unitId);
    const position = positionById(s.position);
    if (!u || !position) continue;
    const target = lifeTargetFor(targets, u.model, position.kind, siteDate)?.hours;
    if (!target) continue;
    const rate = rates.get(u.id) ?? { unitId: u.id, perDay: null, days: 0, source: 'none' as const };
    const remaining = target - s.hours;
    const dueNow = remaining <= 0;
    const due = dueNow ? now : rate.perDay ? new Date(ms(now) + (remaining / rate.perDay) * 24 * HOUR_MS).toISOString() : null;
    out.push({ state: s, unit: u, position, target, remaining, rate, due, dueNow });
  }
  return out.sort((a, b) => (a.due === null ? 1 : 0) - (b.due === null ? 1 : 0) || (a.due && b.due ? ms(a.due) - ms(b.due) : 0));
}

export interface Bucket { label: string; from: Iso; to: Iso; byKind: Partial<Record<ComponentKind, number>>; total: number }

/** Change-outs per site week (Monday start) or site month, from this one on. Past-target ones fall in the first. */
export function forecastBuckets(rows: ForecastRow[], now: Iso, tz: string, unit: 'week' | 'month', n: number): Bucket[] {
  const start = DateTime.fromISO(now, { zone: tz }).startOf(unit === 'week' ? 'week' : 'month');
  const buckets: Bucket[] = Array.from({ length: n }, (_, i) => {
    const a = start.plus(unit === 'week' ? { weeks: i } : { months: i });
    const b = a.plus(unit === 'week' ? { weeks: 1 } : { months: 1 });
    return { label: unit === 'week' ? `w/c ${a.toFormat('d LLL')}` : a.toFormat('LLL yyyy'), from: a.toUTC().toISO()!, to: b.toUTC().toISO()!, byKind: {}, total: 0 };
  });
  for (const r of rows) {
    if (!r.due) continue;
    const t = ms(r.due);
    const b = buckets.find((x) => t < ms(x.to));
    if (!b) continue;
    b.byKind[r.position.kind] = (b.byKind[r.position.kind] ?? 0) + 1;
    b.total += 1;
  }
  return buckets;
}

// ---------- lives, Weibull, KPIs ----------

export const allLives = (states: ComponentState[]): Life[] => states.flatMap((s) => (s.status === 'void' ? [] : s.lives));

/** C-05 input: failed lives are failures; planned removals and open lives are suspensions. */
export function lifeTimes(lives: Life[], kind: ComponentKind, model?: string): LifeTime[] {
  return lives.filter((l) => l.kind === kind && (!model || l.model === model) && l.hours > 0).map((l) => ({ t: l.hours, failed: l.end !== null && l.failed }));
}

export function fitKind(lives: Life[], kind: ComponentKind, model?: string): { fit: WeibullFit | null; data: LifeTime[]; error?: string } {
  const data = lifeTimes(lives, kind, model);
  try { return { fit: weibull(data), data }; } catch (err) { return { fit: null, data, error: (err as Error).message }; }
}

/** Chance a component now at `hours` fails before reaching `target`: 1 − R(target − hours | hours). Null when already past target. */
export function riskBeforeTarget(beta: number, eta: number, hours: number, target: number): number | null {
  if (hours >= target) return null;
  return 1 - Math.exp(-((target / eta) ** beta) + (hours / eta) ** beta);
}

const siteDateOf = (at: Iso, tz: string) => DateTime.fromISO(at, { zone: tz }).toISODate()!;

export interface LifeRatioResult {
  ended: number;
  noTarget: number;
  failures: { n: number; mean: number | null };
  planned: { n: number; mean: number | null };
  reachingTarget: number | null;
  early: number;
}

/** KPI-030 over lives that ended in [from, to). */
export function lifeRatio(lives: Life[], targets: LifeTarget[], from: Iso, to: Iso, tz: string): LifeRatioResult {
  const ended = lives.filter((l) => l.end !== null && ms(l.end) >= ms(from) && ms(l.end) < ms(to));
  const rows = ended.map((l) => {
    const t = lifeTargetFor(targets, l.model, l.kind, siteDateOf(l.end!, tz));
    return { l, r: t ? l.hours / t.hours : null };
  });
  const withT = rows.filter((x) => x.r !== null) as Array<{ l: Life; r: number }>;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const f = withT.filter((x) => x.l.failed).map((x) => x.r);
  const p = withT.filter((x) => !x.l.failed).map((x) => x.r);
  return {
    ended: ended.length, noTarget: rows.length - withT.length,
    failures: { n: f.length, mean: mean(f) }, planned: { n: p.length, mean: mean(p) },
    reachingTarget: withT.length ? withT.filter((x) => x.r >= 1).length / withT.length : null,
    early: f.filter((r) => r < 0.25).length,
  };
}

/** KPI-031: (cost that started each life − recovered) ÷ hours, over ended lives with a cost. */
export function costPerLifeHour(lives: Life[]): { perHour: number | null; lives: number; hours: number; cost: number } {
  const xs = lives.filter((l) => l.end !== null && l.cost !== undefined && l.hours > 0);
  const cost = xs.reduce((s, l) => s + l.cost! - l.recovered, 0);
  const hours = xs.reduce((s, l) => s + l.hours, 0);
  return { perHour: hours > 0 ? cost / hours : null, lives: xs.length, hours, cost };
}

export interface VendorRow {
  vendor: string;
  sent: number;
  returned: number;
  atVendor: number;
  turnaroundDays: number | null;
  ended: number;
  meanLife: number | null;
  meanRatio: number | null;
  early: number;
  costPerHour: number | null;
}

/** Rebuild vendor table; life statistics only with at least `min` ended lives. */
export function vendorStats(states: ComponentState[], targets: LifeTarget[], tz: string, min = 3): VendorRow[] {
  const m = new Map<string, { sent: number; returned: number; atVendor: number; turn: number[]; lives: Life[] }>();
  const get = (v: string) => m.get(v) ?? (m.set(v, { sent: 0, returned: 0, atVendor: 0, turn: [], lives: [] }), m.get(v)!);
  for (const s of states) {
    let sent: ComponentEvent | undefined;
    for (const e of s.events) {
      if (e.kind === 'sent_rebuild' && e.vendor) { get(e.vendor).sent += 1; sent = e; }
      if (e.kind === 'returned_rebuild' && sent?.vendor) {
        const v = get(sent.vendor);
        v.returned += 1;
        v.turn.push((ms(e.at) - ms(sent.at)) / (24 * HOUR_MS));
        sent = undefined;
      }
    }
    if (s.status === 'at_rebuild' && s.vendor) get(s.vendor).atVendor += 1;
    for (const l of s.lives) if (l.vendor && l.end !== null) get(l.vendor).lives.push(l);
  }
  return [...m.entries()].map(([vendor, v]) => {
    const enough = v.lives.length >= min;
    const ratios = v.lives.map((l) => { const t = lifeTargetFor(targets, l.model, l.kind, siteDateOf(l.end!, tz)); return t ? { r: l.hours / t.hours, failed: l.failed } : null; }).filter((x): x is { r: number; failed: boolean } => x !== null);
    const c = costPerLifeHour(v.lives);
    return {
      vendor, sent: v.sent, returned: v.returned, atVendor: v.atVendor,
      turnaroundDays: v.turn.length ? v.turn.reduce((s, x) => s + x, 0) / v.turn.length : null,
      ended: v.lives.length,
      meanLife: enough ? v.lives.reduce((s, l) => s + l.hours, 0) / v.lives.length : null,
      meanRatio: enough && ratios.length ? ratios.reduce((s, x) => s + x.r, 0) / ratios.length : null,
      early: ratios.filter((x) => x.failed && x.r < 0.25).length,
      costPerHour: enough ? c.perHour : null,
    };
  }).sort((a, b) => b.sent - a.sent || a.vendor.localeCompare(b.vendor));
}

// ---------- lists ----------

export const warrantyClaims = (states: ComponentState[]) => states.filter((s) => s.claimDue).sort((a, b) => ms(a.claimDue!.at) - ms(b.claimDue!.at));

export function coresOutstanding(states: ComponentState[], now: Iso, tz: string): Array<{ state: ComponentState; dueBy: string; overdue: boolean }> {
  const today = siteDateOf(now, tz);
  return states.filter((s) => s.core && !s.core.returnedAt && s.status !== 'void')
    .map((s) => ({ state: s, dueBy: s.core!.dueBy, overdue: s.core!.dueBy < today }))
    .sort((a, b) => a.dueBy.localeCompare(b.dueBy));
}

/** Mean life of ended lives by how they started, for C-11's defaults. Needs at least `min` lives. */
export function meanLives(lives: Life[], kind: ComponentKind, model: string | undefined, min = 3): { rebuilt: number | null; fresh: number | null } {
  const ended = lives.filter((l) => l.kind === kind && (!model || l.model === model) && l.end !== null && l.hours > 0);
  const avg = (xs: Life[]) => (xs.length >= min ? xs.reduce((s, l) => s + l.hours, 0) / xs.length : null);
  return { rebuilt: avg(ended.filter((l) => l.startedBy === 'rebuild')), fresh: avg(ended.filter((l) => l.startedBy === 'received')) };
}
