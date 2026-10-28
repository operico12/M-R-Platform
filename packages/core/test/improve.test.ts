// Phase 2 improvement loop: actions, before-and-after effect, and RCA.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import type { ConsoleContext } from '../src/console.js';
import { filterToQuery, EMPTY_FILTER } from '../src/filters.js';
import {
  actionCounts, actionEffect, effectVerdict, cancelAction, cancelRca, changeAction, closeRca, completeAction, createAction, editRca, isOverdue,
  rcaActions, reopenAction, reopenRca, startAction, startRca, type ActionInput, type ImprovementAction, type Rca,
} from '../src/improve.js';
import { twelveHourCalendar } from '../src/time.js';
import type { DownFlag, Role } from '../src/types.js';
import { L, TZ, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role, now = L('2026-10-26 09:00'), userId = `u-${role}`): ConsoleContext => ({
  actor: { userId, role, scope: ['*'] }, now, newId: () => `id-${++n}`, timeZone: TZ, calendar: twelveHourCalendar(TZ),
});
const OWNERS = ['u-supervisor', 'u-technician', 'u-reliability_engineer'];
const input: ActionInput = {
  title: 'Change hydraulic hose routing on 793F', owner: 'u-technician', due: '2026-11-15',
  source: { kind: 'analysis', query: 'system=Hydraulics', label: 'Hydraulics, last 28 days' },
};
function ok<T>(r: { ok: true; records: T[] } | { ok: false; errors: string[] }): T[] {
  if (!r.ok) throw new Error(r.errors.join(' | '));
  return r.records;
}

describe('actions', () => {
  it('supervisors, reliability engineers and superintendents raise them; others cannot', () => {
    for (const r of ['viewer', 'technician', 'admin'] as Role[]) expect(createAction(ctx(r), [], input, OWNERS).ok).toBe(false);
    for (const r of ['supervisor', 'reliability_engineer', 'superintendent'] as Role[]) expect(createAction(ctx(r), [], input, OWNERS).ok).toBe(true);
  });

  it('needs a title, an owner from the site users and a due date', () => {
    const r = createAction(ctx('supervisor'), [], { ...input, title: ' ', owner: 'stranger', due: '15/11/2026' }, OWNERS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors).toHaveLength(3);
  });

  it('warns, but allows, a due date already past', () => {
    const r = createAction(ctx('supervisor'), [], { ...input, due: '2026-10-20' }, OWNERS);
    expect(r.ok && r.warnings[0]).toMatch(/overdue/);
  });

  it('the owner can start and close it; closing needs a note; the log keeps every step', () => {
    const [a] = ok(createAction(ctx('supervisor'), [], input, OWNERS));
    const tech = ctx('technician', L('2026-10-27 08:00'), 'u-technician');
    expect(startAction(ctx('technician', L('2026-10-27 08:00'), 'u-other'), [a!], a!.id).ok).toBe(false);
    const started = ok(startAction(tech, [a!], a!.id));
    expect(started[0]!.status).toBe('in_progress');
    expect(completeAction(tech, started, a!.id, '  ').ok).toBe(false);
    const r = completeAction(tech, started, a!.id, 'Rerouted on HT101 to HT110');
    expect(r.ok && r.records[0]).toMatchObject({ status: 'done', doneAt: L('2026-10-27 08:00'), doneNote: 'Rerouted on HT101 to HT110' });
    expect(r.ok && r.audit[0]).toMatchObject({ entity: 'action', action: 'complete_action', userId: 'u-technician', reason: 'Rerouted on HT101 to HT110' });
    // A technician cannot cancel or reopen, even their own.
    expect(cancelAction(tech, started, a!.id, 'no').ok).toBe(false);
  });

  it('moving the due date or owner needs a reason; a closed action must be reopened first', () => {
    const sup = ctx('supervisor');
    const [a] = ok(createAction(sup, [], input, OWNERS));
    expect(changeAction(sup, [a!], a!.id, { due: '2026-12-01', reason: '' }, OWNERS).ok).toBe(false);
    const moved = ok(changeAction(sup, [a!], a!.id, { due: '2026-12-01', reason: 'Parts on back order' }, OWNERS));
    expect(moved[0]!.due).toBe('2026-12-01');
    expect(changeAction(sup, moved, a!.id, { title: 'Better title', reason: '' }, OWNERS).ok).toBe(true);
    const cancelled = ok(cancelAction(sup, moved, a!.id, 'Covered by the OEM campaign'));
    expect(cancelled[0]).toMatchObject({ status: 'cancelled', cancelReason: 'Covered by the OEM campaign' });
    expect(changeAction(sup, cancelled, a!.id, { title: 'x', reason: 'x' }, OWNERS).ok).toBe(false);
    expect(reopenAction(sup, cancelled, a!.id, '').ok).toBe(false);
    const back = ok(reopenAction(sup, cancelled, a!.id, 'Campaign dropped'));
    expect(back[0]).toMatchObject({ status: 'open', cancelReason: undefined });
    expect(back).toHaveLength(1);
  });

  it('is overdue after the due date ends at the site, not in the browser', () => {
    const a = { status: 'open', due: '2026-10-26' } as ImprovementAction;
    // 23:30 on the 26th in Vancouver is already the 27th in UTC.
    expect(isOverdue(a, L('2026-10-26 23:30'), TZ)).toBe(false);
    expect(isOverdue(a, L('2026-10-27 00:01'), TZ)).toBe(true);
    expect(isOverdue({ ...a, status: 'done' }, L('2026-11-30 00:00'), TZ)).toBe(false);
    expect(actionCounts([a, { ...a, status: 'done' }, { ...a, status: 'in_progress', due: '2026-12-01' }], L('2026-10-28 08:00'), TZ))
      .toEqual({ open: 2, overdue: 1, done: 1, cancelled: 0 });
  });
});

