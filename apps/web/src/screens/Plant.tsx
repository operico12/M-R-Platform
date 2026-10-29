// Plant overview (plan 4.3, Figure 7; docs/fixed-plant.md): circuits in process
// order, duty and standby groups, process delays shown apart from maintenance,
// circuit availability and throughput lost. Also: stops from the historian to
// classify, process delay records, plant KPIs, the historian file and settings.
// Every change runs through a core command; the rules decide.

import {
  DEFAULT_FLAG_RULES,
  NODE_KIND_LABELS,
  PLANT_STATE_LABELS,
  PLANT_SYSTEMS,
  can,
  circuitOf,
  classifyAsDelay,
  classifyAsMaintenance,
  classifyNotAStop,
  computeKpis,
  detectStops,
  endDelay,
  equipmentUnder,
  groupStops,
  parseHistorianCsv,
  plantNow,
  plantOf,
  plantReport,
  plantTree,
  proposeStop,
  recordDelay,
  runReadings,
  runningWhileDown,
  setPlantSettings,
  tripsPerWeek,
  voidDelay,
  wordsFor,
  type Asset,
  type DelayCode,
  type DownFlag,
  type PlantSettings,
  type PlantState,
  type PlantSummary,
  type PlantTree,
  type ProcessDelay,
  type RunSignal,
  type StopGroup,
  type TreeNode,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagSheet } from '../components/FlagSheet';
import { fmtHours, fmtNum, fmtPct, fromLocalInput, hoursSince, siteTime, stageLabel, toLocalInput } from '../format';
import { useApp } from '../store';

const TABS = [['overview', 'Overview'], ['delays', 'Process delays'], ['kpis', 'Plant KPIs'], ['historian', 'Historian file'], ['settings', 'Settings']] as const;
type Tab = (typeof TABS)[number][0];
const W = wordsFor('fixed_plant');
const ICON: Record<PlantState, string> = { run: '●', idle: '○', delay: '◆', down: '■' };
const t0 = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-CA'));

