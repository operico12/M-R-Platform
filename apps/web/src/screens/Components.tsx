// Component life and rebuilds (phase 3; docs/component-life.md): the life board,
// change-out forecast, lives and Weibull, rebuild vendors, warranty claims and
// cores, target life, and a page per serial. Screens call core commands only.

import {
  hasRole,
  COMPONENT_KINDS, DEFAULT_LIFE_BANDS, EVENT_LABELS, KIND_LABELS, POSITIONS, REMOVAL_LABELS, STATUS_LABELS,
  allLives, burnRates, can, changeoutForecast, componentStates, coresOutstanding, costPerLifeHour, fitKind, forecastBuckets, lifeBoard, lifeRatio,
  lifeTargetFor, permission, positionById, proposeLifeTarget, recordEvent, registerComponent, riskBeforeTarget, smuIndex, vendorStats, voidEvent, warrantyClaims, withoutCosts,
  type ClaimStep, type ComponentKind, type ComponentState, type EventInput, type EventKind, type LifeBand, type ReceivedAs, type RemovalReason, type WeibullFit,
} from '@mr/core';
import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fromLocalInput, toLocalInput } from '../format';
import { useApp } from '../store';
import { SEV_STYLE, useOilByPosition } from './Condition';

type Tab = 'board' | 'forecast' | 'lives' | 'vendors' | 'claims' | 'targets';
const TABS: Array<[Tab, string]> = [['board', 'Life board'], ['forecast', 'Change-out forecast'], ['lives', 'Lives and Weibull'], ['vendors', 'Rebuild vendors'], ['claims', 'Warranty and cores'], ['targets', 'Target life']];

const KIND_COLOURS: Record<ComponentKind, string> = {
  engine: '#1f6feb', transmission: '#8250df', torque_converter: '#bf3989', differential: '#b26a00', final_drive: '#2e7d32', front_strut: '#0a7f8a', rear_strut: '#607d8b',
};
const BAND_LABELS: Record<LifeBand, string> = { green: 'Below 75%', amber: '75% to 90%', red: '90% to 100%', past: 'Past target', none: 'No target' };
const bandBg = (b: LifeBand) =>
  b === 'green' ? 'color-mix(in srgb, var(--run) 22%, var(--surface))'
    : b === 'amber' ? 'color-mix(in srgb, var(--sched) 30%, var(--surface))'
      : b === 'red' ? 'color-mix(in srgb, var(--down) 30%, var(--surface))'
        : b === 'past' ? 'var(--down)' : 'var(--surface-2)';

/** Site-local date as YYYY-MM-DD (site time zone, never the browser's). */
const siteDate = (iso: string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' });
const dayTime = (iso: string, tz: string) => new Date(iso).toLocaleString('en-CA', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const yearBefore = (iso: string) => new Date(Date.parse(iso) - 365 * 86400000).toISOString();
const h0 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : Math.round(x).toLocaleString('en-CA'));
const pct = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const money = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `$${x.toLocaleString('en-CA', { minimumFractionDigits: d, maximumFractionDigits: d })}`);

/** Everything the page shows, worked out once from the events. */
function useComponents() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const costs = can(app.actor, 'view_cost');
  const events = useMemo(() => (costs ? app.componentEvents : withoutCosts(app.componentEvents)), [costs, app.componentEvents]);
  const idx = useMemo(() => smuIndex(app.ds.smu), [app.ds.smu]);
  const states = useMemo(() => componentStates(app.components, events, app.ds.assets, idx, app.now), [app.components, events, app.ds.assets, idx, app.now]);
  const today = siteDate(app.now, tz);
  const lives = useMemo(() => allLives(states), [states]);
  const rates = useMemo(() => burnRates(app.ds.assets, idx, app.ds.lifecycle, app.now, tz), [app.ds.assets, idx, app.ds.lifecycle, app.now, tz]);
  const forecast = useMemo(() => changeoutForecast(states, app.ds.assets, app.lifeTargets, rates, app.now, tz), [states, app.ds.assets, app.lifeTargets, rates, app.now, tz]);
  const fits = useMemo(() => {
    const m = new Map<string, { fit: WeibullFit | null; n: number; failures: number; error?: string }>();
    const models = [...new Set(app.ds.assets.map((a) => a.model))].sort();
    for (const kind of COMPONENT_KINDS) for (const model of models) {
      const f = fitKind(lives, kind, model);
      if (f.data.length) m.set(`${kind}|${model}`, { fit: f.fit, n: f.data.length, failures: f.data.filter((x) => x.failed).length, error: f.error });
    }
    return m;
  }, [lives, app.ds.assets]);
  return { app, tz, costs, events, idx, states, today, lives, rates, forecast, fits };
}
type Data = ReturnType<typeof useComponents>;

