// Assist: the first AI features (phase 3, plan section 9; docs/ai-assist.md).
// Guardrails first: everything here runs on the platform, learns only from the
// site's own records, suggests only codes from the site's code list, abstains
// when unsure, and every draft cites the records it came from. Nothing here
// changes a record; a person accepts a suggestion in a normal form.

import { DateTime } from 'luxon';
import type { ComponentEvent, Component } from './components.js';
import { KIND_LABELS } from './components.js';
import type { OilSample } from './condition.js';
import { COMPARTMENT_LABELS, SEVERITY_LABELS } from './condition.js';
import type { ConsoleContext } from './console.js';
import type { Rca } from './improve.js';
import type { WeeklyPack } from './pack.js';
import { can } from './permissions.js';
import { codingIssues } from './reliability.js';
import { SYSTEMS } from './synth/generate.js';
import { ms } from './time.js';
import type { Asset, AuditEntry, DownFlag, Iso, WorkOrder } from './types.js';

const DAY = 86_400_000;

// ---------- settings ----------

export interface AssistSettings {
  suggestCodes: boolean;
  minConfidence: number;
  minScore: number;
  holdoutShare: number;
  minHoldout: number;
  duplicateDays: number;
  duplicateSimilarity: number;
}

export const DEFAULT_ASSIST_SETTINGS: AssistSettings = {
  suggestCodes: false, minConfidence: 0.6, minScore: 0.8, holdoutShare: 0.2, minHoldout: 30, duplicateDays: 7, duplicateSimilarity: 0.5,
};

export function withAssistDefaults(v: Partial<AssistSettings> | undefined): AssistSettings {
  const d = DEFAULT_ASSIST_SETTINGS;
  const o = (v ?? {}) as Partial<AssistSettings>;
  const n = (x: unknown, dv: number) => (typeof x === 'number' && Number.isFinite(x) ? x : dv);
  return {
    suggestCodes: o.suggestCodes === true,
    minConfidence: n(o.minConfidence, d.minConfidence), minScore: n(o.minScore, d.minScore),
    holdoutShare: n(o.holdoutShare, d.holdoutShare), minHoldout: n(o.minHoldout, d.minHoldout),
    duplicateDays: n(o.duplicateDays, d.duplicateDays), duplicateSimilarity: n(o.duplicateSimilarity, d.duplicateSimilarity),
  };
}

type Ok<T> = { ok: true; records: T[]; audit: AuditEntry[]; warnings: string[] };
type No = { ok: false; errors: string[] };

/** Change the assist settings. Suggestions can only be switched on when the held-back check passes for at least one code. */
export function setAssistSettings(ctx: ConsoleContext, current: AssistSettings, next: AssistSettings, reason: string, check: HoldoutCheck | null): Ok<AssistSettings> | No {
  if (!can(ctx.actor, 'edit_assist')) return { ok: false, errors: ['Your role cannot change assist settings.'] };
  const e: string[] = [];
  const int = (x: number, lo: number, hi: number) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!(next.minConfidence >= 0.3 && next.minConfidence <= 0.99)) e.push('Lowest chance to suggest must be from 30% to 99%.');
  if (!(next.minScore >= 0.5 && next.minScore <= 0.99)) e.push('Score needed must be from 50% to 99%.');
  if (!(next.holdoutShare >= 0.1 && next.holdoutShare <= 0.5)) e.push('Share held back must be from 10% to 50%.');
  if (!int(next.minHoldout, 10, 1000)) e.push('Fewest held-back flags must be from 10 to 1,000.');
  if (!int(next.duplicateDays, 1, 90)) e.push('Days to compare work orders must be from 1 to 90.');
  if (!(next.duplicateSimilarity >= 0.2 && next.duplicateSimilarity <= 1)) e.push('Words in common must be from 20% to 100%.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (next.suggestCodes && !current.suggestCodes) {
    // The check must be the one for the new settings, so a change to the score needed is judged by the new score.
    const passing = check ? CODE_FIELDS.filter((f) => passes(check[f], next)) : [];
    if (!passing.length) e.push(`Code suggestions can only be switched on when the held-back score is ${pct(next.minScore)} or more on at least ${next.minHoldout} flags, for at least one code.`);
  }
  if (e.length) return { ok: false, errors: e };
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const clean = withAssistDefaults({ ...next, minConfidence: r4(next.minConfidence), minScore: r4(next.minScore), holdoutShare: r4(next.holdoutShare), duplicateSimilarity: r4(next.duplicateSimilarity) });
  const audit: AuditEntry = { at: ctx.now, userId: ctx.actor.userId, action: 'set_assist_settings', entity: 'settings', entityId: 'assist', before: current, after: clean, reason: reason.trim() };
  return { ok: true, records: [clean], audit: [audit], warnings: [] };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---------- words ----------

