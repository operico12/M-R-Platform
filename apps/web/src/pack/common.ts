// Shared bits for the weekly pack exports.

import type { WeeklyPack } from '@mr/core';
import { fmtHours, fmtPct } from '../format';

export const fmtP = (x: number | null | undefined, d = 1) => fmtPct(x, d);
export const fmtH = (h: number | null | undefined) => fmtHours(h);

/** "Mon 26 Oct 13:05" in the site time zone. */
export function siteStamp(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString('en-CA', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function packFileName(pack: WeeklyPack): string {
  return `weekly-pack-${pack.fleetName.toLowerCase().replace(/\s+/g, '-')}-${pack.week.from.slice(0, 10)}`;
}

/** Plain-language definitions, from docs/kpi-dictionary.md. */
export const FORMULAS: Array<[string, string]> = [
  ['PA', '(calendar hours − maintenance downtime hours) ÷ calendar hours. Scheduled and unscheduled downtime both count; standby does not.'],
  ['Utilisation', 'operating hours from SMU ÷ available hours, over the time SMU readings cover. SMU includes idle time.'],
  ['MTBF', 'operating hours ÷ failures. A failure is an unscheduled downtime event of at least 15 minutes (A7 R9, D1).'],
  ['MTTR', 'hours In repair ÷ repairs.'],
  ['Mean downtime', 'unscheduled downtime hours ÷ failures, including time waiting for parts, labour or a line.'],
  ['Downline', 'time waiting for crew, in transit, or waiting for a shop line.'],
  ['Shop release vs plan', 'releases on or before the first ETA given ÷ releases that had an ETA (A7 D10).'],
  ['Weeks', 'Monday 00:00 to Monday 00:00 in the site time zone. Events count in the week they start.'],
];