export function Components({ arg, query }: { arg?: string; query: string }) {
  const d = useComponents();
  if (arg === 'new') return <Register d={d} />;
  if (arg) return <Serial d={d} id={arg} />;
  const q = new URLSearchParams(query);
  const tab = (TABS.find(([k]) => k === q.get('tab'))?.[0] ?? 'board') as Tab;
  const go = (t: Tab) => { window.location.hash = `#/components?tab=${t}`; };
  const { app, tz, states, forecast, lives, today } = d;
  const installed = states.filter((s) => s.status === 'installed').length;
  const past = forecast.filter((f) => f.dueNow).length;
  const in12 = forecast.filter((f) => f.due && Date.parse(f.due) < Date.parse(app.now) + 84 * 86400000).length;
  const yearAgo = yearBefore(app.now);
  const ratio = lifeRatio(lives, app.lifeTargets, yearAgo, app.now, tz);
  const cph = costPerLifeHour(lives.filter((l) => l.end && l.end >= yearAgo));
  const claims = warrantyClaims(states).length;
  const cores = coresOutstanding(states, app.now, tz);
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Components</h2>
        <span className="muted small">Major components by serial: hours against target life, change-outs ahead, lives and rebuilds.</span>
        <div className="grow" />
        {can(app.actor, 'record_components') && <a className="btn" href="#/components/new" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Register a component</a>}
      </div>
      <div className="grid kpis">
        <Tile label="Installed" value={String(installed)} note={`${states.length} serials in all`} />
        <Tile label="Past target life" value={String(past)} note={`${in12} more due in the next 12 weeks`} warn={past > 0} />
        <Tile label="Life ratio, last 12 months (KPI-030)" value={`${pct(ratio.failures.mean)} / ${pct(ratio.planned.mean)}`} note={`failures (${ratio.failures.n}) / planned (${ratio.planned.n}); ${ratio.early} early failures`} />
        {d.costs && <Tile label="Cost per hour of life (KPI-031)" value={money(cph.perHour, 2)} note={`${cph.lives} lives ended in 12 months`} />}
        <Tile label="Warranty claims due" value={String(claims)} note={`${cores.length} cores outstanding, ${cores.filter((c) => c.overdue).length} overdue`} warn={claims > 0 || cores.some((c) => c.overdue)} />
      </div>
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <button key={k} role="tab" className="chip" aria-pressed={tab === k} onClick={() => go(k)} style={{ minHeight: 40 }}>{l}</button>)}
      </div>
      {tab === 'board' && <Board d={d} />}
      {tab === 'forecast' && <Forecast d={d} />}
      {tab === 'lives' && <Lives d={d} />}
      {tab === 'vendors' && <Vendors d={d} />}
      {tab === 'claims' && <Claims d={d} />}
      {tab === 'targets' && <Targets d={d} today={today} />}
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

const serialLink = (s: ComponentState) => <a href={`#/components/${s.component.id}`}>{s.component.serial}</a>;
const unitNo = (d: Data, id?: string) => d.app.ds.assets.find((a) => a.id === id)?.unitNumber ?? '—';

// ---------- board ----------

