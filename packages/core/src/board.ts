// Status board (plan 4.2, docs/status-board.md): how long each unit has been down or up,
// and the board's filters. Pure functions; durations are always calculated (rule 4).

import type { StandbyFlag } from './standby.js';
import { STAGE_LABELS, type DownFlag, type Iso, type Stage } from './types.js';

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

/**
 * When the unit last came back into use: the latest release, or end of a standby flag
 * (docs/standby.md), at or before now. Undefined when no stop is on record.
 */
export function upSince(unitId: string, flags: DownFlag[], now: Iso, standby: Array<Pick<StandbyFlag, 'unitId' | 'state' | 'end'>> = []): Iso | undefined {
  const t = Date.parse(now);
  let best: number | undefined;
  const ends = [
    ...flags.filter((f) => f.unitId === unitId && f.state === 'released').map((f) => f.end),
    ...standby.filter((s) => s.unitId === unitId && s.state === 'ended').map((s) => s.end),
  ];
  for (const end of ends) {
    if (!end) continue;
    const e = Date.parse(end);
    if (e <= t && (best === undefined || e > best)) best = e;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

/** The three broad statuses (Ope, 29 Oct 2026, docs/status-board.md). Parked is a tag under any of them. */
export type BoardGroup = 'operational' | 'sched' | 'unsched';
export const BOARD_GROUPS: readonly BoardGroup[] = ['operational', 'sched', 'unsched'];

/** Sub-status: in use, standby or parked when operational, the current stage when down. */
export type BoardSub = 'in_use' | 'standby' | 'parked' | 'no_stage' | Stage;

export const BOARD_SUB_LABELS: Record<BoardSub, string> = { in_use: 'In use', standby: 'Standby', parked: 'Parked', no_stage: 'No stage set', ...STAGE_LABELS };

/**
 * Where a unit sits on the board. An open down flag wins over parked and standby. A parked unit
 * (lifecycle not active) with no open down flag is operational, parked; with one, it sits under
 * that flag's status and its card is tagged parked (Ope, 29 Oct 2026).
 * A down unit's sub-status is its flag's current stage, so a wait is never a second flag.
 */
export function boardPlace(openFlag: Pick<DownFlag, 'type' | 'stages'> | undefined, standby: unknown, parked: boolean): { group: BoardGroup; sub: BoardSub; parked: boolean } {
  if (openFlag) return { group: openFlag.type === 'scheduled' ? 'sched' : 'unsched', sub: openFlag.stages.at(-1)?.stage ?? 'no_stage', parked };
  if (parked) return { group: 'operational', sub: 'parked', parked };
  return { group: 'operational', sub: standby ? 'standby' : 'in_use', parked };
}

/** Start of the flag's current stage interval: "in this stage for" is now minus this. */
export function stageSince(flag: Pick<DownFlag, 'start' | 'stages'>): Iso {
  return flag.stages.at(-1)?.start ?? flag.start;
}

export interface StatusRow { unitId: string; unitNumber: string; model: string; group: BoardGroup; sub: BoardSub; text?: string }

/** A sub-status filter key: the same stage can be under scheduled and unscheduled. */
export const subKey = (r: Pick<StatusRow, 'group' | 'sub'>): string => `${r.group}:${r.sub}`;

export interface BoardFilter {
  /** Statuses pressed. With subs: a unit shows if its status or its sub-status is pressed. Both empty: every unit. */
  groups: BoardGroup[];
  /** Sub-status keys pressed, e.g. "unsched:waiting_parts". */
  subs: string[];
  /** Empty: every model. */
  models: string[];
  q: string;
}

export const EMPTY_BOARD_FILTER: BoardFilter = { groups: [], subs: [], models: [], q: '' };

export function filterBoard<T extends StatusRow>(rows: T[], f: BoardFilter): T[] {
  const q = f.q.trim().toLowerCase();
  const anyStatus = f.groups.length === 0 && f.subs.length === 0;
  return rows.filter((r) =>
    (anyStatus || f.groups.includes(r.group) || f.subs.includes(subKey(r)))
    && (!f.models.length || f.models.includes(r.model))
    && (!q || [r.unitNumber, r.model, r.text ?? '', BOARD_SUB_LABELS[r.sub]].some((v) => v.toLowerCase().includes(q))));
}

export interface BoardCounts { groups: Record<BoardGroup, number>; subs: Record<string, number> }

/** Counts per status and sub-status for the units the model filter and search leave, so a count matches what a press shows. */
export function boardCounts(rows: StatusRow[], f: BoardFilter): BoardCounts {
  const groups: Record<BoardGroup, number> = { operational: 0, sched: 0, unsched: 0 };
  const subs: Record<string, number> = {};
  for (const r of filterBoard(rows, { ...f, groups: [], subs: [] })) {
    groups[r.group]++;
    subs[subKey(r)] = (subs[subKey(r)] ?? 0) + 1;
  }
  return { groups, subs };
}

export const toggleIn = <T>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

// Links made before the three statuses still open the right units.
const OLD_STATUS: Record<string, BoardGroup> = { run: 'operational', standby: 'operational', stale: 'operational', down: 'unsched', parked: 'operational' };
const SUBS = new Set<string>(Object.keys(BOARD_SUB_LABELS));

/** The filter as a query string (?status=unsched&sub=unsched:waiting_parts&model=793F&q=brake), so a filtered board can be shared. */
export function boardFilterToQuery(f: BoardFilter): string {
  const p = new URLSearchParams();
  if (f.groups.length) p.set('status', f.groups.join(','));
  if (f.subs.length) p.set('sub', f.subs.join(','));
  if (f.models.length) p.set('model', f.models.join(','));
  if (f.q.trim()) p.set('q', f.q.trim());
  return p.toString();
}

export function boardFilterFromQuery(query: string): BoardFilter {
  const p = new URLSearchParams(query);
  const list = (k: string) => (p.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const groups: BoardGroup[] = [];
  for (const s of list('status')) {
    const g = (BOARD_GROUPS as readonly string[]).includes(s) ? (s as BoardGroup) : OLD_STATUS[s];
    if (g && !groups.includes(g)) groups.push(g);
  }
  const subs = list('sub').filter((k) => {
    const [g, sub] = k.split(':');
    return (BOARD_GROUPS as readonly string[]).includes(g ?? '') && SUBS.has(sub ?? '');
  });
  return { groups, subs, models: list('model'), q: p.get('q') ?? '' };
}
