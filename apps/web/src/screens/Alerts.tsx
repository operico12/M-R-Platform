// Alerts page (phase 2, plan section 4 "Alerts and notifications"): the
// reliability and threshold alerts from docs/alert-rules.md, each in words
// with the numbers behind it, and the A7 flag checks. Supervisors, reliability
// engineers and superintendents answer alerts; answers are kept for good.

import {
  DECISION_LABELS, RULE_ALERTS, activeAlerts, answerAlert, can, openAlerts,
  type AlertDecision, type RuleAlert,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { siteTime } from '../format';
import { analysisHref, newHref } from '../improve/describe';
import { Errors } from '../improve/ui';
import { useApp } from '../store';

const GOES_TO: Record<string, string> = {
  supervisor: 'Supervisor', reliability_engineer: 'Reliability engineer', superintendent: 'Superintendent', planner: 'Planner', stores: 'Stores', admin: 'Admin',
};
type Group = 'all' | 'reliability' | 'threshold' | 'flags';
const GROUPS: Array<[Group, string]> = [['all', 'All'], ['reliability', 'Reliability'], ['threshold', 'Thresholds'], ['flags', 'Flag checks']];

export function Alerts() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [group, setGroup] = useState<Group>('all');
  const [showAnswered, setShowAnswered] = useState(false);
  const split = useMemo(() => openAlerts(app.ruleAlerts, app.alertAnswers, app.now, app.alertSettings.snoozeDays, tz), [app.ruleAlerts, app.alertAnswers, app.now, app.alertSettings.snoozeDays, tz]);
  const flagChecks = useMemo(
    () => activeAlerts({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, rules: app.rules, calendar: app.ds.calendar, now: app.now }),
    [app.ds, app.flags, app.rules, app.now],
  );
  const inGroup = (a: RuleAlert) => group === 'all' || RULE_ALERTS[a.kind].group === group;
  const open = split.open.filter(inGroup).sort((x, y) => RULE_ALERTS[x.kind].id.localeCompare(RULE_ALERTS[y.kind].id) || y.since.localeCompare(x.since));
  const count = (g: 'reliability' | 'threshold') => split.open.filter((a) => RULE_ALERTS[a.kind].group === g).length;
  const unitName = (id?: string) => (id ? app.ds.assets.find((a) => a.id === id)?.unitNumber ?? id : undefined);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Alerts</h2>
        {can(app.actor, 'edit_alert_rules') && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href="#/console/alerts">Alert rules</a>}
      </div>
      <p className="small muted">Plain rules, each explained with the numbers behind it. Email, Teams and push come later; for now alerts show here and in the menu count.</p>

      <div className="grid kpis">
        <div className="card kpi"><div className="label">Reliability, open</div><div className="value">{count('reliability')}</div></div>
        <div className="card kpi"><div className="label">Thresholds, open</div><div className="value">{count('threshold')}</div></div>
        <div className="card kpi"><div className="label">Flag checks</div><div className="value">{flagChecks.length}</div><div className="sub">Cleared by fixing the flag</div></div>
        <div className="card kpi"><div className="label">Answered</div><div className="value">{split.answered.length}</div></div>
      </div>

      <div className="chips" style={{ margin: '12px 0' }}>
        {GROUPS.map(([k, l]) => <button key={k} className="chip" aria-pressed={group === k} onClick={() => setGroup(k)} style={{ minHeight: 40 }}>{l}</button>)}
      </div>

      {group !== 'flags' && (
        <section>
          <h3>Open ({open.length})</h3>
          {!open.length && <p className="muted">Nothing open. Every rule is quiet, or its alerts have been answered.</p>}
          <div style={{ display: 'grid', gap: 12 }}>
            {open.map((a) => <AlertCard key={a.key} a={a} unitName={unitName(a.unitId)} />)}
          </div>
        </section>
      )}

      {(group === 'all' || group === 'flags') && (
        <section>
          <h3>Flag checks ({flagChecks.length})</h3>
          <p className="small muted" style={{ marginTop: 0 }}>A7 section 8. These clear when the flag is put right, so they are not answered here.</p>
          {flagChecks.length ? (
            <div className="table-wrap"><table>
              <thead><tr><th>Unit</th><th>Check</th><th>Since</th><th>Goes to</th></tr></thead>
              <tbody>{flagChecks.map((c, i) => (
                <tr key={`${c.kind}-${c.unitId}-${c.flagId ?? ''}-${i}`}>
                  <td><a href={`#/unit/${c.unitId}`}>{unitName(c.unitId)}</a></td><td>{c.message}</td><td>{siteTime(c.since, tz, true)}</td>
                  <td className="small">{c.goesTo.map((g) => GOES_TO[g] ?? g).join(', ')}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="muted">No flag checks firing.</p>}
        </section>
      )}

      {group !== 'flags' && (
        <section>
          <button className="linklike" onClick={() => setShowAnswered(!showAnswered)} aria-expanded={showAnswered}>
            {showAnswered ? 'Hide' : 'Show'} answered alerts ({split.answered.filter(({ alert }) => inGroup(alert)).length})
          </button>
          {showAnswered && (
            <div className="table-wrap" style={{ marginTop: 8 }}><table>
              <thead><tr><th>Alert</th><th>Answer</th><th>Note</th><th>By</th><th>When</th></tr></thead>
              <tbody>{split.answered.filter(({ alert }) => inGroup(alert)).map(({ alert, answer, until }) => (
                <tr key={alert.key}>
                  <td><span className="small muted">{RULE_ALERTS[alert.kind].id}</span> {alert.title}</td>
                  <td>{DECISION_LABELS[answer.decision]}{until ? <div className="small muted">Back {siteTime(until, tz, true)} if still true</div> : null}
                    {answer.actionId ? <div><a href={`#/actions/${answer.actionId}`}>Open the action</a></div> : null}</td>
                  <td className="small">{answer.note || '—'}</td>
                  <td>{app.userName(answer.answeredBy)}</td>
                  <td>{siteTime(answer.answeredAt, tz, true)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      )}
    </>
  );
}

function AlertCard({ a, unitName }: { a: RuleAlert; unitName?: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const meta = RULE_ALERTS[a.kind];
  const canAnswer = can(app.actor, 'create_actions');
  const [mode, setMode] = useState<AlertDecision | null>(null);
  const [note, setNote] = useState('');
  const [actionId, setActionId] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const openActions = app.actions.filter((x) => x.status === 'open' || x.status === 'in_progress').sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  const submit = (d: AlertDecision) => {
    const r = app.runAlertAnswer((ctx) => answerAlert(ctx, a, d, note, actionId || undefined));
    if (!r.ok) setErrors(r.errors);
  };
  const raiseHref = newHref('actions', a.unitId ? { kind: 'unit', unitId: a.unitId, query: a.query } : { kind: 'analysis', query: a.query ?? '' });

  return (
    <article className="card" aria-label={a.title}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="small" style={{ padding: '2px 10px', borderRadius: 12, background: 'var(--surface-2)', fontWeight: 600 }}>{meta.id} {meta.label}</span>
        <span className="small muted">Since {siteTime(a.since, tz, true)}</span>
      </div>
      <h4 style={{ margin: '8px 0 4px' }}>{a.title}</h4>
      <p style={{ margin: '0 0 6px' }}>{a.detail}</p>
      <p className="small muted" style={{ margin: 0 }}>Based on {a.basedOn}. Goes to {a.goesTo.map((g) => GOES_TO[g] ?? g).join(', ')}.</p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {a.query !== undefined && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={analysisHref(a.query)}>See the events</a>}
        {a.unitId && unitName && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={`#/unit/${a.unitId}`}>{unitName}</a>}
        {canAnswer && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={raiseHref}>Raise action</a>}
        {canAnswer && mode === null && (
          <>
            <button className="btn" onClick={() => submit('noted')}>Noted</button>
            <button className="btn" onClick={() => { setMode('not_a_problem'); setErrors(null); }}>Not a problem</button>
            {openActions.length > 0 && <button className="btn" onClick={() => { setMode('action_raised'); setErrors(null); }}>Link an action</button>}
          </>
        )}
      </div>
      {mode === 'not_a_problem' && (
        <div style={{ marginTop: 10 }}>
          <label className="field"><span>Why it is not a problem</span><input autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="row" style={{ gap: 8 }}><button className="btn primary" onClick={() => submit('not_a_problem')}>Save</button><button className="btn" onClick={() => setMode(null)}>Cancel</button></div>
        </div>
      )}
      {mode === 'action_raised' && (
        <div style={{ marginTop: 10 }}>
          <label className="field"><span>Action</span>
            <select value={actionId} onChange={(e) => setActionId(e.target.value)}>
              <option value="">Pick an open action</option>
              {openActions.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
          </label>
          <label className="field"><span>Note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="row" style={{ gap: 8 }}><button className="btn primary" onClick={() => submit('action_raised')}>Save</button><button className="btn" onClick={() => setMode(null)}>Cancel</button></div>
        </div>
      )}
      <Errors list={errors} />
    </article>
  );
}
