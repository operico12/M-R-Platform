// Project tracking (plan section 8): portfolio, stage gates, tasks and
// milestones, budget against actual, risks and issues, decisions, change
// requests, links to units, work orders, RCAs and actions, and benefits
// measured from the platform's own data before and after.
//
// Same shape as the console and improvement commands: pure functions that
// return the new records and audit entries, or the reasons a change is
// refused. Nothing is deleted: tasks are cancelled, risks closed, projects
// closed or stopped, each with a reason.

import { analyse, filterFromQuery } from './filters.js';
import type { KpiInput } from './kpis.js';
import { can } from './permissions.js';
import { ms, type ShiftCalendar } from './time.js';
import type { ConsoleContext, ConsoleResult } from './console.js';
import { siteToday } from './improve.js';
import type { AuditEntry, Iso } from './types.js';

const refuse = <T>(...errors: string[]): ConsoleResult<T> => ({ ok: false, errors });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- records ----------

/** Plan 8 stage gates, in order. "Stopped" is a way out at any gate, with a reason. */
export type ProjectStage = 'idea' | 'approved' | 'in_progress' | 'closed' | 'benefits_confirmed' | 'stopped';

export const STAGE_ORDER: ProjectStage[] = ['idea', 'approved', 'in_progress', 'closed', 'benefits_confirmed'];

export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  idea: 'Idea',
  approved: 'Approved',
  in_progress: 'In progress',
  closed: 'Closed',
  benefits_confirmed: 'Benefits confirmed',
  stopped: 'Stopped',
};

export type TaskStatus = 'not_started' | 'in_progress' | 'done' | 'cancelled';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

export interface ProjectTask {
  id: string;
  title: string;
  owner: string;
  /** Local dates at the site (YYYY-MM-DD). */
  start: string;
  due: string;
  status: TaskStatus;
  milestone: boolean;
  /** Tasks that must be done first. */
  dependsOn: string[];
  doneAt?: Iso;
  note?: string;
}

export interface ProjectRisk {
  id: string;
  kind: 'risk' | 'issue';
  text: string;
  /** 1 (low) to 3 (high). Issues are already happening, so only impact matters. */
  likelihood: 1 | 2 | 3;
  impact: 1 | 2 | 3;
  owner: string;
  mitigation?: string;
  status: 'open' | 'closed';
  raisedAt: Iso;
  closedAt?: Iso;
  closeNote?: string;
}

export interface ProjectDecision {
  id: string;
  at: Iso;
  by: string;
  text: string;
}

export interface ProjectCost {
  id: string;
  /** Local date the cost was incurred. */
  date: string;
  amount: number;
  text: string;
  /** Work order or purchase order number, if any. */
  reference?: string;
  enteredBy: string;
  enteredAt: Iso;
}

/** A change to budget or end date after approval. The superintendent approves or rejects it (plan 11.2). */
export interface ChangeRequest {
  id: string;
  text: string;
  budget?: number;
  end?: string;
  status: 'proposed' | 'approved' | 'rejected';
  raisedBy: string;
  raisedAt: Iso;
  decidedBy?: string;
  decidedAt?: Iso;
  decisionNote?: string;
}

export interface StageChange {
  stage: ProjectStage;
  at: Iso;
  by: string;
  note?: string;
}

export interface Project {
  id: string;
  title: string;
  /** Charter: the problem, the goal and why now. */
  charter: string;
  scope: string;
  owner: string;
  stage: ProjectStage;
  /** Every gate passed, oldest first. */
  stages: StageChange[];
  /** Local dates. */
  start: string;
  end: string;
  budget: number;
  /** Forecast cost still to spend, entered by the owner. */
  forecastToComplete: number;
  tasks: ProjectTask[];
  risks: ProjectRisk[];
  decisions: ProjectDecision[];
  costs: ProjectCost[];
  changes: ChangeRequest[];
  links: { unitIds: string[]; workOrders: string[]; rcaIds: string[]; actionIds: string[] };
  /** The analysis slice the benefit is measured on (filterToQuery). */
  benefitQuery?: string;
  /** Expected downtime hours avoided per year, from the charter. */
  expectedHoursPerYear?: number;
  /** Value of one down hour, entered for this project, to turn hours into money. */
  valuePerDownHour?: number;
  createdBy: string;
  createdAt: Iso;
  updatedAt: Iso;
}

