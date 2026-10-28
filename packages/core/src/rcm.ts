// RCM to PM job plans (phase 3; docs/rcm.md, plan 7.4). A failure mode
// library per model, task selection in line with SAE JA1011/JA1012, packaging
// by SMU interval into job plans, issued versions, the Maximo export and the
// effectiveness review. Pure functions; the app and the database store what
// they return. Modes are never edited in place: each change is a new revision.

import type { ConsoleContext } from './console.js';
import type { DowntimeEvent } from './kpis.js';
import { can } from './permissions.js';
import { ms } from './time.js';
import type { Asset, AuditEntry, DetectionMethod, Iso } from './types.js';

// ---------- reference ----------

export type Consequence = 'hidden' | 'safety' | 'operational' | 'non_operational';
export const CONSEQUENCES: Consequence[] = ['hidden', 'safety', 'operational', 'non_operational'];
export const CONSEQUENCE_LABELS: Record<Consequence, string> = {
  hidden: 'Hidden', safety: 'Safety or environment', operational: 'Operational', non_operational: 'Non-operational',
};

export type TaskType = 'on_condition' | 'restoration' | 'replacement' | 'failure_finding' | 'run_to_failure' | 'redesign';
export const TASK_TYPES: TaskType[] = ['on_condition', 'restoration', 'replacement', 'failure_finding', 'run_to_failure', 'redesign'];
export const TASK_LABELS: Record<TaskType, string> = {
  on_condition: 'Condition-based task', restoration: 'Scheduled restoration', replacement: 'Scheduled replacement',
  failure_finding: 'Failure-finding task', run_to_failure: 'Run to failure', redesign: 'Redesign',
};
/** Task types that go into PM job plans and need an interval. */
export const SCHEDULED: TaskType[] = ['on_condition', 'restoration', 'replacement', 'failure_finding'];
export const isScheduled = (t: TaskType) => SCHEDULED.includes(t);

/** The calculator that sets each scheduled task's interval (docs/rcm.md "Intervals"). */
export const INTERVAL_CALCULATOR: Partial<Record<TaskType, 'pf_interval' | 'optimal_replacement' | 'failure_finding'>> = {
  on_condition: 'pf_interval', restoration: 'optimal_replacement', replacement: 'optimal_replacement', failure_finding: 'failure_finding',
};

export interface Answers {
  /** A. A warning sign can be found in time to act. */
  warning?: boolean;
  /** B. Failure becomes more likely past an age most items reach. */
  wearOut?: boolean;
  /** C. Rework restores resistance to failure. */
  restorable?: boolean;
  /** D. A check can find the hidden failure. */
  findable?: boolean;
  /** E. The multiple failure could hurt someone or breach an environmental rule. */
  multipleSafety?: boolean;
}

export const QUESTIONS: Array<{ key: keyof Answers; text: string; applies: (c: Consequence, a: Answers) => boolean }> = [
  { key: 'warning', text: 'Is there a warning sign, such as a reading, a noise, wear or a leak, that can be found with enough time to act before the failure?', applies: () => true },
  { key: 'wearOut', text: 'Does the failure become more likely after a certain age, with most items reaching that age?', applies: () => true },
  { key: 'restorable', text: 'Can rework restore the item’s resistance to failure, rather than replacing it?', applies: (_c, a) => a.wearOut === true },
  { key: 'findable', text: 'Can a check find out whether the hidden failure has happened?', applies: (c) => c === 'hidden' },
  { key: 'multipleSafety', text: 'Could the hidden failure, together with a second failure, hurt someone or breach an environmental rule?', applies: (c) => c === 'hidden' },
];

/** docs/rcm.md "Task selection": the first that fits, in JA1012 order of preference. */
export function recommendTask(c: Consequence, a: Answers): TaskType {
  if (a.warning) return 'on_condition';
  if (a.wearOut && a.restorable) return 'restoration';
  if (a.wearOut) return 'replacement';
  if (c === 'hidden') return a.findable ? 'failure_finding' : a.multipleSafety ? 'redesign' : 'run_to_failure';
  if (c === 'safety') return 'redesign';
  return 'run_to_failure';
}

