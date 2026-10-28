// Work and PM management view (phase 2): leading indicators beside the
// lagging ones (plan 10 design rules). KPI-018 to KPI-023, from the ERP work
// orders. Every number lists the work orders behind it.

import {
  AGE_BUCKETS, READINESS_LABELS, aging, backlog, inspectionFinds, isEmergency, pmCompliance, pmsDue, readiness, scheduleCompliance, workMix,
  type WorkOrder, type WorkReadiness,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtNum, fmtPct, siteTime } from '../format';
import { useApp } from '../store';

const RANGES: Array<[number, string]> = [[28, 'Last 28 days'], [90, 'Last 90 days']];
const WAITING: WorkReadiness[] = ['waiting_approval', 'waiting_parts', 'waiting_shutdown', 'unknown'];

type Drill = { title: string; rows: WorkOrder[]; note?: (w: WorkOrder) => string } | null;

export function Work() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const s = app.workSettings;
  const [days, setDays] = useState(28);
  const [drill, setDrill] = useState<Drill>(null);
  const wos = app.ds.workOrders;
  const period = useMemo(() => ({ from: new Date(Date.parse(app.now) - days * 864e5).toISOString(), to: app.now }), [app.now, days]);
  const pmc = useMemo(() => pmCompliance(wos, period, app.now, tz, s), [wos, period, s]);
  const sched = useMemo(() => scheduleCompliance(wos, period, app.now, tz), [wos, period]);
  const mix = useMemo(() => workMix(wos, period, s), [wos, period, s]);
  const bl = useMemo(() => backlog(wos, s), [wos, s]);
  const insp = useMemo(() => inspectionFinds(wos, period), [wos, period]);
  const ag = useMemo(() => aging(wos, app.now), [wos, app.now]);
  const due = useMemo(() => pmsDue(wos, app.now, tz, 7), [wos, app.now]);
  const unit = (id?: string) => app.ds.assets.find((a) => a.id === id)?.unitNumber ?? '';
  const schedAll = sched.reduce((t, w) => ({ s: t.s + w.scheduled, d: t.d + w.done }), { s: 0, d: 0 });
  const hasPlanning = wos.some((w) => w.targetFinish || w.scheduledStart || w.estimatedHours !== undefined);

  return (
    <div className="stack">
      <div className="page-head">
        <h2>Work and PM</h2>
        <span className="muted small">From ERP work orders, last loaded {siteTime(app.lastSync, tz, true)}. Site time zone {tz}.</span>
      </div>
      <div className="row">
        <div className="chips">{RANGES.map(([d, l]) => <button key={d} className="chip" aria-pressed={days === d} onClick={() => setDays(d)} style={{ minHeight: 40 }}>{l}</button>)}</div>
      </div>
      {!hasPlanning && <div className="warns">The loaded work orders have no due dates, schedules or estimates. Add TARGCOMPDATE, SCHEDSTART and ESTDUR to the export to fill this page.</div>}

      <div className="grid kpis">
        <Tile label="PM compliance" v={fmtPct(pmc.value, 0)} sub={`${pmc.onTime} of ${pmc.due} on time · ${pmc.late} late · ${pmc.missed} missed`}
          onClick={() => setDrill({ title: 'PMs due in the period', rows: pmc.rows.map((r) => r.wo), note: (w) => resultWord(pmc.rows.find((r) => r.wo === w)!.result) })} />
        <Tile label="Schedule compliance" v={fmtPct(schedAll.s ? schedAll.d / schedAll.s : null, 0)} sub={`${schedAll.d} of ${schedAll.s} done as scheduled, ${sched.length} full weeks`} />
        <Tile label="Planned work" v={fmtPct(mix.plannedShare, 0)} sub={`Emergency ${fmtPct(mix.emergencyShare, 0)} of ${fmtNum(mix.hours, 0)} h`}
          onClick={() => setDrill({ title: 'Emergency work finished in the period', rows: wos.filter((w) => w.completedAt && w.completedAt >= period.from && w.completedAt < period.to && isEmergency(w, s)), note: (w) => `${fmtNum(w.actualLabourHours ?? w.estimatedHours ?? null, 1)} h` })} />
        <Tile label="Ready backlog" v={bl.readyWeeks === null ? `${fmtNum(bl.readyHours, 0)} h` : `${fmtNum(bl.readyWeeks, 1)} wk`} sub={bl.totalWeeks === null ? 'Set craft hours a week in Console, Work' : `Total ${fmtNum(bl.totalWeeks, 1)} wk at ${s.craftHoursPerWeek} h a week`}
          onClick={() => setDrill({ title: 'Ready to schedule', rows: wos.filter((w) => w.open && readiness(w) === 'ready'), note: (w) => `${fmtNum(w.estimatedHours ?? null, 1)} h` })} />
        <Tile label="Work from inspections" v={fmtPct(insp.value, 0)} sub={`${insp.fromInspection} of ${insp.corrective} corrective jobs raised from a PM or inspection`}
          onClick={() => setDrill({ title: 'Corrective work raised from a PM or inspection', rows: insp.rows, note: (w) => `From ${w.originWorkOrder}` })} />
      </div>
      <p className="small muted">Definitions: KPI dictionary KPI-018 to KPI-023. PM tolerance {s.pmToleranceDays} days. Emergency work is type {s.emergencyTypes.join(', ') || 'none'} or priority {s.emergencyPriorities.join(', ') || 'none'}. Click a tile to see the work orders.</p>

      {drill && <DrillTable drill={drill} onClose={() => setDrill(null)} unit={unit} />}

      <div className="grid two">
        <section className="card">
          <h3>PMs due in the next 7 days ({due.length})</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Unit</th><th>Work order</th><th>PM</th><th>Due</th><th>Scheduled</th><th className="num">Est.</th></tr></thead>
              <tbody>
                {due.map(({ wo, overdue }) => (
                  <tr key={wo.id}>
                    <td>{wo.assetId ? <a href={`#/unit/${wo.assetId}`}>{unit(wo.assetId)}</a> : wo.externalAssetId}</td>
                    <td>{wo.number}</td>
                    <td className="small">{wo.pmNumber ?? wo.description}</td>
                    <td>{siteTime(wo.targetFinish!, tz, true).replace(/,? \d{2}:\d{2}$/, '')}{overdue && <> <span className="rag red">Overdue</span></>}</td>
                    <td>{wo.scheduledStart ? siteTime(wo.scheduledStart, tz, true) : <span className="rag amber">Not scheduled</span>}</td>
                    <td className="num">{fmtNum(wo.estimatedHours ?? null, 0)}</td>
                  </tr>
                ))}
                {!due.length && <tr><td colSpan={6} className="muted">None due.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card">
          <h3>Schedule compliance by week</h3>
          <div style={{ height: 240 }}>
            <ResponsiveContainer>
              <ComposedChart data={sched.map((w) => ({ week: w.week, scheduled: w.scheduled, done: w.done, pct: w.value === null ? null : Math.round(w.value * 100) }))} margin={{ top: 8, right: 0, bottom: 0, left: -10 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="week" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="n" allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis yAxisId="p" orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip />
                <Bar yAxisId="n" dataKey="scheduled" name="Scheduled" fill="var(--border)" />
                <Bar yAxisId="n" dataKey="done" name="Done as scheduled" fill="var(--brand)" />
                <Line yAxisId="p" dataKey="pct" name="Compliance %" stroke="var(--run)" strokeWidth={2} dot />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">Weeks start Monday 00:00 site time and are counted once they end. Done as scheduled means finished by the end of its scheduled finish day.</p>
        </section>

        <section className="card">
          <h3>Backlog by readiness</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart layout="vertical" data={(['ready', 'in_progress', ...WAITING] as WorkReadiness[]).map((r) => ({ r: READINESS_LABELS[r], key: r, hours: Math.round(bl.hours[r]), count: bl.count[r] })).filter((x) => x.count)} margin={{ top: 0, right: 16, bottom: 0, left: 50 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis type="number" unit=" h" tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <YAxis type="category" dataKey="r" width={130} tick={{ fontSize: 12, fill: 'var(--text-2)' }} />
                <Tooltip />
                <Bar dataKey="hours" name="Estimated hours" fill="var(--brand)" cursor="pointer" onClick={(d: { key?: WorkReadiness; r?: string }) => d.key && setDrill({ title: d.r ?? '', rows: wos.filter((w) => w.open && readiness(w) === d.key), note: (w) => `${fmtNum(w.estimatedHours ?? null, 1)} h` })} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="small muted">{bl.open} open work orders. {bl.noEstimate.length ? `${bl.noEstimate.length} have no estimate and are not in the hours. ` : ''}Waiting: {fmtNum(bl.waitingHours, 0)} h. Click a bar to list them.</p>
          {bl.noEstimate.length > 0 && <button className="btn" onClick={() => setDrill({ title: 'Open work with no estimate', rows: bl.noEstimate })}>List work with no estimate</button>}
        </section>

        <section className="card">
          <h3>Open work order age</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Age</th><th className="num">Open</th>{(['ready', 'in_progress', ...WAITING] as WorkReadiness[]).map((r) => <th key={r} className="num small">{READINESS_LABELS[r]}</th>)}</tr></thead>
              <tbody>
                {ag.map((b) => (
                  <tr key={b.label}>
                    <td>{b.count ? <button className="linklike" onClick={() => setDrill({ title: `Open work, ${b.label} old`, rows: b.rows })}>{b.label}</button> : b.label}</td>
                    <td className="num">{b.count}</td>
                    {(['ready', 'in_progress', ...WAITING] as WorkReadiness[]).map((r) => <td key={r} className="num">{b.by[r] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Days since the work order was reported. Buckets: {AGE_BUCKETS.map((b) => b[0]).join(', ')}.</p>
        </section>
      </div>
    </div>
  );
}

const resultWord = (r: string) => ({ on_time: 'On time', late: 'Done late', missed: 'Missed', pending: 'Not due yet' })[r] ?? r;

function Tile({ label, v, sub, onClick }: { label: string; v: string; sub: string; onClick?: () => void }) {
  const body = <><div className="label">{label}</div><div className="value">{v}</div><div className="sub">{sub}</div></>;
  return onClick
    ? <button className="card kpi" onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}>{body}</button>
    : <div className="card kpi">{body}</div>;
}

function DrillTable({ drill, onClose, unit }: { drill: NonNullable<Drill>; onClose: () => void; unit: (id?: string) => string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const d = (x?: string) => (x ? siteTime(x, tz, true) : '');
  return (
    <section className="card" style={{ borderColor: 'var(--brand)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>{drill.title} ({drill.rows.length})</h3><button className="btn" onClick={onClose}>Close</button></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Work order</th><th>Unit</th><th>Type</th><th>Status</th><th>Description</th><th>Reported</th><th>Due</th><th>Scheduled</th><th>Finished</th>{drill.note && <th />}</tr></thead>
          <tbody>
            {drill.rows.slice(0, 200).map((w) => (
              <tr key={w.id}>
                <td>{w.number}</td>
                <td>{w.assetId ? <a href={`#/unit/${w.assetId}`}>{unit(w.assetId)}</a> : w.externalAssetId}</td>
                <td>{w.woType}</td>
                <td>{w.status}</td>
                <td className="small">{w.description}</td>
                <td>{d(w.reportedAt)}</td>
                <td>{d(w.targetFinish)}</td>
                <td>{d(w.scheduledStart)}</td>
                <td>{d(w.completedAt)}</td>
                {drill.note && <td className="small">{drill.note(w)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {drill.rows.length > 200 && <p className="small muted">Showing 200 of {drill.rows.length}.</p>}
    </section>
  );
}
