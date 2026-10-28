// The synthetic fleet must obey the same rules as real data, or demos lie.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import { releaseChecklist } from '../src/flags.js';
import { computeKpis, lineOccupancy } from '../src/kpis.js';
import { smuRisingWhileDown } from '../src/alerts.js';
import { generateFleet } from '../src/synth/generate.js';
import { ms } from '../src/time.js';
import { importAssets, importSmu, importWorkOrders, parseCsv, toSourceCsv } from '../src/imports.js';

const END = '2026-10-26T20:00:00.000Z';
const ds = generateFleet({ seed: 7, units: 40, days: 120, end: END });

describe('synthetic fleet', () => {
  it('is deterministic for a seed', () => {
    const again = generateFleet({ seed: 7, units: 40, days: 120, end: END });
    expect(again.flags.length).toBe(ds.flags.length);
    expect(again.flags[100]).toEqual(ds.flags[100]);
  });

  it('has no overlapping flags per unit and at most one open (R1, R3)', () => {
    for (const a of ds.assets) {
      const fs = ds.flags.filter((f) => f.unitId === a.id).sort((x, y) => ms(x.start) - ms(y.start));
      expect(fs.filter((f) => f.state === 'open').length).toBeLessThanOrEqual(1);
      for (let i = 1; i < fs.length; i++) expect(ms(fs[i]!.start)).toBeGreaterThanOrEqual(ms(fs[i - 1]!.end!));
    }
  });

  it('stage and location intervals are contiguous and cover each flag', () => {
    for (const f of ds.flags) {
      for (const list of [f.stages, f.locations]) {
        expect(list.length).toBeGreaterThan(0);
        expect(list[0]!.start).toBe(f.start);
        for (let i = 1; i < list.length; i++) expect(list[i]!.start).toBe(list[i - 1]!.end);
        expect(list.at(-1)!.end).toBe(f.end);
      }
    }
  });

  it('never puts more units in a line than its capacity, or any in a closed line (L1, L2)', () => {
    const now = END;
    for (const line of ds.shopLines) {
      const iv = ds.flags.flatMap((f) => f.locations.filter((l) => l.kind === 'shop_line' && l.shopLineId === line.id).map((l) => [ms(l.start), ms(l.end ?? now)] as const));
      for (const [s] of iv) {
        const at = s + 1;
        expect(iv.filter(([a, b]) => a <= at && at < b).length).toBeLessThanOrEqual(line.capacity);
      }
      for (const c of ds.closures.filter((c) => c.lineId === line.id)) {
        expect(iv.some(([a, b]) => a < ms(c.end!) && ms(c.start) < b)).toBe(false);
      }
      expect(lineOccupancy(line, ds.flags, ds.closures, { from: ds.flags[0]!.start, to: now }, now).occupancy).toBeLessThanOrEqual(1);
    }
  });

  it('every released flag passes its release checklist', () => {
    for (const f of ds.flags.filter((x) => x.state === 'released' && !ds.flags.some((y) => y.linkedFromFlagId === x.id))) {
      expect(releaseChecklist(f, f.release ?? {})).toEqual([]);
    }
  });

  it('nothing ends in the future', () => {
    for (const f of ds.flags) {
      expect(ms(f.start)).toBeLessThanOrEqual(ms(END));
      if (f.end) expect(ms(f.end)).toBeLessThanOrEqual(ms(END));
    }
  });

  it('produces believable fleet KPIs', () => {
    const k = computeKpis(
      { assets: ds.assets, flags: ds.flags, smu: ds.smu, lifecycle: ds.lifecycle, rules: DEFAULT_FLAG_RULES, now: END },
      { from: new Date(ms(END) - 28 * 864e5).toISOString(), to: END },
    );
    expect(k.pa!).toBeGreaterThan(0.75);
    expect(k.pa!).toBeLessThan(0.97);
    expect(k.utilisation!).toBeGreaterThan(0.7);
    expect(k.utilisation!).toBeLessThan(1);
    expect(k.failures).toBeGreaterThan(50);
    expect(k.mtbf!).toBeGreaterThan(40);
    expect(k.mttr!).toBeLessThan(k.meanDowntime!);
  });

  it('SMU never rises while a unit is flagged down (no false R14 checks)', () => {
    const al = smuRisingWhileDown({ assets: ds.assets, flags: ds.flags, smu: ds.smu, rules: DEFAULT_FLAG_RULES, calendar: ds.calendar, now: END, since: ds.flags[0]!.start });
    expect(al).toEqual([]);
  });

  it('exports to Maximo-style CSV and reads back with no changes and no errors', () => {
    const files = toSourceCsv(ds, ds.site.timeZone);
    const ctx = { tenantId: ds.tenantId, siteId: ds.site.id, timeZone: ds.site.timeZone, now: END, newId: () => 'x' };
    const a = importAssets(parseCsv(files.assets), ds.assets, ctx);
    expect(a.stats).toMatchObject({ inserted: 0, updated: 0, failed: 0, unchanged: ds.assets.length });
    const w = importWorkOrders(parseCsv(files.workOrders), ds.workOrders, ds.assets, ctx);
    expect(w.stats).toMatchObject({ inserted: 0, updated: 0, failed: 0 });
    expect(w.issues).toEqual([]);
    const s = importSmu(parseCsv(files.smu), [], ds.assets, ctx);
    expect(s.stats.failed).toBe(0);
    expect(s.stats.inserted).toBe(ds.smu.length);
  });
});