export interface PartLine { itemNum: string; description: string; qty: number }

export interface RcmMode {
  /** This revision's id. */
  id: string;
  /** Stays the same across revisions. */
  modeId: string;
  revision: number;
  model: string;
  system: string;
  component: string;
  func: string;
  functionalFailure: string;
  mode: string;
  effect: string;
  consequence: Consequence;
  answers: Answers;
  recommended: TaskType;
  taskType: TaskType;
  overrideReason?: string;
  task: string;
  intervalHours?: number;
  intervalBasis?: string;
  craft?: string;
  people?: number;
  taskHours?: number;
  parts: PartLine[];
  /** Why this revision was made (blank for the first). */
  changeNote?: string;
  createdBy: string;
  createdAt: Iso;
  retiredBy?: string;
  retiredAt?: Iso;
  retireReason?: string;
}

// ---------- settings ----------

export interface RcmSettings {
  /** PM levels in SMU hours, smallest first. */
  packages: number[];
  /** A PM also holds the tasks of every smaller level it is a multiple of. */
  nested: boolean;
  prefix: string;
  maximoOrgId: string;
  maximoSiteId: string;
  reviewDays: number;
  reviewFailures: number;
}

export const DEFAULT_RCM_SETTINGS: RcmSettings = {
  packages: [250, 500, 1000, 2000], nested: true, prefix: '', maximoOrgId: '', maximoSiteId: '', reviewDays: 365, reviewFailures: 2,
};

export function withRcmDefaults(v: Partial<RcmSettings> | undefined): RcmSettings {
  const d = DEFAULT_RCM_SETTINGS;
  const o = (v ?? {}) as Partial<RcmSettings>;
  const n = (x: unknown, dv: number) => (typeof x === 'number' && Number.isFinite(x) ? x : dv);
  const t = (x: unknown) => (typeof x === 'string' ? x : '');
  const pk = Array.isArray(o.packages) && o.packages.length && o.packages.every((x) => typeof x === 'number' && x > 0) ? [...new Set(o.packages)].sort((a, b) => a - b) : d.packages;
  return {
    packages: pk, nested: typeof o.nested === 'boolean' ? o.nested : d.nested, prefix: t(o.prefix), maximoOrgId: t(o.maximoOrgId), maximoSiteId: t(o.maximoSiteId),
    reviewDays: n(o.reviewDays, d.reviewDays), reviewFailures: n(o.reviewFailures, d.reviewFailures),
  };
}

type Ok<T> = { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };
const no = (...errors: string[]): No => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, entity: 'rcm_mode' | 'job_plan' | 'settings', id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, reason });

