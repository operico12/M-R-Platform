// Shift grid (docs/shift-grid.md): for each unit that was down in a window, what it was doing in each hour.
// Calculated from the flags' timed stage intervals, never stored or typed (rule 4). Windows are cut in the site
// time zone (rule 7). Pure functions.

import { DateTime } from 'luxon';
import { countingFlags } from './kpis.js';
import { HOUR_MS, ms, shiftsBetween, toIso, type ShiftCalendar } from './time.js';
import type { Asset, DownFlag, FlagType, Iso, Stage } from './types.js';

export interface GridWindow { from: Iso; to: Iso; label: string }

/** A site calendar day: midnight to midnight, so a daylight-saving day is 23 or 25 hours. */
export function dayWindow(date: string, timeZone: string): GridWindow {
  const start = DateTime.fromISO(date, { zone: timeZone }).startOf('day');
  return { from: toIso(start.toMillis()), to: toIso(start.plus({ days: 1 }).toMillis()), label: start.toFormat('ccc d LLL yyyy') };
}

/** One shift of the site calendar, by the date it started on and its name (for example "day"). */
export function shiftWindow(cal: ShiftCalendar, date: string, shiftName: string): GridWindow | undefined {
  const noon = DateTime.fromISO(date, { zone: cal.timeZone }).startOf('day');
  const s = shiftsBetween(cal, toIso(noon.toMillis()), toIso(noon.plus({ days: 1 }).toMillis())).find((x) => x.shiftDate === date && x.name === shiftName);
  return s ? { from: s.start, to: s.end, label: `${noon.toFormat('ccc d LLL')} ${shiftName} shift${s.crew ? ` (crew ${s.crew})` : ''}` } : undefined;
}

export type CellKind = 'up' | 'repair' | 'waiting' | 'future';

export interface GridCell {
  from: Iso;
  to: Iso;
  /** The state with the most minutes: repair beats waiting beats up on a tie. `future` is after now. */
  kind: CellKind;
  /** Type of the flag that held most of the cell; undefined when up. */
  type?: FlagType;
  /** More than one state in the cell. */
  mixed: boolean;
  minutes: { repair: number; waiting: number; up: number };
  stages: Partial<Record<Stage, number>>;
}

export interface GridRow {
  assetId: string;
  unitNumber: string;
  model: string;
  cells: GridCell[];
  downHours: number;
  repairHours: number;
}

export interface ShiftGrid {
  window: GridWindow;
  /** Cell boundaries, with the site-local label of each hour. */
  hours: Array<{ from: Iso; to: Iso; label: string }>;
  rows: GridRow[];
}

const MIN = 60_000;

function cutHours(w: GridWindow, timeZone: string): ShiftGrid['hours'] {
  const out: ShiftGrid['hours'] = [];
  const end = ms(w.to);
  for (let t = ms(w.from); t < end; t += HOUR_MS) {
    const e = Math.min(t + HOUR_MS, end);
    out.push({ from: toIso(t), to: toIso(e), label: DateTime.fromMillis(t, { zone: timeZone }).toFormat('H:mm') });
  }
  return out;
}

export function shiftGrid(input: { flags: DownFlag[]; assets: Asset[]; window: GridWindow; timeZone: string; now: Iso }): ShiftGrid {
  const { window: w, now } = input;
  const hours = cutHours(w, input.timeZone);
  const nowMs = ms(now);
  const byUnit = new Map<string, DownFlag[]>();
  for (const f of countingFlags(input.flags)) {
    const list = byUnit.get(f.unitId) ?? [];
    list.push(f);
    byUnit.set(f.unitId, list);
  }

  const rows: GridRow[] = [];
  for (const asset of input.assets) {
    const flags = (byUnit.get(asset.id) ?? []).sort((a, b) => ms(a.start) - ms(b.start));
    if (!flags.length) continue;
    let downMin = 0;
    let repairMin = 0;
    const cells: GridCell[] = hours.map((h) => {
      const a = ms(h.from);
      const b = ms(h.to);
      if (a >= nowMs) return { from: h.from, to: h.to, kind: 'future', mixed: false, minutes: { repair: 0, waiting: 0, up: 0 }, stages: {} };
      const stop = Math.min(b, nowMs);
      const minutes = { repair: 0, waiting: 0, up: 0 };
      const stages: Partial<Record<Stage, number>> = {};
      const byType: Record<FlagType, number> = { scheduled: 0, unscheduled: 0 };
      // Minutes already claimed in this cell, so overlapping flags are not counted twice.
      let claimedUntil = a;
      for (const f of flags) {
        const fe = f.end ? ms(f.end) : Infinity;
        for (const s of f.stages) {
          const s0 = Math.max(ms(s.start), a, claimedUntil);
          const s1 = Math.min(s.end ? ms(s.end) : fe, fe, stop);
          if (s1 <= s0) continue;
          const m = (s1 - s0) / MIN;
          if (s.stage === 'in_repair') minutes.repair += m; else minutes.waiting += m;
          stages[s.stage] = (stages[s.stage] ?? 0) + m;
          byType[f.type] += m;
          claimedUntil = Math.max(claimedUntil, s1);
        }
      }
      minutes.up = Math.max(0, (stop - a) / MIN - minutes.repair - minutes.waiting);
      downMin += minutes.repair + minutes.waiting;
      repairMin += minutes.repair;
      const kind: CellKind = minutes.repair >= minutes.waiting && minutes.repair >= minutes.up && minutes.repair > 0 ? 'repair'
        : minutes.waiting >= minutes.up && minutes.waiting > 0 ? 'waiting' : 'up';
      const states = [minutes.repair, minutes.waiting, minutes.up].filter((x) => x > 0.0001).length;
      const type: FlagType | undefined = kind === 'up' ? undefined : byType.scheduled > byType.unscheduled ? 'scheduled' : 'unscheduled';
      return { from: h.from, to: h.to, kind, ...(type ? { type } : {}), mixed: states > 1, minutes, stages };
    });
    if (downMin <= 0) continue;
    rows.push({ assetId: asset.id, unitNumber: asset.unitNumber, model: asset.model, cells, downHours: downMin / 60, repairHours: repairMin / 60 });
  }
  rows.sort((x, y) => y.downHours - x.downHours || x.unitNumber.localeCompare(y.unitNumber));
  return { window: w, hours, rows };
}
