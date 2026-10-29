// Golden tests: hand-worked answers from the build plan and A7.
// If a code change moves one of these numbers, the change is wrong or the
// document must be updated first (CLAUDE.md rule).

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import { changeStage, flagDown, moveLocation, release, setEta } from '../src/flags.js';
import { buildEvents, computeKpis, fieldRepairShare, locationHours, shopReleaseVsPlan, splitFlag, stageHours, timeToFirstWrench } from '../src/kpis.js';
import { L, Store, cal, fixtureFlag, minutes, round, truck } from './helpers.js';
import { standbyBreakdown, type StandbyFlag } from '../src/standby.js';

describe('Plan 3.2 worked example: one 12-hour shift', () => {
  const t = truck('ht101');
  const flags = [
    fixtureFlag({ id: 'u', unitId: 'ht101', type: 'unscheduled', start: L('2026-10-26 06:10'), end: L('2026-10-26 08:40') }),
    fixtureFlag({ id: 's', unitId: 'ht101', type: 'scheduled', start: L('2026-10-26 14:00'), end: L('2026-10-26 16:00') }),
  ];
  const smu = [
    { unitId: 'ht101', at: L('2026-10-26 06:00'), hours: 12400.0 },
    { unitId: 'ht101', at: L('2026-10-26 18:00'), hours: 12406.8 },
  ];
  const k = computeKpis(
    { assets: [t], flags, smu, rules: DEFAULT_FLAG_RULES, now: L('2026-10-27 00:00') },
    { from: L('2026-10-26 06:00'), to: L('2026-10-26 18:00') },
  );

  it('4.5 h down, 7.5 h available', () => {
    expect(round(k.downHours)).toBe(4.5);
    expect(round(k.availableHours)).toBe(7.5);
  });
  it('PA = 62.5%', () => expect(round(k.pa, 4)).toBe(0.625));
  it('operated 6.8 h from SMU', () => expect(round(k.operatingHours)).toBe(6.8));
  it('utilisation = 90.7%', () => expect(round(k.utilisation, 3)).toBe(0.907));
  it('standby = 0.7 h, and does not reduce PA', () => expect(round(k.standbyHours)).toBe(0.7));
  it('PA × utilisation = effective utilisation = 56.7%', () => {
    expect(round(k.effectiveUtilisation, 3)).toBe(0.567);
    expect(round(k.pa! * k.utilisation!, 6)).toBe(round(k.effectiveUtilisation, 6));
  });
});

describe('KPI-044 and KPI-045 worked example: the plan 3.2 shift with standby flags', () => {
  const t = truck('ht101');
  const flags = [
    fixtureFlag({ id: 'u', unitId: 'ht101', type: 'unscheduled', start: L('2026-10-26 06:10'), end: L('2026-10-26 08:40') }),
    fixtureFlag({ id: 's', unitId: 'ht101', type: 'scheduled', start: L('2026-10-26 14:00'), end: L('2026-10-26 16:00') }),
  ];
  const sb = (id: string, reasonCode: string, kind: StandbyFlag['kind'], start: string, end: string, state: StandbyFlag['state'] = 'ended'): StandbyFlag =>
    ({ id, tenantId: 't1', siteId: 's1', unitId: 'ht101', reasonCode, kind, start: L(start), end: L(end), state, setBy: 'x', enteredAt: L(start) });
  const standby = [
    sb('a', 'SHIFT_CHANGE', 'operating_delay', '2026-10-26 06:00', '2026-10-26 06:30'),
    sb('b', 'CRIB', 'operating_delay', '2026-10-26 12:00', '2026-10-26 12:30'),
    sb('c', 'NO_OPERATOR', 'standby', '2026-10-26 15:00', '2026-10-26 17:00'),
    sb('v', 'WEATHER', 'standby', '2026-10-26 09:00', '2026-10-26 10:00', 'voided'),
    sb('d', 'CRIB', 'operating_delay', '2026-10-26 12:10', '2026-10-26 12:20'),
  ];
  const p = { from: L('2026-10-26 06:00'), to: L('2026-10-26 18:00') };
  const now = L('2026-10-27 00:00');
  const k = computeKpis({ assets: [t], flags, smu: [], standby, rules: DEFAULT_FLAG_RULES, now }, p);

  it('standby 1 h 40: 10 min after the stop, 30 min crib, 1 h after the PM', () => expect(minutes(k.recordedStandbyHours)).toBe(100));
  it('utilisation (time) = (7.5 − 1.667) ÷ 7.5 = 77.8%, and PA is unchanged at 62.5%', () => {
    expect(round(k.utilisationTime, 3)).toBe(0.778);
    expect(round(k.pa, 4)).toBe(0.625);
  });
  it('by kind: operating delay 40 min, standby 1 h', () => {
    const b = standbyBreakdown(['ht101'], standby, flags, [], p, now);
    expect(minutes(b.byKind.operating_delay)).toBe(40);
    expect(minutes(b.byKind.standby)).toBe(60);
    expect(b.byReason.WEATHER).toBeUndefined();
  });
  it('no standby flags: utilisation (time) is 100% of available time', () => {
    expect(computeKpis({ assets: [t], flags, smu: [], rules: DEFAULT_FLAG_RULES, now }, p).utilisationTime).toBe(1);
  });
});

