// Plant shutdowns (phase 3b part 2, docs/fixed-plant.md "Shutdowns"; KPI-039 to
// KPI-041). A shutdown has a plan, a scope of work orders with a freeze time,
// and an actual start and end. Starting raises scheduled down flags through the
// flag commands; ending releases them. Work orders stay in the ERP: a scope work
// order is done when the import shows it closed. Nothing is deleted.

import type { ConsoleContext, ConsoleResult } from './console.js';
import { changeStage, currentStage, flagDown, openFlagFor, release, type FlagContext } from './flags.js';
import { normaliseWoNumber } from './imports.js';
import { can } from './permissions.js';
import { equipmentUnder, type PlantTree } from './plant.js';
import { HOUR_MS, ms } from './time.js';
import { readiness } from './work.js';
import type { Asset, AuditEntry, DownFlag, Iso, WorkOrder, WorkReadiness } from './types.js';

export interface ScopeItem {
  id: string;
  /** Normalised work order number. */
  workOrder: string;
  addedAt: Iso;
  addedBy: string;
  /** Added after the scope freeze (work added, KPI-041). */
  late: boolean;
  reason?: string;
  removedAt?: Iso;
  removedBy?: string;
  removedReason?: string;
}

export interface Shutdown {
  id: string;
  tenantId: string;
  siteId: string;
  /** The plant, area or circuit shut down. */
  nodeId: string;
  name: string;
  /** The ERP's master work order for the shutdown. */
  workOrder: string;
  plannedStart: Iso;
  plannedEnd: Iso;
  freezeAt: Iso;
  /** Equipment taking part: each gets a scheduled flag when it starts. */
  equipmentIds: string[];
  scope: ScopeItem[];
  actualStart?: Iso;
  actualEnd?: Iso;
  /** Flags raised when it started. */
  flagIds: string[];
  findings?: string;
  createdBy: string;
  createdAt: Iso;
  cancelledAt?: Iso;
  cancelledBy?: string;
  cancelReason?: string;
}

export type ShutdownStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled';

export const SHUTDOWN_STATUS_LABELS: Record<ShutdownStatus, string> = { planned: 'Planned', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };

export function shutdownStatus(s: Shutdown): ShutdownStatus {
  if (s.cancelledAt) return 'cancelled';
  if (s.actualEnd) return 'completed';
  if (s.actualStart) return 'in_progress';
  return 'planned';
}

type R = ConsoleResult<Shutdown>;
const refuse = (...errors: string[]): R => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity: 'shutdown', entityId: id, before, after, reason });
const NO_ROLE = 'Your role cannot plan or run shutdowns.';

export interface PlanInput {
  nodeId: string;
  name: string;
  workOrder: string;
  plannedStart: Iso;
  plannedEnd: Iso;
  /** Default: freezeDays before the planned start. */
  freezeAt?: Iso;
  equipmentIds: string[];
}

function planErrors(input: PlanInput, tree: PlantTree): string[] {
  const e: string[] = [];
  if (!input.name.trim() || input.name.trim().length > 100) e.push('Name the shutdown (1 to 100 characters).');
  if (!tree.byId.get(input.nodeId)) e.push('Pick the plant, area or circuit.');
  else if (tree.byId.get(input.nodeId)!.node.kind === 'group') e.push('Pick a plant, area or circuit, not a redundancy group.');
  if (!input.workOrder.trim()) e.push('Give the master work order.');
  if (!(ms(input.plannedStart) > 0) || !(ms(input.plannedEnd) > 0)) e.push('Give the planned start and end.');
  else if (ms(input.plannedEnd) <= ms(input.plannedStart)) e.push('The planned end is after the planned start.');
  else if (ms(input.plannedEnd) - ms(input.plannedStart) > 60 * 24 * HOUR_MS) e.push('A shutdown is planned for 60 days or less.');
  if (input.freezeAt && ms(input.freezeAt) > ms(input.plannedStart)) e.push('The scope freeze is at or before the planned start.');
  const allowed = new Set(equipmentUnder(tree, input.nodeId));
  if (!input.equipmentIds.length) e.push('Pick the equipment taking part.');
  if (input.equipmentIds.some((id) => !allowed.has(id))) e.push('Only equipment under the node can take part.');
  return e;
}

