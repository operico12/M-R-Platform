// Multi-site (docs/multi-site.md): adding and retiring a site, the switcher, and
// comparing sites each in its own time zone (KPI-043).

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import type { ConsoleContext } from '../src/console.js';
import { addSite, compareSites, lastFullWeeks, retireSite, siteProblems, switcherOrder, type SiteRecord } from '../src/sites.js';
import { local } from '../src/time.js';
import type { Role } from '../src/types.js';
import { TZ, actor, cal, fixtureFlag, truck } from './helpers.js';

let seq = 0;
const ctx = (role: Role): ConsoleContext => ({ actor: actor(role), now: '2026-10-29T12:00:00.000Z', newId: () => `s${++seq}`, timeZone: TZ, calendar: cal });
const sites: SiteRecord[] = [
  { id: 'a', tenantId: 't1', name: 'Mine A', timeZone: 'America/Vancouver' },
  { id: 'x', tenantId: 't2', name: 'Other tenant', timeZone: 'America/Vancouver' },
];

describe('adding and retiring a site', () => {
  it('lets only an admin add one, with a valid time zone and a name unique in the tenant', () => {
    expect(addSite(ctx('superintendent'), sites, 't1', { name: 'Mine B', timeZone: 'America/Edmonton' }).ok).toBe(false);
    const r = addSite(ctx('admin'), sites, 't1', { name: ' Mine B ', timeZone: 'America/Edmonton' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records[0]).toMatchObject({ tenantId: 't1', name: 'Mine B', timeZone: 'America/Edmonton' });
    expect(r.audit[0]).toMatchObject({ action: 'add_site', entity: 'site' });
    expect(siteProblems(sites, 't1', { name: 'mine a', timeZone: 'Mars/Olympus' })).toEqual([
      'The tenant already has a site called mine a.', 'Give an IANA time zone, for example America/Edmonton.',
    ]);
    // The same name in another tenant is fine.
    expect(siteProblems(sites, 't2', { name: 'Mine A', timeZone: 'UTC' })).toEqual([]);
  });

  it('never retires the last active site of a tenant, and needs a reason', () => {
    expect(retireSite(ctx('admin'), sites, 'a', 'Closed')).toEqual({ ok: false, errors: ['This is the last active site of the tenant, so it cannot be retired.'] });
    const two: SiteRecord[] = [...sites, { id: 'b', tenantId: 't1', name: 'Mine B', timeZone: 'America/Edmonton' }];
    expect(retireSite(ctx('admin'), two, 'b', ' ').ok).toBe(false);
    const r = retireSite(ctx('admin'), two, 'b', 'Sold');
    expect(r.ok && r.records[0]).toMatchObject({ id: 'b', retireReason: 'Sold', retiredAt: '2026-10-29T12:00:00.000Z' });
    expect(retireSite(ctx('reliability_engineer'), two, 'b', 'Sold').ok).toBe(false);
  });

  it('orders the switcher: the remembered site first, then by name, retired left out', () => {
    const list = [{ id: '1', name: 'Zinc' }, { id: '2', name: 'Alpha' }, { id: '3', name: 'Coal', retiredAt: '2026-01-01T00:00:00.000Z' }, { id: '4', name: 'Beta' }];
    expect(switcherOrder(list).map((s) => s.id)).toEqual(['2', '4', '1']);
    expect(switcherOrder(list, '1').map((s) => s.id)).toEqual(['1', '2', '4']);
    expect(switcherOrder(list, '3').map((s) => s.id)).toEqual(['2', '4', '1']);
  });
});

describe('KPI-043 multi-site PA, each site in its own week', () => {
  const A = 'America/Vancouver';
  const B = 'America/Edmonton';
  const now = local(A, '2026-10-14 12:00');

  it('uses Monday 00:00 site time for each site', () => {
    expect(lastFullWeeks(A, now, 1)).toEqual({ from: local(A, '2026-10-05 00:00'), to: local(A, '2026-10-12 00:00') });
    expect(lastFullWeeks(B, now, 1)).toEqual({ from: local(B, '2026-10-05 00:00'), to: local(B, '2026-10-12 00:00') });
    expect(lastFullWeeks(A, now, 4).from).toBe(local(A, '2026-09-14 00:00'));
  });

  it('weights by hours: 85.0% and 90.0% give 86.0%, not 87.5%', () => {
    // Site A: 40 trucks, 8 of them down 126 h each → 1,008 of 6,720 h down.
    const aTrucks = Array.from({ length: 40 }, (_, i) => truck(`a${i}`, { siteId: 'a' }));
    const aFlags = aTrucks.slice(0, 8).map((t, i) => fixtureFlag({ id: `af${i}`, unitId: t.id, type: 'unscheduled', start: local(A, '2026-10-05 00:00'), end: local(A, '2026-10-10 06:00') }));
    // Site B: 10 trucks, one down the whole week in Edmonton time → 168 of 1,680 h down.
    const bTrucks = Array.from({ length: 10 }, (_, i) => truck(`b${i}`, { siteId: 'b' }));
    const bFlags = [fixtureFlag({ id: 'bf', unitId: 'b0', type: 'unscheduled', start: local(B, '2026-10-05 00:00'), end: local(B, '2026-10-12 00:00') })];
    // A plant pump at site A is left out, as on the truck board.
    const pump = truck('pump', { siteId: 'a', assetClass: 'fixed_plant' });
    const c = compareSites([
      { site: { id: 'a', tenantId: 't1', name: 'Mine A', timeZone: A }, assets: [...aTrucks, pump], flags: aFlags, smu: [], rules: DEFAULT_FLAG_RULES },
      { site: { id: 'b', tenantId: 't1', name: 'Mine B', timeZone: B }, assets: bTrucks, flags: bFlags, smu: [], rules: DEFAULT_FLAG_RULES },
    ], now);
    expect(c.rows.map((r) => [r.units, r.kpi.calendarHours, Math.round(r.kpi.availableHours), Math.round(r.kpi.pa! * 1000) / 10])).toEqual([[40, 6720, 5712, 85], [10, 1680, 1512, 90]]);
    expect(Math.round(c.pa! * 1000) / 10).toBe(86);
    expect(c.rows[0]!.openFlags).toBe(0);
  });
});
