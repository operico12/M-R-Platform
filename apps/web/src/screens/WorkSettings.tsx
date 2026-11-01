// Console, Work settings: the numbers the Work and PM view needs that the ERP
// does not hold (KPI-018, 020, 021). Reliability engineer or superintendent.

import { DEFAULT_WORK_SETTINGS, permission, setWorkSettings } from '@mr/core';
import { useState } from 'react';
import { useApp } from '../store';

export function WorkSettingsPage() {
  const app = useApp();
  const s = app.workSettings;
  const allowed = ['yes', 'propose', 'approve'].includes(permission(app.actor, 'change_targets'));
  const [craft, setCraft] = useState(String(s.craftHoursPerWeek));
  const [tol, setTol] = useState(String(s.pmToleranceDays));
  const [types, setTypes] = useState(s.emergencyTypes.join(', '));
  const [prios, setPrios] = useState(s.emergencyPriorities.join(', '));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const save = () => {
    const r = app.runWorkSettings((ctx) => setWorkSettings(ctx, s, {
      craftHoursPerWeek: craft === '' ? NaN : Number(craft), pmToleranceDays: tol === '' ? NaN : Number(tol),
      emergencyTypes: types.split(','), emergencyPriorities: prios.split(','),
    }, reason));
    if (!r.ok) { setErrors(r.errors); setSaved(false); return; }
    setErrors(null); setReason(''); setSaved(true);
  };
  return (
    <section className="card" style={{ maxWidth: 720 }}>
      <h3 style={{ marginTop: 0 }}>Work settings</h3>
      <p className="small muted" style={{ marginTop: 0 }}>Used by the Work and PM page. Every change is in the audit trail with a reason. {app.mode === 'demo' ? 'The demo starts with 480 craft hours a week.' : ''}</p>
      <div className="grid two">
        <label className="field"><span>Craft hours a week for backlog work</span><input inputMode="decimal" disabled={!allowed} value={craft} onChange={(e) => setCraft(e.target.value)} /><small className="muted">0 hides backlog in weeks (KPI-021).</small></label>
        <label className="field"><span>PM tolerance, days after due</span><input inputMode="numeric" disabled={!allowed} value={tol} onChange={(e) => setTol(e.target.value)} /><small className="muted">Site to agree. Default {DEFAULT_WORK_SETTINGS.pmToleranceDays} (KPI-018).</small></label>
        <label className="field"><span>Emergency work types</span><input disabled={!allowed} value={types} onChange={(e) => setTypes(e.target.value)} /><small className="muted">ERP work types, comma separated (KPI-020).</small></label>
        <label className="field"><span>Emergency priorities</span><input disabled={!allowed} value={prios} onChange={(e) => setPrios(e.target.value)} /><small className="muted">ERP priorities, comma separated.</small></label>
      </div>
      {allowed ? (
        <>
          <label className="field"><span>Reason for the change</span><input value={reason} onChange={(e) => { setReason(e.target.value); setSaved(false); }} /></label>
          {errors && <div className="errors" role="alert">{errors.map((e) => <div key={e}>{e}</div>)}</div>}
          {saved && <p className="small" role="status">Saved.</p>}
          <button className="btn primary" onClick={save}>Save work settings</button>
        </>
      ) : <p className="small muted">Reliability engineers and superintendents change these.</p>}
    </section>
  );
}