export function planShutdown(ctx: ConsoleContext, tree: PlantTree, site: { tenantId: string; siteId: string }, input: PlanInput, freezeDays = 7): R {
  if (!can(ctx.actor, 'run_shutdowns')) return refuse(NO_ROLE);
  const e = planErrors(input, tree);
  if (e.length) return { ok: false, errors: e };
  const s: Shutdown = {
    id: ctx.newId(), tenantId: site.tenantId, siteId: site.siteId, nodeId: input.nodeId, name: input.name.trim(), workOrder: input.workOrder.trim(),
    plannedStart: input.plannedStart, plannedEnd: input.plannedEnd, freezeAt: input.freezeAt ?? new Date(ms(input.plannedStart) - freezeDays * 24 * HOUR_MS).toISOString(),
    equipmentIds: [...new Set(input.equipmentIds)], scope: [], flagIds: [], createdBy: ctx.actor.userId, createdAt: ctx.now,
  };
  return { ok: true, records: [s], audit: [log(ctx, 'plan_shutdown', s.id, null, s)], warnings: ms(s.plannedStart) < ms(ctx.now) ? ['The planned start is in the past.'] : [] };
}

/** Change the plan before it starts. */
export function changePlan(ctx: ConsoleContext, tree: PlantTree, s: Shutdown, input: PlanInput, reason: string): R {
  if (!can(ctx.actor, 'run_shutdowns')) return refuse(NO_ROLE);
  if (shutdownStatus(s) !== 'planned') return refuse('The plan can change only before the shutdown starts.');
  if (input.nodeId !== s.nodeId) return refuse('The node cannot change. Cancel it and plan a new one.');
  const e = planErrors({ ...input, freezeAt: input.freezeAt ?? s.freezeAt }, tree);
  if (!reason.trim()) e.push('Give a reason.');
  if (e.length) return { ok: false, errors: e };
  const after: Shutdown = {
    ...s, name: input.name.trim(), workOrder: input.workOrder.trim(), plannedStart: input.plannedStart, plannedEnd: input.plannedEnd,
    freezeAt: input.freezeAt ?? s.freezeAt, equipmentIds: [...new Set(input.equipmentIds)],
  };
  return { ok: true, records: [after], audit: [log(ctx, 'change_shutdown_plan', s.id, s, after, reason.trim())], warnings: [] };
}

export function cancelShutdown(ctx: ConsoleContext, s: Shutdown, reason: string): R {
  if (!can(ctx.actor, 'run_shutdowns')) return refuse(NO_ROLE);
  if (shutdownStatus(s) !== 'planned') return refuse('Only a shutdown that has not started can be cancelled.');
  if (!reason.trim()) return refuse('Give a reason.');
  const after: Shutdown = { ...s, cancelledAt: ctx.now, cancelledBy: ctx.actor.userId, cancelReason: reason.trim() };
  return { ok: true, records: [after], audit: [log(ctx, 'cancel_shutdown', s.id, s, after, reason.trim())], warnings: [] };
}

// ---------- scope ----------

export const activeScope = (s: Shutdown) => s.scope.filter((x) => !x.removedAt);

export function addScope(ctx: ConsoleContext, s: Shutdown, workOrders: string[], reason = ''): R {
  if (!can(ctx.actor, 'run_shutdowns')) return refuse(NO_ROLE);
  const st = shutdownStatus(s);
  if (st === 'completed' || st === 'cancelled') return refuse('Nothing is added once a shutdown has ended or been cancelled.');
  const nums = [...new Set(workOrders.map((w) => normaliseWoNumber(w)).filter(Boolean))];
  if (!nums.length) return refuse('Give at least one work order number.');
  const late = ms(ctx.now) > ms(s.freezeAt);
  if (late && !reason.trim()) return refuse('The scope is frozen, so work added needs a reason.');
  const have = new Set(activeScope(s).map((x) => x.workOrder));
  const fresh = nums.filter((n) => !have.has(n));
  const warnings = nums.filter((n) => have.has(n)).map((n) => `${n} is already in scope.`);
  if (!fresh.length) return refuse(...warnings);
  const added: ScopeItem[] = fresh.map((n) => ({ id: ctx.newId(), workOrder: n, addedAt: ctx.now, addedBy: ctx.actor.userId, late, ...(reason.trim() ? { reason: reason.trim() } : {}) }));
  const after: Shutdown = { ...s, scope: [...s.scope, ...added] };
  return { ok: true, records: [after], audit: [log(ctx, late ? 'add_shutdown_work_late' : 'add_shutdown_scope', s.id, null, added, reason.trim() || undefined)], warnings };
}

