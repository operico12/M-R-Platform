// Project tracking (plan 8): gates, tasks and dependencies, change requests,
// health, benefits and the weekly status report.

import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAG_RULES } from '../src/config.js';
import type { ConsoleContext, ConsoleResult } from '../src/console.js';
import { EMPTY_FILTER, filterToQuery } from '../src/filters.js';
import {
  addCost, addRisk, addTask, advanceStage, closeRisk, createProject, decideChange, editProject, editTask, logDecision, nextMilestone,
  progress, projectBenefit, projectHealth, proposeChange, reopenProject, setTaskStatus, spent, statusReport, stopProject,
  type Project, type ProjectInput,
} from '../src/projects.js';
import { twelveHourCalendar } from '../src/time.js';
import type { DownFlag, Role } from '../src/types.js';
import { L, TZ, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role, now = L('2026-10-26 09:00'), userId = `u-${role}`): ConsoleContext => ({
  actor: { userId, role, scope: ['*'] }, now, newId: () => `id-${++n}`, timeZone: TZ, calendar: twelveHourCalendar(TZ),
});
const RE = ctx('reliability_engineer');
const SUP = ctx('superintendent');
const OWNERS = ['u-reliability_engineer', 'u-superintendent', 'u-supervisor', 'u-technician'];
const input: ProjectInput = {
  title: 'Critical hose programme', charter: 'Hose failures are the top hydraulic loss. Replace critical hoses on a time basis.', scope: '793F hoist and steering hoses',
  owner: 'u-reliability_engineer', start: '2026-10-01', end: '2026-12-31', budget: 50000,
};

function okp(r: ConsoleResult<Project>): Project[] {
  if (!r.ok) throw new Error(r.errors.join(' | '));
  return r.records;
}
const one = (list: Project[]) => list[list.length - 1]!;

describe('gates', () => {
  it('reliability engineers and superintendents create projects; they start as ideas', () => {
    for (const r of ['viewer', 'technician', 'supervisor', 'admin'] as Role[]) expect(createProject(ctx(r), [], input, OWNERS).ok).toBe(false);
    const p = one(okp(createProject(RE, [], input, OWNERS)));
    expect(p.stage).toBe('idea');
    expect(createProject(RE, [], { ...input, end: '2026-09-01' }, OWNERS).ok).toBe(false);
  });

  it('only the superintendent approves and confirms benefits; closing needs every task closed', () => {
    let list = okp(createProject(RE, [], input, OWNERS));
    const id = one(list).id;
    expect(advanceStage(RE, list, id, '').ok).toBe(false);
    list = okp(advanceStage(SUP, list, id, 'Funded from the reliability budget'));
    expect(one(list).stage).toBe('approved');
    const started = advanceStage(RE, list, id, '');
    expect(started.ok && started.warnings[0]).toMatch(/No tasks/);
    list = okp(started);
    list = okp(addTask(RE, list, id, { title: 'Hose list', owner: 'u-technician', start: '2026-10-05', due: '2026-10-20' }, OWNERS));
    expect(advanceStage(RE, list, id, 'Delivered').ok).toBe(false);
    const t = one(list).tasks[0]!.id;
    list = okp(setTaskStatus(RE, list, id, t, 'done'));
    expect(advanceStage(RE, list, id, '').ok).toBe(false); // closing note
    list = okp(advanceStage(RE, list, id, 'All hoses on the list replaced'));
    expect(one(list).stage).toBe('closed');
    expect(editProject(RE, list, id, { title: 'x' }, OWNERS).ok).toBe(false);
    expect(advanceStage(RE, list, id, 'Saw it').ok).toBe(false);
    list = okp(advanceStage(SUP, list, id, '120 h a year avoided, checked at the March review'));
    expect(one(list).stages.map((s) => s.stage)).toEqual(['idea', 'approved', 'in_progress', 'closed', 'benefits_confirmed']);
  });

  it('a stopped project keeps its history and can be reopened by the superintendent', () => {
    let list = okp(createProject(RE, [], input, OWNERS));
    const id = one(list).id;
    expect(stopProject(RE, list, id, 'x').ok).toBe(false);
    expect(stopProject(SUP, list, id, '').ok).toBe(false);
    list = okp(stopProject(SUP, list, id, 'OEM campaign covers it'));
    expect(one(list).stage).toBe('stopped');
    list = okp(reopenProject(SUP, list, id, 'Campaign dropped'));
    expect(one(list).stage).toBe('idea');
    expect(one(list).stages).toHaveLength(3);
  });
});