const STOP = new Set((
  'a an and are as at be been but by for from had has have in is it its of on or that the this to was were will with ' +
  'unit truck found noted reported checked operator tech technician crew shift after before when then also again new old ' +
  'not no did does done got get one two all some up out off into over per am pm hr hrs h'
).split(' '));

/** Lower-case words, common words dropped, a plural "s" taken off (docs/ai-assist.md AI-1). */
export function words(text: string | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    const w = raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    if (!STOP.has(w)) out.push(w);
  }
  return out;
}

/** The text assist reads for a flag: notes, work order descriptions, repair summary and findings. */
export function flagText(f: DownFlag, woByNumber?: Map<string, WorkOrder>): string {
  const wo = (f.workOrders ?? []).map((n) => woByNumber?.get(normalise(n))?.description).filter(Boolean);
  return [f.notes, ...wo, f.release?.repairSummary, f.release?.findings].filter(Boolean).join('. ');
}

const normalise = (n: string) => n.trim().toUpperCase().replace(/^WO-?/, '').replace(/^0+/, '');

export function workOrderIndex(wos: WorkOrder[]): Map<string, WorkOrder> {
  return new Map(wos.map((w) => [w.numberNormalised, w]));
}

// ---------- naive Bayes ----------

/** The site's code list: components and failure modes for each system (A9 reference list). */
export type CodeList = Record<string, { components: string[]; modes: string[] }>;

export const STARTER_CODES: CodeList = Object.fromEntries(Object.entries(SYSTEMS).map(([k, v]) => [k, { components: v.components, modes: v.modes }]));

interface NbModel {
  docs: number;
  classDocs: Map<string, number>;
  /** Word counts per class (each word once per flag). */
  wordCounts: Map<string, Map<string, number>>;
  classWords: Map<string, number>;
  vocab: Set<string>;
}

function nbTrain(rows: Array<{ words: string[]; label: string }>): NbModel {
  const m: NbModel = { docs: 0, classDocs: new Map(), wordCounts: new Map(), classWords: new Map(), vocab: new Set() };
  for (const r of rows) {
    m.docs++;
    m.classDocs.set(r.label, (m.classDocs.get(r.label) ?? 0) + 1);
    const wc = m.wordCounts.get(r.label) ?? new Map<string, number>();
    for (const w of new Set(r.words)) {
      wc.set(w, (wc.get(w) ?? 0) + 1);
      m.classWords.set(r.label, (m.classWords.get(r.label) ?? 0) + 1);
      m.vocab.add(w);
    }
    m.wordCounts.set(r.label, wc);
  }
  return m;
}

const logWord = (m: NbModel, c: string, w: string) => Math.log(((m.wordCounts.get(c)?.get(w) ?? 0) + 1) / ((m.classWords.get(c) ?? 0) + m.vocab.size));

export interface Ranked { code: string; chance: number; words: string[] }

