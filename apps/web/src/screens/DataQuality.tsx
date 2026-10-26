// Data quality and checks (plan 3.2 checks, 10.4 "fix a data problem"),
// plus the flag rules page showing which A7 rules are still open.

import { OPEN_A7_SETTINGS, activeAlerts } from '@mr/core';
import { useMemo } from 'react';
import { fmtPct, siteTime } from '../format';
import { useApp } from '../store';

export function DataQuality() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const unit = (id: string) => app.ds.assets.find((a) => a.id === id)?.unitNumber ?? id;
  const alerts = useMemo(
    () => activeAlerts({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, rules: app.rules, calendar: app.ds.calendar, now: app.now }),
    [app.ds, app.flags, app.rules, app.now],
  );
  const since = Date.parse(app.now) - 28 * 864e5;
  const recent = app.flags.filter((f) => f.state === 'released' && f.type === 'unscheduled' && Date.parse(f.start) >= since);
  const checks = [
    { name: 'Unscheduled releases with a detection method', ok: recent.filter((f) => f.release?.detectionMethod).length, of: recent.length },
    { name: 'Unscheduled releases with a cause code (ISO 14224)', ok: recent.filter((f) => f.release?.causeCode).length, of: recent.length },
    { name: 'Flags with an ETA', ok: app.flags.filter((f) => Date.parse(f.start) >= since && f.etas.length > 0).length, of: app.flags.filter((f) => Date.parse(f.start) >= since).length },
    { name: 'Units with an SMU reading at the last shift change', ok: app.ds.assets.length - alerts.filter((a) => a.kind === 'no_smu_reading').length, of: app.ds.assets.length },
  ];
  const score = checks.reduce((s, c) => s + (c.of ? c.ok / c.of : 1), 0) / checks.length;

  return (
    <div className="stack">
      <div className="page-head"><h2>Data quality and checks</h2><span className="muted small">Score {fmtPct(score, 0)} · last 28 days</span></div>

      <section className="card">
        <h3>Checks</h3>
        <table>
          <thead><tr><th>Check</th><th className="num">Pass</th><th className="num">Of</th><th className="num">Rate</th></tr></thead>
          <tbody>{checks.map((c) => <tr key={c.name}><td>{c.name}</td><td className="num">{c.ok}</td><td className="num">{c.of}</td><td className="num">{fmtPct(c.of ? c.ok / c.of : null, 0)}</td></tr>)}</tbody>
        </table>
        <p className="small muted">The synthetic fleet never records a cause code, so that check fails on purpose.</p>
      </section>

      <section className="card">
        <h3>Active alerts ({alerts.length})</h3>
        {alerts.length === 0 ? <p className="small muted">None.</p> : (
          <div className="table-wrap" style={{ maxHeight: 320 }}>
            <table>
              <thead><tr><th>Alert</th><th>Unit</th><th>Since</th><th>Goes to</th></tr></thead>
              <tbody>{alerts.map((a, i) => <tr key={i}><td>{a.message}</td><td>{unit(a.unitId)}</td><td>{siteTime(a.since, tz, true)}</td><td>{a.goesTo.join(', ')}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Audit trail (this session)</h3>
        {app.audit.length === 0 ? <p className="small muted">No changes yet. Flag a unit down on the board to see entries here.</p> : (
          <table>
            <thead><tr><th>When entered</th><th>Effective</th><th>Who</th><th>Action</th><th>Unit</th><th>Reason</th></tr></thead>
            <tbody>{app.audit.map((e, i) => (
              <tr key={i}>
                <td>{siteTime(e.at, tz, true)}</td>
                <td>{e.effectiveAt ? <strong>{siteTime(e.effectiveAt, tz, true)} (back-dated)</strong> : '—'}</td>
                <td>{e.userId}</td>
                <td>{e.action}</td>
                <td>{unit((e.after as { unitId: string }).unitId)}</td>
                <td>{e.reason ?? ''}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export function FlagRules() {
  const app = useApp();
  const r = app.rules;
  const decided: Array<[string, string, string]> = [
    ['D1', 'Minimum length for a failure', `${r.minFailureMinutes} min`],
    ['D2', 'ETA required after', `${r.etaRequiredAfterHours} h`],
    ['D3', 'Reopen window', `${r.reopenWindowHours} h, same system`],
    ['D4', 'PM overrun switch point', r.pmOverrunSwitchAt === 'defect_work_start' ? 'When defect work starts' : 'At planned end'],
    ['D5', 'Defect found at PM counts as a failure', r.pmFoundDefectCountsAsFailure ? 'Yes' : 'No (downtime yes, failure no)'],
    ['D6', 'Reopen gap', `Available if SMU ran more than ${r.reopenGapSmuThresholdHours} h, otherwise downtime`],
    ['D7', 'Technicians can move location', r.technicianCanMoveLocation ? 'Yes' : 'No, stage only'],
    ['D8', 'Line type mismatch', r.lineMismatch === 'block' ? 'Block' : 'Warn; supervisor overrides with a reason'],
    ['D9', 'Back-dating', `Supervisor: ${r.backdating.supervisor.replace('_', ' ')}; reliability engineer: ${r.backdating.reliability_engineer.replace('_', ' ')}`],
    ['D10', 'ETA for shop release vs plan', r.shopReleaseEta === 'first' ? 'First ETA given' : 'Last ETA before release'],
    ['D11', 'Field diagnosis is repair time', r.fieldDiagnosisIsRepair ? 'Yes' : 'No'],
    ['D12', 'Waiting other reasons', r.waitingOtherReasons.join(', ')],
  ];
  return (
    <div className="stack">
      <div className="page-head"><h2>Flags and codes · rules</h2><span className="muted small">From A7 draft 0.1. Read-only in phase 1a.</span></div>
      <section className="card">
        <h3>Open questions in A7 (not yet decided)</h3>
        <p className="small muted">These are settings, not hard-coded. The value shown is what the app uses until a decision is made.</p>
        <table>
          <thead><tr><th>#</th><th>Question</th><th>Current setting</th></tr></thead>
          <tbody>{OPEN_A7_SETTINGS.map((s) => <tr key={s.key}><td>{s.ref}</td><td>{s.question}</td><td><code>{JSON.stringify(r[s.key])}</code></td></tr>)}</tbody>
        </table>
      </section>
      <section className="card">
        <h3>Decisions D1–D12 (proposed defaults)</h3>
        <table>
          <thead><tr><th>#</th><th>Decision</th><th>Setting</th></tr></thead>
          <tbody>{decided.map(([k, n, v]) => <tr key={k}><td>{k}</td><td>{n}</td><td>{v}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
