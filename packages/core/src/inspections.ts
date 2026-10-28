// Inspections (phase 2; docs/inspections.md): versioned forms, recurrence
// by site days or SMU hours, scoring, sign-off by someone else, and defects
// turned into follow-ups. Pure functions; drafts and the outbox are the app's.

import type { ConsoleContext } from './console.js';
import { siteToday } from './improve.js';
import { can, permission } from './permissions.js';
import { ms } from './time.js';
import type { Asset, AssetClass, AuditEntry, Iso, SmuReading } from './types.js';

export type ItemKind = 'pass_fail' | 'rating' | 'reading' | 'note';

export interface FormItem {
  id: string;
  section: string;
  text: string;
  kind: ItemKind;
  critical: boolean;
  /** Default 1. */
  weight: number;
  /** A failed item needs a photo. */
  photoOnFail: boolean;
  /** Readings only. */
  min?: number;
  max?: number;
  unit?: string;
}

export interface InspectionForm {
  /** Same across versions. */
  id: string;
  version: number;
  name: string;
  assetClass: AssetClass;
  /** Empty: every model of the class. */
  models: string[];
  every: { n: number; unit: 'days' | 'smu_hours' };
  items: FormItem[];
  createdBy: string;
  createdAt: Iso;
  reason: string;
  retiredAt?: Iso;
  retiredReason?: string;
}

export interface Answer {
  /** pass_fail: 'pass' | 'fail'; rating: 1 to 5; reading: number; note: text. null = N/A. */
  value: string | number | null;
  note?: string;
  /** Photo ids. */
  photos?: string[];
}

export type DefectSeverity = 'low' | 'medium' | 'high';
export type DefectStatus = 'open' | 'action' | 'work_order' | 'flagged_down' | 'closed';

export interface Defect {
  id: string;
  itemId?: string;
  text: string;
  severity: DefectSeverity;
  status: DefectStatus;
  actionId?: string;
  workOrder?: string;
  closeNote?: string;
  updatedBy?: string;
  updatedAt?: Iso;
}

export type InspectionStatus = 'draft' | 'submitted' | 'signed_off' | 'voided';
export type InspectionResult = 'pass' | 'defects' | 'fail';

export interface Inspection {
  id: string;
  formId: string;
  formVersion: number;
  unitId: string;
  smu?: number;
  status: InspectionStatus;
  answers: Record<string, Answer>;
  defects: Defect[];
  startedBy: string;
  startedAt: Iso;
  submittedAt?: Iso;
  score?: number | null;
  result?: InspectionResult;
  signedOffBy?: string;
  signedOffAt?: Iso;
  signOffNote?: string;
  voidedBy?: string;
  voidedAt?: Iso;
  voidReason?: string;
}

export const RESULT_LABELS: Record<InspectionResult, string> = { pass: 'Pass', defects: 'Defects found', fail: 'Fail' };
export const DEFECT_STATUS_LABELS: Record<DefectStatus, string> = { open: 'Open', action: 'Action raised', work_order: 'Work order raised', flagged_down: 'Unit flagged down', closed: 'Closed' };

type Ok<T> = { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };
const no = (...errors: string[]): No => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, entity: 'inspection' | 'inspection_form', id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, reason });

// ---------- forms ----------

export const latestForms = (forms: InspectionForm[]): InspectionForm[] => {
  const m = new Map<string, InspectionForm>();
  for (const f of forms) if (!m.has(f.id) || m.get(f.id)!.version < f.version) m.set(f.id, f);
  return [...m.values()];
};
export const formVersion = (forms: InspectionForm[], id: string, version: number) => forms.find((f) => f.id === id && f.version === version);
export const appliesTo = (f: InspectionForm, a: Asset) => f.assetClass === a.assetClass && (!f.models.length || f.models.includes(a.model));

export type FormInput = Pick<InspectionForm, 'name' | 'assetClass' | 'models' | 'every' | 'items'>;

function checkForm(input: FormInput): string[] {
  const e: string[] = [];
  if (!input.name.trim()) e.push('Name the form.');
  if (!Number.isInteger(input.every.n) || input.every.n < 1 || input.every.n > (input.every.unit === 'days' ? 366 : 20000)) e.push('Set how often it is due.');
  if (!input.items.length) e.push('Add at least one item.');
  const ids = new Set<string>();
  input.items.forEach((it, i) => {
    const at = `Item ${i + 1}`;
    if (!it.text.trim()) e.push(`${at}: write the question.`);
    if (ids.has(it.id)) e.push(`${at}: duplicate id.`);
    ids.add(it.id);
    if (!(it.weight > 0) || it.weight > 10) e.push(`${at}: weight is above 0 and up to 10.`);
    if (it.kind === 'reading' && it.min === undefined && it.max === undefined) e.push(`${at}: a reading needs a lower or upper limit.`);
    if (it.kind === 'reading' && it.min !== undefined && it.max !== undefined && it.min > it.max) e.push(`${at}: the lower limit is above the upper limit.`);
    if (it.kind === 'note' && it.critical) e.push(`${at}: a note cannot be critical.`);
  });
  return e;
}