export function removeScope(ctx: ConsoleContext, s: Shutdown, scopeId: string, reason: string): R {
  if (!can(ctx.actor, 'run_shutdowns')) return refuse(NO_ROLE);
  const st = shutdownStatus(s);
  if (st === 'completed' || st === 'cancelled') return refuse('The scope is fixed once a shutdown has ended or been cancelled.');
  const item = s.scope.find((x) => x.id === scopeId);
  if (!item || item.removedAt) return refuse('That work order is not in scope.');
  if (!reason.trim()) return refuse('Give a reason.');
  const gone: ScopeItem = { ...item, removedAt: ctx.now, removedBy: ctx.actor.userId, removedReason: reason.trim() };
  const after: Shutdown = { ...s, scope: s.scope.map((x) => (x.id === scopeId ? gone : x)) };
  return { ok: true, records: [after], audit: [log(ctx, 'remove_shutdown_scope', s.id, item, gone, reason.trim())], warnings: [] };
}

/** Open work orders on the shutdown's equipment that look like shutdown work and are not in scope yet. */
export function scopeCandidates(s: Shutdown, wos: WorkOrder[], map?: Record<string, WorkReadiness>): WorkOrder[] {
  const eq = new Set(s.equipmentIds);
  const have = new Set(activeScope(s).map((x) => x.workOrder));
  const from = ms(s.plannedStart) - 24 * HOUR_MS;
  const to = ms(s.plannedEnd);
  const inWindow = (t?: Iso) => !!t && ms(t) >= from && ms(t) <= to;
  return wos
    .filter((w) => w.open && w.assetId && eq.has(w.assetId) && !have.has(w.numberNormalised))
    .filter((w) => readiness(w, map) === 'waiting_shutdown' || inWindow(w.targetStart) || inWindow(w.scheduledStart))
    .sort((a, b) => a.number.localeCompare(b.number));
}

// ---------- start and end ----------

export interface RunResult {
  ok: true;
  shutdown: Shutdown;
  flags: DownFlag[];
  audit: AuditEntry[];
  warnings: string[];
}
export type RunOutcome = RunResult | { ok: false; errors: string[] };

/**
 * Records the actual start and raises a scheduled flag, In place, on each equipment taking part,
 * moved to In repair. Equipment that already has an open flag keeps it.
 */
