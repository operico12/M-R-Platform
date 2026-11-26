// History (docs/history.md): one row per downtime event, newest first, to search and open. A view over the flags;
// durations are calculated (rule 4) and dates are site dates (rule 7).

import { DateTime } from 'luxon';
import type { FlagRulesConfig } from './config.js';
import { currentLocation, lineName } from './flags.js';
import { buildEvents, downIntervals, stageHours, timeToFirstWrench } from './kpis.js';
import { toCsv } from './imports.js';
import { HOUR_MS, ms } from './time.js';
import { LOCATION_LABELS, type Asset, type DownFlag, type FlagType, type Iso, type ShopLine } from './types.js';

export interface HistoryRow {
  eventId: string;
  unitId: string;
  unitNumber: string;
  model: string;
  fleet: string;
  start: Iso;
  end: Iso | null;
  downHours: number;
  types: FlagType[];
  reason: string;
  system: string;
  component: string;
  failureModes: string[];
  where: string;
  inRepairHours: number;
  waitingHours: number;
  firstWrenchHours: number | null;
  workOrders: string[];
  state: 'open' | 'released';
  isFailure: boolean;
  isMinorStop: boolean;
  /** The event's flags in order, for the detail. */
  flags: DownFlag[];
}

export function historyRows(input: { assets: Asset[]; flags: DownFlag[]; lines: ShopLine[]; rules: FlagRulesConfig; now: Iso }): HistoryRow[] {
  const { now } = input;
  const assets = new Map(input.assets.map((a) => [a.id, a] as const));
  const rows: HistoryRow[] = [];
  for (const ev of buildEvents(input.flags, input.rules, now)) {
    const a = assets.get(ev.unitId);
    if (!a) continue;
    const down = ev.flags.reduce((s, f) => s + downIntervals(f, now).reduce((t, iv) => t + (ms(iv.end) - ms(iv.start)) / HOUR_MS, 0), 0);
    let repair = 0;
    for (const f of ev.flags) repair += stageHours(f, { from: f.start, to: f.end ?? now }, now).in_repair;
    const withRelease = [...ev.flags].reverse().find((f) => f.release);
    const last = ev.flags[ev.flags.length - 1]!;
    const loc = last.state === 'open' ? currentLocation(last) : last.locations.at(-1);
    const line = loc?.kind === 'shop_line' ? input.lines.find((l) => l.id === loc.shopLineId) : undefined;
    rows.push({
      eventId: ev.id, unitId: a.id, unitNumber: a.unitNumber, model: a.model, fleet: a.fleet, start: ev.start, end: ev.end,
      downHours: down, types: ev.flags.map((f) => f.type), reason: ev.flags[0]!.reasonCode,
      system: ev.system ?? '', component: withRelease?.release?.component ?? '', failureModes: withRelease?.release?.failureModes ?? [],
      where: !loc ? '' : line ? lineName(line) : loc.kind === 'field' && loc.fieldLocation ? `${LOCATION_LABELS.field}: ${loc.fieldLocation}` : LOCATION_LABELS[loc.kind],
      inRepairHours: repair, waitingHours: Math.max(0, down - repair), firstWrenchHours: timeToFirstWrench(ev),
      workOrders: [...new Set(ev.flags.flatMap((f) => f.workOrders))], state: ev.end ? 'released' : 'open',
      isFailure: ev.isFailure, isMinorStop: ev.isMinorStop, flags: ev.flags,
    });
  }
  return rows.sort((x, y) => ms(y.start) - ms(x.start) || x.unitNumber.localeCompare(y.unitNumber));
}

export interface HistoryFilter {
  q: string;
  /** Site dates (YYYY-MM-DD), inclusive. Blank: no limit. */
  from: string;
  to: string;
  /** The type the event started as. */
  type: FlagType | 'all';
  state: 'all' | 'open' | 'released';
  system: string;
  model: string;
  failuresOnly: boolean;
  minHours: number | null;
  maxHours: number | null;
}

export const EMPTY_HISTORY_FILTER: HistoryFilter = { q: '', from: '', to: '', type: 'all', state: 'all', system: '', model: '', failuresOnly: false, minHours: null, maxHours: null };

export function filterHistory(rows: HistoryRow[], f: HistoryFilter, timeZone: string): HistoryRow[] {
  const from = f.from ? DateTime.fromISO(f.from, { zone: timeZone }).startOf('day').toMillis() : -Infinity;
  const to = f.to ? DateTime.fromISO(f.to, { zone: timeZone }).plus({ days: 1 }).startOf('day').toMillis() : Infinity;
  const t = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    const s = ms(r.start);
    if (s < from || s >= to) return false;
    if (f.type !== 'all' && r.types[0] !== f.type) return false;
    if (f.state !== 'all' && r.state !== f.state) return false;
    if (f.system && r.system !== f.system) return false;
    if (f.model && r.model !== f.model) return false;
    if (f.failuresOnly && !r.isFailure) return false;
    if (f.minHours !== null && r.downHours < f.minHours) return false;
    if (f.maxHours !== null && r.downHours > f.maxHours) return false;
    if (t && !`${r.unitNumber} ${r.model} ${r.reason} ${r.system} ${r.component} ${r.failureModes.join(' ')} ${r.where} ${r.workOrders.join(' ')}`.toLowerCase().includes(t)) return false;
    return true;
  });
}

export type HistorySortKey = 'unit' | 'model' | 'start' | 'end' | 'down' | 'system';

export function sortHistory(rows: HistoryRow[], key: HistorySortKey, dir: 'asc' | 'desc'): HistoryRow[] {
  const d = dir === 'asc' ? 1 : -1;
  const val = (r: HistoryRow): string | number => {
    switch (key) {
      case 'unit': return r.unitNumber;
      case 'model': return r.model;
      case 'start': return ms(r.start);
      // An open event has no end; it sorts as the latest.
      case 'end': return r.end ? ms(r.end) : Number.MAX_SAFE_INTEGER;
      case 'down': return r.downHours;
      case 'system': return r.system;
    }
  };
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, undefined, { numeric: true }) : x < y ? -1 : x > y ? 1 : 0;
    return c * d || a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true });
  });
}

export function historyCsv(rows: HistoryRow[], siteTime: (iso: Iso) => string): string {
  const head = ['Unit', 'Model', 'Fleet', 'Start (site time)', 'End (site time)', 'Down hours', 'Types', 'Reason', 'System', 'Component', 'Failure modes', 'Where', 'In repair h', 'Waiting h', 'To first wrench h', 'Work orders', 'State', 'Failure'];
  const body = rows.map((r) => [
    r.unitNumber, r.model, r.fleet, siteTime(r.start), r.end ? siteTime(r.end) : 'open', r.downHours.toFixed(2), r.types.join(' → '), r.reason, r.system, r.component, r.failureModes.join('; '), r.where,
    r.inRepairHours.toFixed(2), r.waitingHours.toFixed(2), r.firstWrenchHours === null ? '' : r.firstWrenchHours.toFixed(2), r.workOrders.join('; '), r.state, r.isFailure ? 'yes' : r.isMinorStop ? 'minor stop' : 'no',
  ]);
  return toCsv([head, ...body]);
}
