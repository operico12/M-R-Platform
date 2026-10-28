// RCM to PM job plans (phase 3; docs/rcm.md): the failure mode library per
// model, task selection, packaging into job plans, issuing revisions, the
// Maximo export, the review of failures against the library, and settings.
// Screens call core commands only.

import {
  CONSEQUENCES, CONSEQUENCE_LABELS, INTERVAL_CALCULATOR, QUESTIONS, TASK_LABELS, TASK_TYPES, VERDICT_LABELS,
  addMode, buildEvents, can, cleanAnswers, currentModes, isScheduled, issueJobPlan, latestVersion, maximoSheets, packageModel, planChanges, planState,
  rcmModels, rcmReview, recommendTask, retireMode, reviseMode, revisionsOf, setRcmSettings,
  type Answers, type Consequence, type JobPlanDraft, type ModeInput, type PartLine, type RcmMode, type RcmSettings, type TaskType, type Verdict,
} from '@mr/core';
import { useMemo, useState, type ReactNode } from 'react';
import { siteTime } from '../format';
import { useApp } from '../store';

type Tab = 'library' | 'plans' | 'outside' | 'review' | 'settings';
const TABS: Array<[Tab, string]> = [['library', 'Failure modes'], ['plans', 'Job plans'], ['outside', 'Not in job plans'], ['review', 'Review'], ['settings', 'Settings']];

const dayOf = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' });
const h = (x: number | undefined) => (x === undefined ? '—' : `${x.toLocaleString('en-CA')} h`);

function useRcm(query: string) {
  const app = useApp();
  const q = new URLSearchParams(query);
  const models = useMemo(() => rcmModels(app.rcmModes, app.ds.assets), [app.rcmModes, app.ds.assets]);
  const model = q.get('model') && models.includes(q.get('model')!) ? q.get('model')! : models[0] ?? '';
  const modes = useMemo(() => currentModes(app.rcmModes, model), [app.rcmModes, model]);
  const packaged = useMemo(() => packageModel(app.rcmModes, model, app.rcmSettings), [app.rcmModes, model, app.rcmSettings]);
  return { app, q, models, model, modes, packaged, tz: app.ds.site.timeZone, s: app.rcmSettings };
}
type Data = ReturnType<typeof useRcm>;

const href = (tab: Tab, model: string, extra = '') => `#/rcm?tab=${tab}&model=${encodeURIComponent(model)}${extra}`;

export function Rcm({ arg, sub, query }: { arg?: string; sub?: string; query: string }) {
  const d = useRcm(query);
  if (arg === 'mode' && sub) return <ModePage d={d} modeId={sub} />;
  if (arg === 'new') return <NewMode d={d} />;
  const tab = (TABS.find(([k]) => k === d.q.get('tab'))?.[0] ?? 'library') as Tab;
  const { packaged, model } = d;
  const states = packaged.plans.map((p) => planState(p, d.app.jobPlanVersions).kind);
  const waiting = states.filter((k) => k !== 'issued').length;
  return (
    <div className="stack">
      <div className="page-head">
        <h2>RCM</h2>
        <span className="muted small">Failure modes per model, task selection in line with SAE JA1011 and JA1012, and the PM job plans they make.</span>
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="field" style={{ minWidth: 160 }}>
          <span>Model</span>
          <select value={model} onChange={(e) => { window.location.hash = href(tab, e.target.value); }}>{d.models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
        {can(d.app.actor, 'edit_rcm') && <a className="btn primary" href={`#/rcm/new?model=${encodeURIComponent(model)}`} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Add a failure mode</a>}
      </div>
      <div className="grid kpis">
        <Tile label="Failure modes" value={String(d.modes.length)} note={`${d.modes.filter((m) => isScheduled(m.taskType)).length} with a scheduled task`} />
        <Tile label="Job plans" value={String(packaged.plans.length)} note={waiting ? `${waiting} not issued or changed since issue` : 'All issued'} warn={waiting > 0} />
        <Tile label="Not in job plans" value={String(packaged.tooShort.length + packaged.runToFailure.length + packaged.redesign.length)} note={`${packaged.redesign.length} need a redesign`} />
      </div>
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <a key={k} role="tab" className="chip" aria-pressed={tab === k} aria-selected={tab === k} href={href(k, model)} style={{ minHeight: 40, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{l}</a>)}
      </div>
      {!model && <p className="muted">No models yet. Units come from the asset import.</p>}
      {model && tab === 'library' && <LibraryTab d={d} />}
      {model && tab === 'plans' && <PlansTab d={d} />}
      {model && tab === 'outside' && <OutsideTab d={d} />}
      {model && tab === 'review' && <ReviewTab d={d} />}
      {tab === 'settings' && <SettingsTab d={d} />}
    </div>
  );
}

function Tile({ label, value, note, warn }: { label: string; value: string; note?: string; warn?: boolean }) {
  return (
    <div className="card">
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: warn ? 'var(--down)' : undefined }}>{value}</div>
      {note && <div className="small muted">{note}</div>}
    </div>
  );
}

