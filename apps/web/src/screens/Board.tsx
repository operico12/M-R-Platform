// Fleet status board (plan 4.2, Figure 1, docs/status-board.md). Answers "what is down,
// why, for how long, and when is it back?" Exceptions first; readable from 3 metres in TV mode.

import {
  STAGE_LABELS, activeAlerts, boardCounts, boardFilterFromQuery, boardFilterToQuery, downSince, downlineQueue,
  filterBoard, toggleIn, upSince, type Asset, type BoardFilter, type BoardStatus, type DownFlag,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagSheet } from '../components/FlagSheet';
import { fmtHours, hoursSince, locationLabel, siteTime, stageLabel, unitStatus } from '../format';
import { useApp } from '../store';

const CARDS: { status: BoardStatus; word: string }[] = [
  { status: 'run', word: 'Up' },
  { status: 'sched', word: 'Scheduled down' },
  { status: 'down', word: 'Down' },
  { status: 'stale', word: 'No update' },
  { status: 'parked', word: 'Parked' },
];

interface Row {
  unitId: string; unitNumber: string; model: string; status: BoardStatus; text?: string;
  a: Asset; flag?: DownFlag; since?: string; lastReading?: string;
}

export function Board({ tv, query = '' }: { tv: boolean; query?: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [open, setOpen] = useState<Asset | null>(null);
  const [filter, setFilterState] = useState<BoardFilter>(() => boardFilterFromQuery(query));
  const setFilter = (f: BoardFilter) => {
    setFilterState(f);
    const q = boardFilterToQuery(f);
    // replaceState: a filtered board can be shared or reloaded without filling the back button.
    window.history.replaceState(null, '', `#/${tv ? 'tv' : 'board'}${q ? `?${q}` : ''}`);
  };

  const rows = useMemo<Row[]>(() => app.ds.assets.map((a) => {
    const { status, flag } = unitStatus(a.id, app.flags, app.ds, app.now);
    const lastReading = app.ds.smu.filter((r) => r.unitId === a.id).at(-1)?.at;
    const since = flag ? downSince(flag, app.flags) : status === 'run' || status === 'stale' ? upSince(a.id, app.flags, app.now) : undefined;
    const text = flag ? `${flag.reasonCode} ${locationLabel(flag, app.ds)} ${stageLabel(flag)}` : undefined;
    return { unitId: a.id, unitNumber: a.unitNumber, model: a.model, status, text, a, flag, since, lastReading };
  }), [app.ds, app.flags, app.now]);

  const counts = boardCounts(rows, filter);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const shown = filterBoard(rows, filter);
  const models = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.model, (m.get(r.model) ?? 0) + 1);
    return [...m].sort((x, y) => x[0].localeCompare(y[0]));
  }, [rows]);

  const queue = downlineQueue(app.flags, app.now);
  const alerts = useMemo(
    () => activeAlerts({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, rules: app.rules, calendar: app.ds.calendar, now: app.now }),
    [app.ds, app.flags, app.rules, app.now],
  );
  const alertCount = alerts.filter((a) => a.kind !== 'no_smu_reading').length;
  const proposals = app.flags.filter((f) => f.state === 'proposed');
  const tech = app.actor.role === 'technician';
  const filtered = filter.statuses.length > 0 || filter.models.length > 0 || filter.q.trim() !== '';

  const byNumber = (x: Row, y: Row) => x.unitNumber.localeCompare(y.unitNumber, undefined, { numeric: true });
  const attention = shown.filter((r) => r.status === 'down' || r.status === 'sched')
    .sort((x, y) => Date.parse(x.since ?? x.flag!.start) - Date.parse(y.since ?? y.flag!.start));
  const stale = shown.filter((r) => r.status === 'stale').sort(byNumber);
  const running = shown.filter((r) => r.status === 'run').sort(byNumber);
  const parked = shown.filter((r) => r.status === 'parked').sort(byNumber);
  const pick = (a: Asset) => { if (!tv) setOpen(a); };
  const hrs = (iso?: string) => (iso ? fmtHours(hoursSince(iso, app.now)) : '');

  return (
    <div className="board">
      <div className="page-head">
        <h2>Fleet status · Haul trucks</h2>
        <div className="trust">
          <span>Site time {siteTime(app.now, tz)}</span>
          <span>Last sync {siteTime(app.lastSync, tz, true)}</span>
          <span>Data: synthetic fleet</span>
        </div>
      </div>

      {total > 0 && (
        <div className="fleetbar" role="img" aria-label={CARDS.map((c) => `${counts[c.status]} ${c.word.toLowerCase()}`).join(', ')}>
          {CARDS.filter((c) => counts[c.status] > 0).map((c) => <span key={c.status} className={`fb-${c.status}`} style={{ flexGrow: counts[c.status] }} />)}
        </div>
      )}

      <div className="bcounts" aria-label="Counts by status. Press one to show only those units.">
        {CARDS.filter((c) => c.status !== 'parked' || counts.parked > 0 || filter.statuses.includes('parked')).map((c) => (
          <button
            key={c.status}
            type="button"
            className={`bcount bc-${c.status}`}
            aria-pressed={filter.statuses.includes(c.status)}
            disabled={tv}
            onClick={() => setFilter({ ...filter, statuses: toggleIn(filter.statuses, c.status) })}
            title={tv ? undefined : `Show only ${c.word.toLowerCase()} units (press again to undo)`}
          >
            <span className="bc-n">{counts[c.status]}</span>
            <span className="bc-w">{c.word}</span>
          </button>
        ))}
        <div className="bcount bc-info"><span className="bc-n">{queue.length}</span><span className="bc-w">Downline queue</span></div>
        {tv ? (
          <div className="bcount bc-info"><span className="bc-n">{alertCount}</span><span className="bc-w">Alerts</span></div>
        ) : (
          <a className="bcount bc-info" href="#/alerts"><span className="bc-n">{alertCount}</span><span className="bc-w">Alerts</span></a>
        )}
      </div>

      {!tv && (
        <div className="btools">
          <div className="bmodels" role="group" aria-label="Model">
            <button type="button" className="bchip" aria-pressed={filter.models.length === 0} onClick={() => setFilter({ ...filter, models: [] })}>All models</button>
            {models.map(([m, n]) => (
              <button key={m} type="button" className="bchip" aria-pressed={filter.models.includes(m)} onClick={() => setFilter({ ...filter, models: toggleIn(filter.models, m) })}>
                {m} <span className="muted">{n}</span>
              </button>
            ))}
          </div>
          <input
            className="bsearch"
            type="search"
            placeholder="Find a unit, reason or place"
            aria-label="Find a unit, reason or place"
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          />
          {filtered && <button type="button" className="linkish" onClick={() => setFilter({ statuses: [], models: [], q: '' })}>Clear filters</button>}
        </div>
      )}

      {proposals.length > 0 && !tv && (
        <div className="warns">{proposals.length} proposed down flag{proposals.length > 1 ? 's' : ''} waiting for a supervisor: {proposals.map((p) => app.ds.assets.find((a) => a.id === p.unitId)?.unitNumber).join(', ')}</div>
      )}

      {shown.length === 0 && (
        <div className="card bempty">
          No units match these filters.{' '}
          <button type="button" className="linkish" onClick={() => setFilter({ statuses: [], models: [], q: '' })}>Clear filters</button>
        </div>
      )}

      {attention.length > 0 && (
        <section>
          <h3 className="bhead">Needs attention · {attention.length}, longest down first</h3>
          <div className="battn">
            {attention.map((r) => {
              const f = r.flag!;
              const eta = f.etas.at(-1);
              const late = eta && Date.parse(eta.eta) < Date.parse(app.now);
              const noEta = !eta && hoursSince(f.start, app.now) >= app.rules.etaRequiredAfterHours;
              return (
                <button key={r.unitId} type="button" className={`brow br-${r.status}`} onClick={() => pick(r.a)} aria-label={`${r.unitNumber} ${r.status === 'sched' ? 'scheduled down' : 'down'} for ${hrs(r.since)}`}>
                  <span className="br-unit"><strong>{r.unitNumber}</strong><span className="muted small">{r.model}</span></span>
                  <span className="br-what">
                    <span className="br-reason">{f.reasonCode} <span className="muted">· {locationLabel(f, app.ds)}</span></span>
                    <span className="muted small">{stageLabel(f)}{r.status === 'sched' ? ' · scheduled' : ''}</span>
                  </span>
                  <span className="br-time">
                    <span className="br-for"><span className="muted small">down for </span>{hrs(r.since)}</span>
                    {eta ? (
                      <span className={`small ${late ? 'br-late' : 'muted'}`}>{late ? 'ETA passed ' : 'ETA '}{siteTime(eta.eta, tz, true)}</span>
                    ) : noEta ? <span className="small br-late">NO ETA</span> : <span className="small muted">ETA not due yet</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {stale.length > 0 && (
        <section>
          <h3 className="bhead">No update · {stale.length}</h3>
          <p className="small muted bnote">No open flag, but no hour meter reading for over 14 h. Check the unit is running.</p>
          <div className="bchips">
            {stale.map((r) => (
              <button key={r.unitId} type="button" className="bunit bu-stale" onClick={() => pick(r.a)}>
                <strong>{r.unitNumber}</strong>
                <span>{r.lastReading ? `last reading ${hrs(r.lastReading)} ago` : 'no reading on record'}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {running.length > 0 && (
        <section>
          <h3 className="bhead">Running · {running.length}</h3>
          <div className="bchips">
            {running.map((r) => (
              <button key={r.unitId} type="button" className="bunit bu-run" onClick={() => pick(r.a)} title={r.since ? `Up since ${siteTime(r.since, tz, true)}` : undefined}>
                <strong>{r.unitNumber}</strong>
                <span>{r.since ? `up ${hrs(r.since)}` : 'no stops on record'}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {parked.length > 0 && (
        <section>
          <h3 className="bhead">Parked · {parked.length}</h3>
          <div className="bchips">
            {parked.map((r) => (
              <button key={r.unitId} type="button" className="bunit bu-parked" onClick={() => pick(r.a)}>
                <strong>{r.unitNumber}</strong><span>{r.model}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Downline queue</h3>
        {queue.length === 0 ? (
          <p className="muted small">Nothing waiting for a crew, a tow or a line.</p>
        ) : (
          <table>
            <thead><tr><th>Unit</th><th>Waiting for</th><th className="num">Waiting</th><th>Where</th></tr></thead>
            <tbody>
              {queue.map((q) => (
                <tr key={q.flag.id}>
                  <td>{app.ds.assets.find((a) => a.id === q.flag.unitId)?.unitNumber}</td>
                  <td>{STAGE_LABELS[q.stage]}</td>
                  <td className="num">{fmtHours(q.waitingHours)}</td>
                  <td>{locationLabel(q.flag, app.ds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {!tv && (
        <p className="small muted" style={{ marginTop: 8 }}>
          Press a count to show only those units, and again to undo. Tap a unit to {tech ? 'propose a down flag or update its stage' : 'flag it down, move its stage or release it'}.
          Down time counts from the first flag of the stop; up time from the last release. Standby needs the fleet system (phase 1b).
        </p>
      )}

      {open && <FlagSheet asset={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