describe('Appendix A worked example: PA for one truck, one week', () => {
  it('168 h, 20 h unscheduled + 8 h PM → PA 83.3%, standby does not change it', () => {
    const flags = [
      fixtureFlag({ id: 'u', unitId: 'ht1', type: 'unscheduled', start: L('2026-10-05 08:00'), end: L('2026-10-06 04:00') }),
      fixtureFlag({ id: 's', unitId: 'ht1', type: 'scheduled', start: L('2026-10-08 06:00'), end: L('2026-10-08 14:00') }),
    ];
    // 10 h standby: SMU only rises 130 of the 140 available hours.
    const smu = [
      { unitId: 'ht1', at: L('2026-10-05 00:00'), hours: 1000 },
      { unitId: 'ht1', at: L('2026-10-12 00:00'), hours: 1130 },
    ];
    const k = computeKpis(
      { assets: [truck('ht1')], flags, smu, rules: DEFAULT_FLAG_RULES, now: L('2026-10-20 00:00') },
      { from: L('2026-10-05 00:00'), to: L('2026-10-12 00:00') },
    );
    expect(k.calendarHours).toBe(168);
    expect(k.downHours).toBe(28);
    expect(round(k.pa, 3)).toBe(0.833);
    expect(round(k.standbyHours)).toBe(10);
  });
});

