// Demo standby flags (synthetic only, rule 9): a shift change at each shift start, a crib break mid
// shift, and now and then waiting for an operator or weather. Two units are on standby now.

import { shiftsBetween, type Dataset, type StandbyFlag } from '@mr/core';

export function demoStandby(ds: Dataset, days = 91): StandbyFlag[] {
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const end = Date.parse(ds.generatedAt);
  const from = new Date(end - days * 86_400_000).toISOString();
  const shifts = shiftsBetween(ds.calendar, from, ds.generatedAt).filter((s) => Date.parse(s.end) <= end);
  const spans = new Map<string, Array<[number, number]>>();
  for (const f of ds.flags) {
    if (f.state === 'voided') continue;
    const l = spans.get(f.unitId) ?? [];
    l.push([Date.parse(f.start), f.end ? Date.parse(f.end) : end]);
    spans.set(f.unitId, l);
  }
  const down = (unitId: string, a: number, b: number) => (spans.get(unitId) ?? []).some(([s, e]) => s < b && e > a);
  const out: StandbyFlag[] = [];
  let n = 0;
  const add = (unitId: string, reasonCode: string, kind: StandbyFlag['kind'], a: number, b: number | null) => {
    if (down(unitId, a, b ?? end)) return;
    const at = new Date(a).toISOString();
    out.push({ id: `demo-sb-${++n}`, tenantId: ds.tenantId, siteId: ds.site.id, unitId, reasonCode, kind, start: at, end: b === null ? null : new Date(b).toISOString(), state: b === null ? 'open' : 'ended', setBy: 'demo-supervisor', enteredAt: at });
  };
  const trucks = ds.assets.filter((a) => a.assetClass === 'mobile');
  for (const s of shifts) {
    const st = Date.parse(s.start);
    const len = Date.parse(s.end) - st;
    for (const u of trucks) {
      add(u.id, 'SHIFT_CHANGE', 'operating_delay', st, st + (20 + Math.round(rnd() * 20)) * 60_000);
      const crib = st + len / 2 + Math.round((rnd() - 0.5) * 60) * 60_000;
      add(u.id, 'CRIB', 'operating_delay', crib, crib + 30 * 60_000);
      const r = rnd();
      if (r < 0.12) {
        const a = st + (2 + rnd() * 6) * 3_600_000;
        add(u.id, 'NO_OPERATOR', 'standby', a, a + (0.5 + rnd() * 2.5) * 3_600_000);
      } else if (r < 0.15) {
        const a = st + (1 + rnd() * 4) * 3_600_000;
        add(u.id, 'WEATHER', 'standby', a, a + (1 + rnd() * 3) * 3_600_000);
      }
    }
  }
  // On standby now: the first two trucks with no open flag.
  const free = trucks.filter((u) => !ds.flags.some((f) => f.unitId === u.id && f.state === 'open')).slice(0, 2);
  free.forEach((u, i) => add(u.id, i === 0 ? 'NO_OPERATOR' : 'REFUEL', i === 0 ? 'standby' : 'operating_delay', end - (40 + i * 25) * 60_000, null));
  return out;
}
