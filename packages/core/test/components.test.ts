// Component life and rebuilds (docs/component-life.md). The engine story below
// is worked by hand: 3,000 h first life ending in a warranty failure, rebuilt,
// then 1,500 h so far on a second truck.

import { describe, expect, it } from 'vitest';
import { rebuildOrReplace } from '../src/calculators.js';
import {
  allLives, bandOf, burnRates, changeoutForecast, componentStates, coresOutstanding, costPerLifeHour, fitKind, forecastBuckets, lifeBoard, lifeRatio,
  lifeTargetFor, meanLives, recordEvent, registerComponent, riskBeforeTarget, setLifeTarget, smuIndex, vendorStats, voidEvent, warrantyClaims,
  type ComponentData, type EventInput, type LifeTarget,
} from '../src/components.js';
import { canDecide, decideRequest, proposeLifeTarget, waitingOn, type ApprovalRequest } from '../src/approvals.js';
import type { ConsoleContext } from '../src/console.js';
import type { Role, SmuReading } from '../src/types.js';
import { generateFleet } from '../src/synth/generate.js';
import { L, TZ, cal, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role, now = L('2026-10-28 09:00'), userId = `u-${role}`): ConsoleContext => ({ actor: { userId, role, scope: ['*'] }, now, newId: () => `id${++n}`, timeZone: TZ, calendar: cal });
const assets = [truck('ht1'), truck('ht2'), truck('ht3', { model: '797F' })];

// HT2 runs 18 h a day for the last 28 days, ending at 21,500 h.
const ht2: SmuReading[] = Array.from({ length: 29 }, (_, i) => ({ unitId: 'ht2', at: new Date(Date.parse(L('2026-10-28 08:00')) - (28 - i) * 86400000).toISOString(), hours: 21500 - (28 - i) * 18 }));
const smu: SmuReading[] = [
  { unitId: 'ht1', at: L('2026-01-10 07:00'), hours: 10000 },
  { unitId: 'ht1', at: L('2026-06-01 07:00'), hours: 13000 },
  ...ht2,
];
const targets: LifeTarget[] = [
  { id: 't1', model: '793F', kind: 'engine', hours: 20000, effectiveFrom: '2026-01-01', reason: 'OEM', setBy: 'x', setAt: L('2026-01-01 00:00') },
];

function story() {
  let d: ComponentData = { components: [], events: [], assets, smu: smuIndex(smu) };
  const rae = (now: string) => ctx('reliability_engineer', L(now), 'rae');
  const step = (now: string, id: string, input: EventInput) => {
    const r = recordEvent(rae(now), d, id, input);
    if (!r.ok) throw new Error(r.errors.join(' '));
    d = { ...d, events: r.events };
    return r;
  };
  const reg = registerComponent(rae('2026-01-05 09:00'), d, { serial: ' e1 ', kind: 'engine', models: ['793F'], hoursAtEntry: 0, rebuildsAtEntry: 0, at: L('2026-01-05 09:00'), receivedAs: 'new', cost: 600000, warrantyHours: 10000, warrantyMonths: 24 });
  if (!reg.ok) throw new Error(reg.errors.join(' '));
  d = { ...d, components: reg.components, events: reg.events };
  const id = reg.components[0]!.id;
  step('2026-01-10 09:00', id, { kind: 'installed', at: L('2026-01-10 08:00'), unitId: 'ht1', position: 'engine', smu: 10000 });
  const removed = step('2026-06-01 09:00', id, { kind: 'removed', at: L('2026-06-01 08:00'), smu: 13000, reason: 'failure', flagId: 'flag-1' });
  step('2026-06-05 09:00', id, { kind: 'sent_rebuild', at: L('2026-06-05 08:00'), vendor: 'Vendor A' });
  step('2026-06-20 09:00', id, { kind: 'warranty_claim', at: L('2026-06-20 08:00'), claim: 'accepted', cost: 50000 });
  step('2026-07-15 09:00', id, { kind: 'returned_rebuild', at: L('2026-07-15 08:00'), cost: 280000, warrantyHours: 6000 });
  step('2026-08-01 09:00', id, { kind: 'installed', at: L('2026-08-01 08:00'), unitId: 'ht2', position: 'engine', smu: 20000 });
  return { d, id, removed };
}