export function startShutdown(
  ctx: ConsoleContext, s: Shutdown, equipment: Asset[], ctxFor: (a: Asset) => FlagContext, input: { at: Iso; reasonCode: string },
): RunOutcome {
  if (!can(ctx.actor, 'run_shutdowns')) return { ok: false, errors: [NO_ROLE] };
  if (shutdownStatus(s) !== 'planned') return { ok: false, errors: ['Only a planned shutdown can start.'] };
  if (ms(input.at) > ms(ctx.now)) return { ok: false, errors: ['The start cannot be in the future (R3).'] };
  if (!input.reasonCode) return { ok: false, errors: ['Pick the reason code for the shutdown flags.'] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const flags: DownFlag[] = [];
  const audit: AuditEntry[] = [];
  const plannedH = Math.round(((ms(s.plannedEnd) - ms(s.plannedStart)) / HOUR_MS) * 10) / 10;
  for (const id of s.equipmentIds) {
    const a = equipment.find((x) => x.id === id);
    if (!a) { warnings.push(`Equipment ${id} is no longer at the site; skipped.`); continue; }
    const fctx = ctxFor(a);
    if (openFlagFor(fctx.unitFlags)) { warnings.push(`${a.unitNumber} already has an open flag; it carries on.`); continue; }
    const d = flagDown(fctx, {
      type: 'scheduled', reasonCode: input.reasonCode, start: input.at, location: { kind: 'in_place', functionalLocation: a.functionalLocation },
      plannedDurationHours: plannedH, workOrders: [s.workOrder], notes: `Shutdown: ${s.name}`,
    });
    if (!d.ok) { errors.push(...d.errors.map((x) => `${a.unitNumber}: ${x}`)); continue; }
    let f = d.flags[0]!;
    audit.push(...d.audit);
    if (currentStage(f)?.stage !== 'in_repair') {
      const c = changeStage({ ...fctx, unitFlags: [...fctx.unitFlags, f] }, f, { stage: 'in_repair', at: input.at });
      if (c.ok) { f = c.flags[0]!; audit.push(...c.audit); } else warnings.push(`${a.unitNumber}: ${c.errors.join(' ')}`);
    }
    flags.push(f);
  }
  if (errors.length) return { ok: false, errors };
  const after: Shutdown = { ...s, actualStart: input.at, flagIds: flags.map((f) => f.id) };
  audit.push(log(ctx, 'start_shutdown', s.id, s, after));
  return { ok: true, shutdown: after, flags, audit, warnings };
}

/** Records the actual end and releases each shutdown flag still open. */
export function endShutdown(
  ctx: ConsoleContext, s: Shutdown, equipment: Asset[], flags: DownFlag[], ctxFor: (a: Asset) => FlagContext, input: { at: Iso; findings: string },
): RunOutcome {
  if (!can(ctx.actor, 'run_shutdowns')) return { ok: false, errors: [NO_ROLE] };
  if (shutdownStatus(s) !== 'in_progress') return { ok: false, errors: ['Only a shutdown in progress can end.'] };
  if (ms(input.at) > ms(ctx.now)) return { ok: false, errors: ['The end cannot be in the future (R3).'] };
  if (ms(input.at) <= ms(s.actualStart!)) return { ok: false, errors: ['The end is after the start.'] };
  const out: DownFlag[] = [];
  const audit: AuditEntry[] = [];
  const warnings: string[] = [];
  for (const id of s.flagIds) {
    const f = flags.find((x) => x.id === id);
    if (!f || f.state !== 'open') continue;
    const a = equipment.find((x) => x.id === f.unitId);
    if (!a) continue;
    const r = release(ctxFor(a), f, { at: input.at, details: { pmOrWorkOrder: s.workOrder, repairSummary: `Shutdown ${s.name} complete`, findings: input.findings.trim() } });
    if (r.ok) { out.push(...r.flags); audit.push(...r.audit); } else warnings.push(`${a.unitNumber} is still down: ${r.errors.join(' ')}`);
  }
  const after: Shutdown = { ...s, actualEnd: input.at, ...(input.findings.trim() ? { findings: input.findings.trim() } : {}) };
  audit.push(log(ctx, 'end_shutdown', s.id, s, after));
  return { ok: true, shutdown: after, flags: out, audit, warnings };
}

// ---------- report (KPI-039 to KPI-041) ----------

export type ScopeState = 'done' | 'open' | 'not_imported';

export interface ScopeRow {
  item: ScopeItem;
  wo?: WorkOrder;
  state: ScopeState;
}

export interface ShutdownReport {
  status: ShutdownStatus;
  plannedHours: number;
  /** To now while it runs. */
  actualHours: number | null;
  /** KPI-039: actual ÷ planned. */
  ofPlan: number | null;
  overrunHours: number | null;
  lateStartHours: number | null;
  inScope: number;
  atFreeze: number;
  added: number;
  removed: number;
  /** KPI-041: added ÷ at freeze. */
  addedShare: number | null;
  done: number;
  /** KPI-040: done ÷ in scope. */
  completion: number | null;
  estimatedHours: number;
  estimatedHoursDone: number;
  notImported: number;
  rows: ScopeRow[];
}

export function shutdownReport(s: Shutdown, wos: WorkOrder[], now: Iso): ShutdownReport {
  const byNum = new Map<string, WorkOrder>();
  for (const w of wos) byNum.set(w.numberNormalised, w);
  const plannedHours = (ms(s.plannedEnd) - ms(s.plannedStart)) / HOUR_MS;
  const actualHours = s.actualStart ? (ms(s.actualEnd ?? now) - ms(s.actualStart)) / HOUR_MS : null;
  const live = activeScope(s);
  const rows: ScopeRow[] = s.scope.map((item) => {
    const wo = byNum.get(item.workOrder);
    return { item, wo, state: !wo ? 'not_imported' : wo.open ? 'open' : 'done' };
  });
  const liveRows = rows.filter((r) => !r.item.removedAt);
  const atFreeze = live.filter((x) => !x.late).length;
  const added = live.filter((x) => x.late).length;
  const done = liveRows.filter((r) => r.state === 'done').length;
  const est = (rs: ScopeRow[]) => rs.reduce((t, r) => t + (r.wo?.estimatedHours ?? 0), 0);
  return {
    status: shutdownStatus(s),
    plannedHours,
    actualHours,
    ofPlan: actualHours === null ? null : actualHours / plannedHours,
    overrunHours: actualHours === null ? null : actualHours - plannedHours,
    lateStartHours: s.actualStart ? (ms(s.actualStart) - ms(s.plannedStart)) / HOUR_MS : null,
    inScope: live.length,
    atFreeze,
    added,
    removed: s.scope.length - live.length,
    addedShare: atFreeze ? added / atFreeze : null,
    done,
    completion: live.length ? done / live.length : null,
    estimatedHours: est(liveRows),
    estimatedHoursDone: est(liveRows.filter((r) => r.state === 'done')),
    notImported: liveRows.filter((r) => r.state === 'not_imported').length,
    rows,
  };
}
