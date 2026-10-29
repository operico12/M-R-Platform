// Assist (docs/ai-assist.md), hand-worked.

import { describe, expect, it } from 'vitest';
import {
  CODE_FIELDS, DEFAULT_ASSIST_SETTINGS, STARTER_CODES, buildSuggester, checkCitations, codedRows, duplicateWorkOrders, flagText, holdoutCheck,
  jaccard, liveSuggestion, packSummary, passes, rcaTimeline, setAssistSettings, suggestCodes, trainCodes, withAssistDefaults, words,
  type CodeList, type CodedRow, type HoldoutCheck,
} from '../src/assist.js';
import type { ConsoleContext } from '../src/console.js';
import type { Rca } from '../src/improve.js';
import { emptyFishbone } from '../src/improve.js';
import type { WeeklyPack } from '../src/pack.js';
import { generateFleet } from '../src/synth/generate.js';
import type { DownFlag, ReleaseDetails, Role, WorkOrder } from '../src/types.js';
import { L, TZ, cal, truck } from './helpers.js';

let n = 0;
const ctx = (role: Role): ConsoleContext => ({ actor: { userId: `u-${role}`, role, scope: ['*'] }, now: L('2026-10-28 09:00'), newId: () => `id${++n}`, timeZone: TZ, calendar: cal });

function flag(start: string, rel: Partial<ReleaseDetails>, extra: Partial<DownFlag> = {}): DownFlag {
  const s = L(start);
  const e = new Date(Date.parse(s) + 4 * 36e5).toISOString();
  return {
    id: `f${++n}`, tenantId: 't', siteId: 's', unitId: 'ht1', type: 'unscheduled', state: 'released', reasonCode: 'Hydraulics', system: 'Hydraulics', start: s, end: e,
    stages: [{ stage: 'in_repair', start: s, end: e, setBy: 'x', enteredAt: s }], locations: [{ kind: 'field', start: s, end: e, fieldLocation: 'Pit 1', setBy: 'x', enteredAt: s }],
    etas: [], workOrders: [], source: 'app', setBy: 'x', enteredAt: s,
    release: { system: 'Hydraulics', component: 'Hose', failureModes: ['Burst'], repairSummary: 'Replaced hose', ...rel },
    ...extra,
  };
}

function wo(number: string, at: string, description: string, extra: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: `wo-${number}`, tenantId: 't', siteId: 's', assetId: 'ht1', sourceSystem: 'maximo', sourceId: number, number, numberNormalised: number,
    workClass: 'corrective', open: true, description, reportedAt: L(at), ...extra,
  };
}

const CODES: CodeList = {
  Hydraulics: { components: ['Hose', 'Hoist cylinder'], modes: ['Burst', 'Leak'] },
  Engine: { components: ['Turbocharger', 'Injector'], modes: ['Low power', 'Leak'] },
};

const row = (i: number, system: string, component: string, mode: string, text: string): CodedRow => ({
  flagId: `r${i}`, at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), words: words(text), system, component, mode,
});

describe('words', () => {
  it('lower-cases, drops common words and numbers, and takes off a plural s', () => {
    expect(words('The HOSES were leaking at 1450, operator noted.')).toEqual(['hose', 'leaking']);
    expect(words('Glass  press')).toEqual(['glass', 'press']);
    expect(words(undefined)).toEqual([]);
  });
  it('reads notes, work order descriptions, repair summary and findings', () => {
    const f = flag('2026-10-01 08:00', { findings: 'Hose burst at hoist' }, { notes: 'Called in by dispatch', workOrders: ['WO-0042'] });
    const idx = new Map([['42', wo('42', '2026-10-01 08:00', 'Oil spray at rear')]]);
    expect(flagText(f, idx)).toBe('Called in by dispatch. Oil spray at rear. Replaced hose. Hose burst at hoist');
  });
});

describe('AI-1 learning set', () => {
  it('uses released failures with clean system, component and mode; a missing cause code does not matter', () => {
    const flags = [
      flag('2026-10-03 08:00', {}),
      flag('2026-10-01 08:00', { causeCode: 'Wear' }),
      flag('2026-10-02 08:00', { component: 'Other' }),
      flag('2026-10-02 09:00', { failureModes: ['Unknown'] }),
      flag('2026-10-02 10:00', { component: 'Turbocharger' }), // not in Hydraulics
      flag('2026-10-02 11:00', {}, { type: 'scheduled' }),
      flag('2026-10-02 12:00', {}, { state: 'voided' }),
      flag('2026-10-02 13:00', { component: 'hose', failureModes: ['burst'] }), // case is matched to the code list
    ];
    const rows = codedRows(flags, [], CODES);
    expect(rows.map((r) => r.flagId)).toEqual([flags[1]!.id, flags[7]!.id, flags[0]!.id]);
    expect(rows[1]).toMatchObject({ system: 'Hydraulics', component: 'Hose', mode: 'Burst' });
  });
});

