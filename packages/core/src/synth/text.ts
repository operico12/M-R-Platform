// Synthetic free text for failures (phase 3 assist, docs/ai-assist.md): the
// operator's complaint (work order long description), the technician's
// findings and the repair summary. Written from the true codes, before the
// coding noise, so a flag coded "Other" can still read "turbo boost low".
// Some texts are vague on purpose, and many words are shared between systems
// (leak, pressure, noise), so suggestions are not always right.

type R = () => number;

const COMPONENT_WORDS: Record<string, string[]> = {
  Turbocharger: ['turbo', 'turbo charger', 'turbo boost', 'compressor wheel'],
  Injector: ['injector', 'injector cup', 'fuel injector'],
  'Fuel pump': ['fuel pump', 'transfer pump', 'fuel pressure'],
  Aftercooler: ['aftercooler', 'ATAAC core', 'charge air cooler'],
  'Clutch pack': ['clutch pack', 'clutch plates', 'clutch'],
  'Control valve': ['trans control valve', 'transmission valve body', 'solenoid valve'],
  'Torque converter': ['torque converter', 'converter', 'lockup clutch'],
  'Hoist cylinder': ['hoist cylinder', 'hoist ram', 'hoist rod seal'],
  Hose: ['hose', 'hydraulic hose', 'hose fitting', 'braided line'],
  'Hydraulic pump': ['hydraulic pump', 'hoist pump', 'main pump'],
  'Steering valve': ['steering valve', 'HMU', 'steer valve'],
  'Brake pack': ['brake pack', 'brake discs', 'friction discs'],
  'Brake valve': ['brake valve', 'treadle valve', 'brake control valve'],
  Accumulator: ['accumulator', 'brake accumulator', 'nitrogen precharge'],
  'Front strut': ['front strut', 'LH front strut', 'RH front strut'],
  'Rear strut': ['rear strut', 'LH rear strut', 'RH rear strut'],
  'A-frame': ['A-frame', 'A frame ball joint', 'A-frame pin'],
  Alternator: ['alternator', 'charging', 'alternator belt'],
  Harness: ['harness', 'wiring', 'loom', 'connector pins'],
  Starter: ['starter', 'starter motor', 'cranking'],
  Sensor: ['sensor', 'speed sensor', 'pressure sender', 'temperature sender'],
  'Front tyre': ['front tyre', 'LF tyre', 'RF tyre', 'steer tyre'],
  'Rear tyre': ['rear tyre', 'rear dual', 'inner rear tyre'],
  Rim: ['rim', 'lock ring', 'bead seat band'],
  Radiator: ['radiator', 'rad core', 'radiator tank'],
  'Fan drive': ['fan drive', 'fan motor', 'fan clutch'],
  'Water pump': ['water pump', 'coolant pump', 'pump weep hole'],
  'Frame rail': ['frame rail', 'chassis rail', 'frame'],
  'Body pad': ['body pad', 'body pads', 'canopy pad'],
  Tray: ['tray', 'dump body', 'tray floor'],
  Planetary: ['planetary', 'sun gear', 'planet gears'],
  'Wheel bearing': ['wheel bearing', 'hub bearing', 'bearing'],
  Seal: ['duo cone seal', 'final drive seal', 'hub seal'],
  'Steering cylinder': ['steering cylinder', 'steer cylinder', 'steering ram'],
  Pump: ['steering pump', 'steer pump'],
  'Tie rod': ['tie rod', 'tie rod end', 'steering linkage'],
};