/** Chances over the candidates only (they add to 1), best first, with the words that pointed most to each. */
function nbRank(m: NbModel, text: string[], candidates: string[], codeOf: (c: string) => string = (c) => c): Ranked[] {
  if (!candidates.length) return [];
  const ws = [...new Set(text)].filter((w) => m.vocab.has(w));
  const k = candidates.length;
  const logs = candidates.map((c) => Math.log(((m.classDocs.get(c) ?? 0) + 1) / (m.docs + k)) + ws.reduce((s, w) => s + logWord(m, c, w), 0));
  const top = Math.max(...logs);
  const ex = logs.map((l) => Math.exp(l - top));
  const sum = ex.reduce((a, b) => a + b, 0);
  const ranked = candidates.map((c, i) => ({ c, chance: ex[i]! / sum })).sort((a, b) => b.chance - a.chance || a.c.localeCompare(b.c));
  return ranked.map((r, i) => {
    const other = ranked[i === 0 ? 1 : 0]?.c;
    const lift = ws.map((w) => ({ w, d: logWord(m, r.c, w) - (other ? logWord(m, other, w) : 0) })).filter((x) => x.d > 0).sort((a, b) => b.d - a.d || a.w.localeCompare(b.w));
    return { code: codeOf(r.c), chance: r.chance, words: lift.slice(0, 3).map((x) => x.w) };
  });
}

// ---------- AI-1 failure code suggestion ----------

export type CodeField = 'system' | 'component' | 'mode';
export const CODE_FIELDS: CodeField[] = ['system', 'component', 'mode'];
export const CODE_FIELD_LABELS: Record<CodeField, string> = { system: 'System', component: 'Component', mode: 'Failure mode' };

export interface CodedRow { flagId: string; at: Iso; words: string[]; system: string; component: string; mode: string }

/** Released failure flags with clean system, component and mode, in release order (docs/ai-assist.md "What it learns from"). */
export function codedRows(flags: DownFlag[], wos: WorkOrder[], codes: CodeList): CodedRow[] {
  const idx = workOrderIndex(wos);
  const ref = Object.fromEntries(Object.entries(codes).map(([k, v]) => [k, { components: v.components }]));
  const rows: CodedRow[] = [];
  for (const f of flags) {
    if (f.type !== 'unscheduled' || f.state !== 'released' || !f.release) continue;
    const issues = codingIssues(f, ref);
    if (issues.some((i) => i !== 'no_cause')) continue;
    const system = f.release.system ?? f.system;
    const component = f.release.component;
    const mode = f.release.failureModes?.[0];
    const list = system ? codes[system] : undefined;
    if (!list || !component || !mode) continue;
    const c = list.components.find((x) => x.toLowerCase() === component.trim().toLowerCase());
    const md = list.modes.find((x) => x.toLowerCase() === mode.trim().toLowerCase());
    if (!c || !md) continue;
    const w = words(flagText(f, idx));
    if (!w.length) continue;
    rows.push({ flagId: f.id, at: f.end ?? f.start, words: w, system: system!, component: c, mode: md });
  }
  return rows.sort((a, b) => ms(a.at) - ms(b.at) || a.flagId.localeCompare(b.flagId));
}

export interface CodeModel { codes: CodeList; trainedOn: number; system: NbModel; component: NbModel; mode: NbModel }

const SEP = '\u0000';

export function trainCodes(rows: CodedRow[], codes: CodeList): CodeModel {
  return {
    codes,
    trainedOn: rows.length,
    system: nbTrain(rows.map((r) => ({ words: r.words, label: r.system }))),
    component: nbTrain(rows.map((r) => ({ words: r.words, label: r.system + SEP + r.component }))),
    mode: nbTrain(rows.map((r) => ({ words: r.words, label: r.system + SEP + r.mode }))),
  };
}

export interface CodeSuggestion {
  /** The best code for each field, or null when its chance is below the setting (abstain). */
  system: Ranked | null;
  component: Ranked | null;
  mode: Ranked | null;
  /** The best three for each field, whatever their chance, for the "why" view. */
  ranked: Record<CodeField, Ranked[]>;
}

/**
 * Suggest codes for some text. Component and mode are only from the system's own list. With
 * `givenSystem` (the person already picked it) they follow that system; otherwise the suggested one.
 */
