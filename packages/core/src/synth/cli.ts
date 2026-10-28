// pnpm synth [out.json] [--units 40] [--days 120] [--seed 42]
import { writeFileSync } from 'node:fs';
import { generateFleet } from './generate.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const out = args.find((a) => a.endsWith('.json')) ?? 'synthetic-fleet.json';
const ds = generateFleet({ units: opt('units'), days: opt('days'), seed: opt('seed') });
writeFileSync(out, JSON.stringify(ds, null, 2));
console.log(`Wrote ${out}: ${ds.assets.length} units, ${ds.flags.length} flags, ${ds.smu.length} SMU readings`);