describe('A7 section 10 worked example: HT107, Monday 26 October', () => {
  const s = new Store(truck('ht107'));
  const at = (hhmm: string) => L(`2026-10-26 ${hhmm}`);
  s.apply(flagDown(s.ctx(at('08:02')), {
    type: 'unscheduled',
    reasonCode: 'Breakdown',
    system: 'Hydraulics',
    start: at('08:02'),
    location: { kind: 'field', fieldLocation: 'Pit 2 north ramp' },
  }));
  s.apply(changeStage(s.ctx(at('08:40')), s.open, { stage: 'in_repair' }));
  s.apply(setEta(s.ctx(at('09:05')), s.open, at('16:00')));
  s.apply(moveLocation(s.ctx(at('09:30')), s.open, { kind: 'towing' }));
  s.apply(moveLocation(s.ctx(at('10:15')), s.open, { kind: 'shop_yard' }));
  s.apply(moveLocation(s.ctx(at('11:05')), s.open, { kind: 'shop_line', shopLineId: 'L4' }));
  s.apply(changeStage(s.ctx(at('12:20')), s.open, { stage: 'waiting_parts', partOrWorkOrder: 'Seal kit' }));
  s.apply(changeStage(s.ctx(at('14:50')), s.open, { stage: 'in_repair' }));
  s.apply(setEta(s.ctx(at('16:30')), s.open, at('18:00')));
  s.apply(changeStage(s.ctx(at('17:40')), s.open, { stage: 'ready_for_release' }));
  const [flag] = s.apply(release(s.ctx(at('18:10')), s.open, {
    details: { system: 'Hydraulics', component: 'Hoist cylinder', failureModes: ['Leak'], repairSummary: 'Replaced hoist cylinder seals', workOrder: 'WO-123456', smuAtFailure: 30512 },
  }));
  const f = flag!;
  const now = at('23:00');
  const day = { from: at('00:00'), to: L('2026-10-27 00:00') };

  it('downtime is 10 h 08 min', () => {
    const k = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, now }, day);
    expect(minutes(k.downHours)).toBe(608);
  });

  it('splits 9 h 58 min to day shift and 10 min to night shift (change at 18:00)', () => {
    const pieces = splitFlag(f, cal, now);
    const byShift = (n: string) => minutes(pieces.filter((p) => p.shift === n).reduce((a, p) => a + p.hours, 0));
    expect(byShift('day')).toBe(598);
    expect(byShift('night')).toBe(10);
  });

  it('counts as one unscheduled failure on Hydraulics', () => {
    const ev = buildEvents(s.flags, DEFAULT_FLAG_RULES, now);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.isFailure).toBe(true);
    expect(ev[0]!.system).toBe('Hydraulics');
  });

  it('repair time 4 h 55 min; waiting 5 h 13 min by stage', () => {
    const sh = stageHours(f, day, now);
    expect(minutes(sh.in_repair)).toBe(295);
    expect(minutes(sh.waiting_crew)).toBe(38);
    expect(minutes(sh.in_transit)).toBe(45);
    expect(minutes(sh.waiting_line)).toBe(50);
    expect(minutes(sh.waiting_parts)).toBe(150);
    expect(minutes(sh.ready_for_release)).toBe(30);
    const waiting = Object.entries(sh).filter(([k]) => k !== 'in_repair').reduce((a, [, v]) => a + v, 0);
    expect(minutes(waiting)).toBe(313);
    expect(minutes(waiting + sh.in_repair)).toBe(608);
  });

  it('by location: field 1 h 28, towing 45, shop yard 50, Line 4 7 h 05', () => {
    const lh = locationHours(f, day, now);
    expect(minutes(lh.field)).toBe(88);
    expect(minutes(lh.towing)).toBe(45);
    expect(minutes(lh.shop_yard)).toBe(50);
    expect(minutes(lh.shop_line)).toBe(425);
  });

  it('time to first wrench 38 min; MTTR = 4 h 55 for the one failure', () => {
    const ev = buildEvents(s.flags, DEFAULT_FLAG_RULES, now)[0]!;
    expect(minutes(timeToFirstWrench(ev)!)).toBe(38);
    const k = computeKpis({ assets: [s.asset], flags: s.flags, smu: [], rules: DEFAULT_FLAG_RULES, now }, day);
    expect(minutes(k.mttr!)).toBe(295);
    expect(minutes(k.meanDowntime!)).toBe(608);
  });

  it('missed its first ETA (16:00), so it counts against shop release vs plan (D10)', () => {
    const r = shopReleaseVsPlan(s.flags, day, DEFAULT_FLAG_RULES);
    expect(r).toEqual({ due: 1, onTime: 0, rate: 0 });
    // With "last ETA before release" it would have been on time (18:10 > 18:00, so still late).
    const r2 = shopReleaseVsPlan(s.flags, day, { ...DEFAULT_FLAG_RULES, shopReleaseEta: 'last_before_due' });
    expect(r2.onTime).toBe(0);
  });

  it('was not a field repair', () => {
    const ev = buildEvents(s.flags, DEFAULT_FLAG_RULES, now);
    expect(fieldRepairShare(ev, day)).toEqual({ events: 1, field: 0, share: 0 });
  });

  it('kept every stage and location as its own timed interval', () => {
    expect(f.stages.map((x) => x.stage)).toEqual([
      'waiting_crew', 'in_repair', 'in_transit', 'waiting_line', 'in_repair', 'waiting_parts', 'in_repair', 'ready_for_release',
    ]);
    expect(f.locations.map((x) => x.kind)).toEqual(['field', 'towing', 'shop_yard', 'shop_line']);
    expect(f.etas.map((e) => e.eta)).toEqual([at('16:00'), at('18:00')]);
    expect(s.audit).toHaveLength(11);
  });
});