// ---------- helpers ----------

function entry(ctx: ConsoleContext, action: string, p: Project, before: Project | null, reason?: string): AuditEntry {
  return { at: ctx.now, userId: ctx.actor.userId, action, entity: 'project', entityId: p.id, before, after: p, reason };
}

function ok(ctx: ConsoleContext, projects: Project[], before: Project | null, next: Project, action: string, reason?: string, warnings: string[] = []): ConsoleResult<Project> {
  const records = before ? projects.map((x) => (x.id === next.id ? next : x)) : [...projects, next];
  return { ok: true, records, audit: [entry(ctx, action, next, before, reason)], warnings };
}

const isLive = (p: Project) => p.stage !== 'closed' && p.stage !== 'benefits_confirmed' && p.stage !== 'stopped';
const canRun = (ctx: ConsoleContext) => can(ctx.actor, 'run_projects');
const canApprove = (ctx: ConsoleContext) => can(ctx.actor, 'approve_projects');

function find(projects: Project[], id: string): Project | undefined {
  return projects.find((p) => p.id === id);
}

/** Commands that edit a live project share the same checks. */
function editable(ctx: ConsoleContext, projects: Project[], id: string): Project | string[] {
  const p = find(projects, id);
  if (!p) return ['Project not found.'];
  if (!canRun(ctx)) return ['Your role cannot change projects.'];
  if (!isLive(p)) return ['The project is closed. Reopen it to change it.'];
  return p;
}

// ---------- create and gates ----------

export interface ProjectInput {
  title: string;
  charter: string;
  scope: string;
  owner: string;
  start: string;
  end: string;
  budget: number;
  benefitQuery?: string;
  expectedHoursPerYear?: number;
  valuePerDownHour?: number;
  links?: Partial<Project['links']>;
}

function checkInput(input: Pick<ProjectInput, 'title' | 'charter' | 'owner' | 'start' | 'end' | 'budget'>, owners: string[]): string[] {
  const e: string[] = [];
  if (!input.title.trim()) e.push('Give the project a title.');
  if (!input.charter.trim()) e.push('Write the charter: the problem and the goal.');
  if (!owners.includes(input.owner)) e.push('Choose an owner from the site users.');
  if (!DATE.test(input.start) || !DATE.test(input.end)) e.push('Choose start and end dates.');
  else if (input.end < input.start) e.push('The end date is before the start date.');
  if (!Number.isFinite(input.budget) || input.budget < 0) e.push('The budget cannot be negative.');
  return e;
}

/** A new project starts as an idea. */
export function createProject(ctx: ConsoleContext, projects: Project[], input: ProjectInput, owners: string[]): ConsoleResult<Project> {
  if (!canRun(ctx)) return refuse('Your role cannot create projects.');
  const e = checkInput(input, owners);
  if (e.length) return refuse(...e);
  const p: Project = {
    id: ctx.newId(), title: input.title.trim(), charter: input.charter.trim(), scope: input.scope.trim(), owner: input.owner,
    stage: 'idea', stages: [{ stage: 'idea', at: ctx.now, by: ctx.actor.userId }], start: input.start, end: input.end,
    budget: input.budget, forecastToComplete: input.budget, tasks: [], risks: [], decisions: [], costs: [], changes: [],
    links: { unitIds: [], workOrders: [], rcaIds: [], actionIds: [], ...input.links },
    benefitQuery: input.benefitQuery, expectedHoursPerYear: input.expectedHoursPerYear, valuePerDownHour: input.valuePerDownHour,
    createdBy: ctx.actor.userId, createdAt: ctx.now, updatedAt: ctx.now,
  };
  return ok(ctx, projects, null, p, 'create_project');
}