describe('AI-1 naive Bayes', () => {
  it('gives the hand-worked chance and only codes from the list', () => {
    // Vocab {leak, hose, turbo, burst}. Prior Hyd (2+1)/(3+2), Eng (1+1)/5. P(hose|Hyd) = 3/8, P(hose|Eng) = 1/6.
    // Hyd = 3/5 × 3/8 = 27/120, Eng = 2/5 × 1/6 = 8/120, so Hydraulics 27/35.
    const m = trainCodes([row(1, 'Hydraulics', 'Hose', 'Leak', 'leak hose'), row(2, 'Engine', 'Turbocharger', 'Leak', 'leak turbo'), row(3, 'Hydraulics', 'Hose', 'Burst', 'hose burst')], CODES);
    const s = suggestCodes(m, 'hose', 0.6);
    expect(s.system!.code).toBe('Hydraulics');
    expect(s.system!.chance).toBeCloseTo(27 / 35, 12);
    expect(s.system!.words).toEqual(['hose']);
    expect(s.ranked.system.map((r) => r.code)).toEqual(['Hydraulics', 'Engine']);
    expect(s.ranked.component.map((r) => r.code).sort()).toEqual(['Hoist cylinder', 'Hose']);
    // A code learned but not on the list is never suggested.
    const m2 = trainCodes([row(1, 'Brakes', 'Brake pack', 'Worn', 'brake worn'), row(2, 'Engine', 'Injector', 'Leak', 'injector')], CODES);
    expect(suggestCodes(m2, 'brake worn', 0.1).ranked.system.map((r) => r.code)).not.toContain('Brakes');
  });
  it('abstains below the lowest chance, and with no known words', () => {
    const m = trainCodes([row(1, 'Hydraulics', 'Hose', 'Leak', 'leak hose'), row(2, 'Engine', 'Turbocharger', 'Leak', 'leak turbo'), row(3, 'Hydraulics', 'Hose', 'Burst', 'hose burst')], CODES);
    expect(suggestCodes(m, 'hose', 0.8).system).toBeNull();
    const none = suggestCodes(m, 'see work order', 0.1);
    expect(none.system!.chance).toBeCloseTo(3 / 5, 12); // the prior only
    expect(suggestCodes(m, '', 0.1).system).toBeNull();
  });
  it('follows a system the person already picked', () => {
    const m = trainCodes([row(1, 'Hydraulics', 'Hose', 'Leak', 'leak hose'), row(2, 'Engine', 'Turbocharger', 'Leak', 'leak turbo')], CODES);
    const s = suggestCodes(m, 'leak hose', 0.1, 'Engine');
    expect(s.system).toBeNull();
    expect(s.ranked.component.map((r) => r.code).sort()).toEqual(['Injector', 'Turbocharger']);
    expect(liveSuggestion(s, CODE_FIELDS, 'Engine').component?.code).toBe('Turbocharger');
  });
});

