// Status board (plan 4.2, docs/status-board.md): how long each unit has been down or up,
// and the board's filters. Pure functions; durations are always calculated (rule 4).

import type { DownFlag, Iso } from './types.js';

/** Start of the downtime event an open flag belongs to: a type switch or a linked reopen keeps the first start. */
export function downSince(flag: DownFlag, flags: DownFlag[]): Iso {
  const byId = new Map(flags.map((f) => [f.id, f]));
  let start = flag.start;
  let cur: DownFlag | undefined = flag;
  const seen = new Set<string>();
  while (cur?.linkedFromFlagId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.linkedFromFlagId);
    if (cur && cur.state !== 'voided' && Date.parse(cur.start) < Date.parse(start)) start = cur.start;
  }
  return start;
}

/** When the unit last came back up: the latest release before now. Undefined when no stop is on record. */
export function upSince(unitId: string, flags: DownFlag[], now: Iso): Iso | undefined {
  const t = Date.parse(now);
  let best: number | undefined;
  for (const f of flags) {
    if (f.unitId !== unitId || f.state !== 'released' || !f.end) continue;
    const e = Date.parse(f.end);
    if (e <= t && (best === undefined || e > best)) best = e;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

export type BoardStatus = 'run' | 'sched' | 'down' | 'stale' | 'parked';

export interface StatusRow { unitId: string; unitNumber: string; model: string; status: BoardStatus; text?: string }

export interface BoardFilter {
  /** Empty: every status. */
  statuses: BoardStatus[];
  /** Empty: every model. */
  models: string[];
  q: string;
}

export const EMPTY_BOARD_FILTER: BoardFilter = { statuses: [], models: [], q: '' };

export function filterBoard<T extends StatusRow>(rows: T[], f: BoardFilter): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) =>
    (!f.statuses.length || f.statuses.includes(r.status))
    && (!f.models.length || f.models.includes(r.model))
    && (!q || [r.unitNumber, r.model, r.text ?? ''].some((v) => v.toLowerCase().includes(q))));
}

/** Counts per status for the units the model filter and search leave, so a count matches what a click shows. */
export function boardCounts(rows: StatusRow[], f: BoardFilter): Record<BoardStatus, number> {
  const out: Record<BoardStatus, number> = { run: 0, sched: 0, down: 0, stale: 0, parked: 0 };
  for (const r of filterBoard(rows, { ...f, statuses: [] })) out[r.status]++;
  return out;
}

export const toggleIn = <T>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

const STATUSES: BoardStatus[] = ['run', 'sched', 'down', 'stale', 'parked'];

/** The filter as a query string (?status=down,sched&model=793F&q=brake), so a filtered board can be shared. */
export function boardFilterToQuery(f: BoardFilter): string {
  const p = new URLSearchParams();
  if (f.statuses.length) p.set('status', f.statuses.join(','));
  if (f.models.length) p.set('model', f.models.join(','));
  if (f.q.trim()) p.set('q', f.q.trim());
  return p.toString();
}

export function boardFilterFromQuery(query: string): BoardFilter {
  const p = new URLSearchParams(query);
  const list = (k: string) => (p.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    statuses: list('status').filter((s): s is BoardStatus => (STATUSES as string[]).includes(s)),
    models: list('model'),
    q: p.get('q') ?? '',
  };
}