export function suggestCodes(m: CodeModel, text: string, minConfidence: number, givenSystem?: string): CodeSuggestion {
  const w = words(text);
  const empty = { system: [], component: [], mode: [] } as Record<CodeField, Ranked[]>;
  if (!w.length || !m.trainedOn) return { system: null, component: null, mode: null, ranked: empty };
  const sysRank = nbRank(m.system, w, Object.keys(m.codes));
  const known = givenSystem && m.codes[givenSystem] ? givenSystem : undefined;
  const sysPick = known ? null : sysRank[0] && sysRank[0].chance >= minConfidence ? sysRank[0] : null;
  const sys = known ?? sysPick?.code;
  const sub = (model: NbModel, list: string[]) => (sys ? nbRank(model, w, list.map((x) => sys + SEP + x), (c) => c.split(SEP)[1]!) : []);
  const compRank = sub(m.component, sys ? m.codes[sys]!.components : []);
  const modeRank = sub(m.mode, sys ? m.codes[sys]!.modes : []);
  const ok = (r: Ranked[]) => (r[0] && r[0].chance >= minConfidence ? r[0] : null);
  return {
    system: sysPick,
    component: ok(compRank),
    mode: ok(modeRank),
    ranked: { system: sysRank.slice(0, 3), component: compRank.slice(0, 3), mode: modeRank.slice(0, 3) },
  };
}

export interface FieldScore { held: number; answered: number; right: number; precision: number | null; recall: number | null; score: number | null }
export type HoldoutCheck = Record<CodeField, FieldScore> & { trainedOn: number; held: number; heldFrom: Iso | null };

export function passes(s: FieldScore, settings: AssistSettings): boolean {
  return s.held >= settings.minHoldout && s.score !== null && s.score >= settings.minScore;
}

/** The held-back check: learn from the older flags, suggest for the latest holdoutShare, and score each code. */
export function holdoutCheck(rows: CodedRow[], codes: CodeList, settings: AssistSettings): HoldoutCheck {
  const held = Math.floor(rows.length * settings.holdoutShare);
  const train = rows.slice(0, rows.length - held);
  const test = rows.slice(rows.length - held);
  const m = trainCodes(train, codes);
  const tally = { system: { a: 0, r: 0 }, component: { a: 0, r: 0 }, mode: { a: 0, r: 0 } };
  for (const t of test) {
    const s = suggestCodes(m, t.words.join(' '), settings.minConfidence);
    const sysRight = s.system?.code === t.system;
    if (s.system) { tally.system.a++; if (sysRight) tally.system.r++; }
    if (s.component) { tally.component.a++; if (sysRight && s.component.code === t.component) tally.component.r++; }
    if (s.mode) { tally.mode.a++; if (sysRight && s.mode.code === t.mode) tally.mode.r++; }
  }
  const score = (x: { a: number; r: number }): FieldScore => {
    const precision = x.a ? x.r / x.a : null;
    const recall = held ? x.r / held : null;
    const f1 = precision !== null && recall !== null ? (precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0) : null;
    return { held, answered: x.a, right: x.r, precision, recall, score: f1 };
  };
  return { system: score(tally.system), component: score(tally.component), mode: score(tally.mode), trainedOn: train.length, held, heldFrom: test[0]?.at ?? null };
}

export interface Suggester {
  model: CodeModel;
  check: HoldoutCheck;
  /** Codes shown on screens: those that pass, and only when the setting is on. */
  live: CodeField[];
}

/** Everything a screen needs: a model on all clean flags, the held-back check, and which codes are live. */
export function buildSuggester(flags: DownFlag[], wos: WorkOrder[], codes: CodeList, settings: AssistSettings): Suggester {
  const rows = codedRows(flags, wos, codes);
  const check = holdoutCheck(rows, codes, settings);
  const live = settings.suggestCodes ? CODE_FIELDS.filter((f) => passes(check[f], settings)) : [];
  return { model: trainCodes(rows, codes), check, live };
}

/** Only the live codes of a suggestion. A component or mode needs its system to be known or live. */
export function liveSuggestion(s: CodeSuggestion, live: CodeField[], givenSystem?: string): Partial<Record<CodeField, Ranked>> {
  const out: Partial<Record<CodeField, Ranked>> = {};
  if (live.includes('system') && s.system && !givenSystem) out.system = s.system;
  const sysKnown = !!givenSystem || !!out.system;
  if (sysKnown && live.includes('component') && s.component) out.component = s.component;
  if (sysKnown && live.includes('mode') && s.mode) out.mode = s.mode;
  return out;
}

