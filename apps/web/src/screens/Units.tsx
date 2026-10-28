// Unit list and unit page (plan 4.2, Figure 3).

import { buildEvents, can, computeKpis, flagDownHours, openWorkOrders, stageHours, timeToFirstWrench, workOrdersForFlag, type Asset } from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagSheet } from '../components/FlagSheet';
import { STATUS_WORD, fmtHours, fmtNum, fmtPct, siteTime, unitStatus } from '../format';
import { newHref } from '../improve/describe';
import { useApp } from '../store';

const DAY = 864e5;

export function UnitList() {
  const app = useApp();
  const p = { from: new Date(Date.parse(app.now) - 28 * DAY).toISOString(), to: app.now };
  const [q, setQ] = useState('');
  const rows = useMemo(
    () =>
      app.ds.assets.map((a) => {
        const k = computeKpis({ assets: [a], flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now }, p);
        return { a, k, s: unitStatus(a.id, app.flags, app.ds, app.now) };
      }),
    [app.flags, app.now],
  );
  const shown = rows.filter((r) => r.a.unitNumber.toLowerCase().includes(q.toLowerCase())).sort((x, y) => (x.k.pa ?? 1) - (y.k.pa ?? 1));
  return (
    <div>
      <div className="page-head"><h2>Units</h2><span className="muted small">Last 28 days, worst PA first</span></div>
      <input placeholder="Search units" value={q} onChange={(e) => setQ(e.target.value)} className="btn" style={{ marginBottom: 12, fontWeight: 400 }} aria-label="Search units" />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Unit</th><th>Model</th><th>Status</th><th className="num">PA</th><th className="num">Utilisation</th><th className="num">Failures</th><th className="num">MTBF (h)</th><th className="num">Unsched. down</th></tr></thead>
          <tbody>
            {shown.map(({ a, k, s }) => (
              <tr key={a.id}>
                <td><a href={`#/unit/${a.id}`}>{a.unitNumber}</a></td>
                <td>{a.model}</td>
                <td><span className={`status ${s.status === 'parked' ? 'stale' : s.status}`}>{STATUS_WORD[s.status]}</span></td>
                <td className="num">{fmtPct(k.pa)}</td>
                <td className="num">{fmtPct(k.utilisation)}</td>
                <td className="num">{k.failures}</td>
                <td className="num">{fmtNum(k.mtbf, 0)}</td>
                <td className="num">{fmtHours(k.unscheduledDownHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function UnitPage({ id }: { id: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const a = app.ds.assets.find((x) => x.id === id);
  const [sheet, setSheet] = useState<Asset | null>(null);
  if (!a) return <p>Unit not found.</p>;
  const p = { from: new Date(Date.parse(app.now) - 28 * DAY).toISOString(), to: app.now };
  const input = { flags: app.flags, smu: app.ds.smu, lifecycle: app.ds.lifecycle, rules: app.rules, now: app.now };
  const k = computeKpis({ ...input, assets: [a] }, p);
  const fleet = computeKpis({ ...input, assets: app.ds.assets }, p);
  const s = unitStatus(a.id, app.flags, app.ds, app.now);
  const flags = app.flags.filter((f) => f.unitId === a.id).sort((x, y) => Date.parse(y.start) - Date.parse(x.start));
  const events = buildEvents(flags, app.rules, app.now);
  const lastSmu = app.ds.smu.filter((r) => r.unitId === a.id).at(-1);
  const openWos = openWorkOrders(app.ds.workOrders, a.id);
  const woStatus = (n: string) => workOrdersForFlag([n], app.ds.workOrders)[0]?.status;

  // 7-day timeline
  const t0 = Date.parse(app.now) - 7 * DAY;
  const span = 7 * DAY;
  const segs = flags
    .filter((f) => f.state === 'open' || f.state === 'released')
    .map((f) => ({ f, s: Math.max(t0, Date.parse(f.start)), e: f.end ? Date.parse(f.end) : Date.parse(app.now) }))
    .filter((x) => x.e > t0);

  return (
    <div className="stack">
      <div className="page-head">
        <h2>{a.unitNumber}</h2>
        <span className="muted">{a.model} · {a.fleet} · serial {a.serial} · {a.externalAssetId}</span>
        <span className={`status ${s.status === 'parked' ? 'stale' : s.status}`}>{STATUS_WORD[s.status]}</span>
        <button className="btn primary" onClick={() => setSheet(a)}>{s.flag ? 'Update flag' : app.actor.role === 'technician' ? 'Propose down' : 'Flag down'}</button>
        {can(app.actor, 'create_actions') && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={newHref('actions', { kind: 'unit', unitId: a.id })}>Raise action</a>}
        {can(app.actor, 'run_rcas') && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={newHref('rca', { kind: 'unit', unitId: a.id })}>Start RCA</a>}
      </div>
      {(() => {
        const mine = app.actions.filter((x) => x.source.unitId === a.id && (x.status === 'open' || x.status === 'in_progress'));
        const rcas = app.rcas.filter((x) => x.source.unitId === a.id && x.status === 'open');
        if (!mine.length && !rcas.length) return null;
        return (
          <p className="small">
            {rcas.map((x) => <span key={x.id}>Open RCA: <a href={`#/rca/${x.id}`}>{x.title}</a>. </span>)}
            {mine.map((x) => <span key={x.id}>Open action: <a href={`#/actions/${x.id}`}>{x.title}</a> (due {x.due}). </span>)}
          </p>
        );
      })()}
      <div className="trust">SMU {lastSmu ? `${lastSmu.hours.toLocaleString()} h at ${siteTime(lastSmu.at, tz, true)}` : 'no reading'}</div>

      <div className="grid kpis">
        <Kpi label="PA, 28 days" v={fmtPct(k.pa)} sub={`Fleet ${fmtPct(fleet.pa)}`} />
        <Kpi label="Utilisation" v={fmtPct(k.utilisation)} sub={`Fleet ${fmtPct(fleet.utilisation)}`} />
        <Kpi label="MTBF (op. h)" v={fmtNum(k.mtbf, 0)} sub={`Fleet ${fmtNum(fleet.mtbf, 0)} · ${k.failures} failures`} />
        <Kpi label="MTTR" v={fmtHours(k.mttr)} sub={`Fleet ${fmtHours(fleet.mttr)}`} />
        <Kpi label="Mean downtime" v={fmtHours(k.meanDowntime)} sub={`Fleet ${fmtHours(fleet.meanDowntime)}`} />
      </div>

      <section className="card">
        <h3>Last 7 days</h3>
        <div className="timeline" role="img" aria-label="Status timeline, last 7 days">
          {segs.map(({ f, s: st, e }) => (
            <div key={f.id} className={`seg ${f.type === 'scheduled' ? 'sched' : 'down'}`} style={{ left: `${((st - t0) / span) * 100}%`, width: `${Math.max(0.3, ((e - st) / span) * 100)}%` }} title={`${f.reasonCode}: ${siteTime(f.start, tz, true)} – ${f.end ? siteTime(f.end, tz, true) : 'now'}`} />
          ))}
        </div>
        <div className="timeline-axis">{Array.from({ length: 8 }, (_, i) => <span key={i}>{new Date(t0 + i * DAY).toLocaleDateString('en-CA', { timeZone: tz, month: 'short', day: 'numeric' })}</span>)}</div>
        <div className="legend small" style={{ marginTop: 8 }}><span className="status run">● Up</span><span className="status sched">▲ Scheduled</span><span className="status down">■ Unscheduled</span></div>
      </section>

      <section className="card">
        <h3>Open work orders ({openWos.length})</h3>
        {openWos.length === 0 ? <p className="small muted">None open in the ERP.</p> : (
          <div className="table-wrap" style={{ maxHeight: 260 }}>
            <table>
              <thead><tr><th>Work order</th><th>Type</th><th>Status</th><th>Priority</th><th>Description</th><th>Reported</th></tr></thead>
              <tbody>{openWos.map((w) => (
                <tr key={w.id}><td>{w.number}</td><td>{w.woType ?? '—'}</td><td>{w.status ?? '—'}</td><td>{w.priority ?? '—'}</td><td>{w.description}</td><td>{w.reportedAt ? siteTime(w.reportedAt, tz, true) : '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="small muted">From the last ERP import. The ERP stays the system of record; nothing is written back.</p>
      </section>

      <section>
        <h3>Down flags</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Reason / system</th><th>Start</th><th>End</th><th className="num">Down</th><th className="num">In repair</th><th className="num">Waiting</th><th className="num">To 1st wrench</th><th>Work order</th><th>State</th></tr></thead>
            <tbody>
              {flags.slice(0, 60).map((f) => {
                const all = { from: f.start, to: f.end ?? app.now };
                const sh = stageHours(f, all, app.now);
                const rep = sh.in_repair;
                const tot = flagDownHours(f, all, app.now);
                const ev = events.find((e) => e.flags[0]!.id === f.id);
                const ttfw = ev ? timeToFirstWrench(ev) : null;
                return (
                  <tr key={f.id} style={f.state === 'voided' ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                    <td><span className={`status ${f.type === 'scheduled' ? 'sched' : 'down'}`}>{f.type === 'scheduled' ? '▲' : '■'}</span> {f.linkKind === 'type_switch' ? '↳ ' : ''}{f.type}</td>
                    <td>{f.release?.system ?? f.reasonCode}{f.release?.component ? ` · ${f.release.component}` : ''}{f.release?.failureModes?.length ? ` · ${f.release.failureModes.join(', ')}` : ''}</td>
                    <td>{siteTime(f.start, tz, true)}</td>
                    <td>{f.end ? siteTime(f.end, tz, true) : 'open'}</td>
                    <td className="num">{fmtHours(tot)}</td>
                    <td className="num">{fmtHours(rep)}</td>
                    <td className="num">{fmtHours(tot - rep)}</td>
                    <td className="num">{ttfw === null ? '—' : fmtHours(ttfw)}</td>
                    <td>{f.workOrders.map((n) => `${n}${woStatus(n) ? ` (${woStatus(n)})` : ''}`).join(', ')}</td>
                    <td>{f.state}{ev && !ev.isFailure && f.type === 'unscheduled' && !f.linkKind ? ' · minor stop' : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {sheet && <FlagSheet asset={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}

function Kpi({ label, v, sub }: { label: string; v: string; sub: string }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{v}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