const taskCell = (m: RcmMode) => (
  <>
    <strong>{TASK_LABELS[m.taskType]}</strong>{m.taskType !== m.recommended && <span className="small muted"> (recommended: {TASK_LABELS[m.recommended].toLowerCase()})</span>}
    {m.task && <div className="small">{m.task}</div>}
  </>
);

// ---------- library ----------

function LibraryTab({ d }: { d: Data }) {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = d.modes.filter((m) => words.every((w) => `${m.system} ${m.component} ${m.mode} ${m.func} ${m.task} ${TASK_LABELS[m.taskType]}`.toLowerCase().includes(w)));
  const systems = [...new Set(rows.map((m) => m.system))];
  if (!d.modes.length) return <section className="card"><p className="muted">No failure modes for the {d.model} yet.{can(d.app.actor, 'edit_rcm') ? ' Use “Add a failure mode” to start the library.' : ''}</p></section>;
  return (
    <section className="card">
      <label className="field" style={{ maxWidth: 420 }}><span>Search</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="For example pump, leak, brake" /></label>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Component</th><th>Failure mode</th><th>Consequence</th><th>Task</th><th>Interval</th><th>Rev.</th></tr></thead>
          <tbody>
            {systems.map((sys) => [
              <tr key={sys}><th colSpan={6} style={{ textAlign: 'left', background: 'var(--surface-2, transparent)' }}>{sys}</th></tr>,
              ...rows.filter((m) => m.system === sys).map((m) => (
                <tr key={m.modeId}>
                  <td>{m.component}</td>
                  <td><a href={`#/rcm/mode/${m.modeId}`}>{m.mode}</a><div className="small muted">{m.functionalFailure}</div></td>
                  <td>{CONSEQUENCE_LABELS[m.consequence]}</td>
                  <td>{taskCell(m)}</td>
                  <td>{isScheduled(m.taskType) ? h(m.intervalHours) : '—'}</td>
                  <td>{m.revision}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="muted">Nothing matches “{q}”.</p>}
    </section>
  );
}

// ---------- job plans ----------

function PlansTab({ d }: { d: Data }) {
  const { app, packaged, tz, s } = d;
  const [open, setOpen] = useState<string | null>(null);
  const allIssued = useMemo(() => [...new Set(app.jobPlanVersions.filter((v) => v.model === d.model).map((v) => v.jpnum))].map((j) => latestVersion(app.jobPlanVersions, j)!), [app.jobPlanVersions, d.model]);
  // An issued job plan whose tasks have all moved or gone is no longer exported.
  const current = new Set(packaged.plans.map((p) => p.jpnum));
  const issued = allIssued.filter((v) => current.has(v.jpnum));
  const obsolete = allIssued.filter((v) => !current.has(v.jpnum));
  const exportAll = async () => {
    const { xlsxBlob } = await import('../pack/xlsx');
    const blob = await xlsxBlob(maximoSheets(issued, s, app.userName));
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-plans-${d.model}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const canExport = can(app.actor, 'export_reports');
  return (
    <div className="stack">
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <strong>PM levels {s.packages.join(', ')} h</strong>, {s.nested ? 'nested (each PM also holds the smaller levels it is a multiple of)' : 'not nested'}.
            <div className="small muted">Each task goes into the largest level no longer than its interval. Change this in Settings.</div>
          </div>
          {canExport && <button className="btn" disabled={!issued.length} onClick={exportAll} title={issued.length ? '' : 'Issue a job plan first'}>Export issued job plans for Maximo ({issued.length})</button>}
        </div>
        {canExport && (!s.maximoOrgId || !s.maximoSiteId) && <p className="small warns" style={{ marginBottom: 0 }}>Maximo organisation and site IDs are not set, so those columns are blank. Set them in Settings.</p>}
      </section>
      {!packaged.plans.length && <section className="card"><p className="muted">No scheduled tasks yet, so there are no job plans.</p></section>}
      {obsolete.length > 0 && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>No longer needed ({obsolete.length})</h3>
          <p className="small muted">These were issued, but no task now falls at their level. They are left out of the export; set them inactive in Maximo.</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>{obsolete.map((v) => <li key={v.jpnum}>{v.jpnum}, revision {v.revision}, issued {siteTime(v.issuedAt, tz, true)}</li>)}</ul>
        </section>
      )}
      {packaged.plans.map((p) => <PlanCard key={p.jpnum} d={d} p={p} open={open === p.jpnum} toggle={() => setOpen(open === p.jpnum ? null : p.jpnum)} tz={tz} />)}
    </div>
  );
}

function PlanCard({ d, p, open, toggle, tz }: { d: Data; p: JobPlanDraft; open: boolean; toggle: () => void; tz: string }) {
  const { app } = d;
  const st = planState(p, app.jobPlanVersions);
  const ch = st.kind === 'changed' ? planChanges(p, st.version) : null;
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const issue = () => {
    const r = app.runJobPlan((ctx, versions) => issueJobPlan(ctx, versions, p, note));
    setMsg(r.ok ? { ok: true, text: `Issued as revision ${r.records[r.records.length - 1]!.revision}.` } : { ok: false, text: r.errors.join(' ') });
    if (r.ok) setNote('');
  };
  const pill = { padding: '4px 10px', borderRadius: 999, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--border)', whiteSpace: 'nowrap', fontSize: 13 } as const;
  const badge = st.kind === 'not_issued' ? <span style={pill}>◇ Not issued</span>
    : st.kind === 'issued' ? <span style={pill}>● Issued, revision {st.version.revision}</span>
    : <span style={{ ...pill, borderColor: 'var(--down)', fontWeight: 600 }}>▲ Changed since revision {st.version.revision}</span>;
  const parts = p.tasks.reduce((n, t) => n + t.parts.length, 0);
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>{p.jpnum} <span className="small muted" style={{ fontWeight: 400 }}>{p.description}</span></h3>
          <div className="small muted">{p.tasks.length} tasks, {p.duration} h of work, {parts} part lines</div>
        </div>
        <div className="row" style={{ gap: 8 }}>{badge}<button className="btn" onClick={toggle} aria-expanded={open}>{open ? 'Hide tasks' : 'Show tasks'}</button></div>
      </div>
      {p.warnings.map((w) => <p key={w} className="small warns">{w}</p>)}
      {st.kind !== 'not_issued' && <p className="small muted" style={{ marginBottom: 0 }}>Revision {st.version.revision} issued by {app.userName(st.version.issuedBy)}, {siteTime(st.version.issuedAt, tz, true)}: {st.version.note}</p>}
      {ch && (
        <p className="small" style={{ marginBottom: 0 }}>
          Since then: {[ch.added.length && `${ch.added.length} added`, ch.changed.length && `${ch.changed.length} changed (${ch.changed.map((t) => t.component).join(', ')})`, ch.removed.length && `${ch.removed.length} removed (${ch.removed.map((t) => t.component).join(', ')})`].filter(Boolean).join(', ')}.
        </p>
      )}
      {open && (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Task</th><th>Level</th><th>What to do</th><th>Labour</th><th>Parts</th></tr></thead>
            <tbody>
              {p.tasks.map((t) => (
                <tr key={t.modeId} style={ch?.added.includes(t) || ch?.changed.includes(t) ? { background: 'color-mix(in srgb, var(--sched) 18%, transparent)' } : undefined}>
                  <td>{t.seq}</td>
                  <td>{t.level} h</td>
                  <td><a href={`#/rcm/mode/${t.modeId}`}>{t.system}, {t.component}</a>: {t.description}<div className="small muted">{TASK_LABELS[t.taskType]} for {t.mode.toLowerCase()}</div></td>
                  <td>{t.people} × {t.craft}, {t.hours} h</td>
                  <td className="small">{t.parts.map((x) => `${x.qty} × ${x.itemNum} ${x.description}`).join('; ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {st.kind !== 'issued' && can(app.actor, 'issue_job_plans') && (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="field" style={{ flex: '1 1 260px' }}><span>Note for revision {st.kind === 'changed' ? st.version.revision + 1 : 1}</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" /></label>
          <button className="btn primary" onClick={issue}>Issue revision</button>
        </div>
      )}
      {msg && <div className={msg.ok ? 'card' : 'errors'} role="status" style={{ marginTop: 10 }}>{msg.text}</div>}
    </section>
  );
}

// ---------- outside the job plans ----------

function OutsideTab({ d }: { d: Data }) {
  const { packaged, s } = d;
  const list = (title: string, note: string, rows: RcmMode[], extra?: (m: RcmMode) => ReactNode) => (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>{title} ({rows.length})</h3>
      <p className="small muted">{note}</p>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>System, component</th><th>Failure mode</th><th>Consequence</th><th>Task</th>{extra && <th />}</tr></thead>
            <tbody>{rows.map((m) => (
              <tr key={m.modeId}>
                <td>{m.system}, {m.component}</td>
                <td><a href={`#/rcm/mode/${m.modeId}`}>{m.mode}</a></td>
                <td>{CONSEQUENCE_LABELS[m.consequence]}</td>
                <td>{taskCell(m)}{isScheduled(m.taskType) && <div className="small">Every {h(m.intervalHours)}</div>}</td>
                {extra && <td>{extra(m)}</td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="muted small">None.</p>}
    </section>
  );
  const action = (m: RcmMode) => can(d.app.actor, 'create_actions')
    ? <a href={`#/actions/new?src=manual&label=${encodeURIComponent(`RCM redesign: ${d.model} ${m.component}`)}&title=${encodeURIComponent(m.task || `Redesign ${m.component}`)}`}>Raise an action</a>
    : null;
  return (
    <>
      {list('Redesign needed', 'No task was found that is worth doing. Safety and hidden-failure modes here need a one-time change.', packaged.redesign, action)}
      {list(`Shorter than the smallest PM (${s.packages[0]} h)`, 'Do these as operator checks or daily inspections (Inspections forms), not in a PM.', packaged.tooShort)}
      {list('Run to failure', 'No scheduled task. The review checks these still fail rarely enough.', packaged.runToFailure)}
    </>
  );
}

// ---------- review ----------

const VERDICT_SHAPE: Record<Verdict, string> = { review_task: '▲', check_rtf: '◆', working: '●', no_failures: '○' };

function ReviewTab({ d }: { d: Data }) {
  const { app, s, tz } = d;
  const events = useMemo(() => buildEvents(app.flags, app.rules, app.now), [app.flags, app.rules, app.now]);
  const r = useMemo(() => rcmReview(app.rcmModes, events, app.ds.assets, d.model, app.now, s), [app.rcmModes, events, app.ds.assets, d.model, app.now, s]);
  const flagged = r.rows.filter((x) => x.verdict === 'review_task' || x.verdict === 'check_rtf').length;
  return (
    <div className="stack">
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Failures against the library</h3>
        <p className="small muted">
          {r.failures} failures on {d.model} units from {dayOf(r.from, tz)} to {dayOf(r.to, tz)} (A7 R9), matched by system, component and failure mode.
          {flagged ? ` ${flagged} mode${flagged > 1 ? 's' : ''} need a look.` : ''} “Found in operation” means the operator, an alarm or nothing recorded; PM, inspection and condition monitoring count as found by maintenance.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Verdict</th><th>System, component</th><th>Failure mode</th><th>Task</th><th>Failures</th><th>In operation</th><th>By maintenance</th></tr></thead>
            <tbody>{r.rows.map((x) => (
              <tr key={x.mode.modeId}>
                <td style={{ whiteSpace: 'nowrap', fontWeight: x.verdict === 'review_task' || x.verdict === 'check_rtf' ? 700 : 400 }}>{VERDICT_SHAPE[x.verdict]} {VERDICT_LABELS[x.verdict]}</td>
                <td>{x.mode.system}, {x.mode.component}</td>
                <td><a href={`#/rcm/mode/${x.mode.modeId}`}>{x.mode.mode}</a></td>
                <td className="small">{TASK_LABELS[x.mode.taskType]}{isScheduled(x.mode.taskType) ? `, every ${h(x.mode.intervalHours)}` : ''}</td>
                <td>{x.failures}</td><td>{x.inOperation}</td><td>{x.byMaintenance}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Failures not in the library ({r.uncovered.reduce((n, x) => n + x.failures, 0)})</h3>
        <p className="small muted">Candidates to add. {r.uncoded ? `${r.uncoded} more failure${r.uncoded > 1 ? 's have' : ' has'} no system, component or a known failure mode, so cannot be matched (KPI-027 coding quality).` : ''}</p>
        {r.uncovered.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>System</th><th>Component</th><th>Failure mode</th><th>Failures</th><th /></tr></thead>
              <tbody>{r.uncovered.map((x) => (
                <tr key={`${x.system}|${x.component}|${x.mode}`}>
                  <td>{x.system}</td><td>{x.component}</td><td>{x.mode}</td><td>{x.failures}</td>
                  <td>{can(app.actor, 'edit_rcm') && <a href={`#/rcm/new?model=${encodeURIComponent(d.model)}&system=${encodeURIComponent(x.system)}&component=${encodeURIComponent(x.component)}&mode=${encodeURIComponent(x.mode)}`}>Add to the library</a>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="muted small">Every coded failure matches a mode.</p>}
      </section>
    </div>
  );
}

// ---------- settings ----------

function SettingsTab({ d }: { d: Data }) {
  const { app } = d;
  const allowed = can(app.actor, 'edit_rcm');
  const [v, setV] = useState<RcmSettings>(d.s);
  const [levels, setLevels] = useState(d.s.packages.join(', '));
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = () => {
    const packages = levels.split(/[\s,;]+/).filter(Boolean).map(Number);
    const r = app.runRcmSettings((ctx, cur) => setRcmSettings(ctx, cur, { ...v, packages }, reason));
    setMsg(r.ok ? { ok: true, text: 'Saved. Job plans are rebuilt with these settings; issued revisions are not changed.' } : { ok: false, text: r.errors.join(' ') });
    if (r.ok) { setReason(''); setV(r.records[0]!); setLevels(r.records[0]!.packages.join(', ')); }
  };
  const n = (x: string) => Number(x);
  return (
    <section className="card" style={{ maxWidth: 760 }}>
      <h3>RCM settings</h3>
      <p className="small muted">{allowed ? 'Changes go to the audit log with your reason.' : 'Reliability engineers and superintendents change these.'}</p>
      <fieldset disabled={!allowed} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid two" style={{ gap: 10, alignItems: 'start' }}>
          <label className="field"><span>PM levels (SMU hours)</span><input value={levels} onChange={(e) => setLevels(e.target.value)} /></label>
          <label className="field"><span>Nested PMs</span>
            <select value={v.nested ? 'yes' : 'no'} onChange={(e) => setV({ ...v, nested: e.target.value === 'yes' })}>
              <option value="yes">Yes: a PM holds the smaller levels it is a multiple of</option>
              <option value="no">No: each PM holds its own level (Maximo PM sequences)</option>
            </select>
          </label>
          <label className="field"><span>Job plan number prefix</span><input value={v.prefix} onChange={(e) => setV({ ...v, prefix: e.target.value })} placeholder="Blank" /></label>
          <span />
          <label className="field"><span>Maximo organisation (ORGID)</span><input value={v.maximoOrgId} onChange={(e) => setV({ ...v, maximoOrgId: e.target.value })} /></label>
          <label className="field"><span>Maximo site (SITEID)</span><input value={v.maximoSiteId} onChange={(e) => setV({ ...v, maximoSiteId: e.target.value })} /></label>
          <label className="field"><span>Review window (days)</span><input inputMode="numeric" value={v.reviewDays} onChange={(e) => setV({ ...v, reviewDays: n(e.target.value) })} /></label>
          <label className="field"><span>Failures before a task needs review</span><input inputMode="numeric" value={v.reviewFailures} onChange={(e) => setV({ ...v, reviewFailures: n(e.target.value) })} /></label>
        </div>
        {allowed && (
          <>
            <label className="field" style={{ marginTop: 10 }}><span>Reason for the change</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <button className="btn primary" style={{ marginTop: 10 }} onClick={save}>Save settings</button>
          </>
        )}
      </fieldset>
      {msg && <div className={msg.ok ? 'card' : 'errors'} role="status" style={{ marginTop: 10 }}>{msg.text}</div>}
    </section>
  );
}

// ---------- one failure mode ----------

function ModePage({ d, modeId }: { d: Data; modeId: string }) {
  const { app, tz } = d;
  const revs = revisionsOf(app.rcmModes, modeId);
  const [editing, setEditing] = useState(false);
  const [retire, setRetire] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const m = revs[0];
  if (!m) return <section className="card"><p>Failure mode not found. <a href="#/rcm">Back to RCM</a></p></section>;
  const allowed = can(app.actor, 'edit_rcm');
  const doRetire = () => {
    const r = app.runRcm((ctx, modes) => retireMode(ctx, modes, modeId, retire));
    setMsg(r.ok ? { ok: true, text: 'Retired. It leaves the job plans; issued revisions keep it until the next issue.' } : { ok: false, text: r.errors.join(' ') });
  };
  const plans = d.packaged.plans.filter((p) => p.tasks.some((t) => t.modeId === modeId)).map((p) => p.jpnum);
  const calc = INTERVAL_CALCULATOR[m.taskType];
  const row = (label: string, value: ReactNode) => <tr><th style={{ width: 200, textAlign: 'left', verticalAlign: 'top' }}>{label}</th><td>{value}</td></tr>;
  return (
    <div className="stack">
      <div className="page-head">
        <h2><a href={href('library', m.model)} className="small" style={{ fontWeight: 400 }}>RCM {m.model}</a> / {m.component}: {m.mode}</h2>
        <span className="muted small">Revision {m.revision}{m.retiredAt ? `, retired ${siteTime(m.retiredAt, tz, true)} by ${app.userName(m.retiredBy ?? '')}: ${m.retireReason}` : ''}</span>
      </div>
      {editing ? (
        <ModeForm d={d} prev={m} onDone={(text) => { setEditing(false); setMsg({ ok: true, text }); }} onCancel={() => setEditing(false)} />
      ) : (
        <section className="card">
          <div className="table-wrap">
            <table>
              <tbody>
                {row('System, component', `${m.system}, ${m.component}`)}
                {row('Function', m.func)}
                {row('Functional failure', m.functionalFailure)}
                {row('Failure mode', m.mode)}
                {row('Effect', m.effect)}
                {row('Consequence', CONSEQUENCE_LABELS[m.consequence])}
                {row('Answers', <ul style={{ margin: 0, paddingLeft: 18 }}>{QUESTIONS.filter((q) => m.answers[q.key] !== undefined).map((q) => <li key={q.key} className="small">{q.text} <strong>{m.answers[q.key] ? 'Yes' : 'No'}</strong></li>)}</ul>)}
                {row('Task', <>{taskCell(m)}{m.overrideReason && <div className="small">Why not the recommended task: {m.overrideReason}</div>}</>)}
                {isScheduled(m.taskType) && row('Interval', <>{h(m.intervalHours)}{m.intervalBasis && <span className="small muted"> ({m.intervalBasis})</span>}{calc && <> · <a href={`#/calc/${calc}`}>Open the calculator</a></>}</>)}
                {isScheduled(m.taskType) && row('Labour', `${m.people} × ${m.craft}, ${m.taskHours} h each`)}
                {isScheduled(m.taskType) && row('Parts', m.parts.length ? m.parts.map((p) => `${p.qty} × ${p.itemNum} ${p.description}`).join('; ') : '—')}
                {row('In job plans', plans.length ? plans.join(', ') : '—')}
              </tbody>
            </table>
          </div>
          {allowed && !m.retiredAt && <button className="btn primary" style={{ marginTop: 10 }} onClick={() => { setMsg(null); setEditing(true); }}>Change (new revision)</button>}
        </section>
      )}
      {msg && <div className={msg.ok ? 'card' : 'errors'} role="status">{msg.text}</div>}
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Revisions</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Rev.</th><th>By</th><th>When (site time)</th><th>Task</th><th>Note</th></tr></thead>
            <tbody>{revs.map((r) => (
              <tr key={r.id}><td>{r.revision}</td><td>{app.userName(r.createdBy)}</td><td>{siteTime(r.createdAt, tz, true)}</td><td className="small">{TASK_LABELS[r.taskType]}{isScheduled(r.taskType) ? `, every ${h(r.intervalHours)}` : ''}: {r.task || '—'}</td><td className="small">{r.changeNote ?? 'First entry'}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      {allowed && !m.retiredAt && !editing && (
        <section className="card" style={{ maxWidth: 640 }}>
          <h3 style={{ marginTop: 0 }}>Retire</h3>
          <p className="small muted">For a mode that no longer applies, for example after a redesign. It is kept, with the reason.</p>
          <div className="row" style={{ gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: '1 1 260px' }}><span>Reason</span><input value={retire} onChange={(e) => setRetire(e.target.value)} /></label>
            <button className="btn" onClick={doRetire}>Retire</button>
          </div>
        </section>
      )}
    </div>
  );
}

function NewMode({ d }: { d: Data }) {
  const [done, setDone] = useState<string | null>(null);
  if (!can(d.app.actor, 'edit_rcm')) return <section className="card"><p>Reliability engineers and superintendents edit the RCM library.</p></section>;
  return (
    <div className="stack">
      <div className="page-head"><h2><a href={href('library', d.model)} className="small" style={{ fontWeight: 400 }}>RCM {d.model}</a> / New failure mode</h2></div>
      {done ? <div className="card" role="status">{done} <a href={href('library', d.model)}>Back to the library</a></div>
        : <ModeForm d={d} onDone={(t) => setDone(t)} onCancel={() => { window.location.hash = href('library', d.model); }} />}
    </div>
  );
}

type FormState = Omit<ModeInput, 'intervalHours' | 'people' | 'taskHours' | 'parts'> & { intervalHours: string; people: string; taskHours: string; parts: Array<{ itemNum: string; description: string; qty: string }>; note: string };

function ModeForm({ d, prev, onDone, onCancel }: { d: Data; prev?: RcmMode; onDone: (text: string) => void; onCancel: () => void }) {
  const { app, q } = d;
  const [f, setF] = useState<FormState>(() => prev ? {
    model: prev.model, system: prev.system, component: prev.component, func: prev.func, functionalFailure: prev.functionalFailure, mode: prev.mode, effect: prev.effect,
    consequence: prev.consequence, answers: prev.answers, taskType: prev.taskType, overrideReason: prev.overrideReason ?? '', task: prev.task,
    intervalHours: prev.intervalHours === undefined ? '' : String(prev.intervalHours), intervalBasis: prev.intervalBasis ?? '', craft: prev.craft ?? '',
    people: prev.people === undefined ? '1' : String(prev.people), taskHours: prev.taskHours === undefined ? '' : String(prev.taskHours),
    parts: prev.parts.map((p) => ({ itemNum: p.itemNum, description: p.description, qty: String(p.qty) })), note: '',
  } : {
    model: d.model, system: q.get('system') ?? '', component: q.get('component') ?? '', func: '', functionalFailure: '', mode: q.get('mode') ?? '', effect: '',
    consequence: 'operational', answers: {}, taskType: 'run_to_failure', overrideReason: '', task: '', intervalHours: '', intervalBasis: '', craft: '', people: '1', taskHours: '', parts: [], note: '',
  });
  const [chosen, setChosen] = useState(!!prev);
  const [errors, setErrors] = useState<string[] | null>(null);
  const answers = cleanAnswers(f.consequence, f.answers);
  const asked = QUESTIONS.filter((x) => x.applies(f.consequence, answers));
  const complete = asked.every((x) => typeof answers[x.key] === 'boolean');
  const rec = complete ? recommendTask(f.consequence, answers) : null;
  const taskType: TaskType = chosen ? f.taskType : rec ?? f.taskType;
  const sched = isScheduled(taskType);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const lists = useMemo(() => {
    const sys = new Set<string>(); const comp = new Set<string>(); const fm = new Set<string>();
    for (const fl of app.flags) { const r = fl.release; if (r?.system) sys.add(r.system); if (r?.component) comp.add(r.component); for (const m of r?.failureModes ?? []) fm.add(m); }
    for (const m of app.rcmModes) { sys.add(m.system); comp.add(m.component); fm.add(m.mode); }
    return { sys: [...sys].sort(), comp: [...comp].sort(), fm: [...fm].filter((x) => !/^unknown$/i.test(x)).sort() };
  }, [app.flags, app.rcmModes]);
  const num = (x: string) => (x.trim() === '' ? undefined : Number(x));
  const save = () => {
    const input: ModeInput = {
      model: f.model, system: f.system, component: f.component, func: f.func, functionalFailure: f.functionalFailure, mode: f.mode, effect: f.effect, consequence: f.consequence,
      answers, taskType, overrideReason: f.overrideReason, task: f.task, intervalHours: num(f.intervalHours), intervalBasis: f.intervalBasis, craft: f.craft,
      people: num(f.people), taskHours: num(f.taskHours), parts: sched ? f.parts.filter((p) => p.itemNum.trim() || p.description.trim()).map((p): PartLine => ({ itemNum: p.itemNum, description: p.description, qty: Number(p.qty) })) : [],
    };
    const r = app.runRcm((ctx, modes) => (prev ? reviseMode(ctx, modes, prev.modeId, input, f.note) : addMode(ctx, modes, input)));
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors(null);
    onDone(`${prev ? `Saved as revision ${prev.revision + 1}.` : 'Added.'}${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}${sched ? ' Job plans that hold it now show as changed until they are issued again.' : ''}`);
  };
  const text = (k: 'system' | 'component' | 'mode' | 'func' | 'functionalFailure', label: string, list?: string[], hint?: string) => (
    <label className="field"><span>{label}</span><input value={f[k]} onChange={(e) => set(k, e.target.value)} list={list ? `rcm-${k}` : undefined} />{list && <datalist id={`rcm-${k}`}>{list.map((x) => <option key={x} value={x} />)}</datalist>}{hint && <span className="small muted">{hint}</span>}</label>
  );
  const yn = (key: keyof Answers, value: boolean | undefined) => (
    <span className="row" style={{ gap: 6 }}>
      {[true, false].map((b) => <button key={String(b)} type="button" className="chip" aria-pressed={value === b} onClick={() => setF((x) => ({ ...x, answers: { ...x.answers, [key]: b } }))}>{b ? 'Yes' : 'No'}</button>)}
    </span>
  );
  const calc = INTERVAL_CALCULATOR[taskType];
  return (
    <section className="card" style={{ maxWidth: 900 }}>
      <h3 style={{ marginTop: 0 }}>{prev ? `Change ${prev.component}: ${prev.mode}` : `New failure mode for the ${f.model}`}</h3>
      <h4>1. The failure</h4>
      <div className="grid two" style={{ gap: 10, alignItems: 'start' }}>
        {text('system', 'System', lists.sys, 'The same words as on down flags, so the review can match failures')}
        {text('component', 'Component', lists.comp)}
        {text('func', 'Function', undefined, 'What it must do, for example “Cool the engine below 95 °C at full load”')}
        {text('functionalFailure', 'Functional failure', undefined, 'How it fails to do it')}
        {text('mode', 'Failure mode', lists.fm, 'What causes it, for example Leak')}
        <label className="field"><span>Effect</span><textarea rows={2} value={f.effect} onChange={(e) => set('effect', e.target.value)} /><span className="small muted">What happens: what the operator sees, downtime, damage, safety risk</span></label>
      </div>
      <h4>2. Consequence</h4>
      <div className="chips" role="radiogroup" aria-label="Consequence">
        {CONSEQUENCES.map((c: Consequence) => <button key={c} type="button" role="radio" aria-checked={f.consequence === c} className="chip" aria-pressed={f.consequence === c} onClick={() => set('consequence', c)}>{CONSEQUENCE_LABELS[c]}</button>)}
      </div>
      <p className="small muted">Hidden: the operators would not know it has happened during normal work. Otherwise pick the worst effect.</p>
      <h4>3. Task selection</h4>
      <ol style={{ paddingLeft: 18 }}>
        {asked.map((x) => <li key={x.key} style={{ marginBottom: 8 }}><div>{x.text}</div>{yn(x.key, answers[x.key])}</li>)}
      </ol>
      <p>{rec ? <>Recommended: <strong>{TASK_LABELS[rec]}</strong>.</> : <span className="muted">Answer the questions for a recommendation.</span>}</p>
      <div className="grid two" style={{ gap: 10, alignItems: 'start' }}>
        <label className="field"><span>Task type</span>
          <select value={taskType} onChange={(e) => { setChosen(true); set('taskType', e.target.value as TaskType); }}>{TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_LABELS[t]}{t === rec ? ' (recommended)' : ''}</option>)}</select>
        </label>
        {rec && taskType !== rec && <label className="field"><span>Why not the recommended task</span><input value={f.overrideReason ?? ''} onChange={(e) => set('overrideReason', e.target.value)} /></label>}
      </div>
      {(sched || taskType === 'redesign') && (
        <label className="field" style={{ marginTop: 10 }}><span>{taskType === 'redesign' ? 'Change needed' : 'Task (what to do)'}</span><textarea rows={2} value={f.task} onChange={(e) => set('task', e.target.value)} /><span className="small muted">{f.task.length} characters. Maximo shows the first 100; the rest goes to the long description.</span></label>
      )}
      {sched && (
        <>
          <h4>4. Interval and labour</h4>
          <div className="grid two" style={{ gap: 10, alignItems: 'start' }}>
            <label className="field"><span>Interval (SMU hours)</span><input inputMode="numeric" value={f.intervalHours} onChange={(e) => set('intervalHours', e.target.value)} />{calc && <a className="small" href={`#/calc/${calc}`} target="_blank" rel="noreferrer">Work it out with the {calc === 'pf_interval' ? 'P-F interval' : calc === 'optimal_replacement' ? 'optimal replacement' : 'failure-finding interval'} calculator</a>}</label>
            <label className="field"><span>How the interval was set</span><input value={f.intervalBasis ?? ''} onChange={(e) => set('intervalBasis', e.target.value)} placeholder="For example C-12: P-F 1000 h ÷ 2" /></label>
            <label className="field"><span>Craft (Maximo)</span><input value={f.craft ?? ''} onChange={(e) => set('craft', e.target.value)} placeholder="MECH" /></label>
            <label className="field"><span>People</span><input inputMode="numeric" value={f.people} onChange={(e) => set('people', e.target.value)} /></label>
            <label className="field"><span>Hours each</span><input inputMode="decimal" value={f.taskHours} onChange={(e) => set('taskHours', e.target.value)} /></label>
          </div>
          <h4>Parts</h4>
          {f.parts.map((p, i) => (
            <div key={i} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end', marginBottom: 6 }}>
              <label className="field" style={{ width: 150 }}><span>Item number</span><input value={p.itemNum} onChange={(e) => set('parts', f.parts.map((x, j) => (j === i ? { ...x, itemNum: e.target.value } : x)))} /></label>
              <label className="field" style={{ flex: '1 1 200px' }}><span>Description</span><input value={p.description} onChange={(e) => set('parts', f.parts.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} /></label>
              <label className="field" style={{ width: 90 }}><span>Quantity</span><input inputMode="decimal" value={p.qty} onChange={(e) => set('parts', f.parts.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} /></label>
              <button type="button" className="btn" onClick={() => set('parts', f.parts.filter((_, j) => j !== i))} aria-label={`Remove part ${i + 1}`}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => set('parts', [...f.parts, { itemNum: '', description: '', qty: '1' }])}>Add a part</button>
        </>
      )}
      {prev && <label className="field" style={{ marginTop: 10 }}><span>What changed and why</span><input value={f.note} onChange={(e) => set('note', e.target.value)} /></label>}
      {errors && <div className="errors" role="alert" style={{ marginTop: 10 }}><ul style={{ margin: 0, paddingLeft: 18 }}>{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" onClick={save}>{prev ? 'Save as a new revision' : 'Add'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}