describe('tasks', () => {
  const approved = () => {
    let list = okp(createProject(RE, [], input, OWNERS));
    list = okp(advanceStage(SUP, list, one(list).id, 'ok'));
    return list;
  };

  it('dependencies block starting, and loops are refused', () => {
    let list = approved();
    const id = one(list).id;
    list = okp(addTask(RE, list, id, { title: 'Order hoses', owner: 'u-supervisor', start: '2026-10-05', due: '2026-10-10' }, OWNERS));
    const a = one(list).tasks[0]!.id;
    list = okp(addTask(RE, list, id, { title: 'Fit hoses', owner: 'u-technician', start: '2026-10-12', due: '2026-10-30', dependsOn: [a] }, OWNERS));
    const b = one(list).tasks[1]!.id;
    expect(editTask(RE, list, id, a, { title: 'Order hoses', owner: 'u-supervisor', start: '2026-10-05', due: '2026-10-10', dependsOn: [b] }, OWNERS).ok).toBe(false);
    const tech = ctx('technician', L('2026-10-26 09:00'), 'u-technician');
    const r = setTaskStatus(tech, list, id, b, 'in_progress');
    expect(!r.ok && r.errors[0]).toMatch(/Waiting on: Order hoses/);
    list = okp(setTaskStatus(ctx('supervisor', L('2026-10-26 09:00'), 'u-supervisor'), list, id, a, 'done'));
    list = okp(setTaskStatus(tech, list, id, b, 'in_progress'));
    expect(setTaskStatus(tech, list, id, b, 'cancelled', 'no').ok).toBe(false);
    expect(setTaskStatus(RE, list, id, b, 'cancelled', '').ok).toBe(false);
    expect(progress(one(list))).toBe(0.5);
  });

  it('work waits for approval; a task due after the project ends is a warning', () => {
    let list = okp(createProject(RE, [], input, OWNERS));
    const id = one(list).id;
    list = okp(addTask(RE, list, id, { title: 'Survey', owner: 'u-technician', start: '2026-10-05', due: '2027-01-10', milestone: true }, OWNERS));
    expect(setTaskStatus(RE, list, id, one(list).tasks[0]!.id, 'in_progress').ok).toBe(false);
    expect(nextMilestone(one(list))?.title).toBe('Survey');
    const r = addTask(RE, list, id, { title: 'Late', owner: 'u-technician', start: '2026-10-05', due: '2027-01-10' }, OWNERS);
    expect(r.ok && r.warnings[0]).toMatch(/after the project end/);
  });
});

describe('budget and change requests', () => {
  it('budget and dates are free while an idea; after approval they need a change request the superintendent decides', () => {
    let list = okp(createProject(RE, [], input, OWNERS));
    const id = one(list).id;
    list = okp(editProject(RE, list, id, { budget: 60000 }, OWNERS));
    list = okp(advanceStage(SUP, list, id, 'ok'));
    expect(editProject(RE, list, id, { budget: 70000 }, OWNERS).ok).toBe(false);
    list = okp(proposeChange(RE, list, id, { text: 'Steel price rise', budget: 70000, end: '2027-01-31' }));
    expect(projectHealth(one(list), L('2026-10-26 09:00'), TZ).reasons).toContain('A change request is waiting for a decision.');
    const cr = one(list).changes[0]!.id;
    expect(decideChange(RE, list, id, cr, true, '').ok).toBe(false);
    expect(decideChange(SUP, list, id, cr, false, '').ok).toBe(false);
    list = okp(decideChange(SUP, list, id, cr, true, 'Agreed'));
    expect(one(list)).toMatchObject({ budget: 70000, end: '2027-01-31' });
    // The superintendent cannot approve their own request.
    list = okp(proposeChange(SUP, list, id, { text: 'More', budget: 90000 }));
    expect(decideChange(SUP, list, id, one(list).changes[1]!.id, true, 'ok').ok).toBe(false);
  });

  it('costs are added, reversed with a negative entry, never edited', () => {
    let list = okp(createProject(RE, [], input, OWNERS));
    const id = one(list).id;
    list = okp(addCost(RE, list, id, { date: '2026-10-10', amount: 12000, text: 'Hoses', reference: 'PO-1' }));
    list = okp(addCost(RE, list, id, { date: '2026-10-11', amount: -2000, text: 'Credit for returned hoses' }));
    expect(spent(one(list))).toBe(10000);
    expect(addCost(RE, list, id, { date: '2026-10-11', amount: -20000, text: 'x' }).ok).toBe(false);
    expect(addCost(RE, list, id, { date: '2026-10-11', amount: 0, text: 'x' }).ok).toBe(false);
  });
});