export function Plant({ query }: { query: string }) {
  const app = useApp();
  const q = new URLSearchParams(query);
  const tab = (TABS.find(([k]) => k === q.get('tab'))?.[0] ?? 'overview') as Tab;
  const p = app.plant;
  const tree = useMemo(() => plantTree(p.nodes, p.equipment), [p.nodes, p.equipment]);
  const [open, setOpen] = useState<Asset | null>(null);
  if (!p.nodes.length) {
    return (
      <div className="stack">
        <div className="page-head"><h2>Plant overview</h2></div>
        <p className="card">No plant structure at this site yet. Plant structure (plants, circuits and redundancy groups) is set up by an admin; the editor comes with the next part of fixed plant. The demo shows a synthetic concentrator.</p>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Plant overview</h2>
        <span className="muted small">Circuits in process order. Availability counts maintenance only; process delays are shown apart and never reduce it (A7 section 11).</span>
      </div>
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <a key={k} role="tab" className="chip" aria-pressed={tab === k} aria-selected={tab === k} href={`#/plant?tab=${k}`} style={{ minHeight: 40, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{l}</a>)}
      </div>
      {tab === 'overview' && <Overview tree={tree} onOpen={setOpen} />}
      {tab === 'delays' && <DelaysTab tree={tree} />}
      {tab === 'kpis' && <KpisTab tree={tree} />}
      {tab === 'historian' && <HistorianTab tree={tree} />}
      {tab === 'settings' && <SettingsTab />}
      {open && <FlagSheet asset={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Scope area for flag and delay permissions: the fleet of the equipment under the node. */
function areaFor(tree: PlantTree, nodeId: string, equipment: Asset[]): string {
  const ids = equipmentUnder(tree, nodeId);
  return equipment.find((a) => ids.includes(a.id))?.fleet ?? plantOf(tree, nodeId)?.node.name ?? '';
}

function nodeName(tree: PlantTree, id: string | undefined): string {
  return (id && tree.byId.get(id)?.node.name) || '—';
}

// ---------- overview ----------

function Overview({ tree, onOpen }: { tree: PlantTree; onOpen: (a: Asset) => void }) {
  const app = useApp();
  const p = app.plant;
  const input = useMemo(() => ({ ...p, now: app.now }), [p, app.now]);
  const week = useMemo(() => ({ from: new Date(Date.parse(app.now) - 7 * 864e5).toISOString(), to: app.now }), [app.now]);
  const report = useMemo(() => plantReport(input, week, tree), [input, week, tree]);
  const now = useMemo(() => plantNow(input, tree), [input, tree]);
  const openFlag = useMemo(() => new Map(p.flags.filter((f) => f.state === 'open').map((f) => [f.unitId, f])), [p.flags]);
  const groups = useMemo(() => groupStops(p.flags, tree, p.signals), [p.flags, tree, p.signals]);
  const activeDelays = p.delays.filter((d) => !d.voidedAt && !d.end);

  return (
    <div className="stack">
      <StopsToClassify tree={tree} groups={groups} />
      {tree.roots.map((root) => {
        const s = report.summary.get(root.node.id)!;
        const st = now.get(root.node.id);
        const circuits = flatten(root).filter((t) => t.node.kind === 'circuit');
        return (
          <section key={root.node.id} className="stack" aria-label={root.node.name}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <h3 style={{ margin: 0 }}>{root.node.name} <StateBadge state={st?.state} /></h3>
              <span className="small">
                Last 7 days: availability <strong>{fmtPct(s.availability)}</strong> · process delay {fmtHours(s.delayHours)}
                {s.lostTonnes && <> · lost {t0(s.lostTonnes.maintenance)} t maintenance, {t0(s.lostTonnes.process)} t process</>}
              </span>
            </div>
            {activeDelays.filter((d) => d.nodeId === root.node.id).map((d) => <DelayLine key={d.id} d={d} />)}
            <div className="circuits">
              {circuits.map((c) => (
                <CircuitCard key={c.node.id} t={c} tree={tree} s={report.summary.get(c.node.id)!} state={now.get(c.node.id)?.state} now={now} openFlag={openFlag} onOpen={onOpen}
                  area={tree.byId.get(c.node.parentId ?? '')?.node.kind === 'area' ? tree.byId.get(c.node.parentId!)!.node.name : undefined} delays={activeDelays} />
              ))}
            </div>
          </section>
        );
      })}
      <Legend />
    </div>
  );
}

function flatten(t: TreeNode): TreeNode[] {
  return [t, ...t.nodes.flatMap(flatten)];
}

function StateBadge({ state }: { state?: PlantState }) {
  if (!state) return null;
  return <span className={`pstate ${state}`}>{ICON[state]} {PLANT_STATE_LABELS[state]}</span>;
}

function Legend() {
  return (
    <p className="small muted">
      {(['run', 'idle', 'delay', 'down'] as PlantState[]).map((s) => <span key={s} className={`pstate ${s}`} style={{ marginRight: 12, whiteSpace: 'normal', display: 'inline-block' }}>{ICON[s]} {s === 'idle' ? 'Available (standby or stopped, not down)' : PLANT_STATE_LABELS[s]}</span>)}
    </p>
  );
}

function DelayLine({ d }: { d: ProcessDelay }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const eq = d.assetId ? app.plant.equipment.find((a) => a.id === d.assetId)?.unitNumber : undefined;
  return <div className="delayline small">◆ Process delay: <strong>{d.code}</strong>{eq ? ` (${eq})` : ''} since {siteTime(d.start, tz, true)}, {fmtHours(hoursSince(d.start, app.now))}</div>;
}

function CircuitCard({ t, tree, s, state, now, openFlag, onOpen, area, delays }: {
  t: TreeNode; tree: PlantTree; s: PlantSummary; state?: PlantState; now: Map<string, { state: PlantState; causes: string[] }>;
  openFlag: Map<string, DownFlag>; onOpen: (a: Asset) => void; area?: string; delays: ProcessDelay[];
}) {
  const app = useApp();
  return (
    <div className={`circuit ${state ?? ''}`}>
      {area && <div className="small muted">{area}</div>}
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <strong>{t.node.name}</strong>
        <StateBadge state={state} />
      </div>
      <div className="small">
        Availability <strong>{fmtPct(s.availability)}</strong> · delay {fmtHours(s.delayHours)}
        {s.rateTph && <span className="muted"> · {t0(s.rateTph)} t/h</span>}
      </div>
      {s.lostTonnes && <div className="small">Lost 7 d: <strong>{t0(s.lostTonnes.maintenance)} t</strong> maintenance, <strong>{t0(s.lostTonnes.process)} t</strong> process</div>}
      {delays.filter((d) => d.nodeId === t.node.id || (d.assetId && equipmentUnder(tree, t.node.id).includes(d.assetId))).map((d) => <DelayLine key={d.id} d={d} />)}
      <div className="eqs">
        {t.equipment.map((a) => <EquipTile key={a.id} a={a} state={now.get(a.id)?.state} flag={openFlag.get(a.id)} onOpen={onOpen} />)}
      </div>
      {t.nodes.map((g) => {
        const avail = g.equipment.filter((a) => now.get(a.id)?.state !== 'down').length;
        return (
          <div key={g.node.id} className="group">
            <div className="small"><strong>{g.node.name}</strong> <span className={avail < g.needed ? 'rag red' : 'muted'}>{g.needed} of {g.installed} needed · {avail} available</span></div>
            <div className="eqs">
              {g.equipment.map((a) => <EquipTile key={a.id} a={a} state={now.get(a.id)?.state} flag={openFlag.get(a.id)} onOpen={onOpen} standby={g.installed > g.needed} />)}
            </div>
          </div>
        );
      })}
      <div className="small muted" style={{ marginTop: 4 }}>{t.equipment.length + t.nodes.reduce((n, g) => n + g.equipment.length, 0)} {W.units.toLowerCase()} · {t.node.functionalLocation}</div>
    </div>
  );
}

function EquipTile({ a, state, flag, onOpen, standby }: { a: Asset; state?: PlantState; flag?: DownFlag; onOpen: (a: Asset) => void; standby?: boolean }) {
  const app = useApp();
  const st = state ?? 'idle';
  const word = st === 'idle' ? (standby ? 'Standby' : 'Available') : PLANT_STATE_LABELS[st];
  const sched = flag?.type === 'scheduled';
  return (
    <button className={`eq ${st}${sched ? ' sched' : ''}`} onClick={() => onOpen(a)} title={`${a.unitNumber}, ${a.model}: ${word}`}>
      <span className="unit">{a.unitNumber}</span>
      <span className="detail">{ICON[st]} {sched ? 'Planned' : word}</span>
      {flag && <span className="detail">{flag.system ?? flag.reasonCode} · {fmtHours(hoursSince(flag.start, app.now))} · {stageLabel(flag)}</span>}
    </button>
  );
}

// ---------- stops to classify ----------

function StopsToClassify({ tree, groups }: { tree: PlantTree; groups: StopGroup[] }) {
  const app = useApp();
  if (!groups.length) return <p className="small muted">No historian stops waiting to be classified.</p>;
  return (
    <section className="card warnbox" aria-label="Stops to classify">
      <h3 style={{ marginTop: 0 }}>Stops to classify ({groups.length})</h3>
      <p className="small muted">Each stop from the historian waits here as a proposed down flag. It counts nowhere until someone says whether it was maintenance or a process delay. Stops in one circuit that started together are one card.</p>
      <div className="stack">
        {groups.map((g) => <StopCard key={g.key} g={g} tree={tree} />)}
      </div>
      {!can(app.actor, 'set_clear_flag', areaFor(tree, groups[0]!.nodeId ?? '', app.plant.equipment)) && <p className="small locked">🔒 Supervisors in this area, reliability engineers and superintendents classify stops.</p>}
    </section>
  );
}

function StopCard({ g, tree }: { g: StopGroup; tree: PlantTree }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const eq = (id: string) => app.plant.equipment.find((a) => a.id === id)!;
  const first = g.flags[0]!;
  const nodeId = g.nodeId ?? circuitOf(tree, first.unitId) ?? '';
  const area = areaFor(tree, nodeId, app.plant.equipment);
  const codes = app.plantSettings.delayCodes.filter((c) => !c.retired);
  const [mode, setMode] = useState<'none' | 'maint' | 'delay' | 'not'>('none');
  const [unit, setUnit] = useState(first.unitId);
  const [system, setSystem] = useState('');
  const [code, setCode] = useState(codes[0]?.code ?? '');
  const [why, setWhy] = useState('');
  const [err, setErr] = useState<string[]>([]);
  const ok = can(app.actor, 'set_clear_flag', area);
  const covered = g.flags.some((f) => f.notes?.includes('standby took over'));
  const mins = g.end ? Math.round((Date.parse(g.end) - Date.parse(g.start)) / 60_000) : null;
  const show = (r: { ok: boolean; errors?: string[] }) => setErr(r.ok ? [] : r.errors ?? []);

  const maintenance = () => {
    const f = g.flags.find((x) => x.unitId === unit)!;
    const r = app.run(eq(unit), (ctx) => classifyAsMaintenance(ctx, f, system));
    if (!r.ok) return show(r);
    // The other stops in the card were knock-ons of this one.
    for (const o of g.flags.filter((x) => x.id !== f.id)) app.run(eq(o.unitId), (ctx) => classifyNotAStop(ctx, o, `Knock-on of the ${eq(unit).unitNumber} stop`));
    show(r);
  };
  const delay = () => show(app.runClassify(area, (ctxFor, dctx, delays) => classifyAsDelay(ctxFor, dctx, { flags: g.flags, nodeId }, delays, app.plantSettings.delayCodes, { code, end: g.end })));
  const notAStop = () => {
    for (const f of g.flags) {
      const r = app.run(eq(f.unitId), (ctx) => classifyNotAStop(ctx, f, why));
      if (!r.ok) return show(r);
    }
    setErr([]);
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <strong>{nodeName(tree, nodeId)}: {g.flags.map((f) => eq(f.unitId).unitNumber).join(', ')}</strong>
        <span className="small">Stopped at {siteTime(g.start, tz, true)}{g.end ? `, running again at ${siteTime(g.end, tz)} (${mins} min)` : ', still stopped'}</span>
      </div>
      {covered && <p className="small muted">The standby took over. If this was a planned duty change, choose Not a stop.</p>}
      {err.length > 0 && <div className="errors" role="alert">{err.map((e) => <div key={e}>{e}</div>)}</div>}
      {ok && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="btn" aria-pressed={mode === 'maint'} onClick={() => setMode('maint')}>Maintenance</button>
          <button className="btn" aria-pressed={mode === 'delay'} onClick={() => setMode('delay')}>Process delay</button>
          <button className="btn" aria-pressed={mode === 'not'} onClick={() => setMode('not')}>Not a stop</button>
        </div>
      )}
      {mode === 'maint' && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
          {g.flags.length > 1 && (
            <label className="field"><span>Which {W.unit.toLowerCase()} failed</span>
              <select value={unit} onChange={(e) => setUnit(e.target.value)}>{g.flags.map((f) => <option key={f.id} value={f.unitId}>{eq(f.unitId).unitNumber}</option>)}</select>
            </label>
          )}
          <label className="field"><span>System</span>
            <select value={system} onChange={(e) => setSystem(e.target.value)}><option value="">Choose…</option>{Object.keys(PLANT_SYSTEMS).map((s) => <option key={s}>{s}</option>)}</select>
          </label>
          <button className="btn primary" disabled={!system} onClick={maintenance}>Confirm as maintenance</button>
          <span className="small muted" style={{ flexBasis: '100%' }}>Opens an unscheduled down flag from {siteTime(g.start, tz)}{g.flags.length > 1 ? '; the other stops are marked as knock-ons' : ''}. Release it from the flag sheet{g.end ? '; the release form offers the run time from the historian' : ''}.</span>
        </div>
      )}
      {mode === 'delay' && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
          <label className="field"><span>Delay code</span>
            <select value={code} onChange={(e) => setCode(e.target.value)}>{codes.map((c) => <option key={c.code}>{c.code}</option>)}</select>
          </label>
          <button className="btn primary" disabled={!code} onClick={delay}>Record process delay</button>
          <span className="small muted" style={{ flexBasis: '100%' }}>One delay record on {nodeName(tree, nodeId)} from {siteTime(g.start, tz)}{g.end ? ` to ${siteTime(g.end, tz)}` : ', still open'}. It does not reduce maintenance availability.</span>
        </div>
      )}
      {mode === 'not' && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
          <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Reason</span><input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="For example a duty and standby change" /></label>
          <button className="btn" disabled={!why.trim()} onClick={notAStop}>Not a stop</button>
        </div>
      )}
    </div>
  );
}

// ---------- process delays ----------

function DelaysTab({ tree }: { tree: PlantTree }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const p = app.plant;
  const codes = app.plantSettings.delayCodes;
  const cat = (c: string) => (codes.find((x) => x.code === c)?.category === 'external' ? 'External' : 'Process');
  const since = Date.parse(app.now) - 28 * 864e5;
  const list = [...p.delays].filter((d) => !d.end || Date.parse(d.end) >= since).sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const nodes = [...tree.byId.values()].filter((t) => t.node.kind === 'circuit' || t.node.kind === 'plant');
  const [nodeId, setNodeId] = useState(nodes.find((t) => t.node.kind === 'circuit')?.node.id ?? '');
  const [code, setCode] = useState(codes.find((c) => !c.retired)?.code ?? '');
  const [start, setStart] = useState(() => toLocalInput(app.now, tz));
  const [end, setEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string[]>([]);
  const area = areaFor(tree, nodeId, p.equipment);
  const ok = can(app.actor, 'set_clear_flag', area);
  const add = () => {
    const r = app.runDelay(area, (ctx, delays) => recordDelay(ctx, delays, codes, {
      tenantId: app.ds.tenantId, siteId: app.ds.site.id, nodeId, code, start: fromLocalInput(start, tz), end: end ? fromLocalInput(end, tz) : null, notes,
    }));
    setErr(r.ok ? [] : r.errors);
    if (r.ok) { setNotes(''); setEnd(''); }
  };
  const act = (d: ProcessDelay, what: 'end' | 'void') => {
    const a = areaFor(tree, d.nodeId, p.equipment);
    const reason = what === 'void' ? window.prompt('Reason for voiding this delay') ?? '' : '';
    if (what === 'void' && !reason.trim()) return;
    const r = app.runDelay(a, (ctx) => (what === 'end' ? endDelay(ctx, d, new Date().toISOString()) : voidDelay(ctx, d, reason)));
    setErr(r.ok ? [] : r.errors);
  };
  return (
    <div className="stack">
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Record a process delay</h3>
        <p className="small muted">For a stop the historian did not catch, such as a circuit held for no feed. Stops the historian caught are classified on the Overview.</p>
        {ok ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label className="field"><span>Where</span>
              <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>{nodes.map((t) => <option key={t.node.id} value={t.node.id}>{t.node.name} ({NODE_KIND_LABELS[t.node.kind].toLowerCase()})</option>)}</select>
            </label>
            <label className="field"><span>Code</span>
              <select value={code} onChange={(e) => setCode(e.target.value)}>{codes.filter((c) => !c.retired).map((c) => <option key={c.code}>{c.code}</option>)}</select>
            </label>
            <label className="field"><span>Start (site time)</span><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="field"><span>End (empty while it runs)</span><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}><span>Notes</span><input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
            <button className="btn primary" disabled={!nodeId || !code} onClick={add}>Record</button>
          </div>
        ) : <p className="locked">🔒 Supervisors in this area, reliability engineers and superintendents record process delays.</p>}
        {err.length > 0 && <div className="errors" role="alert">{err.map((e) => <div key={e}>{e}</div>)}</div>}
      </section>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Last 28 days ({list.length})</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Start</th><th>Where</th><th>Code</th><th>Category</th><th>Hours</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.slice(0, 300).map((d) => (
                <tr key={d.id} style={d.voidedAt ? { opacity: 0.55 } : undefined}>
                  <td>{siteTime(d.start, tz, true)}</td>
                  <td>{nodeName(tree, d.nodeId)}{d.assetId ? ` · ${p.equipment.find((a) => a.id === d.assetId)?.unitNumber ?? ''}` : ''}</td>
                  <td>{d.code}</td>
                  <td>{cat(d.code)}</td>
                  <td>{fmtHours(((d.end ? Date.parse(d.end) : Date.parse(app.now)) - Date.parse(d.start)) / 3_600_000)}</td>
                  <td className="small">{d.voidedAt ? `Voided: ${d.voidReason}` : d.end ? 'Ended' : 'Running'}</td>
                  <td className="row" style={{ gap: 4 }}>
                    {!d.voidedAt && !d.end && <button className="btn" onClick={() => act(d, 'end')}>End now</button>}
                    {!d.voidedAt && <button className="btn danger" onClick={() => act(d, 'void')}>Void</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------- KPIs ----------

function KpisTab({ tree }: { tree: PlantTree }) {
  const app = useApp();
  const p = app.plant;
  const [days, setDays] = useState(28);
  const period = useMemo(() => ({ from: new Date(Date.parse(app.now) - days * 864e5).toISOString(), to: app.now }), [app.now, days]);
  const report = useMemo(() => plantReport({ ...p, now: app.now }, period, tree), [p, app.now, period, tree]);
  const readings = useMemo(() => runReadings(p.signals, app.now), [p.signals, app.now]);
  const rows = useMemo(() => {
    const out: Array<{ id: string; depth: number; name: string; kind: string; s: PlantSummary; trips: number; mtbf?: number | null; mttr?: number | null }> = [];
    const walk = (t: TreeNode, depth: number) => {
      const ids = equipmentUnder(tree, t.node.id);
      out.push({ id: t.node.id, depth, name: t.node.name, kind: NODE_KIND_LABELS[t.node.kind], s: report.summary.get(t.node.id)!, trips: tripsPerWeek(p.flags, ids, app.rules, period, app.now).perWeek });
      t.nodes.forEach((c) => walk(c, depth + 1));
      for (const a of t.equipment) {
        const k = computeKpis({ assets: [a], flags: p.flags, smu: readings, rules: app.rules ?? DEFAULT_FLAG_RULES, now: app.now }, period);
        out.push({ id: a.id, depth: depth + 1, name: `${a.unitNumber} ${a.model}`, kind: W.unit, s: report.summary.get(a.id)!, trips: tripsPerWeek(p.flags, [a.id], app.rules, period, app.now).perWeek, mtbf: k.mtbf, mttr: k.mttr });
      }
    };
    tree.roots.forEach((r) => walk(r, 0));
    return out;
  }, [tree, report, p.flags, readings, app.rules, app.now, period]);
  const [focus, setFocus] = useState(tree.roots.at(-1)?.node.id ?? '');
  const fs = report.summary.get(focus);
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="small">Period</span>
        <div className="chips">{[7, 28, 90].map((d) => <button key={d} className="chip" aria-pressed={days === d} onClick={() => setDays(d)}>Last {d} days</button>)}</div>
      </div>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Availability, utilisation and throughput lost</h3>
        <p className="small muted">KPI-033 to KPI-038 (KPI dictionary). Availability counts maintenance only. Utilisation = {W.meter.toLowerCase()} ÷ available hours, from historian signals. Circuits are not added into the plant: each plant uses its own roll-up, so a knock-on stop is not counted twice.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Availability</th><th>Utilisation</th><th>Down h</th><th>Process delay h</th><th>Lost t, maintenance</th><th>Lost t, process</th><th>Trips a week</th><th>MTBF ({W.meter.toLowerCase()})</th><th>MTTR</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={r.kind === W.unit ? { color: 'var(--text-2)' } : { fontWeight: r.depth === 0 ? 700 : 600 }}>
                  <td style={{ paddingLeft: 8 + r.depth * 14 }}>{r.name} <span className="small muted">{r.kind === W.unit ? '' : r.kind.toLowerCase()}</span></td>
                  <td>{fmtPct(r.s.availability)}</td>
                  <td>{fmtPct(r.s.utilisation)}</td>
                  <td>{fmtNum(r.s.downHours)}</td>
                  <td>{fmtNum(r.s.delayHours)}</td>
                  <td>{r.s.lostTonnes ? t0(r.s.lostTonnes.maintenance) : '—'}</td>
                  <td>{r.s.lostTonnes ? t0(r.s.lostTonnes.process) : '—'}</td>
                  <td>{fmtNum(r.trips)}</td>
                  <td>{r.mtbf === undefined ? '' : fmtHours(r.mtbf)}</td>
                  <td>{r.mttr === undefined ? '' : fmtHours(r.mttr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Throughput lost by cause</h3>
          <select value={focus} onChange={(e) => setFocus(e.target.value)} aria-label="Plant or circuit">
            {[...tree.byId.values()].filter((t) => t.node.plannedRateTph).map((t) => <option key={t.node.id} value={t.node.id}>{t.node.name}</option>)}
          </select>
        </div>
        {fs && fs.lost.length ? (
          <table>
            <thead><tr><th>Cause</th><th>Kind</th><th>Hours</th><th>Tonnes</th></tr></thead>
            <tbody>
              {fs.lost.slice(0, 15).map((l) => (
                <tr key={`${l.kind}${l.cause}`}><td>{l.cause}</td><td>{l.kind === 'maintenance' ? 'Maintenance' : 'Process delay'}</td><td>{fmtNum(l.hours)}</td><td>{t0(l.tonnes)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="small muted">Nothing lost in this period.</p>}
      </section>
    </div>
  );
}

// ---------- historian file ----------

function HistorianTab({ tree }: { tree: PlantTree }) {
  const app = useApp();
  const p = app.plant;
  const tz = app.ds.site.timeZone;
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const parsed = useMemo(() => (file ? parseHistorianCsv(file.text, p.equipment, tz, p.signals, app.now) : null), [file, p.equipment, p.signals, tz, app.now]);
  const allowed = can(app.actor, 'manage_imports');
  const r14 = useMemo(() => runningWhileDown({ ...p, now: app.now }, app.rules.alerts.smuRiseWhileDownHours, new Date(Date.parse(app.now) - 7 * 864e5).toISOString()), [p, app.now, app.rules]);
  const last = p.signals.reduce((m, s) => (Date.parse(s.at) > m ? Date.parse(s.at) : m), 0);

  const load = () => {
    if (!parsed || !file) return;
    const signals: RunSignal[] = parsed.signals;
    app.addSignals(file.name, signals, parsed.stats);
    // Stops in the new signals that nobody has accounted for become proposals.
    const since = signals.reduce((m, s) => Math.min(m, Date.parse(s.at)), Infinity);
    const stops = Number.isFinite(since) ? detectStops({ ...p, signals: [...p.signals, ...signals], now: new Date().toISOString() }, app.plantSettings, { since: new Date(since).toISOString(), tree }) : [];
    let n = 0;
    for (const s of stops) {
      const a = p.equipment.find((x) => x.id === s.assetId)!;
      if (app.run(a, (ctx) => proposeStop(ctx, s)).ok) n++;
    }
    setDone(`Loaded ${signals.length} signals from ${file.name}. ${n} new stop${n === 1 ? '' : 's'} to classify.`);
    setFile(null);
  };
  const sample = () => {
    const rows = ['tag,timestamp,value'];
    const t = Date.parse(app.now);
    const a = p.equipment[1] ?? p.equipment[0];
    if (a) {
      rows.push(`${a.unitNumber}.RUN,${toLocalInput(new Date(t - 50 * 60_000).toISOString(), tz).replace('T', ' ')},0`);
      rows.push(`${a.unitNumber}.RUN,${toLocalInput(new Date(t - 20 * 60_000).toISOString(), tz).replace('T', ' ')},1`);
    }
    const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
    const el = document.createElement('a');
    el.href = url;
    el.download = 'historian-sample.csv';
    el.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Load a historian export</h3>
        <p className="small muted">One row per change: tag (equipment number, ERP asset number or functional location, optionally with .RUN), timestamp (site time unless it has an offset) and value (1 or RUN, 0 or STOP). Loading the same file again changes nothing. The live historian connector comes with phase 1b.</p>
        <p className="small">{p.signals.length.toLocaleString('en-CA')} signals held · latest {last ? siteTime(new Date(last).toISOString(), tz, true) : '—'} · <button className="linkish" onClick={sample}>Download a sample file</button></p>
        {allowed ? (
          <input type="file" accept=".csv,text/csv" aria-label="Historian CSV file" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setDone(null); setFile({ name: f.name, text: await f.text() }); } }} />
        ) : <p className="locked">🔒 The data owner (Admin in phase 1a) loads historian files.</p>}
        {parsed && (
          <div className="stack" style={{ marginTop: 8 }}>
            <p className="small">{parsed.stats.rows} rows: <strong>{parsed.stats.added}</strong> new signals, {parsed.stats.skipped} skipped.</p>
            {parsed.issues.length > 0 && (
              <ul className="small">{parsed.issues.slice(0, 20).map((i) => <li key={`${i.row}${i.message}`}>Row {i.row}: {i.message}</li>)}{parsed.issues.length > 20 && <li>… and {parsed.issues.length - 20} more</li>}</ul>
            )}
            <button className="btn primary" disabled={!parsed.signals.length} onClick={load}>Load {parsed.signals.length} signals</button>
          </div>
        )}
        {done && <p className="small" role="status">{done}</p>}
      </section>
      <section className="card">
        <h3 style={{ marginTop: 0 }}>Running while flagged down (R14), last 7 days</h3>
        {r14.length ? <ul className="small">{r14.map((x) => <li key={x.flagId}>{x.message}</li>)}</ul> : <p className="small muted">None. {W.meter} come from the historian for plant equipment.</p>}
      </section>
    </div>
  );
}

// ---------- settings ----------

function SettingsTab() {
  const app = useApp();
  const cur = app.plantSettings;
  const [s, setS] = useState<PlantSettings>(cur);
  const [newCode, setNewCode] = useState('');
  const [newCat, setNewCat] = useState<DelayCode['category']>('process');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string[]>([]);
  const ok = can(app.actor, 'edit_plant_settings');
  const save = () => {
    const r = app.runPlantSettings((ctx, c) => setPlantSettings(ctx, c, s, reason));
    setMsg(r.ok ? ['Saved.'] : r.errors);
    if (r.ok) setReason('');
  };
  return (
    <section className="card stack">
      <h3 style={{ margin: 0 }}>Stop detection and process delay codes</h3>
      {!ok && <p className="locked">🔒 Reliability engineers, superintendents and admins change these.</p>}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label className="field"><span>Shortest stop (minutes)</span><input type="number" min={0} max={60} value={s.minStopMinutes} disabled={!ok} onChange={(e) => setS({ ...s, minStopMinutes: Number(e.target.value) })} /></label>
        <label className="field"><span>Duty change gap (minutes)</span><input type="number" min={0} max={60} value={s.changeoverMinutes} disabled={!ok} onChange={(e) => setS({ ...s, changeoverMinutes: Number(e.target.value) })} /></label>
        <label className="field"><span>Stops the standby covered</span>
          <select value={s.coveredStops} disabled={!ok} onChange={(e) => setS({ ...s, coveredStops: e.target.value as PlantSettings['coveredStops'] })}>
            <option value="propose">Propose them (a duty trip is never missed)</option>
            <option value="skip">Skip them</option>
          </select>
        </label>
      </div>
      <table>
        <thead><tr><th>Delay code</th><th>Category</th><th>In use</th></tr></thead>
        <tbody>
          {s.delayCodes.map((c, i) => (
            <tr key={c.code}>
              <td>{c.code}</td><td>{c.category === 'external' ? 'External' : 'Process'}</td>
              <td><input type="checkbox" aria-label={`${c.code} in use`} checked={!c.retired} disabled={!ok} onChange={(e) => setS({ ...s, delayCodes: s.delayCodes.map((x, j) => (j === i ? { ...x, retired: !e.target.checked || undefined } : x)) })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {ok && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field"><span>New code</span><input value={newCode} onChange={(e) => setNewCode(e.target.value)} /></label>
          <label className="field"><span>Category</span>
            <select value={newCat} onChange={(e) => setNewCat(e.target.value as DelayCode['category'])}><option value="process">Process</option><option value="external">External</option></select>
          </label>
          <button className="btn" disabled={!newCode.trim()} onClick={() => { setS({ ...s, delayCodes: [...s.delayCodes, { code: newCode.trim(), category: newCat }] }); setNewCode(''); }}>Add code</button>
        </div>
      )}
      {ok && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Reason for the change</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="btn primary" onClick={save}>Save settings</button>
        </div>
      )}
      {msg.length > 0 && <div className={msg[0] === 'Saved.' ? 'small' : 'errors'} role="status">{msg.map((m) => <div key={m}>{m}</div>)}</div>}
      <p className="small muted">Codes are retired, never removed, so old delays keep their code. Plant structure (plants, circuits, groups and the units needed) is set by an admin; its editor comes with the next part.</p>
    </section>
  );
}