export interface ProjectEdit {
  title?: string;
  charter?: string;
  scope?: string;
  owner?: string;
  forecastToComplete?: number;
  benefitQuery?: string;
  expectedHoursPerYear?: number;
  valuePerDownHour?: number;
  links?: Partial<Project['links']>;
  /** Budget and dates can be edited freely only while the project is an idea; after approval they need a change request. */
  budget?: number;
  start?: string;
  end?: string;
}

export function editProject(ctx: ConsoleContext, projects: Project[], id: string, edit: ProjectEdit, owners: string[]): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  const lockedChange = (edit.budget !== undefined && edit.budget !== p.budget) || (edit.start !== undefined && edit.start !== p.start) || (edit.end !== undefined && edit.end !== p.end);
  if (lockedChange && p.stage !== 'idea') return refuse('After approval, budget and dates change through a change request.');
  const next: Project = {
    ...p,
    title: edit.title?.trim() ?? p.title,
    charter: edit.charter?.trim() ?? p.charter,
    scope: edit.scope?.trim() ?? p.scope,
    owner: edit.owner ?? p.owner,
    budget: edit.budget ?? p.budget,
    start: edit.start ?? p.start,
    end: edit.end ?? p.end,
    forecastToComplete: edit.forecastToComplete ?? p.forecastToComplete,
    benefitQuery: edit.benefitQuery ?? p.benefitQuery,
    expectedHoursPerYear: edit.expectedHoursPerYear ?? p.expectedHoursPerYear,
    valuePerDownHour: edit.valuePerDownHour ?? p.valuePerDownHour,
    links: { ...p.links, ...edit.links },
    updatedAt: ctx.now,
  };
  const e = checkInput(next, owners);
  if (!Number.isFinite(next.forecastToComplete) || next.forecastToComplete < 0) e.push('The forecast cannot be negative.');
  if (e.length) return refuse(...e);
  return ok(ctx, projects, p, next, 'edit_project');
}

/**
 * Move to the next gate (plan 8). Approving an idea, and confirming benefits,
 * are the superintendent's (plan 11.2 "approve project gates and budgets").
 * Closing needs every task done or cancelled.
 */
export function advanceStage(ctx: ConsoleContext, projects: Project[], id: string, note: string): ConsoleResult<Project> {
  const p = find(projects, id);
  if (!p) return refuse('Project not found.');
  const i = STAGE_ORDER.indexOf(p.stage);
  if (i < 0 || i === STAGE_ORDER.length - 1) return refuse('There is no next gate.');
  const to = STAGE_ORDER[i + 1]!;
  const needsApproval = to === 'approved' || to === 'benefits_confirmed';
  if (needsApproval ? !canApprove(ctx) : !canRun(ctx)) {
    return refuse(needsApproval ? 'Only the superintendent approves this gate.' : 'Your role cannot move project gates.');
  }
  const e: string[] = [];
  if (to === 'closed') {
    const open = p.tasks.filter((t) => t.status === 'not_started' || t.status === 'in_progress');
    if (open.length) e.push(`Finish or cancel the ${open.length} open task${open.length === 1 ? '' : 's'} before closing.`);
    if (!note.trim()) e.push('Add a closing note: what was delivered.');
  }
  if (to === 'benefits_confirmed' && !note.trim()) e.push('Say what benefit was confirmed and how.');
  if (to === 'approved' && p.changes.some((c) => c.status === 'proposed')) e.push('Decide the open change requests first.');
  if (e.length) return refuse(...e);
  const warnings: string[] = [];
  if (to === 'in_progress' && !p.tasks.length) warnings.push('No tasks yet. Add tasks so progress can be tracked.');
  if (to === 'closed' && !p.benefitQuery) warnings.push('No benefit slice is set, so the benefit cannot be measured.');
  const next: Project = { ...p, stage: to, stages: [...p.stages, { stage: to, at: ctx.now, by: ctx.actor.userId, note: note.trim() || undefined }], updatedAt: ctx.now };
  return ok(ctx, projects, p, next, `gate_${to}`, note.trim() || undefined, warnings);
}