describe('health', () => {
  const base = (over: Partial<Project> = {}): Project => ({
    id: 'p', title: 't', charter: 'c', scope: '', owner: 'o', stage: 'in_progress', stages: [], start: '2026-10-01', end: '2026-12-31',
    budget: 100, forecastToComplete: 50, tasks: [], risks: [], decisions: [], costs: [], changes: [],
    links: { unitIds: [], workOrders: [], rcaIds: [], actionIds: [] }, createdBy: 'c', createdAt: '', updatedAt: '', ...over,
  });
  const now = L('2026-10-26 09:00');
  const task = (due: string, status: 'not_started' | 'in_progress' | 'done' = 'not_started') => ({ id: due, title: due, owner: 'o', start: '2026-10-01', due, status, milestone: false, dependsOn: [] });

  it('late beats at risk beats on track', () => {
    expect(projectHealth(base(), now, TZ)).toEqual({ health: 'on_track', reasons: [] });
    expect(projectHealth(base({ tasks: [task('2026-10-30')] }), now, TZ).health).toBe('at_risk');
    expect(projectHealth(base({ tasks: [task('2026-10-30', 'in_progress')] }), now, TZ).health).toBe('on_track');
    expect(projectHealth(base({ costs: [{ id: 'c', date: '2026-10-01', amount: 60, text: 'x', enteredBy: 'x', enteredAt: '' }] }), now, TZ).reasons).toEqual(['Actual plus forecast is over budget.']);
    expect(projectHealth(base({ risks: [{ id: 'r', kind: 'risk', text: 'x', likelihood: 2, impact: 3, owner: 'o', status: 'open', raisedAt: '' }] }), now, TZ).health).toBe('at_risk');
    expect(projectHealth(base({ risks: [{ id: 'r', kind: 'risk', text: 'x', likelihood: 1, impact: 3, owner: 'o', status: 'open', raisedAt: '' }] }), now, TZ).health).toBe('on_track');
    expect(projectHealth(base({ tasks: [task('2026-10-25', 'in_progress'), task('2026-10-30')] }), now, TZ)).toEqual({ health: 'late', reasons: ['1 task overdue.', '1 task due within 7 days not started.'] });
    expect(projectHealth(base({ end: '2026-10-20' }), now, TZ).health).toBe('late');
    expect(projectHealth(base({ stage: 'closed', end: '2026-10-20' }), now, TZ).health).toBe('closed');
  });

  it('a task due today, in site time, is not yet overdue', () => {
    // 23:30 local on the 26th is the 27th in UTC.
    expect(projectHealth(base({ tasks: [task('2026-10-26', 'in_progress')] }), L('2026-10-26 23:30'), TZ).health).toBe('on_track');
  });
});