describe('effect: before and after', () => {
  const t1 = truck('t1');
  const flag = (id: string, start: string, hours: number, system = 'Hydraulics'): DownFlag => {
    const s = L(start);
    const e = new Date(Date.parse(s) + hours * 36e5).toISOString();
    return {
      id, tenantId: 't1', siteId: 's1', unitId: 't1', type: 'unscheduled', state: 'released', reasonCode: system, system, start: s, end: e,
      stages: [{ stage: 'in_repair', start: s, end: e, setBy: 'x', enteredAt: s }], locations: [{ kind: 'field', start: s, end: e, fieldLocation: 'Pit 1', setBy: 'x', enteredAt: s }],
      etas: [], workOrders: [], source: 'app', setBy: 'x', enteredAt: s,
    };
  };
  // Hand-worked: done 15 Oct 00:00. Before (17 Sep to 15 Oct): two 10 h hydraulic failures and one 6 h tyre stop.
  // After (15 Oct to 12 Nov): one 5 h hydraulic failure. Both windows are 28 days = 672 h for one truck.
  const flags = [flag('a', '2026-09-20 08:00', 10), flag('b', '2026-10-05 08:00', 10), flag('c', '2026-10-08 08:00', 6, 'Tyres'), flag('d', '2026-10-30 08:00', 5)];
  const done: ImprovementAction = {
    id: 'x', title: 't', owner: 'o', due: '2026-10-15', status: 'done', createdBy: 'c', createdAt: L('2026-09-01 00:00'), updatedAt: L('2026-10-15 00:00'),
    doneAt: L('2026-10-15 00:00'), doneNote: 'n', source: { kind: 'analysis', query: filterToQuery({ ...EMPTY_FILTER, systems: ['Hydraulics'] }), label: 'Hydraulics' },
  };
  const input = (now: string) => ({ assets: [t1], flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L(now), calendar: twelveHourCalendar(TZ), timeZone: TZ });

  it('compares equal windows on the action\'s own slice', () => {
    // Windows are 28 x 24 h of real time, so the after window ends 672 h after the action was done,
    // whatever the site clocks do in between (time zone data for the site can change its DST rules).
    const e = actionEffect(input('2026-11-20 00:00'), done)!;
    expect(e.days).toBe(28);
    expect(e.enough).toBe(true);
    expect(e.before).toMatchObject({ from: L('2026-09-17 00:00'), downHours: 20, failures: 2, events: 2 });
    expect(e.after).toMatchObject({ to: new Date(Date.parse(done.doneAt!) + 28 * 864e5).toISOString(), downHours: 5, failures: 1 });
    expect(e.before.downPer1000).toBeCloseTo((20 / 672) * 1000, 6);
    expect(e.downChange).toBeCloseTo(-0.75, 6);
    expect(e.failureChange).toBe(-1);
    // PA is for the units in the slice, all downtime: (672 - 26) / 672 before.
    expect(e.before.pa).toBeCloseTo(646 / 672, 6);
  });

  it('shortens both windows while the after window fills, and says when it is too early', () => {
    const e = actionEffect(input('2026-10-19 00:00'), done)!;
    expect(e.days).toBe(4);
    expect(e.enough).toBe(false);
    expect(e.before.from).toBe(L('2026-10-11 00:00'));
    expect(e.before.downHours).toBe(0);
    expect(e.downChange).toBeNull();
  });

  it('reads small changes as no clear change', () => {
    const e = actionEffect(input('2026-11-20 00:00'), done)!;
    expect(effectVerdict(e)).toBe('better');
    expect(effectVerdict({ ...e, downChange: -0.05 })).toBe('no_clear_change');
    expect(effectVerdict({ ...e, downChange: 0.12 })).toBe('worse');
    expect(effectVerdict({ ...e, downChange: null })).toBe('no_baseline');
    expect(effectVerdict({ ...e, enough: false })).toBe('too_early');
  });

  it('only for done actions with a slice', () => {
    expect(actionEffect(input('2026-11-12 00:00'), { ...done, status: 'open' })).toBeUndefined();
    expect(actionEffect(input('2026-11-12 00:00'), { ...done, source: { kind: 'manual', label: 'x' } })).toBeUndefined();
  });
});