function Board({ d }: { d: Data }) {
  const models = [...new Set(d.app.ds.assets.map((a) => a.model))].sort();
  const [model, setModel] = useState('');
  const rows = lifeBoard(d.states, d.app.ds.assets.filter((a) => !model || a.model === model), d.app.lifeTargets, d.today);
  const oil = useOilByPosition();
  const anyOil = d.app.oilSamples.length > 0;
  return (
    <section className="card">
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Life board</h3>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}><option value="">All</option>{models.map((m) => <option key={m}>{m}</option>)}</select>
        </label>
      </div>
      <p className="small muted">% of target life since the last rebuild. The mark under it is the latest oil result for that compartment (● OK, ◆ Monitor, ▲ Action, ✖ Critical); open it on the Condition page.</p>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Unit</th>{POSITIONS.map((p) => <th key={p.id} title={p.label}>{p.short}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.unit.id}>
                <th style={{ textAlign: 'left' }}><a href={`#/unit/${r.unit.id}`}>{r.unit.unitNumber}</a> <span className="muted">{r.unit.model}</span></th>
                {r.cells.map((c) => { const o = oil(r.unit.id, c.position.id); return (
                  <td key={c.position.id} style={{ padding: 0 }}>
                    {c.state ? (
                      <a href={`#/components/${c.state.component.id}`} title={`${c.position.label}: ${c.state.component.serial}, ${h0(c.state.hours)} h of ${h0(c.target)} h${o ? `. Oil: ${o.severity}` : ''}`}
                        style={{ display: 'block', minWidth: 52, padding: '8px 6px', textAlign: 'center', textDecoration: 'none', fontWeight: 600, background: bandBg(c.band), color: c.band === 'past' ? '#fff' : 'var(--text)' }}>
                        {c.ratio === null ? h0(c.state.hours) : pct(c.ratio)}
                        {o ? <span style={{ display: 'block', fontSize: 11, fontWeight: 700, marginTop: 2 }}><span style={{ padding: '0 4px', borderRadius: 3, background: SEV_STYLE[o.severity].bg, color: SEV_STYLE[o.severity].fg }}>{SEV_STYLE[o.severity].shape} {SEV_STYLE[o.severity].short}</span></span>
                          : anyOil && <span aria-hidden style={{ display: 'block', fontSize: 11, marginTop: 2, visibility: 'hidden' }}>-</span>}
                      </a>
                    ) : <span className="muted" style={{ display: 'block', padding: '8px 6px', textAlign: 'center' }}>empty</span>}
                  </td>
                ); })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row small" style={{ gap: 12, marginTop: 8 }}>
        {(['green', 'amber', 'red', 'past'] as LifeBand[]).map((b) => (
          <span key={b} className="row" style={{ gap: 4 }}><span aria-hidden style={{ width: 14, height: 14, borderRadius: 3, background: bandBg(b), border: '1px solid var(--border)' }} />{BAND_LABELS[b]}</span>
        ))}
        <span className="muted">Bands {pct(DEFAULT_LIFE_BANDS[0])} and {pct(DEFAULT_LIFE_BANDS[1])}.</span>
      </div>
    </section>
  );
}

// ---------- forecast ----------

function Forecast({ d }: { d: Data }) {
  const { app, tz, forecast, fits } = d;
  const [unit, setUnit] = useState<'week' | 'month'>('week');
  const buckets = forecastBuckets(forecast, app.now, tz, unit, 12);
  const data = buckets.map((b) => ({ label: b.label, ...b.byKind }));
  const horizon = buckets.at(-1)!.to;
  const list = forecast.filter((f) => f.due && f.due < horizon);
  const noRate = forecast.filter((f) => !f.due);
  return (
    <div className="stack">
      <section className="card">
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Change-outs due</h3>
          <div className="chips">{(['week', 'month'] as const).map((u) => <button key={u} className="chip" aria-pressed={unit === u} onClick={() => setUnit(u)} style={{ minHeight: 36 }}>{u === 'week' ? 'Next 12 weeks' : 'Next 12 months'}</button>)}</div>
        </div>
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-2)' }} interval={0} angle={-30} textAnchor="end" height={50} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-2)' }} />
              <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)' }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {COMPONENT_KINDS.map((k) => <Bar key={k} dataKey={k} name={KIND_LABELS[k]} stackId="a" fill={KIND_COLOURS[k]} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="small muted">When each installed component reaches its target life, at the unit's SMU hours per day over the last 28 days (the model's average when a unit has too few readings). Ones already past target are in the first {unit}.</p>
      </section>
      <section className="card">
        <h3>Due in the next 12 {unit}s ({list.length})</h3>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Due</th><th>Unit</th><th>Position</th><th>Serial</th><th>Hours</th><th>Target</th><th>Hours left</th><th>h/day</th><th title="Chance it fails before reaching target life (Weibull for this kind and model)">Fails first</th></tr></thead>
            <tbody>
              {list.map((f) => {
                const w = fits.get(`${f.position.kind}|${f.unit.model}`)?.fit;
                const risk = w ? riskBeforeTarget(w.beta, w.eta, f.state.hours, f.target) : null;
                return (
                  <tr key={f.state.component.id}>
                    <td>{f.dueNow ? <strong style={{ color: 'var(--down)' }}>Now</strong> : day(f.due!, tz)}</td>
                    <td><a href={`#/unit/${f.unit.id}`}>{f.unit.unitNumber}</a></td>
                    <td>{f.position.label}</td>
                    <td>{serialLink(f.state)}</td>
                    <td>{h0(f.state.hours)}</td><td>{h0(f.target)}</td><td>{h0(f.remaining)}</td>
                    <td>{f.rate.perDay === null ? '—' : f.rate.perDay.toFixed(1)}{f.rate.source === 'model' && <span className="muted" title="Model average"> m</span>}</td>
                    <td>{risk === null ? '—' : pct(risk)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {noRate.length > 0 && <p className="small muted">{noRate.length} installed components have no forecast date: the unit is parked or has no SMU readings.</p>}
      </section>
    </div>
  );
}

// ---------- lives and Weibull ----------

function Lives({ d }: { d: Data }) {
  const { app, tz, lives, fits } = d;
  const yearAgo = yearBefore(app.now);
  const rows = [...fits.entries()].map(([k, v]) => { const [kind, model] = k.split('|') as [ComponentKind, string]; return { kind, model, ...v }; });
  return (
    <div className="stack">
      <section className="card">
        <h3>Weibull by component and model</h3>
        <p className="small muted">Failed lives are failures; planned removals and components still running are suspensions (C-05). β above 1 means wear-out, so a planned change-out can prevent failures.</p>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Component</th><th>Model</th><th>Lives</th><th>Failures</th><th>β</th><th>η</th><th>B10</th><th>Target</th><th>Life ratio 12 mo (fail / planned)</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const lr = lifeRatio(lives.filter((l) => l.kind === r.kind && l.model === r.model), app.lifeTargets, yearAgo, app.now, tz);
                const target = lifeTargetFor(app.lifeTargets, r.model, r.kind, d.today)?.hours;
                return (
                  <tr key={`${r.kind}|${r.model}`}>
                    <td>{KIND_LABELS[r.kind]}</td><td>{r.model}</td><td>{r.n}</td><td>{r.failures}</td>
                    <td>{r.fit ? `${r.fit.beta.toFixed(2)} (${r.fit.betaBounds[0].toFixed(2)}–${r.fit.betaBounds[1].toFixed(2)})` : <span className="muted" title={r.error}>—</span>}</td>
                    <td>{r.fit ? h0(r.fit.eta) : '—'}</td><td>{r.fit ? h0(r.fit.b10) : '—'}</td><td>{h0(target)}</td>
                    <td>{pct(lr.failures.mean)} / {pct(lr.planned.mean)}</td>
                    <td><a href={`#/calc/rebuild_or_replace?kind=${r.kind}&model=${encodeURIComponent(r.model)}`}>Rebuild or replace</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">Bounds are 90% two-sided. Fewer than 5 failures gives very wide bounds: treat those as a first look.</p>
      </section>
    </div>
  );
}

// ---------- vendors ----------

function Vendors({ d }: { d: Data }) {
  const rows = vendorStats(d.states, d.app.lifeTargets, d.tz);
  return (
    <section className="card">
      <h3>Rebuild vendors</h3>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Vendor</th><th>Sent</th><th>Back</th><th>At vendor now</th><th>Turnaround</th><th>Ended lives</th><th>Mean life after rebuild</th><th>Life ratio</th><th>Early failures</th>{d.costs && <th>Cost per hour</th>}</tr></thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.vendor}>
                <td>{v.vendor}</td><td>{v.sent}</td><td>{v.returned}</td><td>{v.atVendor}</td>
                <td>{v.turnaroundDays === null ? '—' : `${v.turnaroundDays.toFixed(0)} d`}</td><td>{v.ended}</td><td>{h0(v.meanLife)}</td><td>{pct(v.meanRatio)}</td><td>{v.early}</td>
                {d.costs && <td>{money(v.costPerHour, 2)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">Life statistics need at least 3 ended lives. An early failure is a failed life below 25% of target, which points at rebuild or fitting quality.</p>
    </section>
  );
}

// ---------- warranty and cores ----------

function Claims({ d }: { d: Data }) {
  const claims = warrantyClaims(d.states);
  const cores = coresOutstanding(d.states, d.app.now, d.tz);
  const date = (iso: string) => day(iso, d.tz);
  return (
    <div className="grid two">
      <section className="card">
        <h3>Warranty claims due ({claims.length})</h3>
        <p className="small muted">Failures while under warranty that no accepted or rejected claim has closed.</p>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Serial</th><th>Component</th><th>Failed</th><th>Claim</th></tr></thead>
            <tbody>
              {claims.map((s) => {
                const open = s.events.some((e) => e.kind === 'warranty_claim' && e.claim === 'opened' && e.at >= s.claimDue!.at);
                return <tr key={s.component.id}><td>{serialLink(s)}</td><td>{KIND_LABELS[s.component.kind]}</td><td>{date(s.claimDue!.at)}</td><td>{open ? 'Opened, waiting' : <strong>Not opened</strong>}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h3>Cores outstanding ({cores.length})</h3>
        <p className="small muted">Exchange components whose core has not gone back yet.</p>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Serial</th><th>Component</th><th>Due back</th></tr></thead>
            <tbody>
              {cores.map((c) => <tr key={c.state.component.id}><td>{serialLink(c.state)}</td><td>{KIND_LABELS[c.state.component.kind]}</td><td style={{ color: c.overdue ? 'var(--down)' : undefined, fontWeight: c.overdue ? 700 : undefined }}>{c.dueBy}{c.overdue ? ' (overdue)' : ''}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ---------- target life ----------

function Targets({ d, today }: { d: Data; today: string }) {
  const { app } = d;
  const models = [...new Set(app.ds.assets.map((a) => a.model))].sort();
  const [form, setForm] = useState({ model: models[0] ?? '', kind: 'engine' as ComponentKind, hours: '', from: today, reason: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const p = permission(app.actor, 'edit_life_targets');
  const allowed = p === 'propose' || p === 'approve';
  const pending = app.requests.filter((r) => r.kind === 'life_target' && r.status === 'pending');
  const history = [...app.lifeTargets].filter((t) => t.requestId).sort((a, b) => Date.parse(b.setAt) - Date.parse(a.setAt)).slice(0, 10);
  const save = () => {
    const r = app.runRequest((ctx) => proposeLifeTarget(ctx, app.lifeTargets, app.requests, { model: form.model, kind: form.kind, hours: Number(form.hours), effectiveFrom: form.from, reason: form.reason }));
    setMsg(r.ok ? { ok: true, text: `Sent for approval: ${r.records.at(-1)!.title}. A superintendent who did not ask approves it in Console → Approvals; it applies from then.` } : { ok: false, text: r.errors.join(' ') });
    if (r.ok) setForm((f) => ({ ...f, hours: '', reason: '' }));
  };
  return (
    <div className="grid two">
      <section className="card">
        <h3>Target life now</h3>
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Component</th>{models.map((m) => <th key={m}>{m}</th>)}</tr></thead>
            <tbody>
              {COMPONENT_KINDS.map((k) => (
                <tr key={k}><td>{KIND_LABELS[k]}</td>{models.map((m) => { const t = lifeTargetFor(app.lifeTargets, m, k, today); return <td key={m} title={t ? `From ${t.effectiveFrom}: ${t.reason}` : undefined}>{t ? `${h0(t.hours)} h` : '—'}</td>; })}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h3>Ask for a target life change</h3>
        <p className="small muted">{allowed ? 'A superintendent who did not ask approves it before it applies, the same as KPI targets.' : 'Reliability engineers and superintendents ask for target life changes; a superintendent approves them.'}</p>
        {allowed && (
          <div className="stack" style={{ gap: 10 }}>
            <label className="field"><span>Model</span><select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>{models.map((m) => <option key={m}>{m}</option>)}</select></label>
            <label className="field"><span>Component</span><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ComponentKind })}>{COMPONENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></label>
            <label className="field"><span>Target life (h)</span><input inputMode="numeric" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>
            <label className="field"><span>Applies from (site date)</span><input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></label>
            <label className="field"><span>Reason</span><input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="For example, OEM bulletin or site strategy review" /></label>
            <button className="btn primary" onClick={save}>Send for approval</button>
            {msg && <div className={msg.ok ? 'card' : 'errors'} role="status">{msg.text}</div>}
          </div>
        )}
        {pending.length > 0 && (
          <>
            <h4>Waiting for approval</h4>
            <ul className="small">{pending.map((r) => <li key={r.id}><a href="#/console/approvals">{r.title}</a> · asked by {app.userName(r.requestedBy)}</li>)}</ul>
          </>
        )}
        {history.length > 0 && (
          <>
            <h4>Recent changes</h4>
            <ul className="small">{history.map((t) => <li key={t.id}>{t.model} {KIND_LABELS[t.kind].toLowerCase()}: {h0(t.hours)} h from {t.effectiveFrom}, asked by {app.userName(t.setBy)}, approved by {t.approvedBy ? app.userName(t.approvedBy) : '—'}</li>)}</ul>
          </>
        )}
      </section>
    </div>
  );
}

// ---------- one serial ----------

const NEXT: Record<ComponentState['status'], Array<Exclude<EventKind, 'received'>>> = {
  in_store: ['installed', 'sent_rebuild', 'scrapped', 'warranty_claim', 'core_returned'],
  installed: ['removed', 'warranty_claim', 'core_returned'],
  at_rebuild: ['returned_rebuild', 'scrapped', 'warranty_claim', 'core_returned'],
  scrapped: [],
  void: [],
};

function Serial({ d, id }: { d: Data; id: string }) {
  const { app, tz } = d;
  const [voidMsg, setVoidMsg] = useState<string | null>(null);
  const s = d.states.find((x) => x.component.id === id);
  if (!s) return <div className="card">Component not found. <a href="#/components">Back to components</a></div>;
  const c = s.component;
  const unit = app.ds.assets.find((a) => a.id === s.unitId);
  const target = unit && s.position ? lifeTargetFor(app.lifeTargets, unit.model, c.kind, d.today)?.hours : lifeTargetFor(app.lifeTargets, c.models[0], c.kind, d.today)?.hours;
  const latest = s.events.at(-1);
  const all = d.events.filter((e) => e.componentId === id).sort((a, b) => a.at.localeCompare(b.at) || a.enteredAt.localeCompare(b.enteredAt));
  const when = (iso: string) => dayTime(iso, tz);
  const doVoid = () => {
    const reason = window.prompt('Why is this event wrong? It stays in the history, marked void.');
    if (reason === null || !latest) return;
    const r = app.runComponents((ctx, data) => voidEvent(ctx, data, latest.id, reason));
    setVoidMsg(r.ok ? 'Voided.' : r.errors.join(' '));
  };
  const canVoid = latest && (latest.enteredBy === app.actor.userId || hasRole(app.actor, 'superintendent'));
  return (
    <div className="stack">
      <div className="page-head">
        <h2><a href="#/components" className="small" style={{ fontWeight: 400 }}>Components</a> / {KIND_LABELS[c.kind]} {c.serial}</h2>
        <span className="muted small">{STATUS_LABELS[s.status]}{unit ? ` on ${unit.unitNumber}, ${positionById(s.position ?? '')?.label}` : s.status === 'at_rebuild' ? ` at ${s.vendor}` : ''}</span>
      </div>
      <div className="grid kpis">
        <Tile label="Hours since rebuild" value={`${h0(s.hours)} h`} note={target ? `${pct(s.hours / target)} of ${h0(target)} h target` : 'No target set'} warn={!!target && s.hours >= target} />
        <Tile label="Rebuilds" value={String(s.rebuilds)} note={c.models.length ? `Fits ${c.models.join(', ')}` : 'Fits any model'} />
        <Tile label="Lives" value={String(s.lives.length)} note={`${s.lives.filter((l) => l.end && l.failed).length} ended in failure`} />
        <Tile label="Warranty" value={s.claimDue ? 'Claim due' : s.warranty ? 'Recorded' : 'None'} note={s.warranty ? [s.warranty.hours ? `${h0(s.warranty.hours)} h` : '', s.warranty.months ? `${s.warranty.months} months` : ''].filter(Boolean).join(' or ') + ` from ${day(s.warranty.from, tz)}` : undefined} warn={!!s.claimDue} />
      </div>
      <div className="grid two">
        <section className="card">
          <h3>History</h3>
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>When</th><th>Event</th><th>Details</th>{d.costs && <th>Cost</th>}</tr></thead>
              <tbody>
                {all.map((e) => (
                  <tr key={e.id} style={{ textDecoration: e.voidedAt ? 'line-through' : undefined, opacity: e.voidedAt ? 0.6 : 1 }}>
                    <td>{when(e.at)}</td>
                    <td>{EVENT_LABELS[e.kind]}{e.kind === 'removed' && e.reason ? `: ${REMOVAL_LABELS[e.reason].toLowerCase()}` : ''}{e.kind === 'warranty_claim' && e.claim ? `: ${e.claim}` : ''}</td>
                    <td>{[
                      e.unitId ? `${unitNo(d, e.unitId)} ${positionById(e.position ?? '')?.label ?? ''}` : '', e.smu !== undefined ? `SMU ${h0(e.smu)}` : '', e.vendor ?? '', e.receivedAs ?? '',
                      e.workOrder ? `WO ${e.workOrder}` : '', e.flagId ? 'down flag linked' : '', e.reference ?? '', e.coreDueBy ? `core due ${e.coreDueBy}` : '',
                      e.warrantyHours ? `warranty ${h0(e.warrantyHours)} h` : '', e.warrantyMonths ? `${e.warrantyMonths} months` : '', e.note ?? '', e.voidedAt ? `VOID: ${e.voidReason}` : '',
                    ].filter(Boolean).join(' · ')}</td>
                    {d.costs && <td>{money(e.cost)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canVoid && <button className="btn" onClick={doVoid} style={{ marginTop: 8 }}>Void the latest event</button>}
          {voidMsg && <p className="small" role="status">{voidMsg}</p>}
          <h3 style={{ marginTop: 16 }}>Lives</h3>
          <div className="table-wrap">
            <table className="small">
              <thead><tr><th>Started</th><th>By</th><th>Ended</th><th>Hours</th><th>Outcome</th>{d.costs && <th>Cost per hour</th>}</tr></thead>
              <tbody>
                {s.lives.map((l) => (
                  <tr key={l.start}>
                    <td>{day(l.start, tz)}</td><td>{l.startedBy === 'rebuild' ? l.vendor ?? 'Rebuild' : 'Received'}</td>
                    <td>{l.end ? day(l.end, tz) : 'Running'}</td><td>{h0(l.hours)}</td>
                    <td>{l.end ? (l.failed ? 'Failure' : 'Suspension') : 'Open'}</td>
                    {d.costs && <td>{l.cost !== undefined && l.hours > 0 ? money((l.cost - l.recovered) / l.hours, 2) : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <RecordEvent d={d} s={s} />
      </div>
    </div>
  );
}

function RecordEvent({ d, s }: { d: Data; s: ComponentState }) {
  const { app, tz } = d;
  const kinds = NEXT[s.status];
  const [kind, setKind] = useState<Exclude<EventKind, 'received'>>(kinds[0] ?? 'installed');
  const [f, setF] = useState<Record<string, string>>({ at: toLocalInput(app.now, tz) });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!can(app.actor, 'record_components')) return <section className="card"><h3>Record an event</h3><p className="small muted">Supervisors, reliability engineers and superintendents record component events.</p></section>;
  if (!kinds.length) return <section className="card"><h3>Record an event</h3><p className="small muted">This component is {STATUS_LABELS[s.status].toLowerCase()}: no more events.</p></section>;
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const num = (k: string) => (f[k]?.trim() ? Number(f[k]) : undefined);
  const fitsPos = POSITIONS.filter((p) => p.kind === s.component.kind);
  const unitFlags = app.flags.filter((x) => x.unitId === s.unitId && x.type === 'unscheduled').sort((a, b) => b.start.localeCompare(a.start)).slice(0, 10);
  const submit = () => {
    const input: EventInput = {
      kind, at: fromLocalInput(f.at ?? '', tz), unitId: f.unitId, position: f.position, smu: num('smu'), reason: f.reason as RemovalReason | undefined,
      flagId: f.flagId || undefined, workOrder: f.workOrder, vendor: f.vendor, reference: f.reference, cost: num('cost'),
      warrantyHours: num('warrantyHours'), warrantyMonths: num('warrantyMonths'), claim: f.claim as ClaimStep | undefined, note: f.note,
    };
    const r = app.runComponents((ctx, data) => recordEvent(ctx, data, s.component.id, input));
    setMsg(r.ok ? { ok: true, text: ['Saved.', ...r.warnings].join(' ') } : { ok: false, text: r.errors.join(' ') });
    if (r.ok) setF({ at: toLocalInput(new Date().toISOString(), tz) });
  };
  const field = (k: string, label: string, el?: ReactNode) => <label className="field" key={k}><span>{label}</span>{el ?? <input value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} />}</label>;
  const select = (k: string, options: Array<[string, string]>) => <select value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)}><option value="">Choose…</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  return (
    <section className="card">
      <h3>Record an event</h3>
      <div className="stack" style={{ gap: 10 }}>
        {field('kind', 'Event', <select value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setMsg(null); }}>{kinds.map((k) => <option key={k} value={k}>{EVENT_LABELS[k]}</option>)}</select>)}
        {field('at', 'When (site time)', <input type="datetime-local" value={f.at ?? ''} onChange={(e) => set('at', e.target.value)} />)}
        {kind === 'installed' && <>
          {field('unitId', 'Unit', select('unitId', app.ds.assets.filter((a) => a.assetClass === 'mobile' && (!s.component.models.length || s.component.models.includes(a.model))).map((a) => [a.id, `${a.unitNumber} (${a.model})`])))}
          {field('position', 'Position', select('position', fitsPos.map((p) => [p.id, p.label])))}
          {field('smu', 'Unit SMU (h)')}
          {field('workOrder', 'Work order')}
        </>}
        {kind === 'removed' && <>
          {field('reason', 'Reason', select('reason', Object.entries(REMOVAL_LABELS) as Array<[string, string]>))}
          {field('smu', 'Unit SMU (h)')}
          {f.reason === 'failure' && field('flagId', 'Down flag', select('flagId', unitFlags.map((x) => [x.id, `${dayTime(x.start, tz)} ${x.release?.system ?? x.system ?? x.reasonCode}`])))}
          {field('workOrder', 'Work order')}
        </>}
        {kind === 'sent_rebuild' && <>{field('vendor', 'Rebuild vendor')}{field('reference', 'PO or vendor reference')}</>}
        {kind === 'returned_rebuild' && <>
          {field('reference', 'Vendor reference')}
          {d.costs && field('cost', 'Rebuild cost ($)')}
          {field('warrantyHours', 'Warranty hours')}{field('warrantyMonths', 'Warranty months')}
        </>}
        {kind === 'warranty_claim' && <>
          {field('claim', 'Step', select('claim', [['opened', 'Opened'], ['accepted', 'Accepted'], ['rejected', 'Rejected']]))}
          {field('reference', 'Claim number')}
          {d.costs && f.claim === 'accepted' && field('cost', 'Amount recovered ($)')}
        </>}
        {kind === 'core_returned' && <>{field('reference', 'Return reference')}{d.costs && field('cost', 'Core credit ($)')}</>}
        {field('note', kind === 'scrapped' ? 'Why it is scrapped' : 'Note')}
        <button className="btn primary" onClick={submit}>Save {EVENT_LABELS[kind].toLowerCase()}</button>
        {msg && <div className={msg.ok ? (msg.text.length > 6 ? 'warns' : 'card') : 'errors'} role="status">{msg.text}</div>}
      </div>
    </section>
  );
}

// ---------- register ----------

function Register({ d }: { d: Data }) {
  const { app, tz } = d;
  const models = [...new Set(app.ds.assets.map((a) => a.model))].sort();
  const [f, setF] = useState<Record<string, string>>({ kind: 'engine', receivedAs: 'new', model: models[0] ?? '', at: toLocalInput(app.now, tz), hours: '0', rebuilds: '0' });
  const [msg, setMsg] = useState<string | null>(null);
  if (!can(app.actor, 'record_components')) return <div className="card">Supervisors, reliability engineers and superintendents register components. <a href="#/components">Back</a></div>;
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const num = (k: string) => (f[k]?.trim() ? Number(f[k]) : undefined);
  const save = () => {
    const r = app.runComponents((ctx, data) => registerComponent(ctx, data, {
      serial: f.serial ?? '', kind: f.kind as ComponentKind, partNumber: f.partNumber, models: f.model ? [f.model] : [], hoursAtEntry: Number(f.hours || 0), rebuildsAtEntry: Number(f.rebuilds || 0),
      at: fromLocalInput(f.at ?? '', tz), receivedAs: f.receivedAs as ReceivedAs, vendor: f.vendor, cost: num('cost'), warrantyHours: num('warrantyHours'), warrantyMonths: num('warrantyMonths'),
      coreDueBy: f.coreDueBy || undefined, note: f.note,
    }));
    if (!r.ok) { setMsg(r.errors.join(' ')); return; }
    window.location.hash = `#/components/${r.components.at(-1)!.id}`;
  };
  const field = (k: string, label: string, el?: ReactNode) => <label className="field" key={k}><span>{label}</span>{el ?? <input value={f[k] ?? ''} onChange={(e) => set(k, e.target.value)} />}</label>;
  return (
    <div className="stack">
      <div className="page-head"><h2><a href="#/components" className="small" style={{ fontWeight: 400 }}>Components</a> / Register a component</h2></div>
      <section className="card" style={{ maxWidth: 560 }}>
        <div className="stack" style={{ gap: 10 }}>
          {field('serial', 'Serial')}
          {field('kind', 'Component', <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{COMPONENT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select>)}
          {field('model', 'Fits model', <select value={f.model} onChange={(e) => set('model', e.target.value)}><option value="">Any</option>{models.map((m) => <option key={m}>{m}</option>)}</select>)}
          {field('partNumber', 'Part number')}
          {field('receivedAs', 'Received as', <select value={f.receivedAs} onChange={(e) => set('receivedAs', e.target.value)}><option value="new">New</option><option value="exchange">Exchange (core goes back)</option><option value="used">Used, with history</option></select>)}
          {field('at', 'Received (site time)', <input type="datetime-local" value={f.at} onChange={(e) => set('at', e.target.value)} />)}
          {f.receivedAs === 'used' && <>{field('hours', 'Hours since its last rebuild')}{field('rebuilds', 'Rebuilds so far')}</>}
          {f.receivedAs === 'exchange' && field('coreDueBy', 'Core due back by', <input type="date" value={f.coreDueBy ?? ''} onChange={(e) => set('coreDueBy', e.target.value)} />)}
          {field('vendor', 'Supplier')}
          {d.costs && field('cost', 'Cost ($)')}
          {field('warrantyHours', 'Warranty hours')}{field('warrantyMonths', 'Warranty months')}
          {field('note', 'Note')}
          <button className="btn primary" onClick={save}>Register</button>
          {msg && <div className="errors" role="status">{msg}</div>}
        </div>
      </section>
    </div>
  );
}

/** For the unit page: what is fitted where, against target. */
export function UnitComponents({ unitId }: { unitId: string }) {
  const d = useComponents();
  const unit = d.app.ds.assets.find((a) => a.id === unitId);
  if (!unit || unit.assetClass !== 'mobile') return null;
  const row = lifeBoard(d.states, [unit], d.app.lifeTargets, d.today)[0];
  if (!row || row.cells.every((c) => !c.state)) return null;
  return (
    <section className="card">
      <h3>Components</h3>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Position</th><th>Serial</th><th>Hours</th><th>Target</th><th>% of target</th></tr></thead>
          <tbody>
            {row.cells.map((c) => (
              <tr key={c.position.id}>
                <td>{c.position.label}</td>
                <td>{c.state ? serialLink(c.state) : <span className="muted">empty</span>}</td>
                <td>{c.state ? h0(c.state.hours) : ''}</td><td>{h0(c.target)}</td>
                <td><span style={{ padding: '2px 6px', borderRadius: 4, background: bandBg(c.band), color: c.band === 'past' ? '#fff' : undefined }}>{pct(c.ratio)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
