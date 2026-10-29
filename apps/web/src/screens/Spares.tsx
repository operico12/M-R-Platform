// Spares and rebuild pool sizing (phase 3; docs/spares.md): the rebuild pool per
// model and component kind from the component history, PM part uses and kits from
// the RCM library, and settings. Read-only except settings; the numbers link to the
// spares calculators C-16 to C-18 with the inputs filled in.

import {
  DEMAND_BASIS_LABELS, KIND_LABELS, POOL_VERDICT_LABELS, burnRates, can, changeoutForecast, componentStates, pmKits, pmPartDemand, rebuildPoolRows, setSparesSettings, smuIndex,
  type DemandBasis, type PoolRow, type SparesSettings,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { useApp } from '../store';

type Tab = 'pool' | 'parts' | 'kits' | 'settings';
const TABS: Array<[Tab, string]> = [['pool', 'Rebuild pool'], ['parts', 'PM parts'], ['kits', 'PM kits'], ['settings', 'Settings']];

const pct = (x: number | null, d = 1) => (x === null ? '—' : `${(x * 100).toFixed(d)}%`);
const n1 = (x: number) => x.toLocaleString('en-CA', { maximumFractionDigits: 1 });
const calcLink = (id: string, params: Record<string, string | number>) => `#/calc/${id}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`;

function useSpares() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const s = app.sparesSettings;
  const idx = useMemo(() => smuIndex(app.ds.smu), [app.ds.smu]);
  const states = useMemo(() => componentStates(app.components, app.componentEvents, app.ds.assets, idx, app.now), [app.components, app.componentEvents, app.ds.assets, idx, app.now]);
  const rates = useMemo(() => burnRates(app.ds.assets, idx, app.ds.lifecycle, app.now, tz), [app.ds.assets, idx, app.ds.lifecycle, app.now, tz]);
  const forecast = useMemo(() => changeoutForecast(states, app.ds.assets, app.lifeTargets, rates, app.now, tz), [states, app.ds.assets, app.lifeTargets, rates, app.now, tz]);
  const pool = useMemo(() => rebuildPoolRows({ states, events: app.componentEvents, assets: app.ds.assets, forecast, now: app.now, settings: s }), [states, app.componentEvents, app.ds.assets, forecast, app.now, s]);
  const parts = useMemo(() => pmPartDemand(app.rcmModes, app.ds.assets, rates, app.rcmSettings), [app.rcmModes, app.ds.assets, rates, app.rcmSettings]);
  const kits = useMemo(() => pmKits(app.rcmModes, app.ds.assets, rates, app.rcmSettings), [app.rcmModes, app.ds.assets, rates, app.rcmSettings]);
  return { app, s, pool, parts, kits };
}
type Data = ReturnType<typeof useSpares>;

