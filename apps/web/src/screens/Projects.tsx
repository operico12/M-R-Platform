// Project tracking (plan section 8): portfolio, project pages with tasks
// (list, board and Gantt), risks and issues, money and change requests,
// decisions, benefits and a one-click weekly status report.

import {
  HEALTH_LABELS, PROJECT_STAGE_LABELS, STAGE_ORDER, TASK_STATUS_LABELS, addCost, addRisk, addTask, advanceStage, can, closeRisk, createProject,
  decideChange, editProject, editTask, logDecision, nextMilestone, progress, projectBenefit, projectHealth, proposeChange, reopenProject,
  setTaskStatus, siteToday, spent, statusReport, stopProject, type Health, type Project, type ProjectTask, type TaskStatus,
} from '@mr/core';
import { useMemo, useState, type ReactNode } from 'react';
import { fmtPct, siteTime } from '../format';
import { analysisHref, describeQuery } from '../improve/describe';
import { Errors, History, NoteButton, Warnings } from '../improve/ui';
import { useApp } from '../store';

const linkBtn = { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' } as const;
export const money = (n: number) => `${n < 0 ? '−' : ''}${Math.round(Math.abs(n)).toLocaleString('en-CA')}`;
const HEALTH_RAG: Record<Health, string> = { on_track: 'green', at_risk: 'amber', late: 'red', closed: '' };
const today = (app: ReturnType<typeof useApp>) => siteToday(app.now, app.ds.site.timeZone);

export function Projects({ arg, query }: { arg?: string; query: string }) {
  if (arg === 'new') return <NewProject query={query} />;
  if (arg) return <ProjectPage id={arg} query={query} />;
  return <Portfolio query={query} />;
}

// ---------- portfolio ----------

function Portfolio({ query }: { query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const showClosed = new URLSearchParams(query).get('closed') === '1';
  const rows = app.projects
    .map((p) => ({ p, h: projectHealth(p, app.now, tz) }))
    .filter(({ h }) => showClosed || h.health !== 'closed')
    .sort((a, b) => order(a.h.health) - order(b.h.health) || a.p.end.localeCompare(b.p.end));
  const live = app.projects.map((p) => projectHealth(p, app.now, tz).health).filter((h) => h !== 'closed');
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Projects</h2>
        <span className="muted small">Status comes from the tasks, budget and risks; nobody types it.</span>
      </div>
      <div className="counts">
        <Count label="Live" v={live.length} />
        <Count label="Late" v={live.filter((h) => h === 'late').length} color="var(--down)" />
        <Count label="At risk" v={live.filter((h) => h === 'at_risk').length} color="var(--sched)" />
        <Count label="On track" v={live.filter((h) => h === 'on_track').length} color="var(--run)" />
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label className="small"><input type="checkbox" checked={showClosed} onChange={(e) => { window.location.hash = `#/projects${e.target.checked ? '?closed=1' : ''}`; }} /> Show closed and stopped</label>
        {can(app.actor, 'run_projects') && <a className="btn primary" style={linkBtn} href="#/projects/new?src=manual">New project</a>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Project</th><th>Gate</th><th>Status</th><th>Owner</th><th className="num">Done</th><th>Next milestone</th><th className="num">Budget</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">Benefit</th></tr></thead>
          <tbody>
            {rows.map(({ p, h }) => {
              const m = nextMilestone(p);
              const pr = progress(p);
              const variance = p.budget - spent(p) - p.forecastToComplete;
              return (
                <tr key={p.id}>
                  <td><a href={`#/projects/${p.id}`}>{p.title}</a></td>
                  <td>{PROJECT_STAGE_LABELS[p.stage]}</td>
                  <td>{h.health === 'closed' ? '—' : <span className={`rag ${HEALTH_RAG[h.health]}`} title={h.reasons.join(' ')}>{HEALTH_LABELS[h.health]}</span>}</td>
                  <td>{app.userName(p.owner)}</td>
                  <td className="num">{pr === null ? '—' : fmtPct(pr, 0)}</td>
                  <td className="small">{m ? `${m.due} ${m.title}` : '—'}</td>
                  <td className="num">{money(p.budget)}</td>
                  <td className="num">{money(spent(p))}</td>
                  <td className="num" style={{ color: variance < 0 ? 'var(--down)' : undefined }}>{money(variance)}</td>
                  <td className="num small"><BenefitCell p={p} /></td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={10} className="muted">No projects.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted">Variance is budget minus actual minus forecast to complete. Benefit is downtime hours a year: expected from the charter, realised measured from the data once the project closes.</p>
    </div>
  );
}

const order = (h: Health) => ({ late: 0, at_risk: 1, on_track: 2, closed: 3 })[h];

function useBenefit(p: Project | undefined) {
  const app = useApp();
  return useMemo(
    () => p && projectBenefit({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now, calendar: app.ds.calendar, timeZone: app.ds.site.timeZone }, p),
    [p, app.flags, app.now, app.ds, app.rules],
  );
}

function BenefitCell({ p }: { p: Project }) {
  const b = useBenefit(p);
  if (b) return <span title={b.provisional ? 'Fewer than 28 days since closing' : undefined}>{Math.round(b.hoursAvoidedPerYear).toLocaleString()} h/yr{b.provisional ? ' (early)' : ''}</span>;
  return <span className="muted">{p.expectedHoursPerYear ? `${p.expectedHoursPerYear.toLocaleString()} h/yr expected` : '—'}</span>;
}

function Count({ label, v, color }: { label: string; v: number; color?: string }) {
  return <div className="count"><div className="small muted">{label}</div><div style={{ fontSize: 22, fontWeight: 700, color: v ? color : undefined }}>{v}</div></div>;
}

// ---------- new ----------

function NewProject({ query }: { query: string }) {
  const app = useApp();
  const q = new URLSearchParams(query);
  const rca = app.rcas.find((r) => r.id === q.get('rca'));
  const unit = app.ds.assets.find((a) => a.id === q.get('unit'));
  const slice = q.get('q') ?? rca?.source.query ?? undefined;
  const [title, setTitle] = useState(rca ? rca.title : '');
  const [charter, setCharter] = useState(rca ? `${rca.problem}${rca.rootCause ? `\nRoot cause: ${rca.rootCause}` : ''}` : '');
  const [scope, setScope] = useState('');
  const [owner, setOwner] = useState(app.people.some((u) => u.id === app.actor.userId) ? app.actor.userId : app.people[0]?.id ?? '');
  const [start, setStart] = useState(today(app));
  const [end, setEnd] = useState(siteToday(app.now, app.ds.site.timeZone, 90));
  const [budget, setBudget] = useState('');
  const [expected, setExpected] = useState('');
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  if (!can(app.actor, 'run_projects')) return <p>Reliability engineers and superintendents create projects.</p>;
  const save = () => {
    const r = app.runImprove('projects', (ctx) => createProject(ctx, app.projects, {
      title, charter, scope, owner, start, end, budget: budget === '' ? NaN : Number(budget), benefitQuery: slice,
      expectedHoursPerYear: expected ? Number(expected) : undefined, valuePerDownHour: value ? Number(value) : undefined,
      links: { rcaIds: rca ? [rca.id] : [], unitIds: unit ? [unit.id] : [] },
    }, app.people.map((u) => u.id)));
    if (!r.ok) return setErrors(r.errors);
    window.location.hash = `#/projects/${(r.records.at(-1) as Project).id}`;
  };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="page-head"><h2>New project</h2><span className="muted small">It starts as an idea; the superintendent approves it.</span></div>
      <section className="card">
        <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label className="field"><span>Charter: the problem, the goal and why now</span><textarea rows={4} value={charter} onChange={(e) => setCharter(e.target.value)} /></label>
        <label className="field"><span>Scope: what is in and out</span><textarea rows={2} value={scope} onChange={(e) => setScope(e.target.value)} /></label>
        <div className="grid two">
          <label className="field"><span>Owner</span><select value={owner} onChange={(e) => setOwner(e.target.value)}>{app.people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="field"><span>Budget</span><input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
          <label className="field"><span>Start (site date)</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="field"><span>End (site date)</span><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          <label className="field"><span>Expected downtime avoided (h a year, optional)</span><input inputMode="decimal" value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
          <label className="field"><span>Value of one down hour (optional)</span><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></label>
        </div>
        {slice !== undefined
          ? <p className="small muted">The benefit is measured on <a href={analysisHref(slice)}>{describeQuery(slice, app.ds)}</a>: the 90 days before work starts against the time since it closes.</p>
          : <p className="small muted">No analysis slice, so the benefit will not be measured. Start the project from Downtime analysis or an RCA to measure it.</p>}
        <Errors list={errors} />
        <div className="row"><button className="btn primary" onClick={save}>Create project</button><a className="btn" style={linkBtn} href="#/projects">Cancel</a></div>
      </section>
    </div>
  );
}

// ---------- one project ----------

type Tab = 'overview' | 'tasks' | 'risks' | 'money' | 'report';
const TABS: Array<[Tab, string]> = [['overview', 'Overview'], ['tasks', 'Tasks'], ['risks', 'Risks and issues'], ['money', 'Budget'], ['report', 'Weekly report']];

function ProjectPage({ id, query }: { id: string; query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const p = app.projects.find((x) => x.id === id);
  const tab = (TABS.find(([k]) => k === new URLSearchParams(query).get('tab'))?.[0] ?? 'overview') as Tab;
  const [warnings, setWarnings] = useState<string[]>([]);
  if (!p) return <p>Project not found. <a href="#/projects">All projects</a></p>;
  const h = projectHealth(p, app.now, tz);
  const run: Run = (cmd) => {
    const r = app.runImprove('projects', cmd);
    if (!r.ok) return r.errors;
    setWarnings(r.warnings);
    return null;
  };
  return (
    <div className="stack">
      <div className="page-head">
        <h2>{p.title}</h2>
        <span className="muted">{PROJECT_STAGE_LABELS[p.stage]} · owner {app.userName(p.owner)} · {p.start} to {p.end}</span>
        {h.health !== 'closed' && <span className={`rag ${HEALTH_RAG[h.health]}`}>{HEALTH_LABELS[h.health]}</span>}
      </div>
      <p className="small"><a href="#/projects">All projects</a></p>
      <Gates p={p} run={run} />
      <Warnings list={warnings} />
      {h.reasons.length > 0 && <ul className="small" style={{ margin: 0 }}>{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <a key={k} role="tab" className="chip" aria-selected={tab === k} aria-pressed={tab === k} href={`#/projects/${p.id}?tab=${k}`} style={{ ...linkBtn, minHeight: 40 }}>{l}</a>)}
      </div>
      {tab === 'overview' && <Overview p={p} run={run} />}
      {tab === 'tasks' && <Tasks p={p} run={run} />}
      {tab === 'risks' && <Risks p={p} run={run} />}
      {tab === 'money' && <Money p={p} run={run} />}
      {tab === 'report' && <Report p={p} />}
    </div>
  );
}

type Run = (cmd: Parameters<ReturnType<typeof useApp>['runImprove']>[1]) => string[] | null;

const GATE_ACTION: Partial<Record<Project['stage'], { label: string; prompt: string; approve: boolean }>> = {
  idea: { label: 'Approve', prompt: 'Approval note (funding, conditions)', approve: true },
  approved: { label: 'Start work', prompt: 'Note (optional)', approve: false },
  in_progress: { label: 'Close project', prompt: 'Closing note: what was delivered', approve: false },
  closed: { label: 'Confirm benefits', prompt: 'What benefit was confirmed, and how', approve: true },
};

function Gates({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const next = GATE_ACTION[p.stage];
  const allowed = next && can(app.actor, next.approve ? 'approve_projects' : 'run_projects');
  const live = p.stage === 'idea' || p.stage === 'approved' || p.stage === 'in_progress';
  return (
    <section className="card">
      <ol className="gates">
        {STAGE_ORDER.map((s) => {
          const at = [...p.stages].reverse().find((x) => x.stage === s);
          const current = p.stage === s;
          return <li key={s} aria-current={current ? 'step' : undefined} className={at ? 'passed' : ''}><strong>{PROJECT_STAGE_LABELS[s]}</strong><span className="small muted">{at ? siteTime(at.at, tz, true) : ''}</span></li>;
        })}
      </ol>
      {p.stage === 'stopped' && <p className="small"><strong>Stopped:</strong> {p.stages.at(-1)?.note}</p>}
      <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        {next && allowed && <NoteButton label={next.label} prompt={next.prompt} onSubmit={(n) => run((ctx) => advanceStage(ctx, app.projects, p.id, n))} />}
        {next && !allowed && <span className="small muted">{next.approve ? `The superintendent can ${next.label.toLowerCase()}.` : `The owner can ${next.label.toLowerCase()}.`}</span>}
        {live && can(app.actor, 'approve_projects') && <NoteButton label="Stop project" danger prompt="Why stop it?" onSubmit={(n) => run((ctx) => stopProject(ctx, app.projects, p.id, n))} />}
        {!live && can(app.actor, 'approve_projects') && <NoteButton label="Reopen" prompt="Why reopen it?" onSubmit={(n) => run((ctx) => reopenProject(ctx, app.projects, p.id, n))} />}
      </div>
    </section>
  );
}

function Overview({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const b = useBenefit(p);
  const unit = (id: string) => app.ds.assets.find((a) => a.id === id)?.unitNumber ?? id;
  const history = app.audit.filter((x) => x.entity === 'project' && x.entityId === p.id);
  const edit = can(app.actor, 'run_projects') && (p.stage === 'idea' || p.stage === 'approved' || p.stage === 'in_progress');
  return (
    <>
      <div className="grid two">
        <section className="card">
          <h3>Charter</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{p.charter}</p>
          {p.scope && <><h4 style={{ marginBottom: 4 }}>Scope</h4><p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{p.scope}</p></>}
          <h4 style={{ marginBottom: 4 }}>Linked</h4>
          <ul className="small" style={{ marginTop: 0, paddingLeft: 18 }}>
            {p.links.unitIds.length > 0 && <li>Units: {p.links.unitIds.map((u, i) => <span key={u}>{i ? ', ' : ''}<a href={`#/unit/${u}`}>{unit(u)}</a></span>)}</li>}
            {p.links.rcaIds.map((r) => <li key={r}>RCA: <a href={`#/rca/${r}`}>{app.rcas.find((x) => x.id === r)?.title ?? r}</a></li>)}
            {p.links.actionIds.map((a) => <li key={a}>Action: <a href={`#/actions/${a}`}>{app.actions.find((x) => x.id === a)?.title ?? a}</a></li>)}
            {p.links.workOrders.length > 0 && <li>Work orders: {p.links.workOrders.join(', ')}</li>}
            {!p.links.unitIds.length && !p.links.rcaIds.length && !p.links.actionIds.length && !p.links.workOrders.length && <li className="muted">Nothing linked.</li>}
          </ul>
          {edit && <LinkEditor p={p} run={run} />}
        </section>
        <section className="card">
          <h3>Benefit</h3>
          {p.benefitQuery === undefined && <p className="small muted">No analysis slice is set, so the benefit is not measured.</p>}
          {p.benefitQuery !== undefined && <p className="small">Measured on <a href={analysisHref(p.benefitQuery)}>{describeQuery(p.benefitQuery, app.ds)}</a>.</p>}
          {p.expectedHoursPerYear !== undefined && <p className="small">Expected: {p.expectedHoursPerYear.toLocaleString()} down hours a year avoided{p.valuePerDownHour ? `, worth ${money(p.expectedHoursPerYear * p.valuePerDownHour)}` : ''}.</p>}
          {b ? (
            <table className="small">
              <tbody>
                <tr><td>Before work started (90 days)</td><td className="num">{b.baselineRate.toFixed(1)} down h per 1,000 h</td></tr>
                <tr><td>Since closing ({b.afterDays} days)</td><td className="num">{b.afterRate.toFixed(1)} down h per 1,000 h</td></tr>
                <tr><td>Hours avoided so far</td><td className="num">{Math.round(b.hoursAvoided).toLocaleString()} h</td></tr>
                <tr><td>At this rate, a year</td><td className="num"><strong>{Math.round(b.hoursAvoidedPerYear).toLocaleString()} h</strong></td></tr>
                {b.valueAvoided !== undefined && <tr><td>Value so far</td><td className="num">{money(b.valueAvoided)}</td></tr>}
              </tbody>
            </table>
          ) : p.benefitQuery !== undefined && <p className="small muted">Measured once the project closes: the 90 days before work started against the time since.</p>}
          {b?.provisional && <p className="small muted">Fewer than 28 days since closing, so this is an early reading.</p>}
          {b && <p className="small muted">Downtime during the project is left out. Other changes in the same period also count; check the events before confirming the benefit.</p>}
        </section>
      </div>
      <section className="card">
        <h3>Decisions</h3>
        {p.decisions.length ? <ul style={{ paddingLeft: 18 }}>{[...p.decisions].reverse().map((d) => <li key={d.id}>{d.text} <span className="small muted">({app.userName(d.by)}, {siteTime(d.at, tz, true)})</span></li>)}</ul> : <p className="small muted">No decisions logged.</p>}
        {edit && <NoteButton label="Log decision" prompt="The decision, and who made it" onSubmit={(n) => run((ctx) => logDecision(ctx, app.projects, p.id, n))} />}
      </section>
      <section className="card">
        <h3>Gate history</h3>
        <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
          {p.stages.map((s, i) => <li key={i}>{PROJECT_STAGE_LABELS[s.stage]} · {siteTime(s.at, tz, true)} · {app.userName(s.by)}{s.note ? `: ${s.note}` : ''}</li>)}
        </ul>
        <h4 style={{ marginBottom: 4 }}>Changes this session</h4>
        <History entries={history} userName={app.userName} tz={tz} fmt={siteTime} />
      </section>
    </>
  );
}

function LinkEditor({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState(p.links.unitIds);
  const [wos, setWos] = useState(p.links.workOrders.join(', '));
  const [acts, setActs] = useState(p.links.actionIds);
  const [errors, setErrors] = useState<string[] | null>(null);
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Change links</button>;
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <div className="card">
      <div className="field"><span>Units</span>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{app.ds.assets.map((a) => <label key={a.id} className="small"><input type="checkbox" checked={units.includes(a.id)} onChange={() => setUnits(toggle(units, a.id))} /> {a.unitNumber}</label>)}</div>
      </div>
      <div className="field"><span>Actions</span>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>{app.actions.map((a) => <label key={a.id} className="small"><input type="checkbox" checked={acts.includes(a.id)} onChange={() => setActs(toggle(acts, a.id))} /> {a.title}</label>)}</div>
      </div>
      <label className="field"><span>Work order numbers, comma separated</span><input value={wos} onChange={(e) => setWos(e.target.value)} /></label>
      <Errors list={errors} />
      <div className="row">
        <button className="btn primary" onClick={() => {
          const e = run((ctx) => editProject(ctx, app.projects, p.id, { links: { unitIds: units, actionIds: acts, workOrders: wos.split(',').map((x) => x.trim()).filter(Boolean) } }, app.people.map((u) => u.id)));
          if (e) setErrors(e); else setOpen(false);
        }}>Save links</button>
        <button className="btn" onClick={() => setOpen(false)}>Back</button>
      </div>
    </div>
  );
}

// ---------- tasks ----------

type TaskView = 'list' | 'board' | 'gantt';

function Tasks({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const [view, setView] = useState<TaskView>('list');
  const [editing, setEditing] = useState<ProjectTask | 'new' | null>(null);
  const manage = can(app.actor, 'run_projects') && (p.stage === 'idea' || p.stage === 'approved' || p.stage === 'in_progress');
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="chips">
          {(['list', 'board', 'gantt'] as TaskView[]).map((v) => <button key={v} className="chip" aria-pressed={view === v} onClick={() => setView(v)} style={{ minHeight: 40 }}>{v === 'list' ? 'List' : v === 'board' ? 'Board' : 'Gantt'}</button>)}
        </div>
        {manage && <button className="btn primary" onClick={() => setEditing('new')}>Add task</button>}
      </div>
      {editing && <TaskForm p={p} task={editing === 'new' ? null : editing} run={run} onDone={() => setEditing(null)} />}
      {view === 'list' && <TaskList p={p} run={run} onEdit={manage ? setEditing : undefined} />}
      {view === 'board' && <Board p={p} run={run} />}
      {view === 'gantt' && <Gantt p={p} />}
    </>
  );
}

function TaskButtons({ p, t, run }: { p: Project; t: ProjectTask; run: Run }) {
  const app = useApp();
  const manage = can(app.actor, 'run_projects');
  const mine = t.owner === app.actor.userId;
  const live = p.stage === 'approved' || p.stage === 'in_progress';
  const [err, setErr] = useState<string[] | null>(null);
  if (!live || (!manage && !mine)) return null;
  const set = (s: TaskStatus, note = '') => run((ctx) => setTaskStatus(ctx, app.projects, p.id, t.id, s, note));
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {t.status === 'not_started' && <button className="btn" style={{ minHeight: 34 }} onClick={() => setErr(set('in_progress'))}>Start</button>}
      {(t.status === 'not_started' || t.status === 'in_progress') && <button className="btn" style={{ minHeight: 34 }} onClick={() => setErr(set('done'))}>Done</button>}
      {manage && (t.status === 'not_started' || t.status === 'in_progress') && <NoteButton label="Cancel" danger prompt="Why cancel the task?" onSubmit={(n) => set('cancelled', n)} />}
      {manage && (t.status === 'done' || t.status === 'cancelled') && <button className="btn" style={{ minHeight: 34 }} onClick={() => setErr(set('not_started'))}>Reopen</button>}
      <Errors list={err} />
    </div>
  );
}

function TaskList({ p, run, onEdit }: { p: Project; run: Run; onEdit?: (t: ProjectTask) => void }) {
  const app = useApp();
  const t0 = today(app);
  const title = (id: string) => p.tasks.find((x) => x.id === id)?.title ?? id;
  const rows = [...p.tasks].sort((a, b) => a.start.localeCompare(b.start) || a.due.localeCompare(b.due));
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Task</th><th>Owner</th><th>Start</th><th>Due</th><th>Status</th><th>After</th><th /></tr></thead>
        <tbody>
          {rows.map((t) => {
            const late = (t.status === 'not_started' || t.status === 'in_progress') && t.due < t0;
            return (
              <tr key={t.id}>
                <td>{t.milestone ? '◆ ' : ''}{onEdit && t.status !== 'done' && t.status !== 'cancelled' ? <button className="linklike" onClick={() => onEdit(t)}>{t.title}</button> : t.title}{t.note ? <div className="small muted">{t.note}</div> : null}</td>
                <td>{app.userName(t.owner)}</td>
                <td>{t.start}</td>
                <td>{t.due}{late && <> <span className="rag red">Overdue</span></>}</td>
                <td>{TASK_STATUS_LABELS[t.status]}</td>
                <td className="small">{t.dependsOn.map(title).join(', ')}</td>
                <td><TaskButtons p={p} t={t} run={run} /></td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan={7} className="muted">No tasks yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Board({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const cols: TaskStatus[] = ['not_started', 'in_progress', 'done', 'cancelled'];
  return (
    <div className="board-cols">
      {cols.map((c) => (
        <section key={c} className="card">
          <h4 style={{ marginTop: 0 }}>{TASK_STATUS_LABELS[c]} ({p.tasks.filter((t) => t.status === c).length})</h4>
          {p.tasks.filter((t) => t.status === c).sort((a, b) => a.due.localeCompare(b.due)).map((t) => (
            <div key={t.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
              <div><strong>{t.milestone ? '◆ ' : ''}{t.title}</strong></div>
              <div className="small muted">{app.userName(t.owner)} · due {t.due}</div>
              <TaskButtons p={p} t={t} run={run} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Bars from start to due on a day scale, with today and the project end marked. */
function Gantt({ p }: { p: Project }) {
  const app = useApp();
  const t0 = today(app);
  const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 864e5;
  const tasks = [...p.tasks].filter((t) => t.status !== 'cancelled').sort((a, b) => a.start.localeCompare(b.start));
  if (!tasks.length) return <p className="muted">No tasks yet.</p>;
  const from = Math.min(day(p.start), ...tasks.map((t) => day(t.start)));
  const to = Math.max(day(p.end), ...tasks.map((t) => day(t.due))) + 1;
  const pct = (d: number) => `${((d - from) / (to - from)) * 100}%`;
  const color: Record<TaskStatus, string> = { not_started: 'var(--stale)', in_progress: 'var(--brand)', done: 'var(--run)', cancelled: 'var(--border)' };
  return (
    <section className="card">
      <div className="gantt">
        {tasks.map((t) => {
          const late = t.status !== 'done' && t.due < t0;
          return (
            <div key={t.id} className="gantt-row">
              <div className="gantt-label small" title={t.title}>{t.milestone ? '◆ ' : ''}{t.title}</div>
              <div className="gantt-track">
                <div className="gantt-bar" style={{ left: pct(day(t.start)), width: `calc(${pct(day(t.due) + 1)} - ${pct(day(t.start))})`, background: color[t.status], outline: late ? '2px solid var(--down)' : undefined }} title={`${t.start} to ${t.due} · ${TASK_STATUS_LABELS[t.status]}`} />
                <div className="gantt-mark" style={{ left: pct(day(t0)) }} />
                <div className="gantt-mark end" style={{ left: pct(day(p.end) + 1) }} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="small muted">Blue in progress, green done, grey not started; a red outline is overdue. The solid line is today and the dashed line is the project end.</p>
    </section>
  );
}

function TaskForm({ p, task, run, onDone }: { p: Project; task: ProjectTask | null; run: Run; onDone: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState(task?.title ?? '');
  const [owner, setOwner] = useState(task?.owner ?? app.people[0]?.id ?? '');
  const [start, setStart] = useState(task?.start ?? (today(app) > p.start ? today(app) : p.start));
  const [due, setDue] = useState(task?.due ?? p.end);
  const [milestone, setMilestone] = useState(task?.milestone ?? false);
  const [deps, setDeps] = useState<string[]>(task?.dependsOn ?? []);
  const [errors, setErrors] = useState<string[] | null>(null);
  const save = () => {
    const input = { title, owner, start, due, milestone, dependsOn: deps };
    const ids = app.people.map((u) => u.id);
    const e = run((ctx) => (task ? editTask(ctx, app.projects, p.id, task.id, input, ids) : addTask(ctx, app.projects, p.id, input, ids)));
    if (e) setErrors(e); else onDone();
  };
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>{task ? 'Change task' : 'Add task'}</h3>
      <label className="field"><span>Task</span><input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
      <div className="grid two">
        <label className="field"><span>Owner</span><select value={owner} onChange={(e) => setOwner(e.target.value)}>{app.people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>Milestone</span><span><input type="checkbox" checked={milestone} onChange={(e) => setMilestone(e.target.checked)} /> Show in the portfolio as a milestone</span></label>
        <label className="field"><span>Start</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="field"><span>Due</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      </div>
      {p.tasks.filter((t) => t.id !== task?.id).length > 0 && (
        <div className="field"><span>Starts after</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {p.tasks.filter((t) => t.id !== task?.id && t.status !== 'cancelled').map((t) => <label key={t.id} className="small"><input type="checkbox" checked={deps.includes(t.id)} onChange={() => setDeps(deps.includes(t.id) ? deps.filter((x) => x !== t.id) : [...deps, t.id])} /> {t.title}</label>)}
          </div>
        </div>
      )}
      <Errors list={errors} />
      <div className="row"><button className="btn primary" onClick={save}>{task ? 'Save' : 'Add task'}</button><button className="btn" onClick={onDone}>Back</button></div>
    </section>
  );
}

// ---------- risks ----------

function Risks({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [adding, setAdding] = useState(false);
  const manage = can(app.actor, 'run_projects') && (p.stage === 'idea' || p.stage === 'approved' || p.stage === 'in_progress');
  const rows = [...p.risks].sort((a, b) => (a.status === b.status ? b.likelihood * b.impact - a.likelihood * a.impact : a.status === 'open' ? -1 : 1));
  return (
    <>
      {manage && <div><button className="btn primary" onClick={() => setAdding(true)}>Add risk or issue</button></div>}
      {adding && <RiskForm p={p} run={run} onDone={() => setAdding(false)} />}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Type</th><th>Description</th><th className="num">Score</th><th>Owner</th><th>Mitigation</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const score = r.likelihood * r.impact;
              return (
                <tr key={r.id}>
                  <td>{r.kind === 'issue' ? 'Issue' : 'Risk'}</td>
                  <td>{r.text}<div className="small muted">Raised {siteTime(r.raisedAt, tz, true)}</div></td>
                  <td className="num"><span className={`rag ${score >= 6 || r.kind === 'issue' ? 'red' : score >= 3 ? 'amber' : 'green'}`}>{r.likelihood}×{r.impact}</span></td>
                  <td>{app.userName(r.owner)}</td>
                  <td className="small">{r.mitigation ?? '—'}</td>
                  <td>{r.status === 'open' ? 'Open' : <>Closed<div className="small muted">{r.closeNote}</div></>}</td>
                  <td>{manage && r.status === 'open' && <NoteButton label="Close" prompt="How was it dealt with?" onSubmit={(n) => run((ctx) => closeRisk(ctx, app.projects, p.id, r.id, n))} />}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="muted">Nothing recorded.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted">Score is likelihood × impact, each 1 to 3. An open issue, or a risk scoring 6 or more, puts the project at risk.</p>
    </>
  );
}

function RiskForm({ p, run, onDone }: { p: Project; run: Run; onDone: () => void }) {
  const app = useApp();
  const [kind, setKind] = useState<'risk' | 'issue'>('risk');
  const [text, setText] = useState('');
  const [likelihood, setL] = useState<1 | 2 | 3>(2);
  const [impact, setI] = useState<1 | 2 | 3>(2);
  const [owner, setOwner] = useState(p.owner);
  const [mitigation, setM] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  return (
    <section className="card">
      <div className="grid two">
        <label className="field"><span>Type</span><select value={kind} onChange={(e) => setKind(e.target.value as 'risk' | 'issue')}><option value="risk">Risk (might happen)</option><option value="issue">Issue (happening now)</option></select></label>
        <label className="field"><span>Owner</span><select value={owner} onChange={(e) => setOwner(e.target.value)}>{app.people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        {kind === 'risk' && <label className="field"><span>Likelihood</span><select value={likelihood} onChange={(e) => setL(Number(e.target.value) as 1 | 2 | 3)}><option value={1}>1 Low</option><option value={2}>2 Medium</option><option value={3}>3 High</option></select></label>}
        <label className="field"><span>Impact</span><select value={impact} onChange={(e) => setI(Number(e.target.value) as 1 | 2 | 3)}><option value={1}>1 Low</option><option value={2}>2 Medium</option><option value={3}>3 High</option></select></label>
      </div>
      <label className="field"><span>Description</span><input value={text} onChange={(e) => setText(e.target.value)} /></label>
      <label className="field"><span>Mitigation (optional)</span><input value={mitigation} onChange={(e) => setM(e.target.value)} /></label>
      <Errors list={errors} />
      <div className="row">
        <button className="btn primary" onClick={() => { const e = run((ctx) => addRisk(ctx, app.projects, p.id, { kind, text, likelihood, impact, owner, mitigation }, app.people.map((u) => u.id))); if (e) setErrors(e); else onDone(); }}>Add</button>
        <button className="btn" onClick={onDone}>Back</button>
      </div>
    </section>
  );
}

// ---------- money ----------

function Money({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const manage = can(app.actor, 'run_projects') && (p.stage === 'idea' || p.stage === 'approved' || p.stage === 'in_progress');
  const actual = spent(p);
  const variance = p.budget - actual - p.forecastToComplete;
  const [cost, setCost] = useState({ date: today(app), amount: '', text: '', reference: '' });
  const [costErr, setCostErr] = useState<string[] | null>(null);
  const [forecast, setForecast] = useState(String(p.forecastToComplete));
  const [cr, setCr] = useState({ text: '', budget: '', end: '' });
  const [crErr, setCrErr] = useState<string[] | null>(null);
  return (
    <>
      <div className="grid kpis">
        <Tile label="Budget" v={money(p.budget)} />
        <Tile label="Actual" v={money(actual)} sub={p.budget ? `${fmtPct(actual / p.budget, 0)} of budget` : ''} />
        <Tile label="Forecast to complete" v={money(p.forecastToComplete)} />
        <Tile label="Variance" v={money(variance)} sub={variance < 0 ? 'Over budget' : 'Under or on budget'} warn={variance < 0} />
      </div>
      <div className="grid two">
        <section className="card">
          <h3>Costs</h3>
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>Date</th><th>For</th><th>Reference</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {[...p.costs].sort((a, b) => b.date.localeCompare(a.date)).map((c) => <tr key={c.id}><td>{c.date}</td><td>{c.text}<div className="muted">{app.userName(c.enteredBy)}</div></td><td>{c.reference ?? ''}</td><td className="num">{money(c.amount)}</td></tr>)}
                {!p.costs.length && <tr><td colSpan={4} className="muted">No costs yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {manage && (
            <>
              <h4>Add a cost</h4>
              <div className="grid two">
                <label className="field"><span>Date</span><input type="date" value={cost.date} onChange={(e) => setCost({ ...cost, date: e.target.value })} /></label>
                <label className="field"><span>Amount (negative to reverse)</span><input inputMode="decimal" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} /></label>
                <label className="field"><span>For</span><input value={cost.text} onChange={(e) => setCost({ ...cost, text: e.target.value })} /></label>
                <label className="field"><span>WO or PO number</span><input value={cost.reference} onChange={(e) => setCost({ ...cost, reference: e.target.value })} /></label>
              </div>
              <Errors list={costErr} />
              <button className="btn" onClick={() => {
                const e = run((ctx) => addCost(ctx, app.projects, p.id, { date: cost.date, amount: cost.amount === '' ? NaN : Number(cost.amount), text: cost.text, reference: cost.reference }));
                setCostErr(e);
                if (!e) setCost({ ...cost, amount: '', text: '', reference: '' });
              }}>Add cost</button>
              <h4>Forecast to complete</h4>
              <div className="row">
                <input inputMode="decimal" value={forecast} onChange={(e) => setForecast(e.target.value)} style={{ minHeight: 44, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }} />
                <button className="btn" disabled={Number(forecast) === p.forecastToComplete} onClick={() => setCostErr(run((ctx) => editProject(ctx, app.projects, p.id, { forecastToComplete: Number(forecast) }, app.people.map((u) => u.id))))}>Update forecast</button>
              </div>
              <p className="small muted">Costs are never edited. Reverse a wrong entry with a negative amount.</p>
            </>
          )}
        </section>
        <section className="card">
          <h3>Change requests</h3>
          <p className="small muted">{p.stage === 'idea' ? 'While the project is an idea, change the budget and dates directly on the project.' : 'After approval, the budget and end date change only through a change request that the superintendent decides.'}</p>
          {p.changes.map((c) => (
            <div key={c.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
              <div><strong>{c.status === 'proposed' ? 'Waiting' : c.status === 'approved' ? 'Approved' : 'Rejected'}</strong>: {c.text}</div>
              <div className="small muted">{[c.budget !== undefined ? `Budget ${money(p.budget)} → ${money(c.budget)}` : '', c.end ? `End → ${c.end}` : ''].filter(Boolean).join(' · ')} · raised by {app.userName(c.raisedBy)} {siteTime(c.raisedAt, tz, true)}</div>
              {c.decisionNote && <div className="small">{app.userName(c.decidedBy ?? '')}: {c.decisionNote}</div>}
              {c.status === 'proposed' && can(app.actor, 'approve_projects') && (p.stage === 'approved' || p.stage === 'in_progress') && (
                <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  <NoteButton label="Approve" prompt="Note (optional)" onSubmit={(n) => run((ctx) => decideChange(ctx, app.projects, p.id, c.id, true, n))} />
                  <NoteButton label="Reject" danger prompt="Why reject it?" onSubmit={(n) => run((ctx) => decideChange(ctx, app.projects, p.id, c.id, false, n))} />
                </div>
              )}
            </div>
          ))}
          {manage && p.stage !== 'idea' && (
            <>
              <h4>Propose a change</h4>
              <label className="field"><span>Why</span><input value={cr.text} onChange={(e) => setCr({ ...cr, text: e.target.value })} /></label>
              <div className="grid two">
                <label className="field"><span>New budget (optional)</span><input inputMode="decimal" value={cr.budget} onChange={(e) => setCr({ ...cr, budget: e.target.value })} /></label>
                <label className="field"><span>New end date (optional)</span><input type="date" value={cr.end} onChange={(e) => setCr({ ...cr, end: e.target.value })} /></label>
              </div>
              <Errors list={crErr} />
              <button className="btn" onClick={() => {
                const e = run((ctx) => proposeChange(ctx, app.projects, p.id, { text: cr.text, budget: cr.budget === '' ? undefined : Number(cr.budget), end: cr.end || undefined }));
                setCrErr(e);
                if (!e) setCr({ text: '', budget: '', end: '' });
              }}>Propose change</button>
            </>
          )}
          {manage && p.stage === 'idea' && <IdeaBudget p={p} run={run} />}
        </section>
      </div>
    </>
  );
}

function IdeaBudget({ p, run }: { p: Project; run: Run }) {
  const app = useApp();
  const [budget, setBudget] = useState(String(p.budget));
  const [start, setStart] = useState(p.start);
  const [end, setEnd] = useState(p.end);
  const [err, setErr] = useState<string[] | null>(null);
  return (
    <>
      <div className="grid two">
        <label className="field"><span>Budget</span><input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
        <span />
        <label className="field"><span>Start</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="field"><span>End</span><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <Errors list={err} />
      <button className="btn" onClick={() => setErr(run((ctx) => editProject(ctx, app.projects, p.id, { budget: Number(budget), start, end }, app.people.map((u) => u.id))))}>Save budget and dates</button>
    </>
  );
}

function Tile({ label, v, sub, warn }: { label: string; v: string; sub?: string; warn?: boolean }): ReactNode {
  return <div className="card kpi"><div className="label">{label}</div><div className="value" style={{ color: warn ? 'var(--down)' : undefined }}>{v}</div>{sub && <div className="sub">{sub}</div>}</div>;
}

// ---------- weekly report ----------

function Report({ p }: { p: Project }) {
  const app = useApp();
  const text = statusReport(p, app.now, app.ds.site.timeZone, app.userName, money);
  const [copied, setCopied] = useState(false);
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Weekly status</h3>
        <div className="row">
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy text'}</button>
          <button className="btn" onClick={() => window.print()}>Print or save PDF</button>
        </div>
      </div>
      <pre className="report">{text}</pre>
      <p className="small muted">Built from the project as it stands now, in site time. Paste it into an email or the weekly meeting notes.</p>
    </section>
  );
}