/** Operator complaint and technician finding per mode, with {c} for a component word. */
const MODE_WORDS: Record<string, { complaint: string[]; finding: string[] }> = {
  Leak: { complaint: ['oil leak', 'leaking', 'fluid on the ground', 'weeping oil'], finding: ['{c} leaking', 'leak at {c}', 'seal failed on {c}'] },
  Overheat: { complaint: ['running hot', 'high temp alarm', 'overheating'], finding: ['{c} overheating', 'high temperature from {c}'] },
  'Low power': { complaint: ['no power on the ramp', 'low power', 'derate event', 'sluggish uphill'], finding: ['low power traced to {c}', '{c} fault causing derate'] },
  Slipping: { complaint: ['trans slipping', 'flaring between gears', 'slips under load'], finding: ['{c} slipping', 'worn {c} slipping'] },
  'No shift': { complaint: ['will not shift', 'stuck in gear', 'no upshift'], finding: ['no shift caused by {c}', '{c} stuck'] },
  Contamination: { complaint: ['trans filter bypass alarm', 'dirty oil', 'oil sample high iron'], finding: ['contamination from {c}', 'debris in {c}'] },
  Burst: { complaint: ['hose blew', 'burst line, oil everywhere', 'loud bang then oil spray'], finding: ['{c} burst', '{c} ruptured'] },
  'Low pressure': { complaint: ['low pressure alarm', 'pressure low', 'slow to respond'], finding: ['low pressure from {c}', '{c} not holding pressure'] },
  Worn: { complaint: ['brakes poor', 'long stopping', 'retarder weak'], finding: ['{c} worn past limit', 'worn {c}'] },
  Fade: { complaint: ['brakes fading on the ramp', 'brake fade downhill'], finding: ['fade traced to {c}', '{c} overheated and fading'] },
  'Low charge': { complaint: ['riding low', 'truck sitting low on one corner', 'harsh ride'], finding: ['{c} low on charge', 'recharged {c}'] },
  Crack: { complaint: ['crack seen at walkaround', 'cracked'], finding: ['crack found in {c}', '{c} cracked'] },
  'Open circuit': { complaint: ['no power to panel', 'warning light, fault code', 'dead circuit'], finding: ['open circuit at {c}', '{c} broken wire'] },
  Short: { complaint: ['blowing fuses', 'burning smell from cab', 'breaker trips'], finding: ['short to ground at {c}', '{c} shorted'] },
  Intermittent: { complaint: ['intermittent fault code', 'cuts in and out', 'random alarms'], finding: ['intermittent fault at {c}', 'loose {c}'] },
  Cut: { complaint: ['tyre cut', 'rock cut on tyre', 'flat tyre'], finding: ['{c} cut through to cords', 'cut in {c}'] },
  Separation: { complaint: ['bulge in tyre', 'tread separating'], finding: ['{c} tread separation', 'separation on {c}'] },
  Blocked: { complaint: ['running hot, rad blocked', 'high coolant temp'], finding: ['{c} blocked with dust', '{c} plugged'] },
  Wear: { complaint: ['wear check failed', 'worn liners'], finding: ['{c} worn', 'wear on {c} past limit'] },
  Noise: { complaint: ['grinding noise from wheel', 'noisy rear end', 'whine from final drive'], finding: ['noise from {c}', '{c} noisy, metal on plug'] },
  'Metal in oil': { complaint: ['metal on mag plug', 'oil sample high iron', 'chip detector'], finding: ['metal in oil from {c}', '{c} breaking up'] },
  Play: { complaint: ['steering loose', 'play in steering', 'wandering'], finding: ['play in {c}', '{c} worn, excessive play'] },
};

const ACTIONS: Record<string, string[]> = {
  Leak: ['replaced seals', 'replaced o-rings and retorqued', 'replaced and tested for leaks'],
  Burst: ['replaced hose and refilled', 'made new hose and refilled'],
  Cut: ['changed tyre', 'fitted spare tyre'],
  Separation: ['changed tyre'],
  Crack: ['welded repair', 'gouged and welded'],
  'Low charge': ['recharged nitrogen and oil', 'charged to spec'],
  Short: ['repaired wiring', 'replaced fuse and repaired loom'],
  'Open circuit': ['repaired wiring', 'replaced connector'],
  Intermittent: ['cleaned and secured connector', 'replaced connector'],
};

const VAGUE_COMPLAINT = ['unit down', 'operator called in fault', 'not right, check over', 'parked up by operator', 'see work order'];
const VAGUE_FINDING = ['checked and repaired', 'repaired as required', 'fault found and fixed', 'tested ok after repair'];

const pick = <T,>(r: R, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

export function failureText(r: R, system: string, component: string, mode: string): { complaint: string; findings: string; repairSummary: string } {
  const cw = COMPONENT_WORDS[component] ?? [component.toLowerCase()];
  const mw = MODE_WORDS[mode] ?? { complaint: [mode.toLowerCase()], finding: [`{c} ${mode.toLowerCase()}`] };
  const c = pick(r, cw);
  // The operator rarely names the part; sometimes says the system.
  const x = r();
  const complaint = x < 0.15 ? pick(r, VAGUE_COMPLAINT) : x < 0.45 ? `${system.toLowerCase()}: ${pick(r, mw.complaint)}` : pick(r, mw.complaint);
  // Technicians mostly name the part, sometimes write little.
  const y = r();
  const findings = y < 0.12 ? pick(r, VAGUE_FINDING) : pick(r, mw.finding).replace('{c}', c);
  const action = pick(r, ACTIONS[mode] ?? [`replaced ${pick(r, cw)}`, `repaired ${c}`, `changed out ${c}`]);
  const repairSummary = r() < 0.2 ? 'repaired' : action.charAt(0).toUpperCase() + action.slice(1);
  return { complaint, findings: findings.charAt(0).toUpperCase() + findings.slice(1), repairSummary };
}
