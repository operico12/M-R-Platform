// Improvement actions (phase 2): who does what by when, raised from an
// analysis, a unit, a flag or an RCA, and the downtime on the same slice
// before and after the action was done.

import {
  ACTION_STATUS_LABELS, EMPTY_FILTER, actionCounts, actionEffect, effectVerdict, can, cancelAction, changeAction, completeAction, createAction,
  filterToQuery, isOverdue, reopenAction, siteToday, startAction, type ActionSource, type ImprovementAction,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtHours, fmtPct, siteTime } from '../format';
import { analysisHref, describeQuery } from '../improve/describe';
import { Errors, History, NoteButton, Warnings } from '../improve/ui';
import { useApp } from '../store';

type View = 'open' | 'overdue' | 'mine' | 'done' | 'all';
const VIEWS: Array<[View, string]> = [['open', 'Open'], ['overdue', 'Overdue'], ['mine', 'Mine'], ['done', 'Done'], ['all', 'All']];

export function Actions({ arg, query }: { arg?: string; query: string }) {
  if (arg === 'new') return <NewAction query={query} />;
  if (arg) return <ActionPage id={arg} />;
  return <ActionList query={query} />;
}

function ActionList({ query }: { query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const q = new URLSearchParams(query);
  const view = (VIEWS.find(([k]) => k === q.get('view'))?.[0] ?? 'open') as View;
  const counts = actionCounts(app.actions, app.now, tz);
  const mine = app.actions.filter((a) => a.owner === app.actor.userId && (a.status === 'open' || a.status === 'in_progress')).length;
  const rows = app.actions
    .filter((a) => {
      const live = a.status === 'open' || a.status === 'in_progress';
      if (view === 'open') return live;
      if (view === 'overdue') return isOverdue(a, app.now, tz);
      if (view === 'mine') return live && a.owner === app.actor.userId;
      if (view === 'done') return a.status === 'done';
      return true;
    })
    .sort((x, y) => x.due.localeCompare(y.due));

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Actions</h2>
        <span className="muted small">Raise an action from Downtime analysis, a unit page or an RCA, so its effect can be measured on the same slice.</span>
      </div>
      <div className="counts">
        <Count label="Open" v={counts.open} />
        <Count label="Overdue" v={counts.overdue} warn={counts.overdue > 0} />
        <Count label="Mine" v={mine} />
        <Count label="Done" v={counts.done} />
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="chips" role="tablist">
          {VIEWS.map(([k, l]) => <a key={k} className="chip" role="tab" aria-selected={view === k} aria-pressed={view === k} href={`#/actions?view=${k}`} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', minHeight: 40 }}>{l}</a>)}
        </div>
        {can(app.actor, 'create_actions') && <a className="btn primary" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href="#/actions/new?src=manual">New action</a>}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>Status</th><th>For</th><th className="num">Effect</th></tr></thead>
          <tbody>
            {rows.map((a) => <ActionRow key={a.id} a={a} />)}
            {!rows.length && <tr><td colSpan={6} className="muted">Nothing here.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function useEffectOf(a: ImprovementAction | undefined) {
  const app = useApp();
  return useMemo(
    () => a && actionEffect({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now, calendar: app.ds.calendar, timeZone: app.ds.site.timeZone }, a),
    [a, app.flags, app.now, app.ds, app.rules],
  );
}

function ActionRow({ a }: { a: ImprovementAction }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const e = useEffectOf(a);
  const late = isOverdue(a, app.now, tz);
  return (
    <tr>
      <td><a href={`#/actions/${a.id}`}>{a.title}</a></td>
      <td>{app.userName(a.owner)}</td>
      <td>{a.due}{late && <> <span className="rag red">Overdue</span></>}</td>
      <td>{ACTION_STATUS_LABELS[a.status]}</td>
      <td className="small">{a.source.label}</td>
      <td className="num">{e ? <EffectWord e={e} /> : '—'}</td>
    </tr>
  );
}

function EffectWord({ e }: { e: NonNullable<ReturnType<typeof actionEffect>> }) {
  const v = effectVerdict(e);
  if (v === 'too_early') return <span className="muted small">Too early</span>;
  if (v === 'no_baseline') return <span className="muted small">No downtime before</span>;
  const pct = `${e.downChange! > 0 ? '+' : ''}${fmtPct(e.downChange, 0)} down h`;
  if (v === 'no_clear_change') return <span className="rag amber" title="Within 10% either way">No clear change ({pct})</span>;
  return <span className={`rag ${v === 'better' ? 'green' : 'red'}`}>{pct}</span>;
}

function Count({ label, v, warn }: { label: string; v: number; warn?: boolean }) {
  return <div className="count"><div className="small muted">{label}</div><div style={{ fontSize: 22, fontWeight: 700, color: warn ? 'var(--down)' : undefined }}>{v}</div></div>;
}

// ---------- new ----------

function sourceFrom(query: string, app: ReturnType<typeof useApp>): ActionSource {
  const q = new URLSearchParams(query);
  const kind = (q.get('src') ?? 'manual') as ActionSource['kind'];
  const unitId = q.get('unit') ?? undefined;
  const unit = app.ds.assets.find((a) => a.id === unitId);
  if (kind === 'rca') {
    const r = app.rcas.find((x) => x.id === q.get('rca'));
    return { kind, rcaId: r?.id, query: r?.source.query, label: r ? `RCA: ${r.title}` : 'RCA' };
  }
  if ((kind === 'unit' || kind === 'flag') && unit) {
    return { kind, unitId: unit.id, flagId: q.get('flag') ?? undefined, query: filterToQuery({ ...EMPTY_FILTER, units: [unit.id] }), label: kind === 'flag' ? `${unit.unitNumber} down flag` : unit.unitNumber };
  }
  if (kind === 'analysis') {
    const query = q.get('q') ?? '';
    return { kind, query, label: describeQuery(query, app.ds) };
  }
  return { kind: 'manual', label: '' };
}

function NewAction({ query }: { query: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const source = useMemo(() => sourceFrom(query, app), [query]);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [owner, setOwner] = useState(app.people.some((u) => u.id === app.actor.userId) ? app.actor.userId : app.people[0]?.id ?? '');
  const [due, setDue] = useState(siteToday(app.now, tz, 14));
  const [label, setLabel] = useState(source.label);
  const [errors, setErrors] = useState<string[] | null>(null);
  if (!can(app.actor, 'create_actions')) return <p>Your role cannot raise actions. Supervisors, reliability engineers and superintendents can.</p>;

  const save = () => {
    const r = app.runImprove('actions', (ctx) => createAction(ctx, app.actions, { title, detail, owner, due, source: { ...source, label: label.trim() } }, app.people.map((u) => u.id)));
    if (!r.ok) return setErrors(r.errors);
    const created = r.records.at(-1) as ImprovementAction;
    window.location.hash = `#/actions/${created.id}`;
  };

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="page-head"><h2>New action</h2></div>
      <section className="card">
        <label className="field"><span>What needs doing</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: add hose clamp check to the 500 h PM" autoFocus /></label>
        <label className="field"><span>Detail (optional)</span><textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
        <div className="grid two">
          <label className="field"><span>Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>{app.people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          </label>
          <label className="field"><span>Due (site date)</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
        <label className="field"><span>For</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="What problem this tackles" /></label>
        {source.query !== undefined
          ? <p className="small muted">The effect is measured on this slice: <a href={analysisHref(source.query)}>{describeQuery(source.query, app.ds)}</a>. Date range is ignored; the windows are set by when the action is done.</p>
          : <p className="small muted">Raised without a slice, so its effect is not measured. Raise it from Downtime analysis or a unit page to measure it.</p>}
        <Errors list={errors} />
        <div className="row"><button className="btn primary" onClick={save}>Raise action</button><a className="btn" href="#/actions" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Cancel</a></div>
      </section>
    </div>
  );
}

// ---------- one action ----------

function ActionPage({ id }: { id: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const a = app.actions.find((x) => x.id === id);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const e = useEffectOf(a);
  if (!a) return <p>Action not found. <a href="#/actions">All actions</a></p>;
  const manage = can(app.actor, 'create_actions');
  const owner = a.owner === app.actor.userId;
  const closed = a.status === 'done' || a.status === 'cancelled';
  const run = (cmd: Parameters<typeof app.runImprove>[1]) => {
    const r = app.runImprove('actions', cmd);
    if (!r.ok) return r.errors;
    setWarnings(r.warnings);
    return null;
  };
  const rca = a.source.rcaId ? app.rcas.find((r) => r.id === a.source.rcaId) : undefined;
  const history = app.audit.filter((x) => x.entity === 'action' && x.entityId === a.id);

  return (
    <div className="stack">
      <div className="page-head">
        <h2>{a.title}</h2>
        <span className="muted">{ACTION_STATUS_LABELS[a.status]} · owner {app.userName(a.owner)} · due {a.due}</span>
        {isOverdue(a, app.now, tz) && <span className="rag red">Overdue</span>}
      </div>
      <p className="small"><a href="#/actions">All actions</a></p>
      <Warnings list={warnings} />

      <div className="grid two">
        <section className="card">
          <h3>Details</h3>
          {a.detail && <p>{a.detail}</p>}
          <dl className="small" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
            <dt className="muted">For</dt>
            <dd style={{ margin: 0 }}>{rca ? <a href={`#/rca/${rca.id}`}>{a.source.label}</a> : a.source.unitId ? <a href={`#/unit/${a.source.unitId}`}>{a.source.label}</a> : a.source.label}</dd>
            {a.source.query !== undefined && <><dt className="muted">Slice</dt><dd style={{ margin: 0 }}><a href={analysisHref(a.source.query)}>{describeQuery(a.source.query, app.ds)}</a></dd></>}
            <dt className="muted">Raised</dt><dd style={{ margin: 0 }}>{siteTime(a.createdAt, tz, true)} by {app.userName(a.createdBy)}</dd>
            {a.startedAt && <><dt className="muted">Started</dt><dd style={{ margin: 0 }}>{siteTime(a.startedAt, tz, true)}</dd></>}
            {a.doneAt && <><dt className="muted">Done</dt><dd style={{ margin: 0 }}>{siteTime(a.doneAt, tz, true)}: {a.doneNote}</dd></>}
            {a.cancelReason && <><dt className="muted">Cancelled</dt><dd style={{ margin: 0 }}>{a.cancelledAt ? siteTime(a.cancelledAt, tz, true) : ''}: {a.cancelReason}</dd></>}
          </dl>
          <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            {a.status === 'open' && (manage || owner) && <button className="btn" onClick={() => run((ctx) => startAction(ctx, app.actions, a.id))}>Start</button>}
            {!closed && (manage || owner) && <NoteButton label="Mark done" prompt="What was done?" onSubmit={(n) => run((ctx) => completeAction(ctx, app.actions, a.id, n))} />}
            {!closed && manage && <button className="btn" onClick={() => setEditing(true)}>Change</button>}
            {!closed && manage && <NoteButton label="Cancel action" danger prompt="Why is it no longer needed?" onSubmit={(n) => run((ctx) => cancelAction(ctx, app.actions, a.id, n))} />}
            {closed && manage && <NoteButton label="Reopen" prompt="Why reopen it?" onSubmit={(n) => run((ctx) => reopenAction(ctx, app.actions, a.id, n))} />}
          </div>
          {!manage && !owner && <p className="small muted">Only the owner, or a supervisor, reliability engineer or superintendent, can update it.</p>}
          {editing && <ChangeForm a={a} onDone={() => setEditing(false)} />}
        </section>

        <section className="card">
          <h3>Before and after</h3>
          {e && e.days < 1 ? (
            <p className="small muted">Done {siteTime(a.doneAt!, tz, true)}. The before-and-after view starts filling after the first day and is judged after 7 days.</p>
          ) : !e ? (
            <p className="small muted">{a.status === 'done' ? 'Raised without a slice, so there is nothing to measure.' : 'Measured once the action is done: downtime on the slice in equal windows either side of the done date.'}</p>
          ) : (
            <>
              <p className="small muted">Matching downtime in {e.days} days either side of {siteTime(a.doneAt!, tz, true)}, per 1,000 calendar hours so the windows compare. {e.enough ? '' : 'Less than 7 days since it was done, so it is too early to judge.'}</p>
              <div style={{ height: 200 }}>
                <ResponsiveContainer>
                  <BarChart data={[{ w: 'Before', v: round1(e.before.downPer1000) }, { w: 'After', v: round1(e.after.downPer1000) }]} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="w" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                    <YAxis tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                    <Tooltip formatter={(v: number) => [`${v} h per 1,000 h`, 'Down']} />
                    <Bar dataKey="v" name="Down h per 1,000 h" fill="var(--brand)" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="small">
                <thead><tr><th /><th className="num">Before</th><th className="num">After</th></tr></thead>
                <tbody>
                  <tr><td>Matching downtime</td><td className="num">{fmtHours(e.before.downHours)}</td><td className="num">{fmtHours(e.after.downHours)}</td></tr>
                  <tr><td>Failures</td><td className="num">{e.before.failures}</td><td className="num">{e.after.failures}</td></tr>
                  <tr><td>PA of the units</td><td className="num">{fmtPct(e.before.pa)}</td><td className="num">{fmtPct(e.after.pa)}</td></tr>
                </tbody>
              </table>
              <p className="small">Change in downtime rate: <EffectWord e={e} /></p>
              <p className="small muted">A drop is a signal, not proof: other changes in the same weeks also count. Check the events on the <a href={analysisHref(a.source.query)}>analysis page</a>.</p>
            </>
          )}
        </section>
      </div>

      <section className="card">
        <h3>History</h3>
        <History entries={history} userName={app.userName} tz={tz} fmt={siteTime} />
      </section>
    </div>
  );
}

const round1 = (x: number | null) => (x === null ? 0 : Math.round(x * 10) / 10);

function ChangeForm({ a, onDone }: { a: ImprovementAction; onDone: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState(a.title);
  const [owner, setOwner] = useState(a.owner);
  const [due, setDue] = useState(a.due);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const save = () => {
    const r = app.runImprove('actions', (ctx) => changeAction(ctx, app.actions, a.id, { title, owner, due, reason }, app.people.map((u) => u.id)));
    if (!r.ok) return setErrors(r.errors);
    onDone();
  };
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="grid two">
        <label className="field"><span>Owner</span><select value={owner} onChange={(e) => setOwner(e.target.value)}>{app.people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="field"><span>Due</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      </div>
      <label className="field"><span>Reason (needed to move the date or owner)</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <Errors list={errors} />
      <div className="row"><button className="btn primary" onClick={save}>Save</button><button className="btn" onClick={onDone}>Back</button></div>
    </div>
  );
}