/** A new form, or a new version of one. Earlier versions stay for past inspections. */
export function saveForm(ctx: ConsoleContext, forms: InspectionForm[], id: string | null, input: FormInput, reason: string): Ok<InspectionForm> | No {
  if (!can(ctx.actor, 'edit_inspection_forms')) return no('Your role cannot change inspection forms.');
  const e = checkForm(input);
  const prev = id ? latestForms(forms).find((f) => f.id === id) : undefined;
  if (id && !prev) e.push('Form not found.');
  if (prev?.retiredAt) e.push('That form is retired.');
  if (!reason.trim()) e.push('Give a reason.');
  if (e.length) return no(...e);
  const f: InspectionForm = {
    id: prev?.id ?? ctx.newId(), version: (prev?.version ?? 0) + 1, name: input.name.trim(), assetClass: input.assetClass, models: input.models,
    every: input.every, items: input.items.map((it) => ({ ...it, text: it.text.trim(), section: it.section.trim() || 'General', weight: it.weight || 1 })),
    createdBy: ctx.actor.userId, createdAt: ctx.now, reason: reason.trim(),
  };
  return { ok: true, records: [...forms, f], audit: [log(ctx, prev ? 'new_form_version' : 'add_form', 'inspection_form', f.id, prev ?? null, f, f.reason)], warnings: [] };
}

export function retireForm(ctx: ConsoleContext, forms: InspectionForm[], id: string, reason: string): Ok<InspectionForm> | No {
  if (!can(ctx.actor, 'edit_inspection_forms')) return no('Your role cannot change inspection forms.');
  const f = latestForms(forms).find((x) => x.id === id);
  if (!f || f.retiredAt) return no('That form is not active.');
  if (!reason.trim()) return no('Give a reason.');
  const after = { ...f, retiredAt: ctx.now, retiredReason: reason.trim() };
  return { ok: true, records: forms.map((x) => (x === f ? after : x)), audit: [log(ctx, 'retire_form', 'inspection_form', id, f, after, reason.trim())], warnings: [] };
}

// ---------- scoring ----------

export function itemFailed(it: FormItem, a: Answer | undefined): boolean {
  if (!a || a.value === null || a.value === undefined || a.value === '') return false;
  if (it.kind === 'pass_fail') return a.value === 'fail';
  if (it.kind === 'rating') return Number(a.value) <= 2;
  if (it.kind === 'reading') {
    const v = Number(a.value);
    return (it.min !== undefined && v < it.min) || (it.max !== undefined && v > it.max);
  }
  return false;
}

function itemScore(it: FormItem, a: Answer): number | null {
  if (a.value === null || a.value === '' || it.kind === 'note') return null;
  if (it.kind === 'pass_fail') return a.value === 'pass' ? 1 : 0;
  if (it.kind === 'rating') return (Number(a.value) - 1) / 4;
  return itemFailed(it, a) ? 0 : 1;
}

export function scoreInspection(form: InspectionForm, answers: Record<string, Answer>): { score: number | null; result: InspectionResult; failed: FormItem[] } {
  let w = 0;
  let s = 0;
  const failed: FormItem[] = [];
  for (const it of form.items) {
    const a = answers[it.id];
    if (!a) continue;
    const x = itemScore(it, a);
    if (x !== null) { w += it.weight; s += it.weight * x; }
    if (itemFailed(it, a)) failed.push(it);
  }
  const result: InspectionResult = failed.some((it) => it.critical) ? 'fail' : failed.length ? 'defects' : 'pass';
  return { score: w ? s / w : null, result, failed };
}

/** Problems that stop an inspection being submitted. */
export function submitProblems(form: InspectionForm, answers: Record<string, Answer>): string[] {
  const e: string[] = [];
  form.items.forEach((it, i) => {
    const a = answers[it.id];
    const at = `${i + 1}. ${it.text}`;
    const blank = !a || a.value === undefined || a.value === '';
    if (it.kind !== 'note' && blank) { e.push(`${at}: not answered.`); return; }
    if (it.critical && a && a.value === null) { e.push(`${at}: critical, so it cannot be N/A.`); return; }
    if (it.kind === 'rating' && a && a.value !== null && ![1, 2, 3, 4, 5].includes(Number(a.value))) e.push(`${at}: rate 1 to 5.`);
    if (it.kind === 'reading' && a && a.value !== null && !Number.isFinite(Number(a.value))) e.push(`${at}: enter a number.`);
    if (itemFailed(it, a)) {
      if (!a!.note?.trim()) e.push(`${at}: failed, so add a note.`);
      if (it.photoOnFail && !a!.photos?.length) e.push(`${at}: failed, so add a photo.`);
    }
  });
  return e;
}