// ---------- AI-2 duplicate work orders ----------

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export interface DuplicateGroup { assetId: string; workOrders: WorkOrder[]; similarity: number }

/** Open corrective work orders on the same unit, reported close together, with alike descriptions (docs/ai-assist.md AI-2). */
export function duplicateWorkOrders(wos: WorkOrder[], settings: AssistSettings): DuplicateGroup[] {
  const open = wos.filter((w) => w.open && w.workClass === 'corrective' && w.assetId && w.reportedAt);
  const byAsset = new Map<string, Array<{ wo: WorkOrder; w: string[] }>>();
  for (const wo of open) {
    const w = words(wo.description);
    if (w.length < 2) continue;
    const l = byAsset.get(wo.assetId!) ?? [];
    l.push({ wo, w });
    byAsset.set(wo.assetId!, l);
  }
  const groups: DuplicateGroup[] = [];
  for (const [assetId, list] of byAsset) {
    list.sort((a, b) => ms(a.wo.reportedAt!) - ms(b.wo.reportedAt!) || a.wo.number.localeCompare(b.wo.number));
    const parent = list.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const best = new Map<number, number>();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (ms(list[j]!.wo.reportedAt!) - ms(list[i]!.wo.reportedAt!) > settings.duplicateDays * DAY) break;
        const s = jaccard(list[i]!.w, list[j]!.w);
        if (s < settings.duplicateSimilarity) continue;
        const a = find(i);
        const b = find(j);
        parent[b] = a;
        best.set(a, Math.max(best.get(a) ?? 0, best.get(b) ?? 0, s));
      }
    }
    const members = new Map<number, WorkOrder[]>();
    list.forEach((x, i) => { const r = find(i); members.set(r, [...(members.get(r) ?? []), x.wo]); });
    for (const [root, w] of members) if (w.length > 1) groups.push({ assetId, workOrders: w, similarity: best.get(root) ?? 0 });
  }
  return groups.sort((a, b) => ms(b.workOrders.at(-1)!.reportedAt!) - ms(a.workOrders.at(-1)!.reportedAt!));
}

// ---------- citations ----------

const CITE = /\[((?:KPI-\d{3})|(?:[a-z]+:[^\][\n]+))\]/g;

export interface CitationCheck { ok: boolean; cited: string[]; unknown: string[]; uncited: number[] }

/** Every line must cite at least one record, and only records it was given (plan 9 guardrail; docs/ai-assist.md). */
export function checkCitations(lines: string[], allowed: Set<string>): CitationCheck {
  const cited = new Set<string>();
  const unknown = new Set<string>();
  const uncited: number[] = [];
  lines.forEach((line, i) => {
    const found = [...line.matchAll(CITE)].map((m) => m[1]!);
    if (!found.length) uncited.push(i);
    for (const c of found) (allowed.has(c) ? cited : unknown).add(c);
  });
  return { ok: unknown.size === 0 && uncited.length === 0 && lines.length > 0, cited: [...cited], unknown: [...unknown], uncited };
}

export interface Draft { lines: string[]; allowed: Set<string>; check: CitationCheck }

function draft(lines: string[], allowed: Set<string>): Draft {
  return { lines, allowed, check: checkCitations(lines, allowed) };
}

// ---------- AI-3 weekly pack summary ----------

const p1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const h1 = (x: number) => `${x.toFixed(1)} h`;
const unitCite = (u: string) => `[unit:${u}]`;

/** The records a pack summary may cite: the KPIs it reports and the units and systems in it. */
export function packRecords(p: WeeklyPack): Set<string> {
  const s = new Set(['KPI-001', 'KPI-002', 'KPI-005', 'KPI-006', 'KPI-012', 'KPI-027']);
  for (const b of p.badActors) s.add(`unit:${b.unit}`);
  for (const d of p.downNow) s.add(`unit:${d.unit}`);
  for (const r of p.pareto) s.add(`system:${r.system}`);
  return s;
}