export function setRcmSettings(ctx: ConsoleContext, current: RcmSettings, next: RcmSettings, reason: string): Ok<RcmSettings> | No {
  if (!can(ctx.actor, 'edit_rcm')) return no('Your role cannot change RCM settings.');
  const e: string[] = [];
  const p = next.packages;
  if (!(p.length >= 1 && p.length <= 8 && p.every((x) => Number.isInteger(x) && x >= 10 && x <= 20000))) e.push('PM levels must be 1 to 8 whole numbers of hours from 10 to 20,000.');
  if (new Set(p).size !== p.length) e.push('PM levels must all differ.');
  if (next.prefix.length > 6 || /[^A-Za-z0-9-]/.test(next.prefix)) e.push('The prefix can be up to 6 letters, numbers or dashes.');
  if (next.maximoOrgId.length > 8 || next.maximoSiteId.length > 8) e.push('Maximo organisation and site IDs are up to 8 characters.');
  if (!(Number.isInteger(next.reviewDays) && next.reviewDays >= 30 && next.reviewDays <= 1095)) e.push('Review window must be from 30 to 1,095 days.');
  if (!(Number.isInteger(next.reviewFailures) && next.reviewFailures >= 1 && next.reviewFailures <= 50)) e.push('Review threshold must be from 1 to 50 failures.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return no(...e);
  const clean = withRcmDefaults({ ...next, maximoOrgId: next.maximoOrgId.trim().toUpperCase(), maximoSiteId: next.maximoSiteId.trim().toUpperCase(), prefix: next.prefix.trim().toUpperCase() });
  return { ok: true, records: [clean], audit: [log(ctx, 'set_rcm_settings', 'settings', 'rcm', current, clean, reason.trim())], warnings: [] };
}

// ---------- the library ----------

/** The latest revision of each mode, including retired ones. */
export function latestRevisions(modes: RcmMode[]): RcmMode[] {
  const m = new Map<string, RcmMode>();
  for (const x of modes) { const p = m.get(x.modeId); if (!p || x.revision > p.revision) m.set(x.modeId, x); }
  return [...m.values()];
}

/** The library as it stands: latest revisions that are not retired, in system, component, mode order. */
export function currentModes(modes: RcmMode[], model?: string): RcmMode[] {
  return latestRevisions(modes).filter((x) => !x.retiredAt && (!model || x.model === model)).sort(modeOrder);
}

export const modeOrder = (a: RcmMode, b: RcmMode) =>
  a.model.localeCompare(b.model) || a.system.localeCompare(b.system) || a.component.localeCompare(b.component) || a.mode.localeCompare(b.mode) || a.modeId.localeCompare(b.modeId);

export const revisionsOf = (modes: RcmMode[], modeId: string) => modes.filter((x) => x.modeId === modeId).sort((a, b) => b.revision - a.revision);

export type ModeInput = Pick<RcmMode, 'model' | 'system' | 'component' | 'func' | 'functionalFailure' | 'mode' | 'effect' | 'consequence' | 'answers' | 'taskType' | 'task' | 'parts'>
  & Partial<Pick<RcmMode, 'overrideReason' | 'intervalHours' | 'intervalBasis' | 'craft' | 'people' | 'taskHours'>>;

const T = (s: string | undefined) => (s ?? '').trim();

/** JSON with keys sorted and undefined left out, so records read back from the database compare equal. */
export function stableJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map((v) => stableJson(v === undefined ? null : v)).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().filter((k) => (x as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((x as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

/** Keep only the answers that apply, so a changed consequence does not leave stale ones behind. */
export function cleanAnswers(c: Consequence, a: Answers): Answers {
  const out: Answers = {};
  for (const q of QUESTIONS) if (q.applies(c, { ...a, ...out }) && typeof a[q.key] === 'boolean') out[q.key] = a[q.key];
  return out;
}

export function checkMode(input: ModeInput): string[] {
  const e: string[] = [];
  if (!T(input.model)) e.push('Pick the model.');
  if (!T(input.system)) e.push('Give the system.');
  if (!T(input.component)) e.push('Give the component.');
  if (!T(input.func)) e.push('Give the function.');
  if (!T(input.functionalFailure)) e.push('Give the functional failure.');
  if (!T(input.mode)) e.push('Give the failure mode.');
  if (!T(input.effect)) e.push('Give the effect.');
  if (!CONSEQUENCES.includes(input.consequence)) e.push('Pick the consequence.');
  if (!TASK_TYPES.includes(input.taskType)) e.push('Pick the task type.');
  for (const q of QUESTIONS) if (q.applies(input.consequence, input.answers) && typeof input.answers[q.key] !== 'boolean') e.push(`Answer: ${q.text}`);
  const rec = recommendTask(input.consequence, input.answers);
  if (input.taskType !== rec && !T(input.overrideReason)) e.push(`The recommended task is ${TASK_LABELS[rec].toLowerCase()}. Give a reason for choosing ${TASK_LABELS[input.taskType].toLowerCase()}.`);
  if (isScheduled(input.taskType)) {
    if (!T(input.task)) e.push('Describe the task.');
    if (!(typeof input.intervalHours === 'number' && Number.isFinite(input.intervalHours) && input.intervalHours > 0 && input.intervalHours <= 100_000)) e.push('Give the interval in SMU hours.');
    if (!T(input.craft)) e.push('Give the craft.');
    if (!(Number.isInteger(input.people) && input.people! >= 1 && input.people! <= 20)) e.push('People must be a whole number from 1 to 20.');
    if (!(typeof input.taskHours === 'number' && input.taskHours > 0 && input.taskHours <= 500)) e.push('Give the hours each person works on the task.');
  } else if (input.taskType === 'redesign' && !T(input.task)) e.push('Describe the change needed.');
  if (T(input.craft).length > 8) e.push('Maximo crafts are up to 8 characters.');
  for (const p of input.parts) {
    if (!T(p.itemNum) || T(p.itemNum).length > 30) e.push('Each part needs an item number of up to 30 characters.');
    if (!(Number.isFinite(p.qty) && p.qty > 0)) e.push(`Part ${p.itemNum || ''}: quantity must be above 0.`.replace(':  ', ': '));
  }
  if (input.parts.length && !isScheduled(input.taskType)) e.push('Only scheduled tasks carry parts.');
  return e;
}

function build(ctx: ConsoleContext, input: ModeInput, prev: RcmMode | undefined, note?: string): RcmMode {
  const answers = cleanAnswers(input.consequence, input.answers);
  const recommended = recommendTask(input.consequence, answers);
  const sched = isScheduled(input.taskType);
  return {
    id: ctx.newId(), modeId: prev?.modeId ?? ctx.newId(), revision: (prev?.revision ?? 0) + 1,
    model: T(input.model), system: T(input.system), component: T(input.component), func: T(input.func), functionalFailure: T(input.functionalFailure),
    mode: T(input.mode), effect: T(input.effect), consequence: input.consequence, answers, recommended, taskType: input.taskType,
    overrideReason: input.taskType !== recommended ? T(input.overrideReason) : undefined,
    task: T(input.task),
    intervalHours: sched ? input.intervalHours : undefined, intervalBasis: sched ? T(input.intervalBasis) || undefined : undefined,
    craft: sched ? T(input.craft).toUpperCase() : undefined, people: sched ? input.people : undefined, taskHours: sched ? input.taskHours : undefined,
    parts: sched ? input.parts.map((p) => ({ itemNum: T(p.itemNum).toUpperCase(), description: T(p.description), qty: p.qty })) : [],
    changeNote: note, createdBy: ctx.actor.userId, createdAt: ctx.now,
  };
}

const sameContent = (a: RcmMode, b: RcmMode) => {
  const strip = ({ id: _i, revision: _r, createdBy: _c, createdAt: _t, changeNote: _n, ...rest }: RcmMode) => rest;
  const drop = ({ retiredBy: _a, retiredAt: _b, retireReason: _c, ...r }: ReturnType<typeof strip>) => r;
  return stableJson(drop(strip(a))) === stableJson(drop(strip(b)));
};

/** A new failure mode. */
export function addMode(ctx: ConsoleContext, modes: RcmMode[], input: ModeInput): Ok<RcmMode> | No {
  if (!can(ctx.actor, 'edit_rcm')) return no('Your role cannot edit the RCM library.');
  const e = checkMode(input);
  if (e.length) return no(...e);
  const x = build(ctx, input, undefined);
  const dup = currentModes(modes, x.model).find((m) => m.system.toLowerCase() === x.system.toLowerCase() && m.component.toLowerCase() === x.component.toLowerCase() && m.mode.toLowerCase() === x.mode.toLowerCase() && m.functionalFailure.toLowerCase() === x.functionalFailure.toLowerCase());
  return { ok: true, records: [...modes, x], audit: [log(ctx, 'add_rcm_mode', 'rcm_mode', x.modeId, null, x)], warnings: dup ? [`${x.model} already has ${x.system}, ${x.component}, ${x.mode} for this functional failure.`] : [] };
}

/** A change to a mode: a new revision. The old one is kept. */
export function reviseMode(ctx: ConsoleContext, modes: RcmMode[], modeId: string, input: ModeInput, note: string): Ok<RcmMode> | No {
  if (!can(ctx.actor, 'edit_rcm')) return no('Your role cannot edit the RCM library.');
  const prev = revisionsOf(modes, modeId)[0];
  if (!prev) return no('Failure mode not found.');
  if (prev.retiredAt) return no('This failure mode is retired.');
  if (T(input.model) !== prev.model) return no('A mode stays with its model. Add it to the other model instead.');
  const e = checkMode(input);
  if (!T(note)) e.push('Say what changed and why.');
  if (e.length) return no(...e);
  const x = build(ctx, input, prev, T(note));
  if (sameContent(x, prev)) return no('Nothing has changed.');
  return { ok: true, records: [...modes, x], audit: [log(ctx, 'revise_rcm_mode', 'rcm_mode', modeId, prev, x, T(note))], warnings: [] };
}

export function retireMode(ctx: ConsoleContext, modes: RcmMode[], modeId: string, reason: string): Ok<RcmMode> | No {
  if (!can(ctx.actor, 'edit_rcm')) return no('Your role cannot edit the RCM library.');
  const prev = revisionsOf(modes, modeId)[0];
  if (!prev) return no('Failure mode not found.');
  if (prev.retiredAt) return no('It is already retired.');
  if (!T(reason)) return no('Give a reason.');
  const x: RcmMode = { ...prev, retiredBy: ctx.actor.userId, retiredAt: ctx.now, retireReason: T(reason) };
  return { ok: true, records: modes.map((m) => (m.id === prev.id ? x : m)), audit: [log(ctx, 'retire_rcm_mode', 'rcm_mode', modeId, prev, x, T(reason))], warnings: [] };
}

// ---------- packaging ----------

/** docs/rcm.md "Packaging": the PM level for a task interval, or null when shorter than the smallest. */
export function packageFor(interval: number, packages: number[]): number | null {
  const p = [...packages].sort((a, b) => a - b);
  if (!p.length || interval < p[0]!) return null;
  const top = p[p.length - 1]!;
  if (interval >= top) return Math.floor(interval / top) * top;
  return [...p].reverse().find((x) => x <= interval)!;
}

export interface JobPlanTask {
  seq: number;
  modeId: string;
  revision: number;
  system: string;
  component: string;
  mode: string;
  taskType: TaskType;
  description: string;
  /** The task's own PM level, so a nested PM shows where each task comes from. */
  level: number;
  craft: string;
  people: number;
  hours: number;
  parts: PartLine[];
}

export interface JobPlanContent {
  jpnum: string;
  model: string;
  hours: number;
  description: string;
  duration: number;
  tasks: JobPlanTask[];
}

export interface JobPlanDraft extends JobPlanContent { warnings: string[] }

export interface Packaged {
  plans: JobPlanDraft[];
  /** Scheduled tasks shorter than the smallest PM level. */
  tooShort: RcmMode[];
  runToFailure: RcmMode[];
  redesign: RcmMode[];
}

export const jobPlanNumber = (model: string, hours: number, s: RcmSettings) => `${s.prefix}${model}-${hours}`;

/** Build the job plans for one model from the current library. */
export function packageModel(modes: RcmMode[], model: string, s: RcmSettings = DEFAULT_RCM_SETTINGS): Packaged {
  const cur = currentModes(modes, model);
  const sched = cur.filter((m) => isScheduled(m.taskType));
  const byLevel = new Map<number, RcmMode[]>();
  const tooShort: RcmMode[] = [];
  for (const m of sched) {
    const lvl = packageFor(m.intervalHours!, s.packages);
    if (lvl === null) { tooShort.push(m); continue; }
    const l = byLevel.get(lvl);
    if (l) l.push(m); else byLevel.set(lvl, [m]);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const plans: JobPlanDraft[] = levels.map((h) => {
    const from = s.nested ? levels.filter((l) => l <= h && h % l === 0) : [h];
    const ms_ = from.flatMap((l) => byLevel.get(l)!.map((m) => ({ m, l }))).sort((a, b) => modeOrder(a.m, b.m));
    const tasks: JobPlanTask[] = ms_.map(({ m, l }, k) => ({
      seq: (k + 1) * 10, modeId: m.modeId, revision: m.revision, system: m.system, component: m.component, mode: m.mode, taskType: m.taskType,
      description: m.task, level: l, craft: m.craft!, people: m.people!, hours: m.taskHours!, parts: m.parts,
    }));
    const jpnum = jobPlanNumber(model, h, s);
    const warnings: string[] = [];
    if (jpnum.length > 10) warnings.push(`${jpnum} is longer than Maximo's 10 characters for a job plan number.`);
    const long = tasks.filter((t) => t.description.length > 100).length;
    if (long) warnings.push(`${long} task description${long > 1 ? 's are' : ' is'} over 100 characters; the rest goes to the long description.`);
    return { jpnum, model, hours: h, description: `${model} PM ${h} h (RCM)`, duration: round2(tasks.reduce((x, t) => x + t.hours, 0)), tasks, warnings };
  });
  return { plans, tooShort, runToFailure: cur.filter((m) => m.taskType === 'run_to_failure'), redesign: cur.filter((m) => m.taskType === 'redesign') };
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// ---------- issued versions ----------

export interface JobPlanVersion {
  id: string;
  jpnum: string;
  model: string;
  hours: number;
  revision: number;
  content: JobPlanContent;
  note: string;
  issuedBy: string;
  issuedAt: Iso;
}

const contentOf = (d: JobPlanContent): JobPlanContent => ({ jpnum: d.jpnum, model: d.model, hours: d.hours, description: d.description, duration: d.duration, tasks: d.tasks });

export const latestVersion = (versions: JobPlanVersion[], jpnum: string) =>
  versions.filter((v) => v.jpnum === jpnum).sort((a, b) => b.revision - a.revision)[0];

export type PlanState = { kind: 'not_issued' } | { kind: 'issued'; version: JobPlanVersion } | { kind: 'changed'; version: JobPlanVersion };

export function planState(d: JobPlanContent, versions: JobPlanVersion[]): PlanState {
  const v = latestVersion(versions, d.jpnum);
  if (!v) return { kind: 'not_issued' };
  return stableJson(contentOf(d)) === stableJson(v.content) ? { kind: 'issued', version: v } : { kind: 'changed', version: v };
}

/** What changed between the issued revision and the draft, task by task. */
export function planChanges(d: JobPlanContent, v: JobPlanVersion | undefined): { added: JobPlanTask[]; removed: JobPlanTask[]; changed: JobPlanTask[] } {
  const old = new Map((v?.content.tasks ?? []).map((t) => [t.modeId, t]));
  const now = new Map(d.tasks.map((t) => [t.modeId, t]));
  const strip = ({ seq: _s, revision: _r, ...t }: JobPlanTask) => stableJson(t);
  return {
    added: d.tasks.filter((t) => !old.has(t.modeId)),
    removed: [...old.values()].filter((t) => !now.has(t.modeId)),
    changed: d.tasks.filter((t) => old.has(t.modeId) && strip(old.get(t.modeId)!) !== strip(t)),
  };
}

export function issueJobPlan(ctx: ConsoleContext, versions: JobPlanVersion[], draft: JobPlanContent, note: string): Ok<JobPlanVersion> | No {
  if (!can(ctx.actor, 'issue_job_plans')) return no('Your role cannot issue job plans.');
  if (!draft.tasks.length) return no('The job plan has no tasks.');
  if (!T(note)) return no('Give a note for this revision.');
  const st = planState(draft, versions);
  if (st.kind === 'issued') return no(`Nothing has changed since revision ${st.version.revision}.`);
  const prev = st.kind === 'changed' ? st.version : undefined;
  const v: JobPlanVersion = { id: ctx.newId(), jpnum: draft.jpnum, model: draft.model, hours: draft.hours, revision: (prev?.revision ?? 0) + 1, content: contentOf(draft), note: T(note), issuedBy: ctx.actor.userId, issuedAt: ctx.now };
  return { ok: true, records: [...versions, v], audit: [log(ctx, 'issue_job_plan', 'job_plan', v.id, prev ?? null, v, T(note))], warnings: [] };
}

// ---------- Maximo export ----------

type Cell = string | number;

/** docs/rcm.md "Maximo export": one sheet per Maximo object, Maximo attribute names as headers. */
export function maximoSheets(versions: JobPlanVersion[], s: RcmSettings, userName: (id: string) => string = (x) => x): Array<{ name: string; rows: Cell[][] }> {
  const org = s.maximoOrgId;
  const site = s.maximoSiteId;
  const jp: Cell[][] = [['ORGID', 'SITEID', 'JPNUM', 'DESCRIPTION', 'JPDURATION', 'STATUS']];
  const task: Cell[][] = [['ORGID', 'SITEID', 'JPNUM', 'JPTASK', 'DESCRIPTION', 'DESCRIPTION_LONGDESCRIPTION', 'TASKDURATION']];
  const lab: Cell[][] = [['ORGID', 'SITEID', 'JPNUM', 'JPTASK', 'CRAFT', 'QUANTITY', 'LABORHRS']];
  const mat: Cell[][] = [['ORGID', 'SITEID', 'JPNUM', 'JPTASK', 'ITEMNUM', 'DESCRIPTION', 'ITEMQTY']];
  const about: Cell[][] = [['JPNUM', 'Platform revision', 'Issued by', 'Issued at (UTC)', 'Note']];
  for (const v of [...versions].sort((a, b) => a.jpnum.localeCompare(b.jpnum))) {
    const c = v.content;
    jp.push([org, site, c.jpnum, c.description.slice(0, 100), c.duration, 'DRAFT']);
    for (const t of c.tasks) {
      const long = t.description.length > 100;
      task.push([org, site, c.jpnum, t.seq, long ? `${t.description.slice(0, 97)}...` : t.description, long ? t.description : '', t.hours]);
      lab.push([org, site, c.jpnum, t.seq, t.craft, t.people, t.hours]);
      for (const p of t.parts) mat.push([org, site, c.jpnum, t.seq, p.itemNum, p.description, p.qty]);
    }
    about.push([c.jpnum, v.revision, userName(v.issuedBy), v.issuedAt, v.note]);
  }
  return [{ name: 'JOBPLAN', rows: jp }, { name: 'JOBTASK', rows: task }, { name: 'JPLABOR', rows: lab }, { name: 'JPMATERIAL', rows: mat }, { name: 'About', rows: about }];
}

// ---------- review ----------

export type Verdict = 'review_task' | 'check_rtf' | 'no_failures' | 'working';
export const VERDICT_LABELS: Record<Verdict, string> = { review_task: 'Review the task', check_rtf: 'Check run to failure', no_failures: 'No failures', working: 'Working' };

const FOUND_BY_MAINTENANCE: DetectionMethod[] = ['pm', 'inspection', 'condition_monitoring'];

export interface ReviewRow { mode: RcmMode; failures: number; inOperation: number; byMaintenance: number; verdict: Verdict; eventIds: string[] }
export interface UncoveredRow { system: string; component: string; mode: string; failures: number; eventIds: string[] }
export interface Review { rows: ReviewRow[]; uncovered: UncoveredRow[]; uncoded: number; failures: number; from: Iso; to: Iso }

const key = (...p: string[]) => p.map((x) => x.trim().toLowerCase()).join('|');
const unknownMode = (m: string) => /^(unknown|other|n\/?a|not recorded)$/i.test(m.trim());

/** docs/rcm.md "Review": failures in the window matched to the model's current modes. */
export function rcmReview(modes: RcmMode[], events: DowntimeEvent[], assets: Asset[], model: string, now: Iso, s: RcmSettings = DEFAULT_RCM_SETTINGS): Review {
  const to = now;
  const from = new Date(ms(now) - s.reviewDays * 86_400_000).toISOString();
  const units = new Set(assets.filter((a) => a.model === model).map((a) => a.id));
  const cur = currentModes(modes, model);
  const index = new Map<string, RcmMode[]>();
  for (const m of cur) { const k = key(m.system, m.component, m.mode); const l = index.get(k); if (l) l.push(m); else index.set(k, [m]); }
  const tally = new Map<string, { failures: number; op: number; maint: number; ids: string[] }>(cur.map((m) => [m.modeId, { failures: 0, op: 0, maint: 0, ids: [] }]));
  const uncovered = new Map<string, UncoveredRow>();
  let uncoded = 0;
  let failures = 0;
  for (const e of events) {
    if (!e.isFailure || !units.has(e.unitId) || ms(e.start) < ms(from) || ms(e.start) > ms(to)) continue;
    failures++;
    const rel = [...e.flags].reverse().find((f) => f.release)?.release;
    const sys = rel?.system ?? e.system ?? '';
    const comp = rel?.component ?? '';
    const fms = (rel?.failureModes ?? []).filter((m) => m.trim() && !unknownMode(m));
    if (!sys || !comp || !fms.length) { uncoded++; continue; }
    const hits = new Set<RcmMode>();
    for (const fm of fms) for (const m of index.get(key(sys, comp, fm)) ?? []) hits.add(m);
    if (!hits.size) {
      const k = key(sys, comp, fms[0]!);
      const u = uncovered.get(k) ?? { system: sys, component: comp, mode: fms[0]!, failures: 0, eventIds: [] };
      u.failures++; u.eventIds.push(e.id); uncovered.set(k, u);
      continue;
    }
    const maint = !!rel?.detectionMethod && FOUND_BY_MAINTENANCE.includes(rel.detectionMethod);
    for (const m of hits) { const t = tally.get(m.modeId)!; t.failures++; t.ids.push(e.id); if (maint) t.maint++; else t.op++; }
  }
  const rows: ReviewRow[] = cur.map((m) => {
    const t = tally.get(m.modeId)!;
    const verdict: Verdict = t.failures === 0 ? 'no_failures'
      : isScheduled(m.taskType) && t.op >= s.reviewFailures ? 'review_task'
      : m.taskType === 'run_to_failure' && t.failures >= s.reviewFailures ? 'check_rtf' : 'working';
    return { mode: m, failures: t.failures, inOperation: t.op, byMaintenance: t.maint, verdict, eventIds: t.ids };
  });
  const order: Verdict[] = ['review_task', 'check_rtf', 'working', 'no_failures'];
  rows.sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || b.failures - a.failures || modeOrder(a.mode, b.mode));
  return { rows, uncovered: [...uncovered.values()].sort((a, b) => b.failures - a.failures || a.system.localeCompare(b.system)), uncoded, failures, from, to };
}

/** Models that have a library, plus every model in the fleet. */
export const rcmModels = (modes: RcmMode[], assets: Asset[]) =>
  [...new Set([...modes.map((m) => m.model), ...assets.filter((a) => a.assetClass === 'mobile').map((a) => a.model)])].sort();