describe('the engine story', () => {
  const { d, id, removed } = story();
  const now = L('2026-10-28 09:00');
  const states = componentStates(d.components, d.events, assets, d.smu, now);
  const s = states[0]!;
  it('works out status and hours from events', () => {
    expect(d.components[0]!.serial).toBe('E1');
    expect(s).toMatchObject({ status: 'installed', unitId: 'ht2', position: 'engine', hours: 1500, rebuilds: 1, vendor: 'Vendor A' });
    expect(removed.warnings).toContain('This failure is under warranty: open a warranty claim.');
  });
  it('splits it into lives', () => {
    expect(s.lives).toHaveLength(2);
    expect(s.lives[0]).toMatchObject({ hours: 3000, failed: true, startedBy: 'received', cost: 600000, recovered: 50000, model: '793F' });
    expect(s.lives[0]!.end).toBe(L('2026-06-05 08:00'));
    expect(s.lives[1]).toMatchObject({ hours: 1500, failed: false, end: null, startedBy: 'rebuild', vendor: 'Vendor A', cost: 280000 });
    expect(warrantyClaims(states)).toEqual([]);
  });
  it('KPI-030 life ratio and KPI-031 cost per hour', () => {
    const r = lifeRatio(allLives(states), targets, L('2026-01-01 00:00'), L('2027-01-01 00:00'), TZ);
    expect(r).toMatchObject({ ended: 1, noTarget: 0, failures: { n: 1, mean: 0.15 }, planned: { n: 0, mean: null }, reachingTarget: 0, early: 1 });
    expect(costPerLifeHour(allLives(states)).perHour).toBeCloseTo(550000 / 3000, 9);
  });
  it('board cell and forecast', () => {
    const row = lifeBoard(states, assets, targets, '2026-10-28').find((x) => x.unit.id === 'ht2')!;
    const cell = row.cells.find((c) => c.position.id === 'engine')!;
    expect(cell).toMatchObject({ target: 20000, band: 'green' });
    expect(cell.ratio).toBeCloseTo(0.075, 9);
    const rates = burnRates(assets, d.smu, [], now, TZ);
    expect(rates.get('ht2')!.perDay).toBeCloseTo(18, 6);
    expect(rates.get('ht1')!.source).toBe('model'); // too few recent readings: the 793F average
    const f = changeoutForecast(states, assets, targets, rates, now, TZ);
    expect(f[0]!.remaining).toBe(18500);
    expect((Date.parse(f[0]!.due!) - Date.parse(now)) / 86400000).toBeCloseTo(18500 / 18, 6);
  });
  it('vendor table', () => {
    const v = vendorStats(states, targets, TZ, 1);
    expect(v).toEqual([expect.objectContaining({ vendor: 'Vendor A', sent: 1, returned: 1, atVendor: 0, ended: 0 })]);
    expect(v[0]!.turnaroundDays).toBeCloseTo(40, 6);
  });
});

