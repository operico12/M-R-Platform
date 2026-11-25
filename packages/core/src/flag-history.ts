// Flag history (docs/flag-history.md): where a down flag's time went, and what changed on it.
// Calculated from the timed stage and location intervals, the wait tags and the audit log; nothing
// is stored separately (rules 4 and 5). Pure functions.

import { auditDiff, type AuditRecord } from './audit.js';
import { lineName } from './flags.js';
import { HOUR_MS, ms, overlapHours } from './time.js';
import { LOCATION_LABELS, STAGE_LABELS, type DownFlag, type Iso, type LocationKind, type ShopLine, type Stage } from './types.js';
import type { WaitTag } from './waits.js';

// ---------- time breakdown ----------

export interface TimedStep {
  label: string;
  start: Iso;
  end: Iso | null;
  hours: number;
  by: string;
}

export interface FlagBreakdown {
  downHours: number;
  inRepairHours: number;
  /** Down minus In repair: the "Waiting" column. */
  notInRepairHours: number;
  /** Flag start to the first In repair, as KPI-010. Null when none yet, or when the flag continues an earlier one (a type switch). */
  firstWrenchHours: number | null;
  byStage: Array<{ stage: Stage; label: string; hours: number }>;
  byLocationKind: Array<{ kind: LocationKind; label: string; hours: number }>;
  byLine: Array<{ lineId: string; label: string; hours: number }>;
  /** Hours for each wait tag kind that was on during the flag; kinds can overlap. */
  byWait: Array<{ kind: string; hours: number }>;
  /** Hours with at least one wait tag open, counted once. */
  waitingOnSomethingHours: number;
  moves: TimedStep[];
  stages: TimedStep[];
}

const hoursOf = (start: Iso, end: Iso | null, flag: DownFlag, now: Iso) => overlapHours(start, end ?? flag.end ?? now, flag.start, flag.end ?? now, now);

export function flagBreakdown(flag: DownFlag, waits: WaitTag[], lines: ShopLine[], now: Iso): FlagBreakdown {
  const stop = flag.end ?? now;
  const downHours = Math.max(0, (ms(stop) - ms(flag.start)) / HOUR_MS);

  const stage = new Map<Stage, number>();
  for (const s of flag.stages) stage.set(s.stage, (stage.get(s.stage) ?? 0) + hoursOf(s.start, s.end, flag, now));
  const byStage = [...stage].map(([k, hours]) => ({ stage: k, label: STAGE_LABELS[k], hours })).sort((a, b) => b.hours - a.hours);
  const inRepairHours = stage.get('in_repair') ?? 0;

  const kind = new Map<LocationKind, number>();
  const line = new Map<string, number>();
  for (const l of flag.locations) {
    const h = hoursOf(l.start, l.end, flag, now);
    kind.set(l.kind, (kind.get(l.kind) ?? 0) + h);
    if (l.kind === 'shop_line' && l.shopLineId) line.set(l.shopLineId, (line.get(l.shopLineId) ?? 0) + h);
  }
  const byLocationKind = [...kind].map(([k, hours]) => ({ kind: k, label: LOCATION_LABELS[k], hours })).sort((a, b) => b.hours - a.hours);
  const lineLabel = (id: string) => { const l = lines.find((x) => x.id === id); return l ? lineName(l) : id; };
  const byLine = [...line].map(([lineId, hours]) => ({ lineId, label: lineLabel(lineId), hours })).sort((a, b) => b.hours - a.hours);

  // Wait tags on this flag, not voided, clipped to the flag.
  const mine = waits.filter((w) => w.downFlagId === flag.id && w.state !== 'voided');
  const wait = new Map<string, number>();
  const cuts: Array<[number, number]> = [];
  for (const w of mine) {
    const end = w.end ?? stop;
    const a = Math.max(ms(w.start), ms(flag.start));
    const b = Math.min(ms(end), ms(stop));
    if (b <= a) continue;
    wait.set(w.kind, (wait.get(w.kind) ?? 0) + (b - a) / HOUR_MS);
    cuts.push([a, b]);
  }
  cuts.sort((x, y) => x[0] - y[0]);
  let union = 0;
  let cur: [number, number] | null = null;
  for (const c of cuts) {
    if (cur && c[0] <= cur[1]) cur[1] = Math.max(cur[1], c[1]);
    else { if (cur) union += cur[1] - cur[0]; cur = [c[0], c[1]]; }
  }
  if (cur) union += cur[1] - cur[0];
  const byWait = [...wait].map(([k, hours]) => ({ kind: k, hours })).sort((a, b) => b.hours - a.hours);

  const moves: TimedStep[] = flag.locations.map((l) => ({
    label: l.kind === 'shop_line' && l.shopLineId ? lineLabel(l.shopLineId) : l.kind === 'field' && l.fieldLocation ? `${LOCATION_LABELS.field}: ${l.fieldLocation}` : LOCATION_LABELS[l.kind],
    start: l.start, end: l.end, hours: hoursOf(l.start, l.end, flag, now), by: l.setBy,
  }));
  const stages: TimedStep[] = flag.stages.map((s) => ({ label: STAGE_LABELS[s.stage], start: s.start, end: s.end, hours: hoursOf(s.start, s.end, flag, now), by: s.setBy }));

  return {
    downHours, inRepairHours, notInRepairHours: Math.max(0, downHours - inRepairHours), firstWrenchHours: firstWrench(flag),
    byStage, byLocationKind, byLine, byWait, waitingOnSomethingHours: union / HOUR_MS, moves, stages,
  };
}

