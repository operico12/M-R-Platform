// pnpm synth [out.json] [--units 40] [--days 120] [--seed 42] [--csv folder]
// --csv also writes assets.csv, workorders.csv and meterreadings.csv in Maximo layout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSourceCsv } from '../imports.js';
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
const csvAt = args.indexOf('--csv');
if (csvAt >= 0) {
  const dir = args[csvAt + 1] ?? 'synthetic-csv';
  mkdirSync(dir, { recursive: true });
  const f = toSourceCsv(ds, ds.site.timeZone);
  writeFileSync(join(dir, 'assets.csv'), f.assets);
  writeFileSync(join(dir, 'workorders.csv'), f.workOrders);
  writeFileSync(join(dir, 'meterreadings.csv'), f.smu);
  console.log(`Wrote Maximo-style CSV files to ${dir}`);
}