// ---------- doing one ----------

export function startInspection(ctx: ConsoleContext, list: Inspection[], form: InspectionForm, unit: Asset, smu?: number): Ok<Inspection> | No {
  if (!can(ctx.actor, 'add_notes')) return no('Your role cannot do inspections.');
  if (form.retiredAt) return no('That form is retired.');
  if (!appliesTo(form, unit)) return no(`${form.name} does not apply to ${unit.unitNumber}.`);
  if (smu !== undefined && !(smu >= 0)) return no('The SMU reading must be a number.');
  const i: Inspection = { id: ctx.newId(), formId: form.id, formVersion: form.version, unitId: unit.id, smu, status: 'draft', answers: {}, defects: [], startedBy: ctx.actor.userId, startedAt: ctx.now };
  return { ok: true, records: [...list, i], audit: [], warnings: [] };
}

/** Defects for failed items, keeping any the inspector already edited or added. */
export function defectsFor(ctx: ConsoleContext, form: InspectionForm, i: Inspection): Defect[] {
  const { failed } = scoreInspection(form, i.answers);
  const kept = i.defects.filter((d) => !d.itemId || failed.some((f) => f.id === d.itemId));
  const added = failed.filter((f) => !kept.some((d) => d.itemId === f.id)).map((f): Defect => ({
    id: ctx.newId(), itemId: f.id, text: `${f.text}${i.answers[f.id]?.note ? `: ${i.answers[f.id]!.note}` : ''}`, severity: f.critical ? 'high' : 'medium', status: 'open',
  }));
  return [...kept, ...added];
}

export function submitInspection(ctx: ConsoleContext, list: Inspection[], form: InspectionForm, i: Inspection): Ok<Inspection> | No {
  if (i.startedBy !== ctx.actor.userId) return no('Only the person who started it submits it.');
  if (i.status !== 'draft') return no('It is already submitted.');
  if (form.id !== i.formId || form.version !== i.formVersion) return no('Wrong form version.');
  const e = submitProblems(form, i.answers);
  if (e.length) return no(...e);
  const { score, result } = scoreInspection(form, i.answers);
  const done: Inspection = { ...i, status: 'submitted', submittedAt: ctx.now, score, result, defects: defectsFor(ctx, form, i) };
  return { ok: true, records: list.map((x) => (x.id === i.id ? done : x)).concat(list.some((x) => x.id === i.id) ? [] : [done]), audit: [log(ctx, 'submit_inspection', 'inspection', i.id, null, done)], warnings: result === 'fail' ? ['A critical item failed. Check whether the unit should be flagged down.'] : [] };
}

export function signOff(ctx: ConsoleContext, list: Inspection[], id: string, note: string): Ok<Inspection> | No {
  if (permission(ctx.actor.role, 'sign_off_inspections') !== 'yes') return no('A supervisor or superintendent signs off inspections.');
  const i = list.find((x) => x.id === id);
  if (!i || i.status !== 'submitted') return no('Only a submitted inspection can be signed off.');
  if (i.startedBy === ctx.actor.userId) return no('Someone other than the inspector signs it off.');
  const done: Inspection = { ...i, status: 'signed_off', signedOffBy: ctx.actor.userId, signedOffAt: ctx.now, signOffNote: note.trim() || undefined };
  return { ok: true, records: list.map((x) => (x.id === id ? done : x)), audit: [log(ctx, 'sign_off_inspection', 'inspection', id, i, done, note.trim() || undefined)], warnings: [] };
}

export function voidInspection(ctx: ConsoleContext, list: Inspection[], id: string, reason: string): Ok<Inspection> | No {
  const i = list.find((x) => x.id === id);
  if (!i || i.status === 'voided') return no('Not found.');
  const mineDraft = i.status === 'draft' && i.startedBy === ctx.actor.userId;
  if (!mineDraft && permission(ctx.actor.role, 'sign_off_inspections') !== 'yes') return no('A supervisor or superintendent voids a submitted inspection.');
  if (!reason.trim()) return no('Give a reason.');
  const done: Inspection = { ...i, status: 'voided', voidedBy: ctx.actor.userId, voidedAt: ctx.now, voidReason: reason.trim() };
  return { ok: true, records: list.map((x) => (x.id === id ? done : x)), audit: [log(ctx, 'void_inspection', 'inspection', id, i, done, reason.trim())], warnings: [] };
}

export interface DefectUpdate { status: DefectStatus; actionId?: string; workOrder?: string; closeNote?: string; severity?: DefectSeverity }

