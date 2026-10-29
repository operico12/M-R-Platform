// Sites (docs/multi-site.md): the person's sites side by side, each over its own
// last full reporting week in its own time zone (KPI-043 for the total), and
// adding or retiring a site of the tenant. Every change runs a core command.

import { can, compareSites, isTimeZone, type SiteComparison, type SiteSnapshot } from '@mr/core';
import { useEffect, useState } from 'react';
import { fmtHours, fmtNum, fmtPct, siteTime } from '../format';
import { Errors } from '../improve/ui';
import type { SiteChoice } from '../data/sites';
import { useApp } from '../store';

const ZONES = ['America/Vancouver', 'America/Edmonton', 'America/Regina', 'America/Winnipeg', 'America/Toronto', 'America/Halifax', 'America/St_Johns', 'America/Whitehorse', 'America/Yellowknife', 'America/Denver', 'America/Phoenix', 'America/Santiago', 'America/Lima', 'Australia/Perth', 'Australia/Brisbane', 'Africa/Johannesburg', 'UTC'];

export function Sites() {
  const app = useApp();
  const [weeks, setWeeks] = useState(1);
  const [snaps, setSnaps] = useState<SiteSnapshot[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const sitesKey = app.sites.map((s) => s.id).join(',');
  useEffect(() => {
    let gone = false;
    setSnaps(null);
    setLoadErr(null);
    Promise.all(app.sites.map((s) => app.snapshot(s)))
      .then((x) => { if (!gone) setSnaps(x); })
      .catch((e) => { if (!gone) setLoadErr(e instanceof Error ? e.message : String(e)); });
    return () => { gone = true; };
    // Reload when the list of sites changes, not on every flag change at this site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sitesKey]);
  const live = snaps?.filter((x) => app.sites.some((s) => s.id === x.site.id));
  const cmp: SiteComparison | null = live ? compareSites(live, app.now, weeks) : null;
  return (
    <div className="stack">
      <div className="page-head">
        <h2>Sites</h2>
        <span className="muted small">The sites you belong to, side by side. Each site uses its own week (Monday 00:00 in its time zone), its own flag rules and its own people.</span>
      </div>
      <div className="chips">{[1, 4].map((w) => <button key={w} className="chip" aria-pressed={weeks === w} onClick={() => setWeeks(w)}>{w === 1 ? 'Last full week' : 'Last 4 full weeks'}</button>)}</div>
      <section className="card">
        {loadErr && <p className="errors" role="alert">Could not load a site: {loadErr}</p>}
        {!cmp && !loadErr && <p className="muted">Loading the sites…</p>}
        {cmp && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Site</th><th>Your role</th><th>Period (site time)</th><th>Units</th><th>Down now</th><th>PA</th><th>Utilisation</th><th>Unscheduled down h</th><th>MTBF</th><th>MTTR</th><th /></tr></thead>
              <tbody>
                {cmp.rows.map((r) => {
                  const choice = app.sites.find((s) => s.id === r.site.id);
                  if (!choice) return null;
                  const here = r.site.id === app.ds.site.id;
                  return (
                    <tr key={r.site.id}>
                      <td><strong>{r.site.name}</strong>{here && <span className="small muted"> · open now</span>}<div className="small muted">{r.site.timeZone}</div></td>
                      <td className="small">{ROLE[app.mode === 'demo' ? app.actor.role : choice.role]}</td>
                      <td className="small">{siteTime(r.period.from, r.site.timeZone, true)} to {siteTime(r.period.to, r.site.timeZone, true)}</td>
                      <td>{r.units}</td>
                      <td>{r.openFlags}</td>
                      <td><strong>{fmtPct(r.kpi.pa)}</strong></td>
                      <td>{fmtPct(r.kpi.utilisation)}</td>
                      <td>{fmtNum(r.kpi.unscheduledDownHours, 0)}</td>
                      <td>{fmtHours(r.kpi.mtbf)}</td>
                      <td>{fmtHours(r.kpi.mttr)}</td>
                      <td>{!here && <button className="btn" onClick={() => app.switchSite(r.site.id)}>Open</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              {cmp.rows.length > 1 && (
                <tfoot>
                  <tr>
                    <td><strong>All {cmp.rows.length} sites</strong></td><td /><td className="small muted">each site's own period</td>
                    <td>{cmp.rows.reduce((t, r) => t + r.units, 0)}</td><td>{cmp.rows.reduce((t, r) => t + r.openFlags, 0)}</td>
                    <td><strong>{fmtPct(cmp.pa)}</strong></td><td colSpan={5} className="small muted">PA weighted by calendar hours (KPI-043). The others are per site only.</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        <p className="small muted">Trucks and other mobile units only; plant equipment has its own KPIs on each site's Plant page. Cost is not shown here.</p>
      </section>
      <AddSite />
      <RetireSite />
    </div>
  );
}

const ROLE: Record<SiteChoice['role'], string> = { viewer: 'Viewer', technician: 'Technician', supervisor: 'Supervisor', reliability_engineer: 'Reliability engineer', superintendent: 'Superintendent', admin: 'Admin' };

function AddSite() {
  const app = useApp();
  const [name, setName] = useState('');
  const [tz, setTz] = useState(app.ds.site.timeZone);
  const [err, setErr] = useState<string[] | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can(app.actor, 'add_site')) return <p className="locked small">🔒 The Admin of a site adds another site to the same company.</p>;
  const add = async () => {
    setBusy(true);
    const r = await app.addSite({ name, timeZone: tz });
    setBusy(false);
    if (!r.ok) return setErr(r.errors);
    setErr(null);
    setDone(`${r.records[0]!.name} is added. You are its Admin; open it from the site list to invite its people and set its calendar, rules and codes.`);
    setName('');
  };
  return (
    <section className="card stack" aria-label="Add a site">
      <h3 style={{ margin: 0 }}>Add a site</h3>
      <p className="small muted" style={{ margin: 0 }}>A new mine or plant of the same company. It starts with 12-hour shifts at 06:00 and 18:00, the default flag rules and the starter codes; change them in its Console. You become its Admin.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '2 1 200px' }}><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field" style={{ flex: '1 1 200px' }}><span>Time zone</span>
          <input list="zones" value={tz} onChange={(e) => setTz(e.target.value)} aria-invalid={!isTimeZone(tz)} />
          <datalist id="zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </label>
        <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void add()}>Add site</button>
      </div>
      {!isTimeZone(tz) && tz && <span className="small">Not a time zone name. Use one like America/Edmonton.</span>}
      <Errors list={err} />
      {done && <p className="small" role="status">{done}</p>}
    </section>
  );
}

function RetireSite() {
  const app = useApp();
  const [err, setErr] = useState<string[] | null>(null);
  const mine = app.sites.filter((s) => (app.mode === 'demo' ? can(app.actor, 'add_site') : s.role === 'admin'));
  if (!mine.length || app.sites.length < 2) return null;
  const retire = async (s: SiteChoice) => {
    const why = window.prompt(`Reason for retiring ${s.name}. Its records stay; it leaves the site list.`) ?? '';
    if (!why.trim()) return;
    const r = await app.retireSite(s, why);
    setErr(r.ok ? null : r.errors);
  };
  return (
    <section className="card stack" aria-label="Retire a site">
      <h3 style={{ margin: 0 }}>Retire a site</h3>
      <p className="small muted" style={{ margin: 0 }}>Nothing is deleted. The last active site of the company cannot be retired.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {mine.map((s) => <button key={s.id} className="btn danger" onClick={() => void retire(s)}>Retire {s.name}</button>)}
      </div>
      <Errors list={err} />
    </section>
  );
}