export function Spares({ query }: { query: string }) {
  const d = useSpares();
  const q = new URLSearchParams(query);
  const tab = (TABS.find(([k]) => k === q.get('tab'))?.[0] ?? 'pool') as Tab;
  const short = d.pool.filter((r) => r.verdict === 'short');
  const more = d.pool.filter((r) => r.verdict === 'more');
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Spares</h2>
        <span className="muted small">How many spares to keep, from the component history and the RCM job plans. Stock levels are changed in Maximo.</span>
      </div>
      <div className="grid kpis">
        <Tile label="Pools short" value={String(short.length)} note={short.length ? `${short.reduce((a, r) => a + r.gap, 0)} components short in all` : `All pools meet the ${pct(d.s.fillTarget)} target`} warn={short.length > 0} />
        <Tile label="Pools with more than needed" value={String(more.length)} note={more.length ? `${more.reduce((a, r) => a + r.gap, 0)} more than needed in all` : 'None 2 or more over'} />
        <Tile label="PM parts" value={String(d.parts.length)} note={`${d.kits.length} PM kits from the RCM library`} />
      </div>
      <div className="chips" role="tablist">
        {TABS.map(([k, l]) => <a key={k} role="tab" className="chip" aria-pressed={tab === k} aria-selected={tab === k} href={`#/spares?tab=${k}`} style={{ minHeight: 40, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{l}</a>)}
      </div>
      {tab === 'pool' && <PoolTab d={d} />}
      {tab === 'parts' && <PartsTab d={d} />}
      {tab === 'kits' && <KitsTab d={d} />}
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

const verdictText = (r: PoolRow) => (r.verdict === 'short' ? `Short by ${r.gap}` : r.verdict === 'more' ? `${r.gap} more than needed` : POOL_VERDICT_LABELS[r.verdict]);
const verdictColour = (r: PoolRow) => (r.verdict === 'short' ? 'var(--down)' : r.verdict === 'more' ? 'var(--sched)' : undefined);

function PoolTab({ d }: { d: Data }) {
  const { pool, s } = d;
  const models = [...new Set(pool.map((r) => r.model))];
  const [model, setModel] = useState('');
  const rows = pool.filter((r) => !model || r.model === model);
  if (!pool.length) return <section className="card"><p className="muted">No components recorded yet. The pool comes from the component history on the Components page.</p></section>;
  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Rebuild pool by model and component</h3>
        <label className="field" style={{ minWidth: 140 }}>
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}><option value="">All</option>{models.map((m) => <option key={m} value={m}>{m}</option>)}</select>
        </label>
      </div>
      <p className="small muted">
        Target fill rate {pct(s.fillTarget)}: the share of change-outs with a spare ready. Change-outs a year use {DEMAND_BASIS_LABELS[s.demandBasis].toLowerCase()}.
        The pool is components in stores or at rebuild.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th><th>Component</th><th>Installed</th><th>Pool now</th><th>Change-outs a year<br /><span className="small muted">history / forecast</span></th>
              <th>Repair cycle (days)</th><th>Pool needed</th><th>Fill rate now</th><th>Unit-days waiting a year now</th><th>Verdict</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.model}|${r.kind}`}>
                <td>{r.model}</td>
                <td>{KIND_LABELS[r.kind]}</td>
                <td>{r.installed}</td>
                <td>{r.pool}<div className="small muted">{r.inStores} in stores, {r.atRebuild} at rebuild{r.shared ? `, ${r.shared} shared` : ''}</div></td>
                <td><strong>{r.perYear}</strong><div className="small muted">{r.history} / {r.forecast}</div></td>
                <td>{n1(r.cycleDays)}<div className="small muted">{r.measured ? `mean of ${r.cycles}` : `default (${r.cycles} measured)`}</div></td>
                <td><strong>{r.needed}</strong></td>
                <td>{pct(r.fillNow)}</td>
                <td>{n1(r.waitNow)}</td>
                <td style={{ color: verdictColour(r), fontWeight: r.verdict === 'short' ? 700 : undefined }}>{verdictText(r)}</td>
                <td>{r.perYear > 0 && <a className="small" href={calcLink('rebuild_pool', { perYear: r.perYear, cycleDays: Number(r.cycleDays.toFixed(1)), target: Number((s.fillTarget * 100).toFixed(1)), note: `Spares page: ${r.model} ${KIND_LABELS[r.kind].toLowerCase()}, ${r.perYear} change-outs a year (${s.demandBasis}), ${r.measured ? `mean of ${r.cycles} repair cycles` : 'default repair cycle'}` })}>Costs (C-17)</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        History is removals in the last 365 days for failure or planned (not access or swaps). Forecast is change-outs due at target life in the next 365 days, so it leaves out failures before target.
        The repair cycle runs from removal to back from rebuild. A component that fits more than one model is counted in each model's pool. Method: docs/spares.md.
      </p>
    </section>
  );
}

function PartsTab({ d }: { d: Data }) {
  const { parts, s } = d;
  if (!parts.length) return <section className="card"><p className="muted">No parts on scheduled RCM tasks yet. Add parts to failure modes on the <a href="#/rcm">RCM</a> page.</p></section>;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Parts used by PM tasks</h3>
      <p className="small muted">Uses a year = quantity × fleet SMU hours a year ÷ the PM level the task is in. Fleet hours come from each unit's burn rate over the last 28 days.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th>Description</th><th>Models</th><th>Tasks</th><th>Uses a year</th><th /></tr></thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.itemNum}>
                <td>{p.itemNum}</td><td>{p.description}</td><td>{p.models.join(', ')}</td><td>{p.tasks}</td><td><strong>{n1(p.perYear)}</strong></td>
                <td><a className="small" href={calcLink('poisson_spares', { perYear: Number(p.perYear.toFixed(2)), leadDays: s.leadDays, target: Number((s.fillTarget * 100).toFixed(1)), note: `Spares page: ${p.itemNum} PM uses a year from the RCM library; lead time is the ${s.leadDays} day default` })}>Size it (C-16)</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">The calculator opens with the default lead time of {s.leadDays} days. Type the real lead time from Maximo.</p>
    </section>
  );
}

function KitsTab({ d }: { d: Data }) {
  const { kits, s, app } = d;
  if (!kits.length) return <section className="card"><p className="muted">No PM job plans with parts yet. Kits come from the <a href="#/rcm?tab=plans">RCM job plans</a>.</p></section>;
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>A kit for each PM job plan</h3>
      <p className="small muted">
        Kit uses a year = fleet SMU hours a year × the share of PMs done at this level ÷ the level hours.
        {app.rcmSettings.nested ? ' PMs are nested, so a larger PM that holds this level takes over some of its PMs.' : ' PMs are not nested, so each level is done every level hours.'}
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Job plan</th><th>Parts</th><th>Share of PMs</th><th>Kit uses a year</th><th /></tr></thead>
          <tbody>
            {kits.map((k) => (
              <tr key={k.jpnum}>
                <td>{k.jpnum}</td>
                <td className="small">{k.parts.map((p) => `${p.qty} × ${p.itemNum}${p.description ? ` ${p.description}` : ''}`).join('; ')}</td>
                <td>{pct(k.share, 0)}</td>
                <td><strong>{n1(k.perYear)}</strong></td>
                <td>{k.perYear > 0 && <a className="small" href={calcLink('kit_stocking', { perYear: Number(k.perYear.toFixed(2)), target: Number((s.fillTarget * 100).toFixed(1)), parts: k.parts.map((p) => `${p.itemNum}, ${p.qty}, ${s.leadDays}, , ${p.description.replace(/,/g, ' ')}`).join('\n'), note: `Spares page: ${k.jpnum} kit from the RCM library; lead times are the ${s.leadDays} day default` })}>Size the kit (C-18)</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SettingsTab({ d }: { d: Data }) {
  const { app } = d;
  const allowed = can(app.actor, 'edit_spares');
  const [v, setV] = useState<SparesSettings>(d.s);
  const [target, setTarget] = useState(String(Number((d.s.fillTarget * 100).toFixed(1))));
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const n = (x: string) => (x.trim() === '' ? NaN : Number(x));
  const save = () => {
    const r = app.runSparesSettings((ctx, cur) => setSparesSettings(ctx, cur, { ...v, fillTarget: n(target) / 100 }, reason));
    setMsg(r.ok ? { ok: true, text: 'Saved. The pool and the links use these settings now.' } : { ok: false, text: r.errors.join(' ') });
    if (r.ok) { setReason(''); setV(r.records[0]!); }
  };
  return (
    <section className="card" style={{ maxWidth: 760 }}>
      <h3>Spares settings</h3>
      <p className="small muted">{allowed ? 'Changes go to the audit log with your reason.' : 'Reliability engineers and superintendents change these.'}</p>
      <fieldset disabled={!allowed} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid two" style={{ gap: 10, alignItems: 'start' }}>
          <label className="field"><span>Target fill rate (%)</span><input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
          <label className="field"><span>Change-outs a year from</span>
            <select value={v.demandBasis} onChange={(e) => setV({ ...v, demandBasis: e.target.value as DemandBasis })}>
              {(Object.keys(DEMAND_BASIS_LABELS) as DemandBasis[]).map((k) => <option key={k} value={k}>{DEMAND_BASIS_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="field"><span>Repair cycles from the last (days)</span><input inputMode="numeric" value={v.cycleWindowDays} onChange={(e) => setV({ ...v, cycleWindowDays: n(e.target.value) })} /></label>
          <label className="field"><span>Fewest repair cycles to use the measured mean</span><input inputMode="numeric" value={v.minCycles} onChange={(e) => setV({ ...v, minCycles: n(e.target.value) })} /></label>
          <label className="field"><span>Default repair cycle (days)</span><input inputMode="numeric" value={v.defaultCycleDays} onChange={(e) => setV({ ...v, defaultCycleDays: n(e.target.value) })} /></label>
          <label className="field"><span>Default lead time for PM parts (days)</span><input inputMode="numeric" value={v.leadDays} onChange={(e) => setV({ ...v, leadDays: n(e.target.value) })} /></label>
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
