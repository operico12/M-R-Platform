import { LOCATION_LABELS, STAGE_LABELS, currentLocation, currentStage, lineName, type Dataset, type DownFlag } from '@mr/core';

export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  const whole = Math.floor(h);
  const m = Math.round((h - whole) * 60);
  if (h >= 48) return `${(h / 24).toFixed(1)} d`;
  return m ? `${whole} h ${String(m).padStart(2, '0')}` : `${whole} h`;
}

export function fmtPct(x: number | null | undefined, d = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(d)}%`;
}

export function fmtNum(x: number | null | undefined, d = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(d);
}

export function siteTime(iso: string, tz: string, withDate = false): string {
  return new Date(iso).toLocaleString('en-CA', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
  });
}

export function hoursSince(iso: string, now: string): number {
  return (Date.parse(now) - Date.parse(iso)) / 3_600_000;
}

/** Local datetime-input value ("YYYY-MM-DDTHH:mm") in the site zone ↔ UTC ISO. */
export function toLocalInput(iso: string, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

export function fromLocalInput(v: string, tz: string): string {
  // Find the UTC instant whose site-local wall time equals v.
  const guess = Date.parse(`${v}:00Z`);
  const asLocal = Date.parse(`${toLocalInput(new Date(guess).toISOString(), tz)}:00Z`);
  const offset = asLocal - guess;
  return new Date(guess - offset).toISOString();
}

export function stageLabel(f: DownFlag): string {
  const s = currentStage(f);
  return s ? STAGE_LABELS[s.stage] : '—';
}

export function locationLabel(f: DownFlag, ds: Dataset): string {
  const l = currentLocation(f);
  if (!l) return '—';
  if (l.kind === 'shop_line') {
    const line = ds.shopLines.find((x) => x.id === l.shopLineId);
    return line ? lineName(line) : 'Shop line';
  }
  if (l.kind === 'field') return `Field: ${l.fieldLocation ?? '?'}`;
  return LOCATION_LABELS[l.kind];
}

export type UnitStatus = 'run' | 'sched' | 'down' | 'stale' | 'parked';

export const STATUS_WORD: Record<UnitStatus, string> = {
  run: '● UP',
  sched: '▲ SCHED',
  down: '■ DOWN',
  stale: '◷ NO UPDATE',
  parked: '— PARKED',
};

export function unitStatus(unitId: string, flags: DownFlag[], ds: Dataset, now: string): { status: UnitStatus; flag?: DownFlag } {
  const parked = ds.lifecycle.some((l) => l.assetId === unitId && l.status !== 'active' && Date.parse(l.start) <= Date.parse(now) && (!l.end || Date.parse(now) < Date.parse(l.end)));
  if (parked) return { status: 'parked' };
  const open = flags.find((f) => f.unitId === unitId && f.state === 'open');
  if (open) return { status: open.type === 'scheduled' ? 'sched' : 'down', flag: open };
  const last = ds.smu.filter((r) => r.unitId === unitId).at(-1);
  if (!last || hoursSince(last.at, now) > 14) return { status: 'stale' };
  return { status: 'run' };
}
