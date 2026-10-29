// Synthetic RCM library (docs/rcm.md) for the demo haul trucks. The words
// match the synthetic failure systems, components and modes, so the review
// page has failures to match. Part numbers are made up (SYN-...), never real.

import type { Answers, Consequence, JobPlanVersion, ModeInput, RcmMode, TaskType } from '../rcm.js';
import { DEFAULT_RCM_SETTINGS, addMode, issueJobPlan, packageModel, reviseMode } from '../rcm.js';
import type { ConsoleContext } from '../console.js';
import { twelveHourCalendar } from '../time.js';
import type { Asset } from '../types.js';

type Row = [system: string, component: string, mode: string, func: string, ff: string, effect: string, c: Consequence, a: Answers, t: TaskType, task: string, interval: number, basis: string, craft: string, people: number, hours: number, parts?: Array<[string, string, number]>, override?: string];

const ROWS: Row[] = [
  ['Engine', 'Turbocharger', 'Leak', 'Supply boost air at rated pressure', 'Low boost pressure', 'Low power and black smoke; about 8 h to change the turbo', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Inspect turbo inlet and outlet ducts and clamps for oil and boost leaks', 250, 'C-12: P-F about 600 h ÷ 2, rounded to the 250 h PM', 'MECH', 1, 0.5],
  ['Engine', 'Injector', 'Low power', 'Deliver fuel at the rated rate and pattern', 'Uneven fuel delivery', 'Misfire, low power, high fuel use', 'operational', { warning: true, wearOut: true, restorable: false }, 'on_condition', 'Run cylinder cut-out test and review exhaust temperature spread', 500, 'C-12: P-F about 1200 h ÷ 2', 'MECH', 1, 1],
  ['Engine', 'Fuel pump', 'Leak', 'Supply fuel at rated pressure', 'Fuel leak', 'Fire risk on a hot engine', 'safety', { warning: true, wearOut: false }, 'on_condition', 'Inspect fuel pump, lines and fittings for leaks and chafing', 250, 'C-12: P-F about 500 h ÷ 2', 'MECH', 1, 0.5],
  ['Engine', 'Aftercooler', 'Overheat', 'Cool charge air to below 55 °C', 'Charge air too hot', 'Derate and high exhaust temperature', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Clean aftercooler core fins and check intake temperature trend', 1000, 'C-12: P-F about 2000 h ÷ 2', 'MECH', 1, 1.5],
  ['Engine', 'Air filter', 'Blocked', 'Filter intake air with restriction below the limit', 'Restriction above the limit', 'Low power; dust entry if the seal fails', 'operational', { warning: false, wearOut: true, restorable: false }, 'replacement', 'Replace primary and secondary air filter elements', 500, 'C-13 from filter lives, rounded to the 500 h PM', 'LUBE', 1, 0.75, [['SYN-1101', 'Air filter element, primary', 2], ['SYN-1102', 'Air filter element, secondary', 2]]],
  ['Engine', 'Oil filter', 'Blocked', 'Filter engine oil', 'Filter bypassing', 'Wear metals rise; engine wear', 'operational', { warning: false, wearOut: true, restorable: false }, 'replacement', 'Change engine oil and filters; take an oil sample first', 250, 'Fixed by the oil analysis programme interval', 'LUBE', 1, 1.5, [['SYN-1201', 'Engine oil filter', 4], ['SYN-1202', 'Engine oil 15W-40, litre', 280]]],
  ['Transmission', 'Clutch pack', 'Slipping', 'Hold torque in each gear', 'Clutch slips under load', 'Slow shifts, then no drive; transmission change about 24 h', 'operational', { warning: true, wearOut: true, restorable: true }, 'on_condition', 'Download transmission clutch fill times and review the trend', 500, 'C-12: P-F about 1500 h ÷ 3', 'ELEC', 1, 0.5],
  ['Transmission', 'Control valve', 'No shift', 'Direct oil to the selected clutch', 'Will not shift', 'Truck stops; towing needed', 'operational', { warning: false, wearOut: false }, 'run_to_failure', '', 0, '', '', 0, 0, undefined, ''],
  ['Transmission', 'Torque converter', 'Contamination', 'Transmit engine torque', 'Oil contaminated', 'Converter and transmission wear', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Take transmission and converter oil samples; check magnetic screens', 500, 'Oil analysis interval (docs/condition-monitoring.md)', 'LUBE', 1, 0.5],
  ['Hydraulics', 'Hose', 'Burst', 'Carry hoist oil at working pressure', 'Hose bursts', 'Oil spray onto hot parts; spill to ground', 'safety', { warning: true, wearOut: true, restorable: false }, 'on_condition', 'Inspect hoist and steering hoses for chafing, bulges and weeping fittings', 250, 'C-12: P-F about 500 h ÷ 2', 'MECH', 1, 1],
  ['Hydraulics', 'Hydraulic pump', 'Low pressure', 'Supply oil at rated flow and pressure', 'Low flow', 'Slow hoist and steering', 'operational', { warning: true, wearOut: true, restorable: true }, 'on_condition', 'Measure hoist cycle time and pump case drain flow', 1000, 'C-12: P-F about 2500 h ÷ 2, rounded down', 'MECH', 1, 1],
  ['Hydraulics', 'Hoist cylinder', 'Leak', 'Raise and hold the body', 'Body drifts down', 'Body drift; oil loss', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Check hoist cylinder rods and seals for leaks and scoring', 500, 'C-12: P-F about 1000 h ÷ 2', 'MECH', 1, 0.5],
  ['Brakes', 'Brake pack', 'Worn', 'Stop the truck within the rated distance', 'Brake wear past the limit', 'Longer stopping distance', 'safety', { warning: true, wearOut: true, restorable: true }, 'on_condition', 'Measure brake wear pins at all four wheel stations and record', 500, 'C-12: P-F about 1000 h ÷ 2', 'MECH', 1, 1],
  ['Brakes', 'Accumulator', 'Leak', 'Store pressure for emergency braking', 'Precharge lost', 'No stored braking if the pump fails (hidden)', 'hidden', { warning: false, wearOut: false, findable: true, multipleSafety: true }, 'failure_finding', 'Check brake accumulator precharge pressure with the test kit', 1000, 'C-14: MTBF about 25,000 h, 2% tolerated', 'MECH', 1, 1, [['SYN-1301', 'Accumulator charging valve cap', 2]]],
  ['Suspension', 'Front strut', 'Low charge', 'Support the front at rated ride height', 'Strut too low', 'Harsh ride, frame cracking', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Measure front strut ride height and check for oil and gas leaks', 250, 'C-12: P-F about 600 h ÷ 2', 'MECH', 1, 0.5],
  ['Suspension', 'Rear strut', 'Leak', 'Support the rear at rated ride height', 'Strut too low', 'Harsh ride, frame cracking', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Measure rear strut ride height and check for leaks', 500, 'C-12: P-F about 1000 h ÷ 2', 'MECH', 1, 0.5],
  ['Electrical', 'Alternator', 'Open circuit', 'Charge the batteries', 'No charge', 'Flat batteries; truck will not start', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Check alternator output voltage and belt condition', 500, 'C-12: P-F about 1000 h ÷ 2', 'ELEC', 1, 0.5],
  ['Electrical', 'Starter', 'Open circuit', 'Crank the engine', 'Will not crank', 'Truck cannot start', 'operational', { warning: false, wearOut: true, restorable: true }, 'restoration', 'Change starter motor for a rebuilt exchange unit', 6000, 'C-13: β 2.4, η 9000 h, planned $3,000, failure $14,000', 'ELEC', 1, 2, [['SYN-1401', 'Starter motor, exchange', 1]]],
  ['Electrical', 'Harness', 'Short', 'Carry power and signals', 'Short to ground', 'Random faults, fire risk', 'safety', { warning: true, wearOut: false }, 'on_condition', 'Inspect main harness runs and clamps for chafing near the frame rails', 1000, 'C-12: P-F about 2000 h ÷ 2', 'ELEC', 1, 1],
  ['Tyres', 'Front tyre', 'Cut', 'Carry the load on the front axle', 'Tyre cut through the casing', 'Tyre failure; possible blowout', 'safety', { warning: true, wearOut: false }, 'on_condition', 'Inspect front tyres for cuts and measure tread depth and pressure', 250, 'C-12: P-F about 600 h ÷ 2', 'TYRE', 1, 0.5],
  ['Tyres', 'Rear tyre', 'Low pressure', 'Carry the load on the rear axle', 'Pressure below the limit', 'Overheating and separation', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Check rear tyre pressures with the TPMS readout', 250, 'C-12: P-F about 500 h ÷ 2', 'TYRE', 1, 0.25],
  ['Cooling', 'Radiator', 'Blocked', 'Cool the engine to below 95 °C at full load', 'Cannot hold below 95 °C', 'Overheat and derate', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Inspect and clean radiator core; check coolant temperature trend', 500, 'C-12: P-F about 1000 h ÷ 2', 'MECH', 1, 1],
  ['Cooling', 'Water pump', 'Leak', 'Circulate coolant at rated flow', 'No coolant flow', 'Coolant loss and overheat; about 6 h to change', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Check water pump weep hole and seal for leaks', 500, 'C-12: P-F about 1000 h ÷ 2', 'MECH', 1, 0.25],
  ['Final drives', 'Planetary', 'Metal in oil', 'Reduce speed and carry wheel torque', 'Planetary gear wear', 'Final drive failure; about 30 h to change', 'operational', { warning: true, wearOut: true, restorable: true }, 'on_condition', 'Check final drive magnetic plugs and take oil samples', 500, 'C-12: P-F about 1500 h ÷ 3', 'LUBE', 1, 0.75],
  ['Frame and body', 'Frame rail', 'Crack', 'Carry the body and load', 'Frame cracked', 'Frame failure; weld repair about 20 h', 'operational', { warning: true, wearOut: false }, 'on_condition', 'Inspect frame rails and cross members for cracks at known stress points', 2000, 'C-12: P-F about 4000 h ÷ 2', 'WELD', 1, 2],
  ['Frame and body', 'Tray', 'Wear', 'Carry the load', 'Liners worn through', 'Tray floor wear', 'non_operational', { warning: false, wearOut: true, restorable: false }, 'replacement', 'Replace tray floor wear liners', 8000, 'C-13: β 3.2, η 11,000 h', 'WELD', 2, 16, [['SYN-1501', 'Tray wear liner plate', 12]]],
  ['Steering', 'Steering cylinder', 'Leak', 'Steer the truck', 'Steering slow or drifting', 'Loss of steering control', 'safety', { warning: true, wearOut: false }, 'on_condition', 'Check steering cylinders, pins and hoses for leaks and play', 250, 'C-12: P-F about 500 h ÷ 2', 'MECH', 1, 0.5],
  ['Steering', 'Tie rod', 'Play', 'Hold wheel alignment', 'Excess play', 'Steering wander', 'safety', { warning: false, wearOut: false }, 'redesign', 'Fit tie rod ends with a visible wear indicator', 0, '', '', 0, 0],
  ['Electrical', 'Sensor', 'Intermittent', 'Report machine conditions', 'False or missing readings', 'Nuisance alarms', 'non_operational', { warning: false, wearOut: false }, 'run_to_failure', '', 0, '', '', 0, 0],
];

const toInput = (model: string, r: Row): ModeInput => {
  const [system, component, mode, func, functionalFailure, effect, consequence, answers, taskType, task, interval, basis, craft, people, hours, parts, override] = r;
  return {
    model, system, component, mode, func, functionalFailure, effect, consequence, answers, taskType, task,
    intervalHours: interval || undefined, intervalBasis: basis || undefined, craft: craft || undefined, people: people || undefined, taskHours: hours || undefined,
    parts: (parts ?? []).map(([itemNum, description, qty]) => ({ itemNum, description, qty })), overrideReason: override || undefined,
  };
};

export function generateRcm(input: { assets: Asset[]; end: string }): { modes: RcmMode[]; versions: JobPlanVersion[] } {
  const models = [...new Set(input.assets.filter((a) => a.assetClass === 'mobile' && a.fleet === 'Haul trucks').map((a) => a.model))].sort();
  let n = 0;
  const endMs = Date.parse(input.end);
  const at = (daysBack: number) => new Date(endMs - daysBack * 86_400_000).toISOString();
  const ctx = (daysBack: number): ConsoleContext => ({
    actor: { userId: 'demo-reliability_engineer', role: 'reliability_engineer', scope: ['*'] }, now: at(daysBack),
    newId: () => `rcm-${String(++n).padStart(4, '0')}`, timeZone: 'America/Vancouver', calendar: twelveHourCalendar('America/Vancouver'),
  });
  let modes: RcmMode[] = [];
  let versions: JobPlanVersion[] = [];
  const must = <T>(r: { ok: true; records: T[] } | { ok: false; errors: string[] }): T[] => { if (!r.ok) throw new Error(r.errors.join(' ')); return r.records; };
  models.forEach((model, i) => {
    const day = 240 - i * 90;
    for (const row of ROWS) {
      // The 797F tray is longer life; otherwise the same library.
      const r = model === '797F' && row[1] === 'Tray' ? ([...row.slice(0, 10), 10000, 'C-13: β 3.2, η 13,500 h', ...row.slice(12)] as Row) : row;
      modes = must(addMode(ctx(day), modes, toInput(model, r)));
    }
  });
  const first = models[0];
  if (first) {
    for (const p of packageModel(modes, first, DEFAULT_RCM_SETTINGS).plans) versions = must(issueJobPlan(ctx(220), versions, p, 'First issue from the RCM review'));
    // Two later changes: one issued again, one waiting.
    const find = (comp: string) => modes.find((m) => m.model === first && m.component === comp && m.revision === 1)!;
    const pump = find('Water pump');
    modes = must(reviseMode(ctx(120), modes, pump.modeId, { ...toInput(first, ROWS.find((r) => r[1] === 'Water pump')!), task: 'Check water pump weep hole and seal for leaks; listen for bearing noise' }, 'Two pump bearing failures found late; noise check added'));
    for (const p of packageModel(modes, first, DEFAULT_RCM_SETTINGS).plans.filter((x) => x.tasks.some((t) => t.modeId === pump.modeId))) {
      if (p.hours === 500 || p.hours === 1000) versions = must(issueJobPlan(ctx(110), versions, p, 'Water pump noise check added'));
    }
    const frame = find('Frame rail');
    const row = ROWS.find((r) => r[1] === 'Frame rail')!;
    modes = must(reviseMode(ctx(20), modes, frame.modeId, { ...toInput(first, row), intervalHours: 1000, intervalBasis: 'C-12: P-F about 2000 h ÷ 2 after two cracks found in operation' }, 'Cracks found in operation; interval halved'));
  }
  return { modes, versions };
}