describe('AI-1 held-back check', () => {
  // 8 older rows to learn from, the 2 latest held back (20%).
  const rows = [
    ...[0, 1, 2, 3].map((i) => row(i, 'Hydraulics', 'Hose', 'Burst', 'hose burst')),
    ...[4, 5, 6, 7].map((i) => row(i, 'Engine', 'Turbocharger', 'Low power', 'turbo boost')),
    row(8, 'Hydraulics', 'Hose', 'Burst', 'hose burst'),
    row(9, 'Engine', 'Injector', 'Low power', 'zzz qqq'), // no known words: the prior is 50/50, so no suggestion
  ];
  it('learns from the older flags and scores precision, recall and F1 on the latest', () => {
    const c = holdoutCheck(rows, CODES, DEFAULT_ASSIST_SETTINGS);
    expect(c).toMatchObject({ trainedOn: 8, held: 2, heldFrom: rows[8]!.at });
    for (const f of CODE_FIELDS) {
      expect(c[f]).toMatchObject({ held: 2, answered: 1, right: 1, precision: 1, recall: 0.5 });
      expect(c[f].score).toBeCloseTo(2 / 3, 12);
    }
  });
  it('passes only with enough held-back flags and the score needed', () => {
    const c = holdoutCheck(rows, CODES, DEFAULT_ASSIST_SETTINGS);
    expect(passes(c.system, DEFAULT_ASSIST_SETTINGS)).toBe(false); // 2 held, 30 needed
    expect(passes(c.system, { ...DEFAULT_ASSIST_SETTINGS, minHoldout: 2, minScore: 0.6 })).toBe(true);
    expect(passes(c.system, { ...DEFAULT_ASSIST_SETTINGS, minHoldout: 2, minScore: 0.7 })).toBe(false);
  });
  it('counts a component as wrong when the system is wrong', () => {
    const swapped = [...rows.slice(0, 8), row(8, 'Engine', 'Hose', 'Burst', 'hose burst'), row(9, 'Engine', 'Injector', 'Low power', 'zzz')];
    const c = holdoutCheck(swapped, { ...CODES, Engine: { components: [...CODES.Engine!.components, 'Hose'], modes: [...CODES.Engine!.modes, 'Burst'] } }, DEFAULT_ASSIST_SETTINGS);
    expect(c.system.right).toBe(0);
    expect(c.component.right).toBe(0);
  });
  it('shows only live codes, and a component or mode only with its system', () => {
    const m = trainCodes(rows.slice(0, 8), CODES);
    const s = suggestCodes(m, 'hose burst', 0.6);
    expect(Object.keys(liveSuggestion(s, ['system', 'component', 'mode']))).toEqual(['system', 'component', 'mode']);
    expect(liveSuggestion(s, ['component', 'mode'])).toEqual({});
    expect(Object.keys(liveSuggestion(s, ['system', 'mode']))).toEqual(['system', 'mode']);
  });
});

describe('AI-1 on the synthetic fleet', () => {
  const ds = generateFleet({ seed: 7, units: 40, days: 120, end: '2026-10-27T14:00:00.000Z' });
  it('learns from technician text and passes the check for the system', () => {
    const off = buildSuggester(ds.flags, ds.workOrders, STARTER_CODES, DEFAULT_ASSIST_SETTINGS);
    expect(off.check.held).toBeGreaterThanOrEqual(30);
    expect(passes(off.check.system, DEFAULT_ASSIST_SETTINGS)).toBe(true);
    expect(off.live).toEqual([]); // off until switched on
    const on = buildSuggester(ds.flags, ds.workOrders, STARTER_CODES, { ...DEFAULT_ASSIST_SETTINGS, suggestCodes: true });
    expect(on.live).toContain('system');
  });
  it('writes the text from the true codes, so a flag coded "Other" still reads as its part', () => {
    const other = ds.flags.filter((f) => f.release?.component === 'Other');
    expect(other.length).toBeGreaterThan(0);
    expect(other.every((f) => (f.release?.findings ?? '').length > 0)).toBe(true);
    const corrective = ds.workOrders.filter((w) => w.workClass === 'corrective' && w.description);
    expect(corrective.some((w) => /^(Engine|Hydraulics|Tyres): (Leak|Burst|Cut)$/.test(w.description!))).toBe(false);
  });
});