/** A draft summary from the pack's own numbers (docs/ai-assist.md AI-3). */
export function packSummary(p: WeeklyPack): Draft {
  const k = p.kpis;
  const pr = p.prior;
  const lines: string[] = [];
  const vs = (now: number | null, before: number | null) => {
    if (now === null || before === null) return '';
    const d = (now - before) * 100;
    return Math.abs(d) < 0.05 ? ', the same as the week before' : `, ${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)} points on the week before`;
  };
  if (k.pa !== null) lines.push(`PA was ${p1(k.pa)} against a target of ${p1(p.targets.pa)}${vs(k.pa, pr.pa)} [KPI-001].`);
  if (k.utilisation !== null) lines.push(`Utilisation was ${p1(k.utilisation)} against a target of ${p1(p.targets.utilisation)}${vs(k.utilisation, pr.utilisation)} [KPI-002].`);
  const mtbf = k.mtbf !== null ? `, MTBF ${h1(k.mtbf)}` : '';
  const mttr = k.mttr !== null ? `, MTTR ${h1(k.mttr)}` : '';
  lines.push(`There ${k.failures === 1 ? 'was 1 failure' : `were ${k.failures} failures`} (${pr.failures} the week before)${mtbf}${mttr} [KPI-005] [KPI-006].`);
  const total = p.pareto.reduce((s, r) => s + r.hours, 0);
  const top = p.pareto[0];
  if (top && total > 0) lines.push(`${top.system} lost the most time: ${h1(top.hours)} over ${top.events} ${top.events === 1 ? 'event' : 'events'}, ${p1(top.hours / total)} of unscheduled down hours [system:${top.system}].`);
  const bad = p.badActors[0];
  if (bad) lines.push(`The worst unit was ${bad.unit} (${bad.model}) with ${h1(bad.unscheduledDownHours)} unscheduled down${bad.topSystem ? `, mostly ${bad.topSystem}` : ''} [KPI-027] ${unitCite(bad.unit)}.`);
  const rel = p.shop.releaseVsPlan;
  if (rel.due > 0 && rel.rate !== null) lines.push(`${rel.onTime} of ${rel.due} shop releases were on or before their ETA (${p1(rel.rate)}) [KPI-012].`);
  if (p.downNow.length) {
    const d = p.downNow[0]!;
    const n = p.downNow.length;
    lines.push(`${n} ${n === 1 ? 'unit is' : 'units are'} down now; the longest is ${d.unit}, down ${h1(d.hours)} for ${d.reason} ${unitCite(d.unit)}.`);
  }
  return draft(lines, packRecords(p));
}

// ---------- AI-4 RCA timeline ----------

export interface TimelineInput {
  rca: Rca;
  flags: DownFlag[];
  workOrders: WorkOrder[];
  components: Component[];
  componentEvents: ComponentEvent[];
  oilSamples: OilSample[];
  assets: Asset[];
  timeZone: string;
  now: Iso;
}

const STAGE_TEXT: Record<string, string> = {
  waiting_crew: 'Waiting for crew', in_transit: 'In transit', waiting_line: 'Waiting for a line', in_repair: 'In repair',
  waiting_parts: 'Waiting for parts', waiting_labour: 'Waiting for labour', waiting_other: 'Waiting other', ready_for_release: 'Ready for release',
};
const LOC_TEXT: Record<string, string> = { field: 'Down in field', towing: 'Towing', shop_yard: 'Shop yard', shop_line: 'Shop line', in_place: 'In place' };
const EVENT_TEXT: Record<string, string> = {
  received: 'received', installed: 'installed', removed: 'removed', sent_rebuild: 'sent to rebuild', returned_rebuild: 'back from rebuild',
  core_returned: 'core returned', warranty_claim: 'warranty claim', scrapped: 'scrapped',
};