describe('rules', () => {
  const { d, id } = story();
  const sup = ctx('supervisor');
  it('only allowed roles record, and costs are for cost roles', () => {
    expect(registerComponent(ctx('viewer'), d, { serial: 'X', kind: 'engine', models: [], hoursAtEntry: 0, rebuildsAtEntry: 0, at: L('2026-10-01 08:00'), receivedAs: 'new' }).ok).toBe(false);
    const r = registerComponent(sup, d, { serial: 'X', kind: 'engine', models: [], hoursAtEntry: 0, rebuildsAtEntry: 0, at: L('2026-10-01 08:00'), receivedAs: 'new', cost: 5 });
    expect(!r.ok && r.errors).toEqual(['Only cost roles enter costs.']);
    expect(!registerComponent(sup, d, { serial: 'e1', kind: 'engine', models: [], hoursAtEntry: 0, rebuildsAtEntry: 0, at: L('2026-10-01 08:00'), receivedAs: 'new' }).ok).toBe(true);
  });
  it('a position holds one component, of the right kind', () => {
    const r = registerComponent(sup, d, { serial: 'E2', kind: 'engine', models: [], hoursAtEntry: 5000, rebuildsAtEntry: 2, at: L('2026-10-01 08:00'), receivedAs: 'used' });
    if (!r.ok) throw new Error();
    const d2 = { ...d, components: r.components, events: r.events };
    const e2 = r.components.at(-1)!.id;
    const busy = recordEvent(sup, d2, e2, { kind: 'installed', at: L('2026-10-02 08:00'), unitId: 'ht2', position: 'engine', smu: 21000 });
    expect(!busy.ok && busy.errors[0]).toMatch(/not empty/);
    const wrong = recordEvent(sup, d2, e2, { kind: 'installed', at: L('2026-10-02 08:00'), unitId: 'ht3', position: 'final_drive_lh', smu: 100 });
    expect(!wrong.ok && wrong.errors).toContain('This engine cannot go in the final drive lh position.');
    const ok = recordEvent(sup, d2, e2, { kind: 'installed', at: L('2026-10-02 08:00'), unitId: 'ht3', position: 'engine', smu: 100 });
    expect(ok.ok).toBe(true);
  });
  it('time order, SMU and reasons are checked', () => {
    const early = recordEvent(sup, d, id, { kind: 'removed', at: L('2026-07-30 08:00'), smu: 20500, reason: 'planned' });
    expect(!early.ok && early.errors[0]).toMatch(/before the last event/);
    const low = recordEvent(sup, d, id, { kind: 'removed', at: L('2026-10-20 08:00'), smu: 19000, reason: 'planned' });
    expect(!low.ok && low.errors).toContain('The SMU is below the SMU at install (20000).');
    const noReason = recordEvent(sup, d, id, { kind: 'removed', at: L('2026-10-20 08:00'), smu: 21300 });
    expect(noReason.ok).toBe(false);
    const far = recordEvent(sup, d, id, { kind: 'removed', at: L('2026-10-27 09:00'), smu: 21000, reason: 'failure' });
    expect(far.ok && far.warnings).toEqual([
      'The SMU entered (21000) is 482 h from the unit\'s reading then (21482). Check it.',
      'Link the down flag, so the failure counts the same everywhere.',
      'This failure is under warranty: open a warranty claim.',
    ]);
  });
  it('only the latest event is voided, by its author or a superintendent', () => {
    const last = d.events.at(-1)!;
    expect(voidEvent(sup, d, last.id, 'wrong').ok).toBe(false);
    expect(voidEvent(ctx('reliability_engineer', undefined, 'rae'), d, d.events[0]!.id, 'x').ok).toBe(false);
    expect(voidEvent(ctx('reliability_engineer', undefined, 'rae'), d, last.id, ' ').ok).toBe(false);
    const v = voidEvent(ctx('superintendent'), d, last.id, 'Wrong truck');
    if (!v.ok) throw new Error();
    const s = componentStates(v.components, v.events, assets, d.smu, L('2026-10-28 09:00'))[0]!;
    expect(s.status).toBe('in_store');
    expect(v.audit[0]).toMatchObject({ entity: 'component', action: 'void_component_event' });
  });
});