describe('assist settings', () => {
  const good: HoldoutCheck = {
    trainedOn: 160, held: 40, heldFrom: null,
    system: { held: 40, answered: 40, right: 36, precision: 0.9, recall: 0.9, score: 0.9 },
    component: { held: 40, answered: 30, right: 20, precision: 0.67, recall: 0.5, score: 0.57 },
    mode: { held: 40, answered: 30, right: 20, precision: 0.67, recall: 0.5, score: 0.57 },
  };
  it('only edit_assist roles change them, with a reason', () => {
    const next = { ...DEFAULT_ASSIST_SETTINGS, duplicateDays: 14 };
    expect(setAssistSettings(ctx('supervisor'), DEFAULT_ASSIST_SETTINGS, next, 'x', good).ok).toBe(false);
    expect(setAssistSettings(ctx('admin'), DEFAULT_ASSIST_SETTINGS, next, 'x', good).ok).toBe(false);
    const r = setAssistSettings(ctx('reliability_engineer'), DEFAULT_ASSIST_SETTINGS, next, ' Two weeks ', good);
    expect(r.ok && r.records[0]!.duplicateDays).toBe(14);
    expect(r.ok && r.audit[0]).toMatchObject({ action: 'set_assist_settings', entity: 'settings', entityId: 'assist', reason: 'Two weeks' });
    const bad = setAssistSettings(ctx('superintendent'), DEFAULT_ASSIST_SETTINGS, { ...next, minScore: 1, duplicateDays: 0 }, '', good);
    expect(!bad.ok && bad.errors.length).toBe(3);
  });
  it('switches suggestions on only when a code passes the held-back check', () => {
    const on = { ...DEFAULT_ASSIST_SETTINGS, suggestCodes: true };
    const re = ctx('reliability_engineer');
    expect(setAssistSettings(re, DEFAULT_ASSIST_SETTINGS, on, 'Trial', good).ok).toBe(true);
    expect(setAssistSettings(re, DEFAULT_ASSIST_SETTINGS, on, 'Trial', null).ok).toBe(false);
    expect(setAssistSettings(re, DEFAULT_ASSIST_SETTINGS, { ...on, minScore: 0.95 }, 'Trial', good).ok).toBe(false);
    const few = { ...good, system: { ...good.system, held: 20 } };
    expect(setAssistSettings(re, DEFAULT_ASSIST_SETTINGS, on, 'Trial', few).ok).toBe(false);
    // Switching off is always allowed.
    expect(setAssistSettings(re, on, DEFAULT_ASSIST_SETTINGS, 'Stop', null).ok).toBe(true);
  });
  it('fills in defaults for a missing or partial value', () => {
    expect(withAssistDefaults(undefined)).toEqual(DEFAULT_ASSIST_SETTINGS);
    expect(withAssistDefaults({ suggestCodes: 'yes' as unknown as boolean, minScore: 0.85 })).toEqual({ ...DEFAULT_ASSIST_SETTINGS, minScore: 0.85 });
  });
});

describe('AI-2 duplicate work orders', () => {
  it('scores words in common over words in either', () => {
    expect(jaccard(['hose', 'leak', 'hoist'], ['hose', 'leak', 'rear'])).toBe(0.5);
    expect(jaccard([], [])).toBe(0);
  });
  it('groups open corrective work on the same unit, close in time, with alike words', () => {
    const wos = [
      wo('1', '2026-10-01 08:00', 'Hose leak at hoist cylinder'),
      wo('2', '2026-10-03 08:00', 'Leak at hoist cylinder hose fitting'),
      wo('3', '2026-10-07 07:00', 'Hoist cylinder hose leak'),
      wo('4', '2026-10-20 08:00', 'Hose leak at hoist cylinder'), // too late after 3
      wo('5', '2026-10-02 08:00', 'Hose leak at hoist cylinder', { assetId: 'ht2' }), // other unit
      wo('6', '2026-10-02 08:00', 'Hose leak at hoist cylinder', { open: false }),
      wo('7', '2026-10-02 08:00', 'Hose leak at hoist cylinder', { workClass: 'pm' }),
      wo('8', '2026-10-02 09:00', 'Cracked step'),
      wo('9', '2026-10-02 10:00', 'Leak'), // one word: not compared
    ];
    const g = duplicateWorkOrders(wos, DEFAULT_ASSIST_SETTINGS);
    expect(g).toHaveLength(1);
    expect(g[0]!.workOrders.map((w) => w.number)).toEqual(['1', '2', '3']);
    expect(g[0]!.assetId).toBe('ht1');
    expect(g[0]!.similarity).toBe(1);
  });
});

describe('citations', () => {
  const allowed = new Set(['KPI-001', 'unit:HT1']);
  it('passes when every line cites only records it was given', () => {
    expect(checkCitations(['PA was 90% [KPI-001].', 'HT1 down [unit:HT1] [KPI-001].'], allowed)).toEqual({ ok: true, cited: ['KPI-001', 'unit:HT1'], unknown: [], uncited: [] });
  });
  it('refuses an unknown record, a line with no citation, or nothing at all', () => {
    const c = checkCitations(['HT9 down [unit:HT9].', 'No source here.'], allowed);
    expect(c).toMatchObject({ ok: false, unknown: ['unit:HT9'], uncited: [1] });
    expect(checkCitations([], allowed).ok).toBe(false);
  });
});