/** Stop a project at any gate, with a reason. */
export function stopProject(ctx: ConsoleContext, projects: Project[], id: string, reason: string): ConsoleResult<Project> {
  const p = find(projects, id);
  if (!p) return refuse('Project not found.');
  if (!canApprove(ctx)) return refuse('Only the superintendent stops a project.');
  if (!isLive(p)) return refuse('The project is already closed.');
  if (!reason.trim()) return refuse('Give a reason for stopping.');
  const next: Project = { ...p, stage: 'stopped', stages: [...p.stages, { stage: 'stopped', at: ctx.now, by: ctx.actor.userId, note: reason.trim() }], updatedAt: ctx.now };
  return ok(ctx, projects, p, next, 'stop_project', reason.trim());
}

/** Back to the last live gate. The earlier close stays in the stage history and the audit log. */
export function reopenProject(ctx: ConsoleContext, projects: Project[], id: string, reason: string): ConsoleResult<Project> {
  const p = find(projects, id);
  if (!p) return refuse('Project not found.');
  if (!canApprove(ctx)) return refuse('Only the superintendent reopens a project.');
  if (isLive(p)) return refuse('The project is open.');
  if (!reason.trim()) return refuse('Give a reason for reopening.');
  const last = [...p.stages].reverse().find((s) => s.stage === 'idea' || s.stage === 'approved' || s.stage === 'in_progress')?.stage ?? 'idea';
  const next: Project = { ...p, stage: last, stages: [...p.stages, { stage: last, at: ctx.now, by: ctx.actor.userId, note: `Reopened: ${reason.trim()}` }], updatedAt: ctx.now };
  return ok(ctx, projects, p, next, 'reopen_project', reason.trim());
}

// ---------- tasks ----------

export interface TaskInput {
  title: string;
  owner: string;
  start: string;
  due: string;
  milestone?: boolean;
  dependsOn?: string[];
}

function checkTask(p: Project, t: TaskInput, owners: string[], selfId?: string): string[] {
  const e: string[] = [];
  if (!t.title.trim()) e.push('Give the task a title.');
  if (!owners.includes(t.owner)) e.push('Choose an owner from the site users.');
  if (!DATE.test(t.start) || !DATE.test(t.due)) e.push('Choose start and due dates.');
  else if (t.due < t.start) e.push('The due date is before the start date.');
  for (const d of t.dependsOn ?? []) {
    if (d === selfId) e.push('A task cannot depend on itself.');
    else if (!p.tasks.some((x) => x.id === d)) e.push('A task it depends on is not in this project.');
  }
  if (selfId && createsCycle(p.tasks, selfId, t.dependsOn ?? [])) e.push('That would make tasks depend on each other in a loop.');
  return e;
}

function createsCycle(tasks: ProjectTask[], id: string, deps: string[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t.id === id ? deps : t.dependsOn]));
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === id) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(byId.get(x) ?? []));
  }
  return false;
}

export function addTask(ctx: ConsoleContext, projects: Project[], id: string, t: TaskInput, owners: string[]): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  const e = checkTask(p, t, owners);
  if (e.length) return refuse(...e);
  const task: ProjectTask = { id: ctx.newId(), title: t.title.trim(), owner: t.owner, start: t.start, due: t.due, status: 'not_started', milestone: !!t.milestone, dependsOn: t.dependsOn ?? [] };
  const warnings = task.due > p.end ? ['The task is due after the project end date.'] : [];
  return ok(ctx, projects, p, { ...p, tasks: [...p.tasks, task], updatedAt: ctx.now }, 'add_task', undefined, warnings);
}

export function editTask(ctx: ConsoleContext, projects: Project[], id: string, taskId: string, t: TaskInput, owners: string[]): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  const old = p.tasks.find((x) => x.id === taskId);
  if (!old) return refuse('Task not found.');
  if (old.status === 'done' || old.status === 'cancelled') return refuse('The task is closed.');
  const e = checkTask(p, t, owners, taskId);
  if (e.length) return refuse(...e);
  const task: ProjectTask = { ...old, title: t.title.trim(), owner: t.owner, start: t.start, due: t.due, milestone: !!t.milestone, dependsOn: t.dependsOn ?? [] };
  return ok(ctx, projects, p, { ...p, tasks: p.tasks.map((x) => (x.id === taskId ? task : x)), updatedAt: ctx.now }, 'edit_task');
}

