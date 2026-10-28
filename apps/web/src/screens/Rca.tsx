// Root cause analysis (phase 2): problem statement, 5-Why chain, fishbone,
// root cause, and the actions raised from it. Nothing is deleted: an RCA is
// closed with a root cause or cancelled with a reason, and can be reopened.

import {
  EMPTY_FILTER, FISHBONE, analyse, can, cancelRca, closeRca, editRca, filterFromQuery, filterToQuery, flagSystem, rcaActions, reopenRca, startRca,
  ACTION_STATUS_LABELS, type ActionSource, type FishboneCategory, type Rca,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { fmtHours, siteTime } from '../format';
import { analysisHref, describeQuery, newHref } from '../improve/describe';
import { Errors, History, NoteButton, Warnings } from '../improve/ui';
import { useApp } from '../store';

const STATUS: Record<Rca['status'], string> = { open: 'Open', closed: 'Closed', cancelled: 'Cancelled' };
const linkBtn = { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' } as const;

export function RcaScreen({ arg, query }: { arg?: string; query: string }) {
  if (arg === 'new') return <NewRca query={query} />;
  if (arg) return <RcaPage id={arg} />;
  return <RcaList />;
}

function RcaList() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const rows = [...app.rcas].sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) || y.updatedAt.localeCompare(x.updatedAt));
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Root cause analysis</h2>
        <span className="muted small">Start one from a unit page or Downtime analysis so the events come with it.</span>
      </div>
      {can(app.actor, 'run_rcas') && <div><a className="btn primary" style={linkBtn} href="#/rca/new?src=manual">New RCA</a></div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Title</th><th>Lead</th><th>Status</th><th>For</th><th>Root cause</th><th className="num">Actions</th><th>Updated</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const acts = rcaActions(r, app.actions);
              return (
                <tr key={r.id}>
                  <td><a href={`#/rca/${r.id}`}>{r.title}</a></td>
                  <td>{app.userName(r.lead)}</td>
                  <td>{STATUS[r.status]}</td>
                  <td className="small">{r.source.label}</td>
                  <td className="small">{r.rootCause ?? <span className="muted">Not yet</span>}</td>
                  <td className="num">{acts.filter((a) => a.status === 'done').length}/{acts.filter((a) => a.status !== 'cancelled').length}</td>
                  <td>{siteTime(r.updatedAt, tz, true)}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="muted">No analyses yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sourceFrom(query: string, app: ReturnType<typeof useApp>): ActionSource {
  const q = new URLSearchParams(query);
  const kind = q.get('src');
  const unit = app.ds.assets.find((a) => a.id === q.get('unit'));
  if ((kind === 'unit' || kind === 'flag') && unit) return { kind, unitId: unit.id, flagId: q.get('flag') ?? undefined, query: filterToQuery({ ...EMPTY_FILTER, units: [unit.id], range: { preset: '90d' } }), label: unit.unitNumber };
  if (kind === 'analysis') { const s = q.get('q') ?? ''; return { kind, query: s, label: describeQuery(s, app.ds) }; }
  return { kind: 'manual', label: 'Manual' };
}

function NewRca({ query }: { query: string }) {
  const app = useApp();
  const source = useMemo(() => sourceFrom(query, app), [query]);
  const leads = app.people.filter((u) => u.role === 'reliability_engineer' || u.role === 'superintendent');
  const [title, setTitle] = useState(source.kind === 'manual' ? '' : `${source.label}: `);
  const [problem, setProblem] = useState('');
  const [lead, setLead] = useState(leads.some((u) => u.id === app.actor.userId) ? app.actor.userId : leads[0]?.id ?? '');
  const [errors, setErrors] = useState<string[] | null>(null);
  if (!can(app.actor, 'run_rcas')) return <p>Reliability engineers and superintendents lead root cause analyses. You can raise an action instead.</p>;
  const flagIds = new URLSearchParams(query).get('flag');
  const save = () => {
    const r = app.runImprove('rcas', (ctx) => startRca(ctx, app.rcas, { title, problem, source, lead, flagIds: flagIds ? [flagIds] : [] }, leads.map((u) => u.id)));
    if (!r.ok) return setErrors(r.errors);
    window.location.hash = `#/rca/${(r.records.at(-1) as Rca).id}`;
  };
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div className="page-head"><h2>New root cause analysis</h2></div>
      <section className="card">
        <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label className="field"><span>Problem statement: what, where, when, how big</span>
          <textarea rows={3} value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="For example: HT107 hoist hose burst three times in six weeks, 31 h down, all on the night shift" /></label>
        <label className="field"><span>Lead</span><select value={lead} onChange={(e) => setLead(e.target.value)}>{leads.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        {source.query !== undefined && <p className="small muted">Events come from <a href={analysisHref(source.query)}>{describeQuery(source.query, app.ds)}</a>.</p>}
        <Errors list={errors} />
        <div className="row"><button className="btn primary" onClick={save}>Start RCA</button><a className="btn" style={linkBtn} href="#/rca">Cancel</a></div>
      </section>
    </div>
  );
}

function RcaPage({ id }: { id: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const r = app.rcas.find((x) => x.id === id);
  const [warnings, setWarnings] = useState<string[]>([]);
  const events = useMemo(() => {
    if (!r?.source.query && r?.source.query !== '') return [];
    const f = filterFromQuery(r.source.query);
    const a = analyse({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now, calendar: app.ds.calendar, timeZone: tz }, f);
    return [...a.events].sort((x, y) => y.event.start.localeCompare(x.event.start)).slice(0, 12);
  }, [r?.source.query, app.flags, app.now]);
  if (!r) return <p>Analysis not found. <a href="#/rca">All analyses</a></p>;
  const edit = can(app.actor, 'run_rcas') && r.status === 'open';
  const leads = app.people.filter((u) => u.role === 'reliability_engineer' || u.role === 'superintendent').map((u) => u.id);
  const run = (cmd: Parameters<typeof app.runImprove>[1]) => {
    const res = app.runImprove('rcas', cmd);
    if (!res.ok) return res.errors;
    setWarnings(res.warnings);
    return null;
  };
  const acts = rcaActions(r, app.actions);
  const unitName = (uid: string) => app.ds.assets.find((a) => a.id === uid)?.unitNumber ?? uid;

  return (
    <div className="stack">
      <div className="page-head">
        <h2>{r.title}</h2>
        <span className="muted">{STATUS[r.status]} · led by {app.userName(r.lead)} · started {siteTime(r.createdAt, tz, true)}</span>
      </div>
      <p className="small"><a href="#/rca">All analyses</a>{r.source.unitId && <> · <a href={`#/unit/${r.source.unitId}`}>{r.source.label}</a></>}{r.source.query !== undefined && <> · <a href={analysisHref(r.source.query)}>Open in analysis</a></>}</p>
      <Warnings list={warnings} />
      {!can(app.actor, 'run_rcas') && <p className="small muted">You can read this analysis. Reliability engineers and superintendents edit it.</p>}

      <section className="card">
        <h3>Problem</h3>
        <EditableText value={r.problem} rows={2} disabled={!edit} onSave={(v) => run((ctx) => editRca(ctx, app.rcas, r.id, { problem: v }, leads))} />
      </section>

      <div className="grid two">
        <section className="card">
          <h3>5 Whys</h3>
          <Whys r={r} disabled={!edit} onSave={(whys) => run((ctx) => editRca(ctx, app.rcas, r.id, { whys }, leads))} />
        </section>
        <section className="card">
          <h3>Root cause</h3>
          <EditableText value={r.rootCause ?? ''} rows={3} placeholder="The cause that, removed, stops it happening again" disabled={!edit} onSave={(v) => run((ctx) => editRca(ctx, app.rcas, r.id, { rootCause: v }, leads))} />
          {r.closeNote && <p className="small"><strong>Closing note:</strong> {r.closeNote}{r.closedAt ? ` (${siteTime(r.closedAt, tz, true)})` : ''}</p>}
          {r.cancelReason && <p className="small"><strong>Cancelled:</strong> {r.cancelReason}</p>}
          <div className="row" style={{ flexWrap: 'wrap', marginTop: 12 }}>
            {edit && <NoteButton label="Close RCA" prompt="Closing note: what was agreed" onSubmit={(n) => run((ctx) => closeRca(ctx, app.rcas, r.id, n, app.actions))} />}
            {edit && <NoteButton label="Cancel RCA" danger prompt="Why is it no longer needed?" onSubmit={(n) => run((ctx) => cancelRca(ctx, app.rcas, r.id, n))} />}
            {r.status !== 'open' && can(app.actor, 'run_rcas') && <NoteButton label="Reopen" prompt="Why reopen it?" onSubmit={(n) => run((ctx) => reopenRca(ctx, app.rcas, r.id, n))} />}
          </div>
        </section>
      </div>

      <section className="card">
        <h3>Fishbone</h3>
        <Fishbone r={r} disabled={!edit} onSave={(cat, items) => run((ctx) => editRca(ctx, app.rcas, r.id, { fishbone: { [cat]: items } }, leads))} />
      </section>

      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Actions ({acts.length})</h3>
          {can(app.actor, 'create_actions') && r.status !== 'cancelled' && <a className="btn primary" style={linkBtn} href={newHref('actions', { kind: 'rca', rcaId: r.id })}>Raise action</a>}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              {acts.map((a) => <tr key={a.id}><td><a href={`#/actions/${a.id}`}>{a.title}</a></td><td>{app.userName(a.owner)}</td><td>{a.due}</td><td>{ACTION_STATUS_LABELS[a.status]}</td></tr>)}
              {!acts.length && <tr><td colSpan={4} className="muted">None yet. An RCA closes with a warning when nothing is tracked.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {r.source.query !== undefined && (
        <section className="card">
          <h3>Recent events on this slice</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Unit</th><th>Start</th><th>System · component · mode</th><th className="num">Down</th><th>Failure</th></tr></thead>
              <tbody>
                {events.map(({ event, flags, hours }) => {
                  const f = flags[0]!;
                  return (
                    <tr key={event.id} style={r.flagIds.some((x) => flags.some((fl) => fl.id === x)) ? { background: 'var(--warn-bg)' } : undefined}>
                      <td><a href={`#/unit/${event.unitId}`}>{unitName(event.unitId)}</a></td>
                      <td>{siteTime(event.start, tz, true)}</td>
                      <td>{flagSystem(f)}{f.release?.component ? ` · ${f.release.component}` : ''}{f.release?.failureModes?.length ? ` · ${f.release.failureModes.join(', ')}` : ''}</td>
                      <td className="num">{fmtHours(hours)}</td>
                      <td>{event.isFailure ? 'Yes' : 'No'}</td>
                    </tr>
                  );
                })}
                {!events.length && <tr><td colSpan={5} className="muted">No events in the slice's date range.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h3>History</h3>
        <History entries={app.audit.filter((x) => x.entity === 'rca' && x.entityId === r.id)} userName={app.userName} tz={tz} fmt={siteTime} />
      </section>
    </div>
  );
}

function EditableText({ value, rows, placeholder, disabled, onSave }: { value: string; rows: number; placeholder?: string; disabled: boolean; onSave: (v: string) => string[] | null }) {
  const [v, setV] = useState(value);
  const [errors, setErrors] = useState<string[] | null>(null);
  if (disabled) return <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{value || <span className="muted">Not recorded.</span>}</p>;
  return (
    <>
      <textarea rows={rows} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} style={{ width: '100%', padding: 8, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }} />
      <Errors list={errors} />
      {v !== value && <div className="row" style={{ marginTop: 6 }}><button className="btn primary" onClick={() => setErrors(onSave(v))}>Save</button><button className="btn" onClick={() => setV(value)}>Undo</button></div>}
    </>
  );
}

function Whys({ r, disabled, onSave }: { r: Rca; disabled: boolean; onSave: (whys: string[]) => string[] | null }) {
  const [whys, setWhys] = useState<string[]>(r.whys.length ? r.whys : ['']);
  const [errors, setErrors] = useState<string[] | null>(null);
  const changed = JSON.stringify(whys.map((w) => w.trim()).filter(Boolean)) !== JSON.stringify(r.whys);
  if (disabled) {
    return r.whys.length ? <ol style={{ margin: 0, paddingLeft: 22 }}>{r.whys.map((w, i) => <li key={i}>{w}</li>)}</ol> : <p className="muted">No whys recorded.</p>;
  }
  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>Start from the problem and ask why each answer happened.</p>
      {whys.map((w, i) => (
        <label key={i} className="field"><span>Why {i + 1}</span>
          <input value={w} onChange={(e) => setWhys(whys.map((x, j) => (j === i ? e.target.value : x)))} />
        </label>
      ))}
      <div className="row">
        {whys.length < 7 && <button className="btn" onClick={() => setWhys([...whys, ''])}>Add why</button>}
        {changed && <button className="btn primary" onClick={() => setErrors(onSave(whys))}>Save whys</button>}
      </div>
      <Errors list={errors} />
    </>
  );
}

/** The six bones as boxes either side of a spine that points at the problem. */
function Fishbone({ r, disabled, onSave }: { r: Rca; disabled: boolean; onSave: (cat: FishboneCategory, items: string[]) => string[] | null }) {
  const [open, setOpen] = useState<FishboneCategory | null>(null);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const top = FISHBONE.slice(0, 3);
  const bottom = FISHBONE.slice(3);
  const bone = ([k, label]: [FishboneCategory, string]) => (
    <div key={k} className="card" style={{ padding: 10, minHeight: 90 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong className="small">{label}</strong>
        {!disabled && <button className="btn" style={{ minHeight: 32, padding: '0 10px' }} onClick={() => { setOpen(k); setText(r.fishbone[k].join('\n')); setErrors(null); }}>Edit</button>}
      </div>
      {r.fishbone[k].length ? <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{r.fishbone[k].map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="small muted" style={{ margin: '6px 0 0' }}>Nothing yet</p>}
    </div>
  );
  return (
    <>
      <div className="fishbone">
        <div className="fb-row fb-top">{top.map(bone)}</div>
        <div className="fb-spine" aria-hidden="true"><span /></div>
        <div className="fb-head">{r.problem}</div>
        <div className="fb-row fb-bottom">{bottom.map(bone)}</div>
      </div>
      {open && (
        <div className="card" style={{ marginTop: 12 }}>
          <label className="field"><span>{FISHBONE.find(([k]) => k === open)?.[1]}: one cause per line</span><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></label>
          <Errors list={errors} />
          <div className="row">
            <button className="btn primary" onClick={() => { const e = onSave(open, text.split('\n')); if (e) setErrors(e); else setOpen(null); }}>Save</button>
            <button className="btn" onClick={() => setOpen(null)}>Back</button>
          </div>
        </div>
      )}
    </>
  );
}