/** A draft timeline of the flags under study, from their records only (docs/ai-assist.md AI-4). */
export function rcaTimeline(i: TimelineInput): Draft & { rows: Array<{ at: Iso; text: string; cite: string }> } {
  const flags = i.flags.filter((f) => i.rca.flagIds.includes(f.id) && f.state !== 'voided' && f.state !== 'proposed');
  const unit = new Map(i.assets.map((a) => [a.id, a.unitNumber]));
  const rows: Array<{ at: Iso; text: string; cite: string; order: number }> = [];
  const allowed = new Set<string>();
  const add = (at: Iso | undefined, unitId: string | undefined, text: string, cite: string, order = 0) => {
    if (!at) return;
    allowed.add(cite);
    rows.push({ at, text: `${unitId ? `${unit.get(unitId) ?? unitId}: ` : ''}${text}`, cite, order });
  };
  const wo = workOrderIndex(i.workOrders);
  const units = new Set(flags.map((f) => f.unitId));
  for (const f of flags) {
    const c = `flag:${f.id}`;
    add(f.start, f.unitId, `${f.type === 'scheduled' ? 'Scheduled' : 'Unscheduled'} down flag set, ${f.release?.system ?? f.system ?? f.reasonCode}`, c, 0);
    for (const l of f.locations) add(l.start, f.unitId, `Location ${LOC_TEXT[l.kind] ?? l.kind}${l.reason ? ` (${l.reason})` : ''}`, c, 1);
    for (const s of f.stages) add(s.start, f.unitId, `Stage ${STAGE_TEXT[s.stage] ?? s.stage}${s.reason ? ` (${s.reason})` : ''}${s.partOrWorkOrder ? `, ${s.partOrWorkOrder}` : ''}`, c, 2);
    for (const e of f.etas) add(e.setAt, f.unitId, `ETA set for ${fmt(e.eta, i.timeZone)}`, c, 3);
    if (f.state === 'released' && f.end) {
      const r = f.release ?? {};
      const code = [r.system, r.component, r.failureModes?.join(', ')].filter(Boolean).join(' / ');
      const extra = [r.repairSummary && `repair: ${r.repairSummary}`, r.findings && `findings: ${r.findings}`].filter(Boolean).join('; ');
      add(f.end, f.unitId, `Released${code ? `, coded ${code}` : ''}${extra ? `; ${extra}` : ''}`, c, 4);
    }
    for (const n of f.workOrders) {
      const w = wo.get(normalise(n));
      if (!w) continue;
      const wc = `wo:${w.number}`;
      add(w.reportedAt, f.unitId, `Work order ${w.number} reported${w.description ? `: ${w.description}` : ''}`, wc, 0);
      add(w.completedAt, f.unitId, `Work order ${w.number} completed`, wc, 5);
    }
  }
  if (flags.length) {
    const from = Math.min(...flags.map((f) => ms(f.start))) - 30 * DAY;
    const to = Math.max(...flags.map((f) => ms(f.end ?? i.now)));
    const inWindow = (at: Iso) => ms(at) >= from && ms(at) <= to;
    const comp = new Map(i.components.map((c) => [c.id, c]));
    for (const e of i.componentEvents) {
      if (e.voidedAt || !e.unitId || !units.has(e.unitId) || !inWindow(e.at)) continue;
      if (e.kind !== 'installed' && e.kind !== 'removed') continue;
      const c = comp.get(e.componentId);
      add(e.at, e.unitId, `${c ? `${KIND_LABELS[c.kind] ?? c.kind} ${c.serial}` : 'Component'} ${EVENT_TEXT[e.kind]}${e.reason ? ` (${e.reason})` : ''}`, `component:${e.id}`, 1);
    }
    for (const s of i.oilSamples) {
      // Normal samples are left out: they would bury the ones that matter.
      if (s.voidedAt || s.severity === 'normal' || !units.has(s.unitId) || !inWindow(s.takenAt)) continue;
      const why = s.reasons.map((x) => x.trim().replace(/\.$/, '')).filter(Boolean).join('; ');
      add(s.takenAt, s.unitId, `Oil sample, ${COMPARTMENT_LABELS[s.compartment] ?? s.compartment}: ${SEVERITY_LABELS[s.severity] ?? s.severity}${why ? `. ${why}` : ''}`, `oil:${s.id}`, 1);
    }
  }
  rows.sort((a, b) => ms(a.at) - ms(b.at) || a.order - b.order);
  const out = rows.map(({ order: _o, ...r }) => r);
  return { ...draft(out.map((r) => `${fmt(r.at, i.timeZone)}  ${r.text} [${r.cite}]`), allowed), rows: out };
}