describe('root cause analysis', () => {
  const LEADS = ['u-reliability_engineer'];
  const rIn = { title: 'HT107 hydraulic hose failures', problem: 'Three hose failures in 6 weeks on HT107 boom circuit', source: { kind: 'unit' as const, unitId: 'ht107', label: 'HT107' }, lead: 'u-reliability_engineer' };

  it('reliability engineers and superintendents lead them', () => {
    for (const r of ['viewer', 'technician', 'supervisor', 'admin'] as Role[]) expect(startRca(ctx(r), [], rIn, LEADS).ok).toBe(false);
    expect(startRca(ctx('superintendent'), [], rIn, LEADS).ok).toBe(true);
  });

  it('works through whys and a fishbone, then closes only with a root cause', () => {
    const re = ctx('reliability_engineer');
    const [r] = ok(startRca(re, [], rIn, LEADS));
    let list = ok(editRca(re, [r!], r!.id, { whys: ['Hose burst', 'Rubbed on frame', ' ', 'Clamp missing after PM'], fishbone: { method: ['PM sheet has no clamp check'], people: [] } }, LEADS));
    expect(list[0]!.whys).toEqual(['Hose burst', 'Rubbed on frame', 'Clamp missing after PM']);
    expect(list[0]!.fishbone.method).toEqual(['PM sheet has no clamp check']);
    expect(editRca(re, list, r!.id, { whys: Array(8).fill('why') }, LEADS).ok).toBe(false);
    expect(closeRca(re, list, r!.id, 'Done', []).ok).toBe(false);
    list = ok(editRca(re, list, r!.id, { rootCause: 'PM job plan does not check hose clamps' }, LEADS));
    const action: ImprovementAction = { ...({} as ImprovementAction), id: 'a1', status: 'open', source: { kind: 'rca', rcaId: r!.id, label: r!.title } };
    expect(rcaActions(list[0]!, [action])).toHaveLength(1);
    const noActions = closeRca(re, list, r!.id, 'Agreed at reliability meeting', []);
    expect(noActions.ok && noActions.warnings[0]).toMatch(/No actions/);
    const closed = closeRca(re, list, r!.id, 'Agreed at reliability meeting', [action]);
    expect(closed.ok && closed.warnings).toEqual([]);
    const c = ok(closed)[0] as Rca;
    expect(c.status).toBe('closed');
    expect(editRca(re, [c], c.id, { title: 'x' }, LEADS).ok).toBe(false);
    expect(ok(reopenRca(re, [c], c.id, 'Failed again'))[0]!.status).toBe('open');
  });

  it('cancelling needs a reason', () => {
    const re = ctx('reliability_engineer');
    const [r] = ok(startRca(re, [], rIn, LEADS));
    expect(cancelRca(re, [r!], r!.id, '').ok).toBe(false);
    expect(ok(cancelRca(re, [r!], r!.id, 'Duplicate of the fleet RCA'))[0]!.status).toBe('cancelled');
  });
});
