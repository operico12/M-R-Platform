// Console, Alert rules: the thresholds behind the reliability and threshold
// alerts (docs/alert-rules.md). Reliability engineer, superintendent or admin
// (plan 11.2 "Edit alert rules and thresholds"), with a reason.

import { DEFAULT_ALERT_SETTINGS, RULE_ALERTS, can, setAlertSettings, type AlertSettings, type RuleAlertKind } from '@mr/core';
import { useState } from 'react';
import { useApp } from '../store';

type RuleKey = Exclude<keyof AlertSettings, 'snoozeDays'>;
const RULES: Array<{ key: RuleKey; kind: RuleAlertKind; what: string; fields: Array<[string, string]> }> = [
  { key: 'repeatOffender', kind: 'repeat_offender', what: 'One unit, same system, several failures', fields: [['failures', 'Failures'], ['days', 'Within days']] },
  { key: 'mtbfDrop', kind: 'mtbf_drop', what: "A model's recent MTBF against its baseline", fields: [['windowDays', 'Recent days'], ['baselineDays', 'Baseline days'], ['dropPct', 'Drop %'], ['minFailures', 'Minimum failures']] },
  { key: 'repairSpike', kind: 'repair_spike', what: 'A repair much longer than usual for the system', fields: [['multiple', 'Times the median'], ['baselineDays', 'Baseline days'], ['minEvents', 'Minimum earlier failures'], ['lookbackDays', 'Ended within days']] },
  { key: 'cluster', kind: 'cluster', what: 'Same system and component on several units', fields: [['units', 'Units'], ['days', 'Within days']] },
  { key: 'chronic', kind: 'chronic', what: 'A unit with far more unscheduled down than its model', fields: [['windowDays', 'Days'], ['multiple', 'Times the model median'], ['minSharePct', 'At least % of calendar']] },
  { key: 'silent', kind: 'silent', what: 'Not flagged down but SMU barely moved', fields: [['hours', 'Over hours'], ['minRise', 'SMU rise below h']] },
  { key: 'pmOverdue', kind: 'pm_overdue', what: 'Open PM past due plus the PM tolerance (Work settings)', fields: [] },
  { key: 'kpiBelow', kind: 'kpi_below', what: 'A fleet KPI red against its target, last 7 days', fields: [] },
];

type Form = Record<string, Record<string, string | boolean>>;
const toForm = (s: AlertSettings): Form => {
  const f: Form = { snooze: { days: String(s.snoozeDays) } };
  for (const r of RULES) f[r.key] = Object.fromEntries(Object.entries(s[r.key]).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v)]));
  return f;
};
const fromForm = (f: Form): AlertSettings => {
  const out = { snoozeDays: f.snooze!.days === '' ? NaN : Number(f.snooze!.days) } as Record<string, unknown>;
  for (const r of RULES) out[r.key] = Object.fromEntries(Object.entries(f[r.key]!).map(([k, v]) => [k, typeof v === 'boolean' ? v : v === '' ? NaN : Number(v)]));
  return out as unknown as AlertSettings;
};

export function AlertRulesPage() {
  const app = useApp();
  const s = app.alertSettings;
  const allowed = can(app.actor, 'edit_alert_rules');
  const [form, setForm] = useState<Form>(() => toForm(s));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (rule: string, field: string, v: string | boolean) => { setForm({ ...form, [rule]: { ...form[rule], [field]: v } }); setSaved(false); };
  const save = () => {
    const r = app.runAlertSettings((ctx) => setAlertSettings(ctx, s, fromForm(form), reason));
    if (!r.ok) { setErrors(r.errors); setSaved(false); return; }
    setErrors(null); setReason(''); setSaved(true); setForm(toForm(r.records[0]!));
  };
  return (
    <section className="card" style={{ maxWidth: 900 }}>
      <h3 style={{ marginTop: 0 }}>Alert rules</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Plain rules behind the Alerts page. The defaults are starting points for the site to agree. Every change is in the audit trail with a reason.
        The flag checks (no ETA, waiting parts, SMU rising while down) are flag rules and change under Flags and codes.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Rule</th><th>On</th><th>Thresholds</th></tr></thead>
          <tbody>
            {RULES.map((r) => (
              <tr key={r.key}>
                <td style={{ minWidth: 180 }}><strong>{RULE_ALERTS[r.kind].id} {RULE_ALERTS[r.kind].label}</strong><div className="small muted">{r.what}</div></td>
                <td><input type="checkbox" aria-label={`${RULE_ALERTS[r.kind].label} on`} disabled={!allowed} checked={form[r.key]!.enabled as boolean} onChange={(e) => set(r.key, 'enabled', e.target.checked)} style={{ width: 22, height: 22 }} /></td>
                <td>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                    {r.fields.map(([k, l]) => (
                      <label key={k} className="small" style={{ display: 'grid', gap: 2 }}>
                        {l}
                        <input inputMode="decimal" disabled={!allowed} value={form[r.key]![k] as string} onChange={(e) => set(r.key, k, e.target.value)} style={{ width: 90 }}
                          placeholder={String((DEFAULT_ALERT_SETTINGS[r.key] as unknown as Record<string, number>)[k])} />
                      </label>
                    ))}
                    {!r.fields.length && <span className="small muted">No thresholds of its own</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="field" style={{ maxWidth: 320 }}><span>Days a "noted" alert stays hidden</span><input inputMode="numeric" disabled={!allowed} value={form.snooze!.days as string} onChange={(e) => set('snooze', 'days', e.target.value)} /></label>
      {allowed ? (
        <>
          <label className="field"><span>Reason for the change</span><input value={reason} onChange={(e) => { setReason(e.target.value); setSaved(false); }} /></label>
          {errors && <div className="errors" role="alert">{errors.map((e) => <div key={e}>{e}</div>)}</div>}
          {saved && <p className="small" role="status">Saved.</p>}
          <button className="btn primary" onClick={save}>Save alert rules</button>
        </>
      ) : <p className="small muted">Reliability engineers, superintendents and admins change these.</p>}
    </section>
  );
}