/**
 * Move a task on. The task owner may update their own task; a task cannot
 * start or finish while a task it depends on is still open. Cancelling needs
 * a note.
 */
export function setTaskStatus(ctx: ConsoleContext, projects: Project[], id: string, taskId: string, status: TaskStatus, note = ''): ConsoleResult<Project> {
  const p = find(projects, id);
  if (!p) return refuse('Project not found.');
  const old = p.tasks.find((x) => x.id === taskId);
  if (!old) return refuse('Task not found.');
  if (!canRun(ctx) && old.owner !== ctx.actor.userId) return refuse('Only the task owner, or someone who runs projects, can update it.');
  if (!isLive(p)) return refuse('The project is closed.');
  if (p.stage === 'idea') return refuse('Work starts once the project is approved.');
  if (old.status === status) return refuse('Nothing has changed.');
  if (status === 'cancelled' && !canRun(ctx)) return refuse('Only someone who runs projects can cancel a task.');
  if (status === 'cancelled' && !note.trim()) return refuse('Give a reason for cancelling the task.');
  if (status === 'not_started' && !canRun(ctx)) return refuse('Only someone who runs projects can reopen a task.');
  if (status === 'in_progress' || status === 'done') {
    const blocked = old.dependsOn.map((d) => p.tasks.find((x) => x.id === d)).filter((x) => x && (x.status === 'not_started' || x.status === 'in_progress'));
    if (blocked.length) return refuse(`Waiting on: ${blocked.map((x) => x!.title).join(', ')}.`);
  }
  const task: ProjectTask = { ...old, status, doneAt: status === 'done' ? ctx.now : undefined, note: note.trim() || old.note };
  return ok(ctx, projects, p, { ...p, tasks: p.tasks.map((x) => (x.id === taskId ? task : x)), updatedAt: ctx.now }, `task_${status}`, note.trim() || undefined);
}

// ---------- risks, decisions, costs ----------

export function addRisk(ctx: ConsoleContext, projects: Project[], id: string, r: Pick<ProjectRisk, 'kind' | 'text' | 'likelihood' | 'impact' | 'owner' | 'mitigation'>, owners: string[]): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  const e: string[] = [];
  if (!r.text.trim()) e.push(`Describe the ${r.kind}.`);
  if (!owners.includes(r.owner)) e.push('Choose an owner from the site users.');
  if (![1, 2, 3].includes(r.likelihood) || ![1, 2, 3].includes(r.impact)) e.push('Rate likelihood and impact from 1 to 3.');
  if (e.length) return refuse(...e);
  const risk: ProjectRisk = { id: ctx.newId(), kind: r.kind, text: r.text.trim(), likelihood: r.kind === 'issue' ? 3 : r.likelihood, impact: r.impact, owner: r.owner, mitigation: r.mitigation?.trim() || undefined, status: 'open', raisedAt: ctx.now };
  return ok(ctx, projects, p, { ...p, risks: [...p.risks, risk], updatedAt: ctx.now }, `add_${r.kind}`);
}

export function closeRisk(ctx: ConsoleContext, projects: Project[], id: string, riskId: string, note: string): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  const r = p.risks.find((x) => x.id === riskId);
  if (!r) return refuse('Not found.');
  if (r.status === 'closed') return refuse('Already closed.');
  if (!note.trim()) return refuse('Say how it was dealt with.');
  const next: ProjectRisk = { ...r, status: 'closed', closedAt: ctx.now, closeNote: note.trim() };
  return ok(ctx, projects, p, { ...p, risks: p.risks.map((x) => (x.id === riskId ? next : x)), updatedAt: ctx.now }, `close_${r.kind}`, note.trim());
}

export function logDecision(ctx: ConsoleContext, projects: Project[], id: string, text: string): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  if (!text.trim()) return refuse('Write the decision.');
  const d: ProjectDecision = { id: ctx.newId(), at: ctx.now, by: ctx.actor.userId, text: text.trim() };
  return ok(ctx, projects, p, { ...p, decisions: [...p.decisions, d], updatedAt: ctx.now }, 'log_decision', text.trim());
}