describe('targets, bands, buckets, cores', () => {
  it('target life is effective-dated and role-checked', () => {
    expect(setLifeTarget(ctx('supervisor'), targets, { model: '793F', kind: 'engine', hours: 22000, effectiveFrom: '2026-11-01', reason: 'x' }).ok).toBe(false);
    const r = setLifeTarget(ctx('reliability_engineer'), targets, { model: '793F', kind: 'engine', hours: 22000, effectiveFrom: '2026-11-01', reason: 'New OEM bulletin' });
    if (!r.ok) throw new Error();
    expect(lifeTargetFor(r.records, '793F', 'engine', '2026-10-31')!.hours).toBe(20000);
    expect(lifeTargetFor(r.records, '793F', 'engine', '2026-11-01')!.hours).toBe(22000);
    expect(r.audit[0]).toMatchObject({ entity: 'life_target', before: expect.objectContaining({ hours: 20000 }) });
  });
  it('a target life change needs a superintendent who did not ask (decided 2026-10-28)', () => {
    const input = { model: '793F', kind: 'engine' as const, hours: 22000, effectiveFrom: '2026-11-01', reason: 'New OEM bulletin' };
    expect(proposeLifeTarget(ctx('supervisor'), targets, [], input).ok).toBe(false);
    expect(proposeLifeTarget(ctx('reliability_engineer'), targets, [], { ...input, hours: 50 }).ok).toBe(false);
    const asked = proposeLifeTarget(ctx('reliability_engineer', L('2026-10-28 09:00'), 'rae'), targets, [], input);
    if (!asked.ok) throw new Error(asked.errors.join(' '));
    const req = asked.records[0]!;
    expect(req).toMatchObject({ kind: 'life_target', status: 'pending', title: 'Target life 22,000 h for 793F engine' });
    expect(req.impact[0]).toBe('Replaces 20,000 h from 2026-11-01.');
    // Asking twice for the same model, kind and date is refused while one waits.
    expect(proposeLifeTarget(ctx('reliability_engineer'), targets, asked.records, input).ok).toBe(false);
    // Nothing applies until it is approved.
    expect(lifeTargetFor(targets, '793F', 'engine', '2026-11-01')!.hours).toBe(20000);
    expect(canDecide('reliability_engineer', 'life_target')).toBe(false);
    expect(canDecide('superintendent', 'life_target')).toBe(true);
    expect(waitingOn(asked.records, 'sid', 'superintendent').map((r) => r.id)).toEqual([req.id]);
    const state = { requests: asked.records as ApprovalRequest[], targets: [], users: [], lifeTargets: targets };
    expect(decideRequest(ctx('reliability_engineer', L('2026-10-28 10:00'), 'rae2'), state, req.id, 'approve', '').ok).toBe(false);
    // A superintendent who asked cannot approve their own.
    const own = proposeLifeTarget(ctx('superintendent', L('2026-10-28 09:00'), 'sid'), targets, [], input);
    if (!own.ok) throw new Error();
    expect(decideRequest(ctx('superintendent', L('2026-10-28 10:00'), 'sid'), { ...state, requests: own.records }, own.records[0]!.id, 'approve', '').ok).toBe(false);
    const done = decideRequest(ctx('superintendent', L('2026-10-28 10:00'), 'sid'), state, req.id, 'approve', '');
    if (!done.ok) throw new Error(done.errors.join(' '));
    const t = done.lifeTargets!.at(-1)!;
    expect(t).toMatchObject({ hours: 22000, setBy: 'rae', approvedBy: 'sid', requestId: req.id, reason: 'New OEM bulletin' });
    expect(done.records[0]).toMatchObject({ status: 'approved', appliedId: t.id });
    expect(lifeTargetFor(done.lifeTargets!, '793F', 'engine', '2026-11-01')!.hours).toBe(22000);
    expect(done.audit.map((a) => a.entity)).toEqual(['approval', 'life_target']);
  });
  it('bands', () => {
    expect([null, 0.5, 0.75, 0.89, 0.9, 1, 1.3].map((x) => bandOf(x))).toEqual(['none', 'green', 'amber', 'amber', 'red', 'past', 'past']);
  });
  it('risk of failing before target (conditional Weibull)', () => {
    expect(riskBeforeTarget(2, 20000, 10000, 20000)).toBeCloseTo(1 - Math.exp(-0.75), 12);
    expect(riskBeforeTarget(2, 20000, 20000, 20000)).toBeNull();
  });
  it('forecast buckets by site week and month', () => {
    const now = L('2026-10-28 09:00'); // a Wednesday
    const row = (due: string | null) => ({ due, position: { kind: 'engine' } }) as never;
    const w = forecastBuckets([row(now), row(L('2026-11-02 00:30')), row(L('2027-03-01 00:00')), row(null)], now, TZ, 'week', 12);
    expect(w[0]).toMatchObject({ label: 'w/c 26 Oct', total: 1 });
    expect(w[1]).toMatchObject({ label: 'w/c 2 Nov', total: 1, byKind: { engine: 1 } });
    const m = forecastBuckets([row(now), row(L('2027-03-01 00:00'))], now, TZ, 'month', 12);
    expect(m[0]!.label).toBe('Oct 2026');
    expect(m[4]).toMatchObject({ label: 'Feb 2027', total: 0 });
    expect(m[5]).toMatchObject({ label: 'Mar 2027', total: 1 });
  });
  it('cores outstanding turn overdue after the due date', () => {
    const d: ComponentData = { components: [], events: [], assets, smu: smuIndex([]) };
    const r = registerComponent(ctx('superintendent'), d, { serial: 'T9', kind: 'transmission', models: [], hoursAtEntry: 0, rebuildsAtEntry: 0, at: L('2026-09-01 08:00'), receivedAs: 'exchange', coreDueBy: '2026-10-01', cost: 120000 });
    if (!r.ok) throw new Error();
    const now = L('2026-10-28 09:00');
    const states = componentStates(r.components, r.events, assets, d.smu, now);
    expect(coresOutstanding(states, now, TZ)).toEqual([expect.objectContaining({ dueBy: '2026-10-01', overdue: true })]);
    const back = recordEvent(ctx('superintendent'), { ...d, components: r.components, events: r.events }, r.components[0]!.id, { kind: 'core_returned', at: L('2026-10-05 08:00'), cost: 20000 });
    if (!back.ok) throw new Error();
    expect(coresOutstanding(componentStates(back.components, back.events, assets, d.smu, now), now, TZ)).toEqual([]);
  });
  it('a parked unit has no burn rate', () => {
    const r = burnRates([truck('ht2')], smuIndex(ht2), [{ assetId: 'ht2', status: 'parked', start: L('2026-10-20 00:00'), end: null }], L('2026-10-28 09:00'), TZ);
    expect(r.get('ht2')).toMatchObject({ perDay: null, source: 'parked' });
  });
});

