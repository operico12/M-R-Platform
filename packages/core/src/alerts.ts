// Checks and alerts (A7 section 8). Pure: given the records and the time,
// return the alerts that are active now. Thresholds come from the rules.

import type { FlagRulesConfig } from './config.js';
import { currentStage, pmOverrunDue } from './flags.js';
import { HOUR_MS, ms, shiftsBetween, type ShiftCalendar } from './time.js';
import type { Asset, DownFlag, Iso, SmuReading } from './types.js';

export type AlertKind =
  | 'no_eta'
  | 'eta_passed'
  | 'proposal_unconfirmed'
  | 'waiting_line'
  | 'waiting_parts'
  | 'smu_rising_while_down'
  | 'no_smu_reading'
  | 'pm_overrun'
  | 'flag_open_long';

export interface Alert {
  kind: AlertKind;
  unitId: string;
  flagId?: string;
  since: Iso;
  message: string;
  goesTo: string[];
}

export interface AlertInput {
  assets: Asset[];
  flags: DownFlag[];
  smu: SmuReading[];
  rules: FlagRulesConfig;
  calendar: ShiftCalendar;
  now: Iso;
  /** Only check flags that ended after this time (default: last 24 h). */
  since?: Iso;
}

const hrs = (a: Iso, b: Iso) => (ms(b) - ms(a)) / HOUR_MS;

export function activeAlerts(input: AlertInput): Alert[] {
  const { rules, now } = input;
  const a = rules.alerts;
  const unit = new Map(input.assets.map((x) => [x.id, x]));
  const name = (id: string) => unit.get(id)?.unitNumber ?? id;
  const out: Alert[] = [];

  for (const f of input.flags) {
    if (f.state === 'proposed' && hrs(f.enteredAt, now) * 60 >= a.proposalUnconfirmedMinutes) {
      out.push({ kind: 'proposal_unconfirmed', unitId: f.unitId, flagId: f.id, since: f.enteredAt, message: `${name(f.unitId)}: proposed down flag not confirmed`, goesTo: ['supervisor'] });
    }
    if (f.state !== 'open') continue;
    const downH = hrs(f.start, now);
    if (f.etas.length === 0 && downH >= rules.etaRequiredAfterHours) {
      out.push({ kind: 'no_eta', unitId: f.unitId, flagId: f.id, since: f.start, message: `${name(f.unitId)}: down ${downH.toFixed(1)} h with no ETA`, goesTo: ['supervisor'] });
    }
    const lastEta = f.etas.at(-1);
    if (lastEta && hrs(lastEta.eta, now) * 60 >= a.etaPassedGraceMinutes) {
      out.push({ kind: 'eta_passed', unitId: f.unitId, flagId: f.id, since: lastEta.eta, message: `${name(f.unitId)}: ETA passed, not released`, goesTo: ['supervisor', 'planner'] });
    }
    const st = currentStage(f);
    if (st?.stage === 'waiting_line' && hrs(st.start, now) >= a.waitingLineHours) {
      out.push({ kind: 'waiting_line', unitId: f.unitId, flagId: f.id, since: st.start, message: `${name(f.unitId)}: waiting for a line ${hrs(st.start, now).toFixed(1)} h`, goesTo: ['supervisor', 'planner'] });
    }
    if (st?.stage === 'waiting_parts' && hrs(st.start, now) >= a.waitingPartsHours) {
      out.push({ kind: 'waiting_parts', unitId: f.unitId, flagId: f.id, since: st.start, message: `${name(f.unitId)}: waiting parts ${hrs(st.start, now).toFixed(1)} h`, goesTo: ['planner', 'stores'] });
    }
    if (pmOverrunDue(f, now)) {
      out.push({ kind: 'pm_overrun', unitId: f.unitId, flagId: f.id, since: now, message: `${name(f.unitId)}: PM past its planned duration. Is a defect keeping it down? (R8)`, goesTo: ['supervisor'] });
    }
    if (downH >= a.flagOpenDays * 24) {
      out.push({ kind: 'flag_open_long', unitId: f.unitId, flagId: f.id, since: f.start, message: `${name(f.unitId)}: flag open ${(downH / 24).toFixed(1)} days`, goesTo: ['superintendent'] });
    }
  }

  out.push(...smuRisingWhileDown(input));
  out.push(...missingSmu(input));
  return out;
}

/**
 * R14: SMU rose more than the threshold in a shift while the unit was flagged down.
 * Checked per completed shift, on the part of the shift the unit was down.
 */
