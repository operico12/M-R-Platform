// Fixed plant, part 2 (docs/fixed-plant.md): shutdowns with their scope and
// KPI-039 to KPI-041, operator rounds and lube routes with KPI-042, and the
// plant structure editor. Every change runs through a core command.

import {
  NODE_KIND_LABELS,
  PARENT_KINDS,
  ROUND_SKIP_REASONS,
  ROUTE_KIND_LABELS,
  SHUTDOWN_STATUS_LABELS,
  activeScope,
  addScope,
  can,
  cancelShutdown,
  changePlan,
  endShutdown,
  equipmentUnder,
  formVersion,
  latestForms,
  nodeProblems,
  permission,
  placementChanges,
  planShutdown,
  removeScope,
  retireForm,
  retireNode,
  routeCompliance,
  routeDue,
  saveForm,
  saveNode,
  scopeCandidates,
  scoreInspection,
  shutdownReport,
  shutdownStatus,
  signOffRound,
  startShutdown,
  stopForm,
  submitProblems,
  submitRound,
  voidRound,
  type Answer,
  type FormItem,
  type InspectionForm,
  type ItemKind,
  type NodeInput,
  type PlantNode,
  type PlantNodeKind,
  type PlantTree,
  type Round,
  type RouteKind,
  type Shutdown,
  type SkippedStop,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { fmtHours, fmtPct, fromLocalInput, siteTime, toLocalInput } from '../format';
import { Errors, Warnings } from '../improve/ui';
import { useApp } from '../store';
import { ItemInput, KIND_LABELS } from './Inspections';

const go = (h: string) => { window.location.hash = h; };
const lines = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
const nodeName = (tree: PlantTree, id?: string) => (id && tree.byId.get(id)?.node.name) || '—';

function Pill({ tone, children }: { tone?: 'bad' | 'warn' | 'good'; children: React.ReactNode }) {
  const bg = tone === 'bad' ? 'var(--down)' : tone === 'warn' ? 'var(--warn-bg)' : 'var(--surface-2)';
  const fg = tone === 'bad' ? '#fff' : tone === 'warn' ? 'var(--warn-ink)' : 'inherit';
  return <span className="small" style={{ padding: '2px 10px', borderRadius: 12, background: bg, color: fg, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card" style={{ padding: 10, minWidth: 140, flex: '1 1 140px' }}>
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{value}</div>
      {note && <div className="small muted">{note}</div>}
    </div>
  );
}

// ---------- shutdowns ----------

export function ShutdownsTab({ tree }: { tree: PlantTree }) {
  const app = useApp();
  const list = useMemo(() => {
    const order = { in_progress: 0, planned: 1, completed: 2, cancelled: 3 } as const;
    return [...app.plant.shutdowns].sort((a, b) => order[shutdownStatus(a)] - order[shutdownStatus(b)]
      || (shutdownStatus(a) === 'planned' ? Date.parse(a.plannedStart) - Date.parse(b.plannedStart) : Date.parse(b.plannedStart) - Date.parse(a.plannedStart)));
  }, [app.plant.shutdowns]);
  const [openId, setOpenId] = useState<string | null>(() => list.find((s) => shutdownStatus(s) !== 'completed' && shutdownStatus(s) !== 'cancelled')?.id ?? null);
  const [planning, setPlanning] = useState(false);
  const ok = can(app.actor, 'run_shutdowns');
  return (
    <div className="stack">
      <p className="small muted">A shutdown has a plan, a scope of work orders frozen {app.plantSettings.scopeFreezeDays} days before it starts, and an actual start and end. Starting it flags each piece of equipment down as scheduled; ending it releases them. Scope work orders stay in the ERP and count as done when the work order import shows them closed.</p>
      {ok ? (planning ? <PlanForm tree={tree} onDone={(id) => { setPlanning(false); if (id) setOpenId(id); }} /> : <div><button className="btn primary" onClick={() => setPlanning(true)}>Plan a shutdown</button></div>)
        : <p className="locked small">🔒 Supervisors, reliability engineers and superintendents plan and run shutdowns.</p>}
      {!list.length && <p className="card muted">No shutdowns yet.</p>}
      {list.map((s) => <ShutdownCard key={s.id} s={s} tree={tree} open={openId === s.id} onToggle={() => setOpenId(openId === s.id ? null : s.id)} />)}
    </div>
  );
}

function PlanForm({ tree, onDone, s }: { tree: PlantTree; onDone: (id?: string) => void; s?: Shutdown }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const nodes = [...tree.byId.values()].filter((t) => t.node.kind !== 'group');
  const [nodeId, setNodeId] = useState(s?.nodeId ?? nodes[0]?.node.id ?? '');
  const [name, setName] = useState(s?.name ?? '');
  const [wo, setWo] = useState(s?.workOrder ?? '');
  const day = 864e5;
  const [start, setStart] = useState(() => toLocalInput(s?.plannedStart ?? new Date(Date.parse(app.now) + 14 * day).toISOString(), tz).slice(0, 14) + '00');
  const [end, setEnd] = useState(() => toLocalInput(s?.plannedEnd ?? new Date(Date.parse(app.now) + 15 * day).toISOString(), tz).slice(0, 14) + '00');
  const under = useMemo(() => equipmentUnder(tree, nodeId), [tree, nodeId]);
  const [picked, setPicked] = useState<string[] | null>(s?.equipmentIds ?? null);
  const eq = picked ?? under;
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const unit = (id: string) => app.plant.equipment.find((a) => a.id === id);
  const save = () => {
    const input = { nodeId, name, workOrder: wo, plannedStart: fromLocalInput(start, tz), plannedEnd: fromLocalInput(end, tz), equipmentIds: eq };
    const r = app.runShutdown((ctx) => (s ? changePlan(ctx, tree, s, input, reason) : planShutdown(ctx, tree, { tenantId: app.ds.tenantId, siteId: app.ds.site.id }, input, app.plantSettings.scopeFreezeDays)));
    if (!r.ok) return setErr(r.errors);
    setWarn(r.warnings);
    onDone(r.records[0]!.id);
  };
  return (
    <section className="card stack" aria-label={s ? 'Change the plan' : 'Plan a shutdown'}>
      <h3 style={{ margin: 0 }}>{s ? 'Change the plan' : 'Plan a shutdown'}</h3>
      <div className="grid two">
        <label className="field"><span>Where</span>
          <select value={nodeId} disabled={!!s} onChange={(e) => { setNodeId(e.target.value); setPicked(null); }}>
            {nodes.map((t) => <option key={t.node.id} value={t.node.id}>{t.node.name} ({NODE_KIND_LABELS[t.node.kind].toLowerCase()})</option>)}
          </select></label>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Wet plant shutdown, November" /></label>
        <label className="field"><span>Master work order (ERP)</span><input value={wo} onChange={(e) => setWo(e.target.value)} /></label>
        <span />
        <label className="field"><span>Planned start (site time)</span><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="field"><span>Planned end (site time)</span><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small"><strong>Equipment taking part</strong> ({eq.length} of {under.length})</legend>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {under.map((id) => (
            <label key={id} className="chip" style={{ minHeight: 40, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={eq.includes(id)} onChange={(e) => setPicked(e.target.checked ? [...eq, id] : eq.filter((x) => x !== id))} />
              {unit(id)?.unitNumber ?? id}
            </label>
          ))}
        </div>
      </fieldset>
      {s && <label className="field"><span>Reason for the change</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={save}>{s ? 'Save the plan' : 'Plan it'}</button>
        <button className="btn" onClick={() => onDone()}>Cancel</button>
      </div>
      {!s && <p className="small muted">The scope freezes {app.plantSettings.scopeFreezeDays} days before the planned start (plant settings). Work orders added after that count as work added (KPI-041).</p>}
      <Errors list={err} />
      <Warnings list={warn} />
    </section>
  );
}

function ShutdownCard({ s, tree, open, onToggle }: { s: Shutdown; tree: PlantTree; open: boolean; onToggle: () => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const wos = useMemo(() => [...app.ds.workOrders, ...app.plant.workOrders], [app.ds.workOrders, app.plant.workOrders]);
  const rep = useMemo(() => shutdownReport(s, wos, app.now), [s, wos, app.now]);
  const st = shutdownStatus(s);
  const tone = st === 'in_progress' ? 'warn' : st === 'cancelled' ? undefined : st === 'completed' ? 'good' : undefined;
  return (
    <section className="card stack" aria-label={s.name}>
      <button className="linkish" onClick={onToggle} aria-expanded={open} style={{ textAlign: 'left', padding: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <strong>{s.name}</strong>
          <Pill tone={tone}>{SHUTDOWN_STATUS_LABELS[st]}</Pill>
        </div>
        <div className="small muted">
          {nodeName(tree, s.nodeId)} · WO {s.workOrder} · planned {siteTime(s.plannedStart, tz, true)} to {siteTime(s.plannedEnd, tz, true)} ({fmtHours(rep.plannedHours)})
          {s.actualStart && <> · started {siteTime(s.actualStart, tz, true)}</>}{s.actualEnd && <>, ended {siteTime(s.actualEnd, tz, true)}</>}
        </div>
      </button>
      {open && <ShutdownDetail s={s} tree={tree} rep={rep} />}
    </section>
  );
}

function ShutdownDetail({ s, tree, rep }: { s: Shutdown; tree: PlantTree; rep: ReturnType<typeof shutdownReport> }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const st = shutdownStatus(s);
  const ok = can(app.actor, 'run_shutdowns');
  const [mode, setMode] = useState<'none' | 'start' | 'end' | 'cancel' | 'plan'>('none');
  const [at, setAt] = useState(() => toLocalInput(app.now, tz));
  const sched = app.codes.filter((c) => c.appliesTo === 'scheduled' && !c.retiredAt);
  const [code, setCode] = useState(() => sched.find((c) => c.code === 'SHUTDOWN')?.code ?? sched[0]?.code ?? '');
  const [text, setText] = useState(s.findings ?? '');
  const [err, setErr] = useState<string[] | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [addWo, setAddWo] = useState('');
  const [addWhy, setAddWhy] = useState('');
  const wos = useMemo(() => [...app.ds.workOrders, ...app.plant.workOrders], [app.ds.workOrders, app.plant.workOrders]);
  const cands = useMemo(() => (st === 'planned' || st === 'in_progress' ? scopeCandidates(s, wos) : []), [s, wos, st]);
  const late = Date.parse(app.now) > Date.parse(s.freezeAt);
  const unit = (id: string) => app.plant.equipment.find((a) => a.id === id);
  const done = (r: { ok: true; warnings: string[] } | { ok: false; errors: string[] }) => {
    if (!r.ok) { setErr(r.errors); return false; }
    setErr(null); setWarn(r.warnings); setMode('none');
    return true;
  };
  const run = () => {
    if (mode === 'start') done(app.runShutdownFlow((ctx, ctxFor) => startShutdown(ctx, s, app.plant.equipment, ctxFor, { at: fromLocalInput(at, tz), reasonCode: code })));
    if (mode === 'end') done(app.runShutdownFlow((ctx, ctxFor) => endShutdown(ctx, s, app.plant.equipment, app.plant.flags, ctxFor, { at: fromLocalInput(at, tz), findings: text })));
    if (mode === 'cancel') done(app.runShutdown((ctx) => cancelShutdown(ctx, s, text)));
  };
  const add = (nums: string[]) => { if (done(app.runShutdown((ctx) => addScope(ctx, s, nums, addWhy)))) { setAddWo(''); setAddWhy(''); } };
  const remove = (id: string) => {
    const why = window.prompt('Reason for taking this work order out of scope') ?? '';
    if (why.trim()) done(app.runShutdown((ctx) => removeScope(ctx, s, id, why)));
  };
  const STATE: Record<string, [string, 'good' | 'warn' | undefined]> = { done: ['Done', 'good'], open: ['Open', undefined], not_imported: ['Not in the import', 'warn'] };
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Stat label="Duration against plan (KPI-039)" value={fmtPct(rep.ofPlan, 0)} note={rep.actualHours === null ? 'Not started' : `${fmtHours(rep.actualHours)} of ${fmtHours(rep.plannedHours)}${st === 'in_progress' ? ' so far' : ''}`} />
        <Stat label="Scope completion (KPI-040)" value={fmtPct(rep.completion, 0)} note={`${rep.done} of ${rep.inScope} work orders closed`} />
        <Stat label="Work added after freeze (KPI-041)" value={fmtPct(rep.addedShare, 0)} note={`${rep.added} added to ${rep.atFreeze} at freeze${rep.removed ? `, ${rep.removed} taken out` : ''}`} />
        {rep.lateStartHours !== null && <Stat label="Start against plan" value={rep.lateStartHours > 0 ? `${fmtHours(rep.lateStartHours)} late` : rep.lateStartHours < 0 ? `${fmtHours(-rep.lateStartHours)} early` : 'On time'} />}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Scope freezes {siteTime(s.freezeAt, tz, true)}{late ? ' (frozen)' : ''}. Equipment: {s.equipmentIds.map((id) => unit(id)?.unitNumber ?? id).join(', ')}.
        {rep.estimatedHours > 0 && <> Estimated {Math.round(rep.estimatedHours)} h of work, {Math.round(rep.estimatedHoursDone)} h closed.</>}
        {rep.notImported > 0 && <> {rep.notImported} work order{rep.notImported === 1 ? ' is' : 's are'} not in the last import yet.</>}
      </p>
      {s.findings && <p className="small"><strong>Findings:</strong> {s.findings}</p>}
      {s.cancelReason && <p className="small"><strong>Cancelled:</strong> {s.cancelReason}</p>}
      {ok && (st === 'planned' || st === 'in_progress') && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {st === 'planned' && <button className="btn primary" aria-pressed={mode === 'start'} onClick={() => { setMode('start'); setAt(toLocalInput(new Date().toISOString(), tz)); }}>Start shutdown</button>}
          {st === 'in_progress' && <button className="btn primary" aria-pressed={mode === 'end'} onClick={() => { setMode('end'); setAt(toLocalInput(new Date().toISOString(), tz)); }}>End shutdown</button>}
          {st === 'planned' && <button className="btn" aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>Change the plan</button>}
          {st === 'planned' && <button className="btn danger" aria-pressed={mode === 'cancel'} onClick={() => { setMode('cancel'); setText(''); }}>Cancel shutdown</button>}
        </div>
      )}
      {mode === 'plan' && <PlanForm tree={tree} s={s} onDone={() => setMode('none')} />}
      {(mode === 'start' || mode === 'end' || mode === 'cancel') && (
        <div className="card stack">
          {mode !== 'cancel' && <label className="field" style={{ maxWidth: 260 }}><span>{mode === 'start' ? 'Actual start' : 'Actual end'} (site time)</span><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></label>}
          {mode === 'start' && (
            <>
              <label className="field" style={{ maxWidth: 260 }}><span>Reason code for the flags</span>
                <select value={code} onChange={(e) => setCode(e.target.value)}>{sched.map((c) => <option key={c.id} value={c.code}>{c.label}</option>)}</select></label>
              <p className="small muted" style={{ margin: 0 }}>Each of the {s.equipmentIds.length} pieces of equipment gets a scheduled down flag, In place, In repair, against WO {s.workOrder}. Equipment already flagged down keeps its flag.</p>
            </>
          )}
          {mode === 'end' && (
            <>
              <label className="field"><span>Findings (optional)</span><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} /></label>
              <p className="small muted" style={{ margin: 0 }}>Releases each shutdown flag still open, with WO {s.workOrder} and these findings. Release any equipment that is not ready separately afterwards.</p>
            </>
          )}
          {mode === 'cancel' && <label className="field"><span>Reason</span><input value={text} onChange={(e) => setText(e.target.value)} /></label>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" onClick={run}>{mode === 'start' ? 'Start it' : mode === 'end' ? 'End it' : 'Cancel the shutdown'}</button>
            <button className="btn" onClick={() => setMode('none')}>Back</button>
          </div>
        </div>
      )}
      <Errors list={err} />
      <Warnings list={warn} />
      <h4 style={{ margin: '8px 0 0' }}>Scope ({rep.inScope})</h4>
      {rep.rows.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Work order</th><th>Equipment</th><th>Description</th><th>Status</th><th>Added</th><th /></tr></thead>
            <tbody>
              {rep.rows.map(({ item, wo, state }) => (
                <tr key={item.id} style={item.removedAt ? { opacity: 0.55 } : undefined}>
                  <td>{wo?.number ?? item.workOrder}</td>
                  <td>{wo?.assetId ? unit(wo.assetId)?.unitNumber ?? '' : ''}</td>
                  <td className="small">{wo?.description ?? ''}</td>
                  <td>{item.removedAt ? <span className="small">Taken out: {item.removedReason}</span> : <Pill tone={STATE[state]![1]}>{STATE[state]![0]}</Pill>}</td>
                  <td className="small">{siteTime(item.addedAt, tz, true)}{item.late ? <> · <strong>after freeze</strong>{item.reason ? `: ${item.reason}` : ''}</> : ''}</td>
                  <td>{ok && !item.removedAt && (st === 'planned' || st === 'in_progress') && <button className="btn" onClick={() => remove(item.id)}>Take out</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="small muted">No work orders in scope yet.</p>}
      {ok && (st === 'planned' || st === 'in_progress') && (
        <div className="stack">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '1 1 200px' }}><span>Add work orders (numbers, comma or space separated)</span><input value={addWo} onChange={(e) => setAddWo(e.target.value)} /></label>
            {late && <label className="field" style={{ flex: '1 1 200px' }}><span>Reason (the scope is frozen)</span><input value={addWhy} onChange={(e) => setAddWhy(e.target.value)} /></label>}
            <button className="btn" disabled={!lines(addWo).length} onClick={() => add(lines(addWo))}>Add to scope</button>
          </div>
          {cands.length > 0 && (
            <div className="small">
              <strong>Open work orders on this equipment that look like shutdown work:</strong>
              <ul style={{ margin: '4px 0' }}>
                {cands.slice(0, 20).map((w) => (
                  <li key={w.id}>{w.number} · {w.assetId ? unit(w.assetId)?.unitNumber : ''} · {w.description ?? ''} <button className="linkish" disabled={late && !addWhy.trim()} onClick={() => add([w.number])}>Add</button></li>
                ))}
              </ul>
              {late && !addWhy.trim() && <span className="muted">Give a reason above to add one after the freeze.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- rounds ----------

const DUE_WORD = { overdue: ['Overdue', 'bad'], due_soon: ['Due now', 'warn'], never: ['Never done', 'warn'], ok: ['Up to date', 'good'] } as const;
const every = (f: InspectionForm) => `every ${f.every.n === 1 ? '' : `${f.every.n} `}${f.every.unit === 'shifts' ? (f.every.n === 1 ? 'shift' : 'shifts') : f.every.n === 1 ? 'day' : 'days'}`;

export function RoundsTab({ tree, routeId, roundId }: { tree: PlantTree; routeId?: string; roundId?: string }) {
  if (routeId) return <RouteEditor tree={tree} id={routeId} />;
  if (roundId) return <RoundView id={roundId} />;
  return <RoundsHome tree={tree} />;
}

function RoundsHome({ tree }: { tree: PlantTree }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const due = useMemo(() => routeDue(app.forms, app.rounds, app.ds.calendar, app.now), [app.forms, app.rounds, app.ds.calendar, app.now]);
  const [days, setDays] = useState(7);
  const period = useMemo(() => ({ from: new Date(Date.parse(app.now) - days * 864e5).toISOString(), to: app.now }), [app.now, days]);
  const comp = useMemo(() => routeCompliance(app.forms, app.rounds, period, app.ds.calendar, app.now), [app.forms, app.rounds, period, app.ds.calendar, app.now]);
  const recent = useMemo(() => [...app.rounds].filter((r) => r.status !== 'draft').sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 40), [app.rounds]);
  const [err, setErr] = useState<string[] | null>(null);
  const canDo = can(app.actor, 'add_notes');
  const mine = app.roundDrafts;
  const start = (f: InspectionForm) => {
    const r = app.beginRound(f);
    if (!r.ok) return setErr(r.errors);
    go(`#/plant?tab=rounds&round=${r.round.id}`);
  };
  const totals = comp.reduce((t, c) => ({ due: t.due + c.due, done: t.done + c.done }), { due: 0, done: 0 });
  return (
    <div className="stack">
      <p className="small muted">A route is a walk past equipment in order: an operator round or a lube route. A round makes one inspection per stop, so failed items, defects, sign-off and the equipment's history work as for any inspection. A stop can be skipped with a reason, for example when the equipment is down.</p>
      {mine.length > 0 && (
        <section className="card" aria-label="Rounds in progress on this device">
          <h3 style={{ marginTop: 0 }}>In progress on this device</h3>
          {mine.map((r) => {
            const f = formVersion(app.forms, r.formId, r.formVersion);
            return <div key={r.id} className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}><span>{f?.name ?? 'Route'} · started {siteTime(r.startedAt, tz, true)}</span><a className="btn primary" href={`#/plant?tab=rounds&round=${r.id}`}>Continue</a></div>;
          })}
        </section>
      )}
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Due</h3>
        <Errors list={err} />
        {due.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Route</th><th>Where</th><th>How often</th><th>Last done</th><th>State</th><th /></tr></thead>
              <tbody>
                {due.map((d) => (
                  <tr key={d.form.id}>
                    <td><strong>{d.form.name}</strong><div className="small muted">{ROUTE_KIND_LABELS[d.form.route!.kind]} · {d.form.route!.stops.length} stops</div></td>
                    <td>{nodeName(tree, d.form.route!.nodeId)}</td>
                    <td>{every(d.form)}</td>
                    <td className="small">{d.last ? siteTime(d.last.startedAt, tz, true) : '—'}</td>
                    <td><Pill tone={DUE_WORD[d.state][1]}>{DUE_WORD[d.state][0]}</Pill>{d.dueBy && d.state !== 'overdue' && <div className="small muted">by {siteTime(d.dueBy, tz, true)}</div>}</td>
                    <td>{canDo && <button className="btn" onClick={() => start(d.form)}>Start round</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="small muted">No routes yet.</p>}
        {can(app.actor, 'edit_inspection_forms') && <p className="small"><a href="#/plant?tab=rounds&route=new">New route</a>{due.length > 0 && <> · Change a route: {due.map((d, i) => <span key={d.form.id}>{i ? ', ' : ''}<a href={`#/plant?tab=rounds&route=${d.form.id}`}>{d.form.name}</a></span>)}</>}</p>}
      </section>
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Route compliance (KPI-042)</h3>
          <div className="chips">{[7, 28].map((d) => <button key={d} className="chip" aria-pressed={days === d} onClick={() => setDays(d)}>Last {d} days</button>)}</div>
        </div>
        <p className="small muted">Rounds done in their due shift or day ÷ due periods ended. A period still running counts only once its round is done. Overall: <strong>{fmtPct(totals.due ? totals.done / totals.due : null)}</strong> ({totals.done} of {totals.due}).</p>
        <table>
          <thead><tr><th>Route</th><th>Due</th><th>Done</th><th>Compliance</th></tr></thead>
          <tbody>{comp.map((c) => <tr key={c.form.id}><td>{c.form.name}</td><td>{c.due}</td><td>{c.done}</td><td>{fmtPct(c.value)}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Recent rounds</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Started</th><th>Route</th><th>By</th><th>Stops</th><th>Result</th></tr></thead>
            <tbody>
              {recent.map((r) => {
                const f = formVersion(app.forms, r.formId, r.formVersion);
                const ins = app.inspections.filter((i) => i.roundId === r.id);
                const fails = ins.filter((i) => i.result === 'fail').length;
                const defects = ins.filter((i) => i.result === 'defects').length;
                const waiting = ins.filter((i) => i.status === 'submitted').length;
                return (
                  <tr key={r.id} style={r.status === 'voided' ? { opacity: 0.55 } : undefined}>
                    <td><a href={`#/plant?tab=rounds&round=${r.id}`}>{siteTime(r.startedAt, tz, true)}</a></td>
                    <td>{f?.name ?? ''}</td>
                    <td className="small">{app.userName(r.startedBy)}</td>
                    <td className="small">{ins.length} done{r.skipped.length ? `, ${r.skipped.length} skipped` : ''}</td>
                    <td>{r.status === 'voided' ? <span className="small">Voided</span> : fails ? <Pill tone="bad">{fails} failed</Pill> : defects ? <Pill tone="warn">{defects} with defects</Pill> : <Pill tone="good">Pass</Pill>}{waiting > 0 && r.status !== 'voided' && <span className="small muted"> · {waiting} to sign off</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function RoundView({ id }: { id: string }) {
  const app = useApp();
  const draft = app.roundDrafts.find((r) => r.id === id);
  if (draft) return <RoundFill round={draft} />;
  const done = app.rounds.find((r) => r.id === id);
  if (done) return <RoundDone round={done} />;
  return <p className="muted">This round is not on this device. Rounds stay on the device they were started on until submitted. <a href="#/plant?tab=rounds">Back to rounds</a></p>;
}

function RoundFill({ round }: { round: Round }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const form = formVersion(app.forms, round.formId, round.formVersion);
  const stops = app.drafts.filter((d) => d.roundId === round.id);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(true);
  const [at, setAt] = useState(0);
  if (!form?.route) return <p className="muted">The route for this round is missing.</p>;
  const unit = (sid: string) => app.plant.equipment.find((a) => a.id === sid);
  const skipped = new Map(round.skipped.map((s) => [s.stopId, s.reason]));
  const setSkip = (stopId: string, reason: string | null) => {
    const next: SkippedStop[] = [...round.skipped.filter((s) => s.stopId !== stopId), ...(reason === null ? [] : [{ stopId, reason }])];
    setSaved(app.saveRoundDraft({ ...round, skipped: next }));
    setErrors(null);
  };
  const answer = (stopId: string, itemId: string, a: Partial<Answer>) => {
    const d = stops.find((x) => x.unitId === stopId);
    if (!d) return;
    setSaved(app.saveDraft({ ...d, answers: { ...d.answers, [itemId]: { value: null, ...d.answers[itemId], ...a } } }));
    setErrors(null);
  };
  const route = form.route;
  const stopId = route.stops[Math.min(at, route.stops.length - 1)]!;
  const sf = stopForm(form, stopId);
  const d = stops.find((x) => x.unitId === stopId);
  const left = route.stops.filter((sid) => !skipped.has(sid) && submitProblems(stopForm(form, sid), stops.find((x) => x.unitId === sid)?.answers ?? {}).length > 0).length;
  const flagged = (sid: string) => app.plant.flags.some((f) => f.unitId === sid && f.state === 'open');
  const submit = () => {
    const r = app.runRound((ctx) => submitRound(ctx, form, round, stops, round.skipped, app.plant.equipment));
    if (!r.ok) return setErrors(r.errors);
    go(`#/plant?tab=rounds&round=${round.id}`);
  };
  const { score, result } = scoreInspection(sf, d?.answers ?? {});
  return (
    <div className="stack">
      <p className="small" style={{ margin: 0 }}><a href="#/plant?tab=rounds">Rounds</a> / {form.name}</p>
      <h3 style={{ margin: 0 }}>{form.name}</h3>
      <p className="small muted" style={{ margin: 0 }}>Started {siteTime(round.startedAt, tz, true)}. {saved ? 'Saved on this device as you go.' : <strong>This device could not save the round. Do not close the page.</strong>}</p>
      <div className="chips" role="tablist" aria-label="Stops">
        {route.stops.map((sid, i) => {
          const sk = skipped.has(sid);
          const open = submitProblems(stopForm(form, sid), stops.find((x) => x.unitId === sid)?.answers ?? {}).length;
          return <button key={sid} role="tab" className="chip" aria-selected={i === at} aria-pressed={i === at} onClick={() => setAt(i)} style={{ minHeight: 40 }}>{i + 1}. {unit(sid)?.unitNumber ?? sid} {sk ? '⤼' : open ? '' : '✓'}</button>;
        })}
      </div>
      <section className="card stack" aria-label={`Stop ${at + 1}`}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <strong>Stop {at + 1} of {route.stops.length}: {unit(stopId)?.unitNumber} {unit(stopId)?.model}</strong>
          {flagged(stopId) && <Pill tone="warn">Flagged down</Pill>}
        </div>
        <label className="field" style={{ maxWidth: 320 }}><span>Skip this stop</span>
          <select value={skipped.get(stopId) ?? ''} onChange={(e) => setSkip(stopId, e.target.value || null)}>
            <option value="">Not skipped</option>
            {ROUND_SKIP_REASONS.map((r) => <option key={r}>{r}</option>)}
          </select></label>
        {!skipped.has(stopId) && sf.items.map((it, n) => <ItemInput key={it.id} it={it} n={n + 1} a={d?.answers[it.id]} onChange={(a) => answer(stopId, it.id, a)} />)}
        {!skipped.has(stopId) && <span className="small">Score {score === null ? '—' : fmtPct(score, 0)} · {result === 'fail' ? 'Fail' : result === 'defects' ? 'Defects' : 'Pass'}</span>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" disabled={at === 0} onClick={() => setAt(at - 1)}>Previous stop</button>
          <button className="btn" disabled={at >= route.stops.length - 1} onClick={() => setAt(at + 1)}>Next stop</button>
        </div>
      </section>
      <section className="card" style={{ position: 'sticky', bottom: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span className="small">{left ? `${left} stop${left === 1 ? '' : 's'} to finish` : 'Ready to submit'} · {round.skipped.length} skipped</span>
          <span className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={() => { if (window.confirm('Discard this round? Its answers and photos are removed from this device.')) { app.discardRound(round.id); go('#/plant?tab=rounds'); } }}>Discard</button>
            <button className="btn primary big" onClick={submit}>Submit round</button>
          </span>
        </div>
        <Errors list={errors} />
      </section>
    </div>
  );
}

function RoundDone({ round }: { round: Round }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const form = formVersion(app.forms, round.formId, round.formVersion);
  const ins = app.inspections.filter((i) => i.roundId === round.id);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string[] | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const unit = (id: string) => app.plant.equipment.find((a) => a.id === id);
  const canSign = permission(app.actor.role, 'sign_off_inspections') === 'yes';
  const waiting = ins.filter((i) => i.status === 'submitted').length;
  const sign = () => { const r = app.runRound((ctx) => signOffRound(ctx, round, app.inspections, note)); if (!r.ok) setErr(r.errors); else { setErr(null); setWarn(['Signed off.']); } };
  const voidIt = () => {
    const why = window.prompt('Reason for voiding this round and its inspections') ?? '';
    if (!why.trim()) return;
    const r = app.runRound((ctx) => voidRound(ctx, round, app.inspections, why));
    if (!r.ok) setErr(r.errors);
  };
  return (
    <div className="stack">
      <p className="small" style={{ margin: 0 }}><a href="#/plant?tab=rounds">Rounds</a> / {form?.name}</p>
      <h3 style={{ margin: 0 }}>{form?.name}: {siteTime(round.startedAt, tz, true)}</h3>
      <p className="small muted" style={{ margin: 0 }}>By {app.userName(round.startedBy)}{round.submittedAt ? `, submitted ${siteTime(round.submittedAt, tz, true)}` : ''}.{round.status === 'voided' ? ` Voided: ${round.voidReason}` : ''}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Stop</th><th>Result</th><th>Score</th><th>Status</th></tr></thead>
          <tbody>
            {form?.route?.stops.map((sid, n) => {
              const i = ins.find((x) => x.unitId === sid);
              const sk = round.skipped.find((s) => s.stopId === sid);
              return (
                <tr key={sid}>
                  <td>{n + 1}. <a href={`#/plant?eq=${sid}`}>{unit(sid)?.unitNumber ?? sid}</a></td>
                  <td>{sk ? <span className="small">Skipped: {sk.reason}</span> : i ? <a href={`#/inspections/view/${i.id}`}><Pill tone={i.result === 'fail' ? 'bad' : i.result === 'defects' ? 'warn' : 'good'}>{i.result === 'fail' ? 'Fail' : i.result === 'defects' ? 'Defects' : 'Pass'}</Pill></a> : '—'}</td>
                  <td>{i?.score === null || i?.score === undefined ? '—' : fmtPct(i.score, 0)}</td>
                  <td className="small">{i ? (i.status === 'signed_off' ? 'Signed off' : i.status === 'voided' ? 'Voided' : 'Waiting for sign-off') : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {round.status === 'submitted' && canSign && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {waiting > 0 && round.startedBy !== app.actor.userId && (
            <>
              <label className="field" style={{ flex: '1 1 200px' }}><span>Sign-off note (optional)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <button className="btn primary" onClick={sign}>Sign off {waiting} stop{waiting === 1 ? '' : 's'}</button>
            </>
          )}
          <button className="btn danger" onClick={voidIt}>Void round</button>
        </div>
      )}
      <Errors list={err} />
      <Warnings list={warn} />
    </div>
  );
}

// ---------- route editor ----------

function RouteEditor({ tree, id }: { tree: PlantTree; id: string }) {
  const app = useApp();
  const prev = id === 'new' ? undefined : latestForms(app.forms).find((f) => f.id === id && f.route);
  const nodes = [...tree.byId.values()].filter((t) => t.node.kind !== 'group');
  const [name, setName] = useState(prev?.name ?? '');
  const [kind, setKind] = useState<RouteKind>(prev?.route?.kind ?? 'operator_round');
  const [nodeId, setNodeId] = useState(prev?.route?.nodeId ?? nodes[0]?.node.id ?? '');
  const [stops, setStops] = useState<string[]>(prev?.route?.stops ?? []);
  const [n, setN] = useState(prev?.every.n ?? 1);
  const [unitKind, setUnitKind] = useState<'shifts' | 'days'>(prev?.every.unit === 'days' ? 'days' : 'shifts');
  const [items, setItems] = useState<FormItem[]>(() => prev?.items.map((i) => ({ ...i })) ?? []);
  const [reason, setReason] = useState(prev ? '' : 'First version');
  const [err, setErr] = useState<string[] | null>(null);
  if (!can(app.actor, 'edit_inspection_forms')) return <p className="muted">Your role cannot change routes. <a href="#/plant?tab=rounds">Back to rounds</a></p>;
  if (id !== 'new' && !prev) return <p className="muted">Route not found. <a href="#/plant?tab=rounds">Back to rounds</a></p>;
  const under = equipmentUnder(tree, nodeId);
  const unit = (sid: string) => app.plant.equipment.find((a) => a.id === sid);
  const move = (i: number, d: -1 | 1) => { const s = [...stops]; const [x] = s.splice(i, 1); s.splice(i + d, 0, x!); setStops(s); };
  const setItem = (iid: string, p: Partial<FormItem>) => setItems(items.map((it) => (it.id === iid ? { ...it, ...p } : it)));
  const addItem = (sid: string) => setItems([...items, { id: `i${Date.now().toString(36)}${items.length}`, section: unit(sid)?.unitNumber ?? 'Stop', text: '', kind: kind === 'lube_route' ? 'task' : 'pass_fail', critical: false, weight: 1, photoOnFail: false, stopId: sid }]);
  const save = () => {
    const kept = items.filter((it) => it.stopId && stops.includes(it.stopId)).sort((a, b) => stops.indexOf(a.stopId!) - stops.indexOf(b.stopId!));
    const r = app.runForms((ctx) => saveForm(ctx, app.forms, prev?.id ?? null, { name, assetClass: 'fixed_plant', models: [], every: { n, unit: unitKind }, items: kept, route: { kind, nodeId, stops } }, reason));
    if (!r.ok) return setErr(r.errors);
    go('#/plant?tab=rounds');
  };
  const retire = () => {
    const why = window.prompt('Reason for retiring this route') ?? '';
    if (!why.trim() || !prev) return;
    const r = app.runForms((ctx) => retireForm(ctx, app.forms, prev.id, why));
    if (!r.ok) return setErr(r.errors);
    go('#/plant?tab=rounds');
  };
  return (
    <div className="stack">
      <p className="small" style={{ margin: 0 }}><a href="#/plant?tab=rounds">Rounds</a> / {prev ? `${prev.name} (new version ${prev.version + 1})` : 'New route'}</p>
      <section className="card">
        <div className="grid two">
          <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field"><span>Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as RouteKind)}>{Object.entries(ROUTE_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field"><span>Where</span>
            <select value={nodeId} onChange={(e) => { setNodeId(e.target.value); setStops([]); }}>{nodes.map((t) => <option key={t.node.id} value={t.node.id}>{t.node.name} ({NODE_KIND_LABELS[t.node.kind].toLowerCase()})</option>)}</select></label>
          <div className="row" style={{ alignItems: 'end', gap: 8 }}>
            <label className="field" style={{ width: 110 }}><span>Every</span><input type="number" min={1} value={n} onChange={(e) => setN(Number(e.target.value))} /></label>
            <label className="field"><span>Unit</span>
              <select value={unitKind} onChange={(e) => setUnitKind(e.target.value as 'shifts' | 'days')}><option value="shifts">Shifts</option><option value="days">Site days</option></select></label>
          </div>
        </div>
      </section>
      <section className="card stack">
        <h3 style={{ margin: 0 }}>Stops in walking order</h3>
        {stops.map((sid, i) => (
          <div key={sid} className="card stack" style={{ padding: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <strong>{i + 1}. {unit(sid)?.unitNumber ?? sid} <span className="small muted">{unit(sid)?.model}</span></strong>
              <span className="row" style={{ gap: 4 }}>
                <button className="btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                <button className="btn" disabled={i === stops.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                <button className="btn" onClick={() => setStops(stops.filter((x) => x !== sid))}>Remove</button>
              </span>
            </div>
            {items.filter((it) => it.stopId === sid).map((it) => (
              <div key={it.id} className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label className="field" style={{ flex: '2 1 200px' }}><span>Check</span><input value={it.text} onChange={(e) => setItem(it.id, { text: e.target.value })} /></label>
                <label className="field" style={{ flex: '1 1 140px' }}><span>Kind</span>
                  <select value={it.kind} onChange={(e) => setItem(it.id, { kind: e.target.value as ItemKind, critical: e.target.value === 'note' ? false : it.critical })}>
                    {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                <label className="row small" style={{ gap: 4, minHeight: 40 }}><input type="checkbox" checked={it.critical} disabled={it.kind === 'note'} onChange={(e) => setItem(it.id, { critical: e.target.checked })} /> Critical</label>
                <button className="btn" onClick={() => setItems(items.filter((x) => x.id !== it.id))}>Remove</button>
              </div>
            ))}
            <div><button className="btn" onClick={() => addItem(sid)}>Add a check</button></div>
          </div>
        ))}
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {under.filter((x) => !stops.includes(x)).map((x) => <button key={x} className="chip" style={{ minHeight: 40 }} onClick={() => setStops([...stops, x])}>+ {unit(x)?.unitNumber ?? x}</button>)}
        </div>
      </section>
      <section className="card stack">
        <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={save}>{prev ? 'Save new version' : 'Save route'}</button>
          {prev && <button className="btn danger" onClick={retire}>Retire route</button>}
          <a className="btn" href="#/plant?tab=rounds">Cancel</a>
        </div>
        <Errors list={err} />
      </section>
    </div>
  );
}

// ---------- structure editor ----------

const KINDS = Object.keys(PARENT_KINDS) as PlantNodeKind[];

export function StructureTab({ tree }: { tree: PlantTree }) {
  const app = useApp();
  const nodes = app.plant.nodes;
  const ok = can(app.actor, 'edit_shop_structure');
  const [edit, setEdit] = useState<string | 'new' | null>(null);
  const [warn, setWarn] = useState<string[]>([]);
  const [err, setErr] = useState<string[] | null>(null);
  const retired = nodes.filter((n) => n.retiredAt);
  const rows: Array<{ n: PlantNode; depth: number }> = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const n of nodes.filter((x) => !x.retiredAt && x.parentId === parent).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))) {
      rows.push({ n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(undefined, 0);
  const retire = (n: PlantNode) => {
    const why = window.prompt(`Reason for retiring ${n.name}`) ?? '';
    if (!why.trim()) return;
    const r = app.runNode((ctx) => retireNode(ctx, nodes, app.plant.equipment, n.id, why));
    if (!r.ok) return setErr(r.errors);
    setErr(null); setWarn(r.warnings);
  };
  return (
    <div className="stack">
      <p className="small muted">Plants, areas, circuits and redundancy groups. Equipment sits under the node whose functional location is the longest match for its own, so moving a node's functional location moves its equipment. Nodes are retired, never deleted, so history keeps its place.</p>
      {!ok && <p className="locked small">🔒 The admin changes the plant structure (plan 11.2). Reliability engineers propose changes to the admin.</p>}
      {ok && edit === null && <div><button className="btn primary" onClick={() => { setEdit('new'); setWarn([]); }}>Add a node</button></div>}
      {ok && edit !== null && <NodeEditor id={edit === 'new' ? null : edit} onDone={(w) => { setEdit(null); setWarn(w ?? []); }} />}
      <Errors list={err} />
      <Warnings list={warn} />
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Kind</th><th>Functional location</th><th>Needed</th><th>Planned rate</th><th>Equipment</th><th /></tr></thead>
            <tbody>
              {rows.map(({ n, depth }) => {
                const t = tree.byId.get(n.id);
                return (
                  <tr key={n.id}>
                    <td style={{ paddingLeft: 8 + depth * 16 }}>{depth === 0 ? <strong>{n.name}</strong> : n.name}</td>
                    <td>{NODE_KIND_LABELS[n.kind]}</td>
                    <td className="small">{n.functionalLocation ?? ''}</td>
                    <td>{n.kind === 'group' ? `${t?.needed ?? n.needed ?? ''} of ${t?.installed ?? ''}` : ''}</td>
                    <td>{n.plannedRateTph ? `${n.plannedRateTph.toLocaleString('en-CA')} t/h` : ''}</td>
                    <td className="small">{t?.equipment.map((a) => a.unitNumber).join(', ')}</td>
                    <td className="row" style={{ gap: 4 }}>{ok && <><button className="btn" onClick={() => { setEdit(n.id); setWarn([]); }}>Change</button><button className="btn danger" onClick={() => retire(n)}>Retire</button></>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {tree.unplaced.length > 0 && <p className="card small warnbox"><strong>Not placed:</strong> {tree.unplaced.map((a) => `${a.unitNumber} (${a.functionalLocation ?? 'no functional location'})`).join(', ')}. Give a node a functional location that matches, or correct it in the ERP.</p>}
      {retired.length > 0 && <p className="small muted">Retired: {retired.map((n) => `${n.name} (${n.retireReason})`).join('; ')}.</p>}
    </div>
  );
}

function NodeEditor({ id, onDone }: { id: string | null; onDone: (warnings?: string[]) => void }) {
  const app = useApp();
  const nodes = app.plant.nodes;
  const prev = id ? nodes.find((n) => n.id === id) : undefined;
  const [input, setInput] = useState<NodeInput>(() => prev
    ? { kind: prev.kind, name: prev.name, parentId: prev.parentId, order: prev.order, needed: prev.needed, functionalLocation: prev.functionalLocation, plannedRateTph: prev.plannedRateTph }
    : { kind: nodes.length ? 'circuit' : 'plant', name: '', order: nodes.length ? Math.max(...nodes.map((n) => n.order)) + 1 : 0 });
  const [reason, setReason] = useState(prev ? '' : 'New node');
  const [err, setErr] = useState<string[] | null>(null);
  const live = nodes.filter((n) => !n.retiredAt && n.id !== id);
  const parents = live.filter((n) => PARENT_KINDS[input.kind].includes(n.kind));
  const check = useMemo(() => nodeProblems(nodes, app.plant.equipment, id, input), [nodes, app.plant.equipment, id, input]);
  const moves = useMemo(() => {
    if (check.errors.length) return [];
    const draft: PlantNode = { ...(prev ?? { id: '__new__', tenantId: '', siteId: '' }), ...input, ...(input.parentId ? {} : { parentId: undefined }) } as PlantNode;
    const after = prev ? nodes.map((n) => (n.id === id ? draft : n)) : [...nodes, draft];
    const name = (nid?: string) => (nid ? after.find((n) => n.id === nid)?.name ?? nid : 'unplaced');
    return placementChanges(nodes, after, app.plant.equipment).map((c) => `${c.asset.unitNumber} moves from ${name(c.from)} to ${name(c.to)}.`);
  }, [check.errors.length, prev, input, nodes, id, app.plant.equipment]);
  const num = (v: string) => (v === '' ? undefined : Number(v));
  const save = () => {
    const r = app.runNode((ctx) => saveNode(ctx, nodes, app.plant.equipment, { tenantId: app.ds.tenantId, siteId: app.ds.site.id }, id, input, reason));
    if (!r.ok) return setErr(r.errors);
    onDone(r.warnings);
  };
  return (
    <section className="card stack" aria-label={prev ? `Change ${prev.name}` : 'Add a node'}>
      <h3 style={{ margin: 0 }}>{prev ? `Change ${prev.name}` : 'Add a node'}</h3>
      <div className="grid two">
        <label className="field"><span>Kind</span>
          <select value={input.kind} onChange={(e) => { const k = e.target.value as PlantNodeKind; setInput({ ...input, kind: k, parentId: live.find((n) => n.id === input.parentId && PARENT_KINDS[k].includes(n.kind))?.id, needed: k === 'group' ? input.needed ?? 1 : undefined }); }}>
            {KINDS.map((k) => <option key={k} value={k}>{NODE_KIND_LABELS[k]}</option>)}
          </select></label>
        <label className="field"><span>Name</span><input value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} /></label>
        <label className="field"><span>Sits under</span>
          <select value={input.parentId ?? ''} onChange={(e) => setInput({ ...input, parentId: e.target.value || undefined })}>
            {PARENT_KINDS[input.kind].includes(null) && <option value="">Nothing (top level)</option>}
            {!PARENT_KINDS[input.kind].includes(null) && !input.parentId && <option value="">Choose…</option>}
            {parents.map((n) => <option key={n.id} value={n.id}>{n.name} ({NODE_KIND_LABELS[n.kind].toLowerCase()})</option>)}
          </select></label>
        <label className="field"><span>Place in process order</span><input type="number" min={0} value={input.order} onChange={(e) => setInput({ ...input, order: Number(e.target.value) })} /></label>
        <label className="field"><span>Functional location (optional)</span><input value={input.functionalLocation ?? ''} onChange={(e) => setInput({ ...input, functionalLocation: e.target.value || undefined })} /></label>
        {input.kind === 'group'
          ? <label className="field"><span>Needed to run</span><input type="number" min={1} max={100} value={input.needed ?? ''} onChange={(e) => setInput({ ...input, needed: num(e.target.value) })} /></label>
          : <label className="field"><span>Planned rate, t/h (optional)</span><input type="number" min={0} value={input.plannedRateTph ?? ''} onChange={(e) => setInput({ ...input, plannedRateTph: num(e.target.value) })} /></label>}
        <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      </div>
      {check.errors.length > 0 && !err && <div className="small muted">{check.errors.map((e) => <div key={e}>• {e}</div>)}</div>}
      <Warnings list={[...check.warnings, ...moves]} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" onClick={save}>{prev ? 'Save' : 'Add'}</button>
        <button className="btn" onClick={() => onDone()}>Cancel</button>
      </div>
      <Errors list={err} />
    </section>
  );
}