describe('C-11 rebuild or replace', () => {
  it('worked example (docs/calculators.md)', () => {
    const r = rebuildOrReplace({ rebuildPrice: 280000, rebuildLife: 16000, newPrice: 600000, newLife: 22000, changeoutHours: 24, costPerDownHour: 2500, coreCredit: 60000, hoursPerYear: 6000 });
    expect(r.values.rebuildPerHour).toBeCloseTo(21.25, 9);
    expect(r.values.replacePerHour).toBeCloseTo(600000 / 22000, 9);
    expect(r.values.breakEvenLife).toBeCloseTo(340000 / (600000 / 22000), 6);
    expect(r.values.annualDifference).toBeCloseTo((600000 / 22000 - 21.25) * 6000, 6);
    expect(r.sentence).toMatch(/^Rebuild is cheaper/);
  });
});

describe('Weibull from component lives', () => {
  it('failed lives are failures, planned and open lives suspensions', () => {
    const lives = [3000, 9000, 14000, 16000, 18000].map((h, i) => ({ componentId: `c${i}`, serial: `S${i}`, kind: 'engine' as const, model: '793F', start: '', end: i < 4 ? 'x' : null, hours: h, failed: i % 2 === 0 && i < 4, startedBy: 'rebuild' as const, recovered: 0 }));
    const { data, fit } = fitKind(lives, 'engine', '793F');
    expect(data.map((x) => x.failed)).toEqual([true, false, true, false, false]);
    expect(fit).not.toBeNull();
    expect(meanLives(lives, 'engine', '793F', 3)).toEqual({ rebuilt: (3000 + 9000 + 14000 + 16000) / 4, fresh: null });
  });
});

describe('synthetic component history', () => {
  const END = '2026-10-26T20:00:00.000Z';
  const ds = generateFleet({ seed: 7, units: 12, days: 120, end: END });
  const states = componentStates(ds.components, ds.componentEvents, ds.assets, smuIndex(ds.smu), END);
  it('is deterministic and consistent', () => {
    const again = generateFleet({ seed: 7, units: 12, days: 120, end: END });
    expect(again.componentEvents).toEqual(ds.componentEvents);
    expect(states.every((s) => s.status !== 'void' && s.hours >= 0)).toBe(true);
    const seen = new Set<string>();
    for (const s of states.filter((x) => x.status === 'installed')) {
      const k = `${s.unitId}|${s.position}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBeGreaterThan(100);
    expect(ds.lifeTargets).toHaveLength(14);
  });
  it('has failures and suspensions to fit', () => {
    const f = fitKind(allLives(states), 'final_drive', '793F');
    expect(f.data.some((x) => x.failed) && f.data.some((x) => !x.failed)).toBe(true);
  });
});