export function smuRisingWhileDown(input: AlertInput): Alert[] {
  const { rules, now, calendar } = input;
  const out: Alert[] = [];
  const since = input.since ? ms(input.since) : ms(now) - 24 * HOUR_MS;
  for (const f of input.flags) {
    if (f.state !== 'open' && f.state !== 'released') continue;
    if (f.end && ms(f.end) < since) continue;
    const readings = input.smu.filter((r) => r.unitId === f.unitId);
    if (readings.length < 2) continue;
    const end = f.end ?? now;
    for (const sh of shiftsBetween(calendar, f.start, end)) {
      // Readings come once a shift, so compare the shift's SMU rise with the
      // hours the unit was NOT flagged down in that shift. Anything beyond
      // that (plus the threshold) ran while flagged down.
      const before = readings.find((r) => ms(r.at) === ms(sh.start))?.hours;
      const after = readings.find((r) => ms(r.at) === ms(sh.end))?.hours;
      if (before === undefined || after === undefined) continue;
      const downS = Math.max(ms(sh.start), ms(f.start));
      let downE = Math.min(ms(sh.end), ms(end));
      if (rules.smuCheckExcludesReadyForRelease) {
        const rfr = f.stages.find((x) => x.stage === 'ready_for_release');
        if (rfr) downE = Math.min(downE, ms(rfr.start));
      }
      if (downE <= downS) continue;
      const notDownH = (ms(sh.end) - ms(sh.start) - (downE - downS)) / HOUR_MS;
      const rise = after - before - notDownH;
      if (rise > rules.alerts.smuRiseWhileDownHours) {
        out.push({
          kind: 'smu_rising_while_down',
          unitId: f.unitId,
          flagId: f.id,
          since: sh.start,
          message: `SMU rose ${rise.toFixed(1)} h while flagged down in the ${sh.name} shift of ${sh.shiftDate}. The flag is probably wrong (R14).`,
          goesTo: ['supervisor', 'reliability_engineer'],
        });
      }
    }
  }
  return out;
}

/** No SMU reading at the end of the last completed shift. */
export function missingSmu(input: AlertInput): Alert[] {
  const { calendar, now } = input;
  const shifts = shiftsBetween(calendar, new Date(ms(now) - 36 * HOUR_MS).toISOString(), now).filter((s) => ms(s.end) <= ms(now));
  const last = shifts.at(-1);
  if (!last) return [];
  const windowStart = ms(last.end) - 2 * HOUR_MS;
  const windowEnd = ms(last.end) + 2 * HOUR_MS;
  return input.assets
    .filter((a) => a.assetClass === 'mobile')
    .filter((a) => !input.smu.some((r) => r.unitId === a.id && ms(r.at) >= windowStart && ms(r.at) <= windowEnd))
    .map((a) => ({
      kind: 'no_smu_reading' as const,
      unitId: a.id,
      since: last.end,
      message: `${a.unitNumber}: no SMU reading for the ${last.name} shift of ${last.shiftDate}`,
      goesTo: ['supervisor'],
    }));
}

/**
 * Alerts in plain words for the status board (docs/status-board.md): what it is, what it means
 * and what to do next. Listed most urgent kind first.
 */
export const ALERT_PLAIN: Record<AlertKind, { title: string; what: string; next: string }> = {
  eta_passed: { title: 'ETA passed', what: 'Should be back by now but is still down.', next: 'Update the ETA or release it' },
  no_eta: { title: 'No ETA', what: 'Down with no return time given.', next: 'Add an ETA' },
  proposal_unconfirmed: { title: 'Down flag not confirmed', what: 'A technician flagged it down and nobody has confirmed it yet.', next: 'Confirm or reject the flag' },
  smu_rising_while_down: { title: 'Hour meter moving while down', what: 'The hour meter went up while the unit is flagged down, so the flag may be wrong.', next: 'Check the flag times' },
  pm_overrun: { title: 'PM running over', what: 'Past its planned time. A defect may be keeping it down.', next: 'Check for a defect' },
  waiting_parts: { title: 'Waiting parts too long', what: 'Stuck waiting for parts.', next: 'Chase the parts' },
  waiting_line: { title: 'Waiting for a line too long', what: 'Ready to repair but no shop line is free.', next: 'Find a line or a crew' },
  flag_open_long: { title: 'Down a long time', what: 'This down flag has been open for days.', next: 'Review the plan to get it back' },
  no_smu_reading: { title: 'No hour meter reading', what: 'No reading came in for the last shift.', next: 'Check the reading feed' },
};

const ALERT_ORDER = Object.keys(ALERT_PLAIN) as AlertKind[];

/** Most urgent kind first, then the one that has been on longest. */
export function sortAlerts<T extends Pick<Alert, 'kind' | 'since'>>(alerts: T[]): T[] {
  return [...alerts].sort((x, y) => ALERT_ORDER.indexOf(x.kind) - ALERT_ORDER.indexOf(y.kind) || ms(x.since) - ms(y.since));
}