/** Costs are added, never edited; a wrong entry is reversed with a negative one. */
export function addCost(ctx: ConsoleContext, projects: Project[], id: string, c: Pick<ProjectCost, 'date' | 'amount' | 'text' | 'reference'>): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  const e: string[] = [];
  if (!DATE.test(c.date)) e.push('Choose the date.');
  if (!Number.isFinite(c.amount) || c.amount === 0) e.push('Enter an amount (negative to reverse an entry).');
  if (!c.text.trim()) e.push('Say what the cost was for.');
  if (e.length) return refuse(...e);
  if (c.amount < 0 && spent(p) + c.amount < 0) return refuse('That would take the actual cost below zero.');
  const cost: ProjectCost = { id: ctx.newId(), date: c.date, amount: c.amount, text: c.text.trim(), reference: c.reference?.trim() || undefined, enteredBy: ctx.actor.userId, enteredAt: ctx.now };
  const warnings = c.date > siteToday(ctx.now, ctx.timeZone) ? ['The cost is dated in the future.'] : [];
  return ok(ctx, projects, p, { ...p, costs: [...p.costs, cost], updatedAt: ctx.now }, 'add_cost', undefined, warnings);
}

// ---------- change requests ----------

export function proposeChange(ctx: ConsoleContext, projects: Project[], id: string, c: Pick<ChangeRequest, 'text' | 'budget' | 'end'>): ConsoleResult<Project> {
  const p = editable(ctx, projects, id);
  if (Array.isArray(p)) return refuse(...p);
  if (p.stage === 'idea') return refuse('While the project is an idea, edit the budget and dates directly.');
  const e: string[] = [];
  if (!c.text.trim()) e.push('Say why the change is needed.');
  if (c.budget === undefined && c.end === undefined) e.push('Propose a new budget, a new end date, or both.');
  if (c.budget !== undefined && (!Number.isFinite(c.budget) || c.budget < 0)) e.push('The budget cannot be negative.');
  if (c.end !== undefined && (!DATE.test(c.end) || c.end < p.start)) e.push('Choose an end date after the start.');
  if (e.length) return refuse(...e);
  const cr: ChangeRequest = { id: ctx.newId(), text: c.text.trim(), budget: c.budget, end: c.end, status: 'proposed', raisedBy: ctx.actor.userId, raisedAt: ctx.now };
  return ok(ctx, projects, p, { ...p, changes: [...p.changes, cr], updatedAt: ctx.now }, 'propose_change', cr.text);
}

/** The superintendent approves (the new budget or end date applies) or rejects, with a note. Not their own request. */
export function decideChange(ctx: ConsoleContext, projects: Project[], id: string, changeId: string, approve: boolean, note: string): ConsoleResult<Project> {
  const p = find(projects, id);
  if (!p) return refuse('Project not found.');
  if (!canApprove(ctx)) return refuse('Only the superintendent decides change requests.');
  if (!isLive(p)) return refuse('The project is closed.');
  const c = p.changes.find((x) => x.id === changeId);
  if (!c) return refuse('Change request not found.');
  if (c.status !== 'proposed') return refuse('That change request has been decided.');
  if (c.raisedBy === ctx.actor.userId && !ctx.actor.fullAccess) return refuse('Someone else must decide your own change request.');
  if (!approve && !note.trim()) return refuse('Give a reason for rejecting.');
  const decided: ChangeRequest = { ...c, status: approve ? 'approved' : 'rejected', decidedBy: ctx.actor.userId, decidedAt: ctx.now, decisionNote: note.trim() || undefined };
  const next: Project = {
    ...p,
    budget: approve && c.budget !== undefined ? c.budget : p.budget,
    end: approve && c.end !== undefined ? c.end : p.end,
    changes: p.changes.map((x) => (x.id === changeId ? decided : x)),
    updatedAt: ctx.now,
  };
  return ok(ctx, projects, p, next, approve ? 'approve_change' : 'reject_change', note.trim() || undefined);
}

// ---------- reading a project ----------

export const spent = (p: Project) => p.costs.reduce((s, c) => s + c.amount, 0);