describe('AI-3 weekly pack summary', () => {
  const kpis = (pa: number, failures: number) => ({ pa, utilisation: 0.8, mtbf: 50, mttr: 4.25, failures });
  const pack = {
    targets: { pa: 0.88, utilisation: 0.85 },
    kpis: kpis(0.905, 3),
    prior: kpis(0.89, 5),
    pareto: [{ system: 'Hydraulics', hours: 30, events: 2, cumulative: 0.6 }, { system: 'Engine', hours: 20, events: 1, cumulative: 1 }],
    badActors: [{ unit: 'HT104', model: '793F', unscheduledDownHours: 22.5, failures: 2, pa: 0.8, topSystem: 'Hydraulics' }],
    shop: { releaseVsPlan: { due: 4, onTime: 3, rate: 0.75 } },
    downNow: [{ unit: 'HT110', since: '', hours: 12.25, reason: 'Engine', stage: 'in_repair', downline: false }, { unit: 'HT104', since: '', hours: 2, reason: 'Tyres', stage: 'in_repair', downline: false }],
  } as unknown as WeeklyPack;
  it('drafts sentences from the pack numbers, each citing its records', () => {
    const d = packSummary(pack);
    expect(d.lines).toEqual([
      'PA was 90.5% against a target of 88.0%, up 1.5 points on the week before [KPI-001].',
      'Utilisation was 80.0% against a target of 85.0%, the same as the week before [KPI-002].',
      'There were 3 failures (5 the week before), MTBF 50.0 h, MTTR 4.3 h [KPI-005] [KPI-006].',
      'Hydraulics lost the most time: 30.0 h over 2 events, 60.0% of unscheduled down hours [system:Hydraulics].',
      'The worst unit was HT104 (793F) with 22.5 h unscheduled down, mostly Hydraulics [KPI-027] [unit:HT104].',
      '3 of 4 shop releases were on or before their ETA (75.0%) [KPI-012].',
      '2 units are down now; the longest is HT110, down 12.3 h for Engine [unit:HT110].',
    ]);
    expect(d.check.ok).toBe(true);
  });
});

describe('AI-4 RCA timeline', () => {
  it('lists the flags under study and nearby records in time order, each cited', () => {
    const f = flag('2026-10-10 08:00', { findings: 'Hose burst at hoist' }, { id: 'F1', workOrders: ['77'], etas: [{ eta: L('2026-10-10 14:00'), setAt: L('2026-10-10 08:30'), setBy: 'x' }] });
    const voided = flag('2026-10-11 08:00', {}, { id: 'F2', state: 'voided' });
    const rca: Rca = {
      id: 'R1', title: 'Hoist hoses', problem: '', source: { kind: 'manual', label: '' }, flagIds: ['F1', 'F2'], whys: [], fishbone: emptyFishbone(),
      status: 'open', lead: 'u', createdBy: 'u', createdAt: L('2026-10-12 08:00'), updatedAt: L('2026-10-12 08:00'),
    };
    const t = rcaTimeline({
      rca, flags: [f, voided], workOrders: [wo('77', '2026-10-10 08:05', 'Oil spray at rear', { completedAt: L('2026-10-10 12:30') })],
      components: [{ id: 'C1', serial: 'SN1', kind: 'engine', models: [], hoursAtEntry: 0, rebuildsAtEntry: 0, createdBy: 'u', createdAt: L('2026-01-01 00:00') }],
      componentEvents: [
        { id: 'E1', componentId: 'C1', kind: 'installed', at: L('2026-09-20 10:00'), unitId: 'ht1' } as never,
        { id: 'E2', componentId: 'C1', kind: 'installed', at: L('2026-08-01 10:00'), unitId: 'ht1' } as never, // more than 30 days before
      ],
      oilSamples: [{ id: 'O1', unitId: 'ht1', compartment: 'hydraulic', takenAt: L('2026-10-05 09:00'), readings: {}, severity: 'action', reasons: ['Iron high'], enteredBy: 'u', enteredAt: L('2026-10-05 09:00') } as never],
      assets: [truck('ht1')], timeZone: TZ, now: L('2026-10-28 09:00'),
    });
    expect(t.rows.map((r) => `${r.cite} ${r.text}`)).toEqual([
      'component:E1 HT1: engine SN1 installed',
      'oil:O1 HT1: Oil sample, hydraulic: action (Iron high)',
      'flag:F1 HT1: Unscheduled down flag set, Hydraulics',
      'flag:F1 HT1: Location Down in field',
      'flag:F1 HT1: Stage In repair',
      'wo:77 HT1: Work order 77 reported: Oil spray at rear',
      'flag:F1 HT1: ETA set for Sat 10 Oct 14:00',
      'flag:F1 HT1: Released, coded Hydraulics / Hose / Burst; repair: Replaced hose; findings: Hose burst at hoist',
      'wo:77 HT1: Work order 77 completed',
    ]);
    expect(t.lines[0]).toBe('Sun 20 Sep 10:00  HT1: engine SN1 installed [component:E1]');
    expect(t.check.ok).toBe(true);
  });
});
