// Pure parts of the assist-ask Edge Function (docs/ai-assist.md AI-5): no Deno or
// npm imports, so the core tests can run them. The citation rule mirrors
// checkCitations and askRecords in packages/core/src/assist.ts; a test keeps them
// the same.

export const MODEL = 'claude-opus-5-5';
export const MAX_QUESTION = 500;
export const MAX_CONTEXT_BYTES = 80_000;

export interface AskRequest {
  siteId: string;
  question: string;
  context: AskContextIn;
}

/** The shape the app sends (AskContext in core). Only the fields used here are typed. */
export interface AskContextIn {
  week: string;
  trend: Array<{ week: string }>;
  pareto: Array<{ system: string }>;
  badActors: Array<{ unit: string }>;
  downNow: Array<{ unit: string }>;
  dictionary: string;
  [k: string]: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arr = (x: unknown) => Array.isArray(x);

/** Check the request body. Returns an error sentence, or null when it is fine. */
export function badRequest(body: unknown, bytes: number): string | null {
  if (bytes > MAX_CONTEXT_BYTES) return 'The request is too large.';
  const b = body as Partial<AskRequest> | null;
  if (!b || typeof b !== 'object') return 'Send a JSON body.';
  if (typeof b.siteId !== 'string' || !UUID.test(b.siteId)) return 'Give the site.';
  if (typeof b.question !== 'string' || !b.question.trim()) return 'Type a question.';
  if (b.question.length > MAX_QUESTION) return `Keep the question to ${MAX_QUESTION} characters.`;
  const c = b.context as Partial<AskContextIn> | undefined;
  if (!c || typeof c.week !== 'string' || typeof c.dictionary !== 'string' || !arr(c.trend) || !arr(c.pareto) || !arr(c.badActors) || !arr(c.downNow)) return 'The numbers to answer from are missing.';
  return null;
}

export function allowedRecords(c: AskContextIn): Set<string> {
  const s = new Set<string>();
  for (const m of c.dictionary.matchAll(/KPI-\d{3}/g)) s.add(m[0]);
  for (const t of c.trend) s.add(`week:${t.week}`);
  s.add(`week:${c.week}`);
  for (const b of c.badActors) s.add(`unit:${b.unit}`);
  for (const d of c.downNow) s.add(`unit:${d.unit}`);
  for (const x of c.pareto) s.add(`system:${x.system}`);
  return s;
}

const CITE = /\[((?:KPI-\d{3})|(?:[a-z]+:[^\][\n]+))\]/g;

export interface Checked { ok: boolean; cited: string[]; unknown: string[]; uncited: number[] }

export function checkLines(lines: string[], allowed: Set<string>): Checked {
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

/** Structured output: a list of short cited lines, or a plain "cannot answer" with a reason. */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answerable: { type: 'boolean' },
    lines: { type: 'array', items: { type: 'string' } },
  },
  required: ['answerable', 'lines'],
  additionalProperties: false,
} as const;

/** Kept the same for every request so it can be cached. The question and numbers go in the user turn. */
export const SYSTEM = `You answer questions from maintenance and reliability people at a mine about their fleet's weekly numbers.

You are given two things in the user turn: the site's KPI dictionary (the only definitions to use) and the numbers from the weekly pack that the person can already see. Answer only from those. Do not use outside knowledge about the site, and do not guess numbers you were not given.

Answer as a list of short lines in plain English, a few lines at most. Each line must end with the records it used, in square brackets, chosen from:
- [KPI-001] style ids from the dictionary, for a definition or a KPI value
- [week:<label>] for a week in the trend, using the label exactly as given
- [unit:<unit number>] for a unit in the bad actors or down now
- [system:<name>] for a system in the Pareto, using the name exactly as given
Every line needs at least one of these, and only these.

If the numbers cannot answer the question, set answerable to false and give one or two lines saying what is missing, still cited (for example the KPI it would need). Never give advice that changes records; people do that in the platform.

Numbers: PA, utilisation and shares are fractions (0.905 means 90.5%); write them as percentages with one decimal. Hours with one decimal.`;

export function userTurn(question: string, context: AskContextIn): string {
  const { dictionary, ...numbers } = context;
  return `<kpi_dictionary>\n${dictionary}\n</kpi_dictionary>\n\n<weekly_pack_numbers>\n${JSON.stringify(numbers)}\n</weekly_pack_numbers>\n\n<question>\n${question.trim()}\n</question>`;
}

/** Parse the model's JSON answer. Returns null when it is not the agreed shape. */
export function parseAnswer(text: string): { answerable: boolean; lines: string[] } | null {
  try {
    const v = JSON.parse(text) as { answerable?: unknown; lines?: unknown };
    if (typeof v.answerable !== 'boolean' || !Array.isArray(v.lines) || !v.lines.every((l) => typeof l === 'string')) return null;
    const lines = (v.lines as string[]).map((l) => l.trim()).filter(Boolean).slice(0, 12);
    return { answerable: v.answerable, lines };
  } catch {
    return null;
  }
}