export function updateDefect(ctx: ConsoleContext, list: Inspection[], inspectionId: string, defectId: string, u: DefectUpdate): Ok<Inspection> | No {
  if (!can(ctx.actor, 'add_notes')) return no('Your role cannot follow up defects.');
  const i = list.find((x) => x.id === inspectionId);
  const d = i?.defects.find((x) => x.id === defectId);
  if (!i || !d || i.status === 'draft' || i.status === 'voided') return no('Defect not found.');
  const e: string[] = [];
  if (u.status === 'action' && !u.actionId) e.push('Pick the action.');
  if (u.status === 'work_order' && !u.workOrder?.trim()) e.push('Enter the work order number.');
  if (u.status === 'closed' && !u.closeNote?.trim()) e.push('Say how it was closed.');
  if (e.length) return no(...e);
  const nd: Defect = {
    ...d, status: u.status, severity: u.severity ?? d.severity, actionId: u.status === 'action' ? u.actionId : d.actionId,
    workOrder: u.status === 'work_order' ? u.workOrder!.trim() : d.workOrder, closeNote: u.status === 'closed' ? u.closeNote!.trim() : d.closeNote,
    updatedBy: ctx.actor.userId, updatedAt: ctx.now,
  };
  const after = { ...i, defects: i.defects.map((x) => (x.id === defectId ? nd : x)) };
  return { ok: true, records: list.map((x) => (x.id === inspectionId ? after : x)), audit: [log(ctx, `defect_${u.status}`, 'inspection', inspectionId, d, nd, nd.closeNote)], warnings: [] };
}

// ---------- due list ----------

export type DueState = 'overdue' | 'due_soon' | 'ok' | 'never';

export interface DueRow {
  unit: Asset;
  form: InspectionForm;
  last?: Inspection;
  state: DueState;
  /** Site date for day forms. */
  dueDate?: string;
  /** SMU hours for hour forms. */
  dueSmu?: number;
  currentSmu?: number;
}

/** Latest SMU reading at or before now. */
export function smuNow(smu: SmuReading[], unitId: string, now: Iso): number | undefined {
  let best: SmuReading | undefined;
  for (const r of smu) if (r.unitId === unitId && ms(r.at) <= ms(now) && (!best || ms(r.at) > ms(best.at))) best = r;
  return best?.hours;
}

export function dueList(forms: InspectionForm[], assets: Asset[], list: Inspection[], smu: SmuReading[], now: Iso, tz: string): DueRow[] {
  const today = siteToday(now, tz);
  const rows: DueRow[] = [];
  for (const form of latestForms(forms).filter((f) => !f.retiredAt)) {
    for (const unit of assets.filter((a) => appliesTo(form, a))) {
      const done = list.filter((i) => i.formId === form.id && i.unitId === unit.id && (i.status === 'submitted' || i.status === 'signed_off'))
        .sort((a, b) => ms(b.submittedAt!) - ms(a.submittedAt!));
      const last = done[0];
      if (!last) { rows.push({ unit, form, state: 'never' }); continue; }
      if (form.every.unit === 'days') {
        const dueDate = siteToday(last.submittedAt!, tz, form.every.n);
        // Due soon within 2 days, shorter for short intervals (a daily form: only on the day).
        const soon = Math.min(2, form.every.n - 1);
        const state: DueState = dueDate < today ? 'overdue' : dueDate <= siteToday(now, tz, soon) ? 'due_soon' : 'ok';
        rows.push({ unit, form, last, state, dueDate });
      } else {
        const cur = smuNow(smu, unit.id, now);
        const base = last.smu ?? smuNow(smu, unit.id, last.submittedAt!);
        if (base === undefined || cur === undefined) { rows.push({ unit, form, last, state: 'ok', currentSmu: cur }); continue; }
        const dueSmu = base + form.every.n;
        const state: DueState = cur > dueSmu ? 'overdue' : cur >= dueSmu - form.every.n * 0.1 ? 'due_soon' : 'ok';
        rows.push({ unit, form, last, state, dueSmu, currentSmu: cur });
      }
    }
  }
  const order: Record<DueState, number> = { overdue: 0, due_soon: 1, never: 2, ok: 3 };
  return rows.sort((a, b) => order[a.state] - order[b.state] || a.unit.unitNumber.localeCompare(b.unit.unitNumber));
}

/** Open defects across inspections, newest first. */
export const openDefects = (list: Inspection[]) =>
  list.filter((i) => i.status === 'submitted' || i.status === 'signed_off')
    .flatMap((i) => i.defects.filter((d) => d.status === 'open').map((d) => ({ inspection: i, defect: d })))
    .sort((a, b) => ms(b.inspection.submittedAt!) - ms(a.inspection.submittedAt!));