export type Health = 'on_track' | 'at_risk' | 'late' | 'closed';

export const HEALTH_LABELS: Record<Health, string> = { on_track: 'On track', at_risk: 'At risk', late: 'Late', closed: 'Closed' };

/**
 * Plan 8 portfolio status, with every reason behind it (late reasons first).
 * Late: past the end date, or an open task past its due date.
 * At risk: a task due within 7 days not started, actual plus forecast over budget,
 * an open high risk (likelihood × impact ≥ 6) or an open issue, or a change request waiting.
 */
export function projectHealth(p: Project, now: Iso, timeZone: string): { health: Health; reasons: string[] } {
  if (!isLive(p)) return { health: 'closed', reasons: [] };
  const today = siteToday(now, timeZone);
  const soon = siteToday(now, timeZone, 7);
  const open = p.tasks.filter((t) => t.status === 'not_started' || t.status === 'in_progress');
  const late: string[] = [];
  if (p.stage !== 'idea' && p.end < today) late.push(`Past its end date (${p.end}).`);
  const overdue = open.filter((t) => t.due < today);
  if (overdue.length) late.push(`${overdue.length} task${overdue.length === 1 ? '' : 's'} overdue.`);
  const risk: string[] = [];
  const stalled = open.filter((t) => t.status === 'not_started' && t.due <= soon);
  if (stalled.length) risk.push(`${stalled.length} task${stalled.length === 1 ? '' : 's'} due within 7 days not started.`);
  if (spent(p) + p.forecastToComplete > p.budget) risk.push('Actual plus forecast is over budget.');
  const high = p.risks.filter((r) => r.status === 'open' && (r.kind === 'issue' || r.likelihood * r.impact >= 6));
  if (high.length) risk.push(`${high.length} open issue${high.length === 1 ? '' : 's'} or high risk${high.length === 1 ? '' : 's'}.`);
  if (p.changes.some((c) => c.status === 'proposed')) risk.push('A change request is waiting for a decision.');
  if (late.length) return { health: 'late', reasons: [...late, ...risk] };
  return risk.length ? { health: 'at_risk', reasons: risk } : { health: 'on_track', reasons: [] };
}

/** The next milestone not yet done, by due date. */
export function nextMilestone(p: Project): ProjectTask | undefined {
  return p.tasks.filter((t) => t.milestone && (t.status === 'not_started' || t.status === 'in_progress')).sort((a, b) => a.due.localeCompare(b.due))[0];
}

/** Share of tasks done, by count; cancelled tasks are left out. */
export function progress(p: Project): number | null {
  const live = p.tasks.filter((t) => t.status !== 'cancelled');
  return live.length ? live.filter((t) => t.status === 'done').length / live.length : null;
}

export const stageAt = (p: Project, stage: ProjectStage): Iso | undefined => [...p.stages].reverse().find((s) => s.stage === stage)?.at;

export interface Benefit {
  /** Matching down hours per 1000 calendar hours. */
  baselineRate: number;
  afterRate: number;
  baseline: { from: Iso; to: Iso; downHours: number; calendarHours: number };
  after: { from: Iso; to: Iso; downHours: number; calendarHours: number };
  /** (baseline rate − after rate) × after calendar hours. Negative means more downtime. */
  hoursAvoided: number;
  /** Hours avoided scaled to a year at the after window's rate. */
  hoursAvoidedPerYear: number;
  valueAvoided?: number;
  /** Days in the after window. Under 28 days the figure is provisional. */
  afterDays: number;
  provisional: boolean;
}

/**
 * Plan 8 benefits tracking: downtime on the project's slice in the 90 days
 * before it went in progress, against the time since it closed (up to 365
 * days). Rates per calendar hour, so a short after window still compares.
 */
