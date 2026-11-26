// Down list (docs/down-list.md): one row per unit with an open down flag, with what it is waiting for, the latest
// comment and when it is expected back. A view over existing records; durations are calculated (rule 4).

import { downSince } from './board.js';
import type { FlagComment } from './comments.js';
import { currentLocation, currentStage, lineName } from './flags.js';
import { HOUR_MS, ms, toIso } from './time.js';
import { toCsv } from './imports.js';
import { LOCATION_LABELS, STAGE_LABELS, type Asset, type DownFlag, type FlagType, type Iso, type ShopLine, type Stage } from './types.js';
import type { WaitTag } from './waits.js';

export interface DownRow {
  unitId: string;
  unitNumber: string;
  model: string;
  flagId: string;
  type: FlagType;
  stage?: Stage;
  stageLabel: string;
  stageHours: number;
  location: string;
  reason: string;
  waiting: string[];
  /** Start of the event, which a type switch keeps. */
  downSince: Iso;
  downHours: number;
  expectedBack?: Iso;
  /** `eta` was set by a person; `plan` is the flag's start plus its planned hours. */
  expectedSource?: 'eta' | 'plan';
  late: boolean;
  lastComment?: { text: string; by: string; at: Iso };
  commentCount: number;
  workOrders: string[];
}

export function downList(input: {
  assets: Asset[];
  flags: DownFlag[];
  waits: WaitTag[];
  comments: FlagComment[];
  lines: ShopLine[];
  now: Iso;
  waitLabel?: (kind: string) => string;
}): DownRow[] {
  const { now } = input;
  const waitLabel = input.waitLabel ?? ((k: string) => k);
  const assets = new Map(input.assets.map((a) => [a.id, a] as const));
  const byId = new Map(input.flags.map((f) => [f.id, f] as const));
  const rows: DownRow[] = [];
  for (const f of input.flags) {
    if (f.state !== 'open') continue;
    const a = assets.get(f.unitId);
    if (!a) continue;
    const unitFlags = input.flags.filter((x) => x.unitId === f.unitId);
    const since = downSince(f, unitFlags);

    // This flag and the earlier ones in the same event.
    const chain = new Set<string>([f.id]);
    for (let c: DownFlag | undefined = f; c?.linkedFromFlagId && !chain.has(c.linkedFromFlagId); ) {
      chain.add(c.linkedFromFlagId);
      c = byId.get(c.linkedFromFlagId);
    }
    const mine = input.comments.filter((c) => chain.has(c.downFlagId) && c.state === 'active').sort((x, y) => ms(y.enteredAt) - ms(x.enteredAt));
    const last = mine[0];

    const stage = currentStage(f);
    const loc = currentLocation(f);
    const line = loc?.kind === 'shop_line' ? input.lines.find((l) => l.id === loc.shopLineId) : undefined;
    const location = !loc ? '' : line ? lineName(line) : loc.kind === 'field' && loc.fieldLocation ? `${LOCATION_LABELS.field}: ${loc.fieldLocation}` : LOCATION_LABELS[loc.kind];

    const eta = f.etas.at(-1)?.eta;
    const planned = f.type === 'scheduled' && !eta && f.plannedDurationHours ? toIso(ms(f.start) + f.plannedDurationHours * HOUR_MS) : undefined;
    const expectedBack = eta ?? planned;

    rows.push({
      unitId: a.id, unitNumber: a.unitNumber, model: a.model, flagId: f.id, type: f.type,
      ...(stage ? { stage: stage.stage } : {}), stageLabel: stage ? STAGE_LABELS[stage.stage] : 'No stage set',
      stageHours: stage ? Math.max(0, (ms(now) - ms(stage.start)) / HOUR_MS) : 0,
      location, reason: [f.reasonCode, f.system].filter(Boolean).join(' · '),
      waiting: input.waits.filter((w) => w.unitId === f.unitId && w.state === 'open').map((w) => waitLabel(w.kind)),
      downSince: since, downHours: Math.max(0, (ms(now) - ms(since)) / HOUR_MS),
      ...(expectedBack ? { expectedBack, expectedSource: eta ? ('eta' as const) : ('plan' as const) } : {}),
      late: !!expectedBack && ms(expectedBack) < ms(now),
      ...(last ? { lastComment: { text: last.text, by: last.setBy, at: last.enteredAt } } : {}),
      commentCount: mine.length, workOrders: f.workOrders,
    });
  }
  return rows.sort((x, y) => y.downHours - x.downHours || x.unitNumber.localeCompare(y.unitNumber));
}

export type DownSortKey = 'unit' | 'type' | 'stage' | 'location' | 'down' | 'expected' | 'comment';

export function sortDownList(rows: DownRow[], key: DownSortKey, dir: 'asc' | 'desc'): DownRow[] {
  const d = dir === 'asc' ? 1 : -1;
  const val = (r: DownRow): string | number => {
    switch (key) {
      case 'unit': return r.unitNumber;
      case 'type': return r.type;
      case 'stage': return r.stageLabel;
      case 'location': return r.location;
      case 'down': return r.downHours;
      // No expected time sorts last either way.
      case 'expected': return r.expectedBack ? ms(r.expectedBack) : Number.POSITIVE_INFINITY * d;
      case 'comment': return r.lastComment ? ms(r.lastComment.at) : Number.POSITIVE_INFINITY * d;
    }
  };
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, undefined, { numeric: true }) : x < y ? -1 : x > y ? 1 : 0;
    return c * d || a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true });
  });
}

export interface DownListFilter { q: string; type: FlagType | 'all'; stage: Stage | 'all'; late: boolean; noEta: boolean; quiet: boolean }
export const EMPTY_DOWN_FILTER: DownListFilter = { q: '', type: 'all', stage: 'all', late: false, noEta: false, quiet: false };

/** `quiet`: no comment in the last 24 hours. */
export function filterDownList(rows: DownRow[], f: DownListFilter, now: Iso): DownRow[] {
  const t = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.type !== 'all' && r.type !== f.type) return false;
    if (f.stage !== 'all' && r.stage !== f.stage) return false;
    if (f.late && !r.late) return false;
    if (f.noEta && r.expectedBack) return false;
    if (f.quiet && r.lastComment && ms(now) - ms(r.lastComment.at) < 24 * HOUR_MS) return false;
    if (t) {
      const hay = `${r.unitNumber} ${r.model} ${r.reason} ${r.location} ${r.stageLabel} ${r.waiting.join(' ')} ${r.workOrders.join(' ')} ${r.lastComment?.text ?? ''}`.toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });
}

export function downListCsv(rows: DownRow[], siteTime: (iso: Iso) => string, userName: (id: string) => string): string {
  const head = ['Unit', 'Model', 'Type', 'Stage', 'Hours in stage', 'Location', 'Reason / system', 'Waiting for', 'Down since (site time)', 'Down hours', 'Expected back (site time)', 'Expected from', 'Late', 'Last comment', 'Last comment by', 'Last comment at (site time)', 'Comments', 'Work orders'];
  const body = rows.map((r) => [
    r.unitNumber, r.model, r.type, r.stageLabel, r.stageHours.toFixed(1), r.location, r.reason, r.waiting.join('; '), siteTime(r.downSince), r.downHours.toFixed(1),
    r.expectedBack ? siteTime(r.expectedBack) : '', r.expectedSource ?? '', r.late ? 'yes' : '', r.lastComment?.text ?? '', r.lastComment ? userName(r.lastComment.by) : '', r.lastComment ? siteTime(r.lastComment.at) : '',
    r.commentCount, r.workOrders.join('; '),
  ]);
  return toCsv([head, ...body]);
}