const fmt = (at: Iso, tz: string) => DateTime.fromISO(at, { zone: tz }).toFormat('ccc d LLL HH:mm');

// ---------- AI-5 questions (Claude, through the assist-ask Edge Function) ----------

/** What a question may draw on: the KPI dictionary and the pack numbers the person already sees (docs/ai-assist.md AI-5). */
export interface AskContext {
  week: string;
  partial: boolean;
  timeZone: string;
  targets: { pa: number; utilisation: number };
  kpis: AskKpis;
  prior: AskKpis;
  trend: Array<{ week: string; pa: number | null; utilisation: number | null; mtbf: number | null; failures: number }>;
  pareto: Array<{ system: string; hours: number; events: number }>;
  badActors: Array<{ unit: string; model: string; unscheduledDownHours: number; failures: number; pa: number | null; topSystem: string }>;
  downNow: Array<{ unit: string; hours: number; reason: string; stage: string | null }>;
  shopRelease: { due: number; onTime: number; rate: number | null };
  dictionary: string;
}

export interface AskKpis {
  pa: number | null; utilisation: number | null; mtbf: number | null; mttr: number | null; meanDowntime: number | null;
  failures: number; minorStops: number; downHours: number; scheduledDownHours: number; unscheduledDownHours: number; operatingHours: number;
}

const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);
const askKpis = (k: WeeklyPack['kpis']): AskKpis => ({
  pa: r3(k.pa), utilisation: r3(k.utilisation), mtbf: r3(k.mtbf), mttr: r3(k.mttr), meanDowntime: r3(k.meanDowntime),
  failures: k.failures, minorStops: k.minorStops, downHours: r3(k.downHours)!, scheduledDownHours: r3(k.scheduledDownHours)!,
  unscheduledDownHours: r3(k.unscheduledDownHours)!, operatingHours: r3(k.operatingHours)!,
});

/** The context sent with a question: numbers only, no people's names, no costs, no free text from flags. */
export function askContext(p: WeeklyPack, dictionary: string, trendWeeks = 8): AskContext {
  return {
    week: p.week.label, partial: p.partial, timeZone: p.timeZone, targets: p.targets,
    kpis: askKpis(p.kpis), prior: askKpis(p.prior),
    trend: p.trend.slice(-trendWeeks).map((t) => ({ week: t.label, pa: r3(t.pa), utilisation: r3(t.utilisation), mtbf: r3(t.mtbf), failures: t.failures })),
    pareto: p.pareto.slice(0, 10).map((x) => ({ system: x.system, hours: r3(x.hours)!, events: x.events })),
    badActors: p.badActors.slice(0, 10).map((b) => ({ ...b, unscheduledDownHours: r3(b.unscheduledDownHours)!, pa: r3(b.pa) })),
    downNow: p.downNow.map((d) => ({ unit: d.unit, hours: r3(d.hours)!, reason: d.reason, stage: d.stage ?? null })),
    shopRelease: p.shop.releaseVsPlan,
    dictionary,
  };
}

/** Records an answer may cite (mirrored in supabase/functions/assist-ask/logic.ts; a test keeps them the same). */
export function askRecords(c: AskContext): Set<string> {
  const s = new Set<string>();
  for (const m of c.dictionary.matchAll(/KPI-\d{3}/g)) s.add(m[0]);
  for (const t of c.trend) s.add(`week:${t.week}`);
  s.add(`week:${c.week}`);
  for (const b of c.badActors) s.add(`unit:${b.unit}`);
  for (const d of c.downNow) s.add(`unit:${d.unit}`);
  for (const x of c.pareto) s.add(`system:${x.system}`);
  return s;
}