export function projectBenefit(input: KpiInput & { calendar: ShiftCalendar; timeZone: string }, p: Project, opts: { baselineDays?: number; maxAfterDays?: number; minAfterDays?: number } = {}): Benefit | undefined {
  if (p.benefitQuery === undefined) return undefined;
  const started = stageAt(p, 'in_progress');
  const closed = stageAt(p, 'closed');
  if (!started || !closed) return undefined;
  const f = filterFromQuery(p.benefitQuery);
  const baseDays = opts.baselineDays ?? 90;
  const maxAfter = opts.maxAfterDays ?? 365;
  const afterTo = Math.min(ms(input.now), ms(closed) + maxAfter * 864e5);
  if (afterTo <= ms(closed)) return undefined;
  const b = analyse(input, f, { from: new Date(ms(started) - baseDays * 864e5).toISOString(), to: started });
  const a = analyse(input, f, { from: closed, to: new Date(afterTo).toISOString() });
  const rate = (x: typeof a) => (x.kpis.calendarHours > 0 ? (x.downHours / x.kpis.calendarHours) * 1000 : 0);
  const baselineRate = rate(b);
  const afterRate = rate(a);
  const hoursAvoided = ((baselineRate - afterRate) / 1000) * a.kpis.calendarHours;
  const afterDays = (afterTo - ms(closed)) / 864e5;
  const hoursAvoidedPerYear = afterDays > 0 ? (hoursAvoided / afterDays) * 365 : 0;
  return {
    baselineRate, afterRate,
    baseline: { from: b.period.from, to: b.period.to, downHours: b.downHours, calendarHours: b.kpis.calendarHours },
    after: { from: a.period.from, to: a.period.to, downHours: a.downHours, calendarHours: a.kpis.calendarHours },
    hoursAvoided, hoursAvoidedPerYear,
    valueAvoided: p.valuePerDownHour !== undefined ? hoursAvoided * p.valuePerDownHour : undefined,
    afterDays: Math.round(afterDays * 10) / 10,
    provisional: afterDays < (opts.minAfterDays ?? 28),
  };
}

/** Plain-text weekly status for email or the weekly meeting (plan 8, "one-click weekly status report"). */
export function statusReport(p: Project, now: Iso, timeZone: string, name: (id: string) => string, money: (n: number) => string): string {
  const h = projectHealth(p, now, timeZone);
  const today = siteToday(now, timeZone);
  const weekAgo = new Date(ms(now) - 7 * 864e5).toISOString();
  const done = p.tasks.filter((t) => t.status === 'done' && t.doneAt && t.doneAt >= weekAgo);
  const next = p.tasks.filter((t) => (t.status === 'not_started' || t.status === 'in_progress') && t.due <= siteToday(now, timeZone, 14)).sort((a, b) => a.due.localeCompare(b.due));
  const openRisks = p.risks.filter((r) => r.status === 'open').sort((a, b) => b.likelihood * b.impact - a.likelihood * a.impact);
  const pr = progress(p);
  const lines = [
    `${p.title}: weekly status, ${today}`,
    `Stage: ${PROJECT_STAGE_LABELS[p.stage]} · Status: ${HEALTH_LABELS[h.health]} · Owner: ${name(p.owner)} · Ends ${p.end}`,
    ...h.reasons.map((r) => `  - ${r}`),
    `Progress: ${pr === null ? 'no tasks' : `${Math.round(pr * 100)}% of tasks done`}`,
    `Budget ${money(p.budget)} · actual ${money(spent(p))} · forecast to complete ${money(p.forecastToComplete)} · variance ${money(p.budget - spent(p) - p.forecastToComplete)}`,
    '',
    'Done in the last 7 days:',
    ...(done.length ? done.map((t) => `  - ${t.title} (${name(t.owner)})`) : ['  - Nothing']),
    'Due in the next 14 days:',
    ...(next.length ? next.map((t) => `  - ${t.due} ${t.title} (${name(t.owner)})${t.due < today ? ' OVERDUE' : ''}`) : ['  - Nothing']),
    'Open risks and issues:',
    ...(openRisks.length ? openRisks.map((r) => `  - ${r.kind === 'issue' ? 'Issue' : `Risk ${r.likelihood}×${r.impact}`}: ${r.text} (${name(r.owner)})`) : ['  - None']),
  ];
  const waiting = p.changes.filter((c) => c.status === 'proposed');
  if (waiting.length) lines.push('Change requests waiting:', ...waiting.map((c) => `  - ${c.text}`));
  return lines.join('\n');
}