describe('benefit', () => {
  const t1 = truck('t1');
  const flag = (id: string, start: string, hours: number): DownFlag => {
    const s = L(start);
    const e = new Date(Date.parse(s) + hours * 36e5).toISOString();
    return {
      id, tenantId: 't1', siteId: 's1', unitId: 't1', type: 'unscheduled', state: 'released', reasonCode: 'Hydraulics', system: 'Hydraulics', start: s, end: e,
      stages: [{ stage: 'in_repair', start: s, end: e, setBy: 'x', enteredAt: s }], locations: [{ kind: 'field', start: s, end: e, fieldLocation: 'P', setBy: 'x', enteredAt: s }],
      etas: [], workOrders: [], source: 'app', setBy: 'x', enteredAt: s,
    };
  };
  // Hand-worked: in progress 1 Jul, closed 1 Sep. Baseline 2 Apr to 1 Jul (90 days, 2160 h): 54 h down = 25 per 1000 h.
  // After 1 Sep to 1 Oct (30 days, 720 h): 9 h down = 12.5 per 1000 h. Avoided (25 − 12.5) × 0.72 = 9 h; 9 ÷ 30 × 365 = 109.5 h a year.
  const flags = [flag('a', '2026-05-01 08:00', 30), flag('b', '2026-06-10 08:00', 24), flag('c', '2026-08-01 08:00', 100), flag('d', '2026-09-15 08:00', 9)];
  const p = {
    benefitQuery: filterToQuery({ ...EMPTY_FILTER, systems: ['Hydraulics'] }), valuePerDownHour: 2000,
    stages: [{ stage: 'in_progress', at: L('2026-07-01 00:00'), by: 'x' }, { stage: 'closed', at: L('2026-09-01 00:00'), by: 'x' }],
  } as Project;
  const inp = (now: string) => ({ assets: [t1], flags, smu: [], rules: DEFAULT_FLAG_RULES, now: L(now), calendar: twelveHourCalendar(TZ), timeZone: TZ });

  it('compares the 90 days before work started with the time since it closed; downtime during the project is left out', () => {
    const b = projectBenefit(inp('2026-10-01 00:00'), p)!;
    expect(b.baseline.calendarHours).toBeCloseTo(2160, 6);
    expect(b.baseline.downHours).toBeCloseTo(54, 6);
    expect(b.baselineRate).toBeCloseTo(25, 6);
    expect(b.after.calendarHours).toBeCloseTo(720, 6);
    expect(b.afterRate).toBeCloseTo(12.5, 6);
    expect(b.hoursAvoided).toBeCloseTo(9, 6);
    expect(b.hoursAvoidedPerYear).toBeCloseTo(109.5, 6);
    expect(b.valueAvoided).toBeCloseTo(18000, 6);
    expect(b.provisional).toBe(false);
  });

  it('is provisional under 28 days and absent before closing', () => {
    expect(projectBenefit(inp('2026-09-10 00:00'), p)!.provisional).toBe(true);
    expect(projectBenefit(inp('2026-10-01 00:00'), { ...p, stages: p.stages.slice(0, 1) })).toBeUndefined();
  });
});

describe('weekly status report', () => {
  it('lists status, money, recent work, next work and risks', () => {
    let list = okp(createProject(RE, [], input, OWNERS));
    const id = one(list).id;
    list = okp(advanceStage(SUP, list, id, 'ok'));
    list = okp(advanceStage(RE, list, id, ''));
    list = okp(addTask(RE, list, id, { title: 'Hose list', owner: 'u-technician', start: '2026-10-05', due: '2026-10-20' }, OWNERS));
    list = okp(addTask(RE, list, id, { title: 'Fit kits', owner: 'u-technician', start: '2026-10-21', due: '2026-11-02' }, OWNERS));
    list = okp(setTaskStatus(RE, list, id, one(list).tasks[0]!.id, 'done'));
    list = okp(addRisk(RE, list, id, { kind: 'risk', text: 'Kit lead time', likelihood: 2, impact: 3, owner: 'u-supervisor' }, OWNERS));
    list = okp(logDecision(RE, list, id, 'Use OEM hoses only'));
    list = okp(addCost(RE, list, id, { date: '2026-10-10', amount: 12000, text: 'Hoses' }));
    const text = statusReport(one(list), L('2026-10-26 09:00'), TZ, (u) => u.replace('u-', ''), (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-CA')}`);
    expect(text).toContain('Stage: In progress · Status: At risk');
    expect(text).toContain('50% of tasks done');
    expect(text).toContain('Budget $50,000 · actual $12,000 · forecast to complete $50,000 · variance -$12,000');
    expect(text).toContain('  - Hose list (technician)');
    expect(text).toContain('  - 2026-11-02 Fit kits (technician)');
    expect(text).toContain('Risk 2×3: Kit lead time (supervisor)');
    list = okp(closeRisk(RE, list, id, one(list).risks[0]!.id, 'Second supplier found'));
    expect(one(list).risks[0]!.status).toBe('closed');
  });
});