function firstWrench(flag: DownFlag): number | null {
  if (flag.linkedFromFlagId) return null;
  const first = flag.stages.find((s) => s.stage === 'in_repair');
  return first ? Math.max(0, (ms(first.start) - ms(flag.start)) / HOUR_MS) : null;
}

// ---------- change log ----------

export interface FlagChange {
  at: Iso;
  effectiveAt?: Iso;
  userId: string;
  action: string;
  reason?: string;
  field: string;
  label: string;
  before: string;
  after: string;
}

const FIELD_LABELS: Array<[string, string]> = [
  ['type', 'Type'], ['reasonCode', 'Reason'], ['system', 'System'],
  ['release.system', 'System (release)'], ['release.component', 'Component'], ['release.failureModes', 'Failure modes'],
  ['release.repairSummary', 'Repair summary'], ['release.workOrder', 'Work order'], ['release.pmOrWorkOrder', 'PM or work order'],
  ['release.findings', 'Findings'], ['release.causeCode', 'Cause code'], ['release.detectionMethod', 'Detected by'], ['release.smuAtFailure', 'SMU at failure'],
  ['workOrders', 'Work orders'], ['plannedDurationHours', 'Planned hours'], ['notes', 'Notes'], ['state', 'State'], ['voidReason', 'Void reason'], ['eta', 'ETA'],
];

const text = (v: unknown): string => (v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The flag's tracked fields, flattened to text. The ETA is the latest one set. */
function flatten(f: unknown): Record<string, string> {
  if (!f || typeof f !== 'object') return {};
  const o = f as Partial<DownFlag> & Record<string, unknown>;
  const out: Record<string, string> = {};
  const rel = (o.release ?? {}) as Record<string, unknown>;
  for (const [key] of FIELD_LABELS) {
    if (key === 'eta') out[key] = text(o.etas?.length ? o.etas[o.etas.length - 1]!.eta : '');
    else if (key.startsWith('release.')) out[key] = text(rel[key.slice(8)]);
    else out[key] = text(o[key]);
  }
  return out;
}

/**
 * Every recorded change to one down flag, oldest first, from the app's own audit entries (the database's row
 * changes carry the same facts without the action and reason, so they are left out). A new flag lists what it
 * was raised with. Changes to stage and location intervals show as moves, not fields.
 */
export function flagChanges(audit: AuditRecord[], flagId: string): FlagChange[] {
  const out: FlagChange[] = [];
  for (const r of [...audit].filter((x) => x.entity === 'down_flag' && x.entityId === flagId).sort((a, b) => ms(a.at) - ms(b.at))) {
    const before = flatten(r.before);
    const after = flatten(r.after);
    for (const c of auditDiff(before, after)) {
      const label = FIELD_LABELS.find(([k]) => k === c.field)?.[1] ?? c.field;
      const b = text(c.before);
      const a = text(c.after);
      if (b === a) continue;
      out.push({ at: r.at, ...(r.effectiveAt ? { effectiveAt: r.effectiveAt } : {}), userId: r.userId, action: r.action, ...(r.reason ? { reason: r.reason } : {}), field: c.field, label, before: b, after: a });
    }
  }
  return out;
}

/** Audit entries for one flag are fetched for its dates plus a day either side. */
export function flagAuditRange(flag: Pick<DownFlag, 'start' | 'end'>, now: Iso): { from: Iso; to: Iso } {
  const day = 24 * HOUR_MS;
  return { from: new Date(ms(flag.start) - day).toISOString(), to: new Date(ms(flag.end ?? now) + 2 * day).toISOString() };
}
