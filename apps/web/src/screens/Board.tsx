// Fleet status board (plan 4.2, Figure 1, docs/status-board.md). Three statuses (Ope, 29 Oct 2026):
// operational, scheduled down, unscheduled down. Every unit has a card listing what is open on it
// and for how long. Readable from 3 metres in TV mode.

import {
  ALERT_PLAIN, BOARD_SUB_LABELS, STAGE_LABELS, sortAlerts, activeAlerts, boardCounts, boardFilterFromQuery, boardFilterToQuery, boardPlace, currentStandby,
  downSince, downlineQueue, filterBoard, stageSince, subKey, toggleIn, upSince,
  type Alert, type Asset, type BoardFilter, type BoardGroup, type BoardSub, type DownFlag, type StandbyFlag,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagSheet } from '../components/FlagSheet';
import { fmtHours, hoursSince, locationLabel, siteTime, unitStatus } from '../format';
import { useApp } from '../store';

// Ope, 29 Oct 2026: four tiles on top (these three and Alerts). Parked units are listed at the bottom.
const GROUPS: { group: BoardGroup; word: string; empty: string }[] = [
  { group: 'operational', word: 'Operational', empty: 'No units are operational.' },
  { group: 'unsched', word: 'Unscheduled down', empty: 'Nothing is down unscheduled.' },
  { group: 'sched', word: 'Scheduled down', empty: 'Nothing is scheduled down.' },
  { group: 'parked', word: 'Parked', empty: '' },
];
const TILES = GROUPS.filter((g) => g.group !== 'parked');
const NO_READING_HOURS = 14;
// Alerts already shown another way on the card: the ETA line, the proposal line, the reading line, the stage line.
const SHOWN_ELSEWHERE = new Set<Alert['kind']>(['no_eta', 'eta_passed', 'proposal_unconfirmed', 'no_smu_reading', 'waiting_line', 'waiting_parts']);

interface Row {
  unitId: string; unitNumber: string; model: string; group: BoardGroup; sub: BoardSub; text?: string;
  a: Asset; flag?: DownFlag; standby?: StandbyFlag; proposal?: DownFlag; since?: string;
  noReadingSince?: string | null; alerts: Alert[]; stageLate: boolean; busy: boolean;
}

export function Board({ tv, query = '' }: { tv: boolean; query?: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [open, setOpen] = useState<Asset | null>(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [filter, setFilterState] = useState<BoardFilter>(() => boardFilterFromQuery(query));
  const setFilter = (f: BoardFilter) => {
    setFilterState(f);
    const q = boardFilterToQuery(f);
    // replaceState: a filtered board can be shared or reloaded without filling the back button.
    window.history.replaceState(null, '', `#/${tv ? 'tv' : 'board'}${q ? `?${q}` : ''}`);
  };

  const alerts = useMemo(
    () => activeAlerts({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, rules: app.rules, calendar: app.ds.calendar, now: app.now }),
    [app.ds, app.flags, app.rules, app.now],
  );
  const sbLabel = (code: string) => app.standbyReasons.find((x) => x.code === code)?.label ?? code;

  const rows = useMemo<Row[]>(() => {
    const lastReading = new Map<string, string>();
    for (const r of app.ds.smu) lastReading.set(r.unitId, r.at);
    return app.ds.assets.map((a) => {
      const u = unitStatus(a.id, app.flags, app.ds, app.now);
      const flag = u.flag;
      const parked = u.status === 'parked';
      // Down wins over standby (docs/standby.md).
      const sb = !flag && !parked ? currentStandby(a.id, app.standby) : undefined;
      const { group, sub } = boardPlace(flag, sb, parked);
      const proposal = !flag && !parked ? app.flags.find((f) => f.unitId === a.id && f.state === 'proposed') : undefined;
      const last = lastReading.get(a.id);
      const noReadingSince = group === 'operational' && (!last || hoursSince(last, app.now) > NO_READING_HOURS) ? (last ?? null) : undefined;
      const since = flag ? downSince(flag, app.flags) : group === 'operational' ? upSince(a.id, app.flags, app.now, app.standby) : undefined;
      const mine = alerts.filter((x) => x.unitId === a.id);
      const stageLate = mine.some((x) => x.kind === 'waiting_line' || x.kind === 'waiting_parts');
      const text = flag
        ? `${flag.reasonCode} ${locationLabel(flag, app.ds)}`
        : sb ? `standby ${sbLabel(sb.reasonCode)}` : proposal ? `proposed ${proposal.reasonCode}` : undefined;
      const shownAlerts = mine.filter((x) => !SHOWN_ELSEWHERE.has(x.kind));
      const busy = Boolean(sb || proposal || noReadingSince !== undefined || shownAlerts.length);
      return { unitId: a.id, unitNumber: a.unitNumber, model: a.model, group, sub, text, a, flag, standby: sb, proposal, since, noReadingSince, alerts: shownAlerts, stageLate, busy };
    });
  }, [app.ds, app.flags, app.now, app.standby, app.standbyReasons, alerts]);

  const counts = boardCounts(rows, filter);
  const total = Object.values(counts.groups).reduce((s, n) => s + n, 0);
  const shown = filterBoard(rows, filter);
  const models = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.model, (m.get(r.model) ?? 0) + 1);
    return [...m].sort((x, y) => x[0].localeCompare(y[0]));
  }, [rows]);

  const queue = downlineQueue(app.flags, app.now);
  // A missing reading is shown on the unit's card, not counted as an alert.
  const alertList = useMemo(() => sortAlerts(alerts.filter((a) => a.kind !== 'no_smu_reading')), [alerts]);
  const alertCount = alertList.length;
  const alertKinds = Object.entries(alertList.reduce<Record<string, number>>((m, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + 1 }), {}));
  const unitOf = (id: string) => app.ds.assets.find((a) => a.id === id);
  const alertsOpen = tv || showAlerts;
  const tech = app.actor.role === 'technician';
  const filtered = filter.groups.length > 0 || filter.subs.length > 0 || filter.models.length > 0 || filter.q.trim() !== '';
  const clear = () => setFilter({ groups: [], subs: [], models: [], q: '' });

  const byNumber = (x: Row, y: Row) => x.unitNumber.localeCompare(y.unitNumber, undefined, { numeric: true });
  const longest = (x: Row, y: Row) => Date.parse(x.since ?? x.flag!.start) - Date.parse(y.since ?? y.flag!.start);
  const opOrder = (x: Row, y: Row) => {
    // Something open first: standby longest first, then other open items, then in use by unit number.
    const rank = (r: Row) => (r.standby ? 0 : r.busy ? 1 : 2);
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (x.standby && y.standby) return Date.parse(x.standby.start) - Date.parse(y.standby.start);
    return byNumber(x, y);
  };
  const inGroup = (g: BoardGroup) => shown.filter((r) => r.group === g).sort(g === 'operational' ? opOrder : g === 'parked' ? byNumber : longest);
  // Sub-statuses of a status with a count, largest first.
  const subsOf = (g: BoardGroup) => Object.entries(counts.subs)
    .filter(([k]) => k.startsWith(`${g}:`))
    .map(([k, n]) => ({ key: k, sub: k.slice(g.length + 1) as BoardSub, n }))
    .sort((x, y) => y.n - x.n || BOARD_SUB_LABELS[x.sub].localeCompare(BOARD_SUB_LABELS[y.sub]));
  const pick = (a: Asset) => { if (!tv) setOpen(a); };
  const hrs = (iso?: string | null) => (iso ? fmtHours(hoursSince(iso, app.now)) : '');
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : '');
  const groups = GROUPS.filter((g) => g.group !== 'parked' || counts.groups.parked > 0 || filter.groups.includes('parked'));
  const bar = [
    { key: 'operational:in_use', cls: 'fb-run', word: 'in use' },
    { key: 'operational:standby', cls: 'fb-standby', word: 'on standby' },
  ].map((b) => ({ ...b, n: counts.subs[b.key] ?? 0 }))
    .concat([
      { key: 'sched', cls: 'fb-sched', word: 'scheduled down', n: counts.groups.sched },
      { key: 'unsched', cls: 'fb-down', word: 'unscheduled down', n: counts.groups.unsched },
      { key: 'parked', cls: 'fb-parked', word: 'parked', n: counts.groups.parked },
    ]);

  const card = (r: Row) => {
    const f = r.flag;
    if (!f) {
      const items: JSX.Element[] = [];
      if (r.standby) items.push(<li key="sb" className="ui-standby"><span>‖ Standby: {sbLabel(r.standby.reasonCode)}</span><span>{hrs(r.standby.start)}</span></li>);
      if (r.proposal) items.push(<li key="pr" className="ui-warn"><span>Down proposed: {r.proposal.reasonCode}, waiting for a supervisor</span><span>{hrs(r.proposal.enteredAt)}</span></li>);
      if (r.noReadingSince !== undefined) items.push(<li key="nr" className="ui-muted"><span>No hour meter reading</span><span>{r.noReadingSince ? hrs(r.noReadingSince) : 'none yet'}</span></li>);
      for (const x of r.alerts) items.push(<li key={x.kind} className="ui-warn"><span>⚠ {ALERT_PLAIN[x.kind].title}</span><span>{hrs(x.since)}</span></li>);
      const parked = r.group === 'parked';
      return (
        <button key={r.unitId} type="button" className={`ucard uc-${parked ? 'parked' : r.standby ? 'standby' : 'run'} uc-small`} onClick={() => pick(r.a)}
          aria-label={`${r.unitNumber}, ${parked ? 'parked' : r.standby ? `on standby for ${hrs(r.standby.start)}` : 'operational'}`}>
          <span className="uc-head">
            <strong>{r.unitNumber}</strong><span className="muted small">{r.model}</span>
            <span className="uc-time">{parked ? 'parked' : r.since ? <><span className="muted small">up </span>{hrs(r.since)}</> : <span className="muted small">no stops on record</span>}</span>
          </span>
          {!parked && (items.length ? <ul className="uc-items">{items}</ul> : <span className="uc-ok small">In use</span>)}
        </button>
      );
    }
    const eta = f.etas.at(-1);
    const late = eta && Date.parse(eta.eta) < Date.parse(app.now);
    const noEta = !eta && hoursSince(f.start, app.now) >= app.rules.etaRequiredAfterHours;
    const st = f.stages.at(-1);
    return (
      <button key={r.unitId} type="button" className={`ucard uc-${r.group}`} onClick={() => pick(r.a)}
        aria-label={`${r.unitNumber} ${r.group === 'sched' ? 'scheduled down' : 'unscheduled down'} for ${hrs(r.since)}`}>
        <span className="uc-head">
          <strong>{r.unitNumber}</strong><span className="muted small">{r.model}</span>
          <span className="uc-time"><span className="muted small">down </span>{hrs(r.since)}</span>
        </span>
        <span className="uc-reason">{f.reasonCode} <span className="muted">· {locationLabel(f, app.ds)}</span></span>
        <ul className="uc-items">
          <li className={r.stageLate ? 'ui-warn' : 'ui-stage'}><span>{st ? STAGE_LABELS[st.stage] : BOARD_SUB_LABELS.no_stage}</span><span>{hrs(stageSince(f))}</span></li>
          <li className={late || noEta ? 'ui-late' : 'ui-muted'}>
            {eta ? <><span>{late ? 'ETA passed' : 'ETA'} {siteTime(eta.eta, tz, true)}</span><span>{late ? hrs(eta.eta) : ''}</span></>
              : noEta ? <span>NO ETA</span> : <span>ETA not due yet</span>}
          </li>
          {r.alerts.map((x) => <li key={x.kind} className="ui-warn"><span>⚠ {ALERT_PLAIN[x.kind].title}</span><span>{x.kind === 'pm_overrun' ? '' : hrs(x.since)}</span></li>)}
        </ul>
      </button>
    );
  };

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
        <div className="fleetbar" role="img" aria-label={bar.filter((b) => b.n > 0).map((b) => `${b.n} ${b.word}`).join(', ')}>
          {bar.filter((b) => b.n > 0).map((b) => <span key={b.key} className={b.cls} style={{ flexGrow: b.n }} title={`${b.n} ${b.word}`} />)}
        </div>
      )}

      <div className="bstatus" aria-label="Units by status, and alerts. Press a status to show only those units.">
        {TILES.map((g) => {
          const subs = subsOf(g.group);
          return (
            <button
              key={g.group}
              type="button"
              className={`bstat bs-${g.group}`}
              aria-pressed={filter.groups.includes(g.group)}
              disabled={tv}
              onClick={() => setFilter({ ...filter, groups: toggleIn(filter.groups, g.group) })}
              title={tv ? undefined : `Show only ${g.word.toLowerCase()} units (press again to undo)`}
            >
              <span className="bs-w">{g.word}</span>
              <span className="bs-n">{counts.groups[g.group]}<span className="bs-pct">{pct(counts.groups[g.group])}</span></span>
              <span className="bs-subs">{subs.length ? subs.slice(0, 3).map((x) => `${x.n} ${BOARD_SUB_LABELS[x.sub].toLowerCase()}`).join(' · ') : 'None'}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`bstat bs-alerts${alertCount ? ' bs-alerts-on' : ''}`}
          aria-expanded={alertsOpen}
          aria-controls="board-alerts"
          disabled={tv || alertCount === 0}
          onClick={() => setShowAlerts(!showAlerts)}
          title={tv ? undefined : showAlerts ? 'Hide the alerts' : 'Show the alerts'}
        >
          <span className="bs-w">Alerts</span>
          <span className="bs-n">{alertCount}<span className="bs-pct">{alertCount ? (alertsOpen ? 'hide ▴' : 'show ▾') : ''}</span></span>
          <span className="bs-subs">{alertCount ? alertKinds.slice(0, 2).map(([k, n]) => `${n} ${ALERT_PLAIN[k as Alert['kind']].title}`).join(' · ') : 'Nothing needs action'}</span>
        </button>
      </div>

      {alertsOpen && alertCount > 0 && (
        <section id="board-alerts" className="balerts" aria-label="Alerts">
          <ol>
            {alertList.map((x) => {
              const u = unitOf(x.unitId);
              const p = ALERT_PLAIN[x.kind];
              return (
                <li key={`${x.kind}-${x.unitId}-${x.flagId ?? ''}`}>
                  <button type="button" className="balert" onClick={() => u && pick(u)} disabled={tv}>
                    <span className="ba-unit">{u?.unitNumber ?? x.unitId}</span>
                    <span className="ba-body">
                      <strong>{p.title}</strong>
                      <span className="muted small">{p.what} Next: {p.next} ({x.goesTo.join(', ')}).</span>
                    </span>
                    <span className="ba-time">{x.kind === 'pm_overrun' ? 'now' : hrs(x.since)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          {!tv && <a className="small" href="#/alerts">Open the alerts page</a>}
        </section>
      )}

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
            placeholder="Find a unit, reason, stage or place"
            aria-label="Find a unit, reason, stage or place"
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          />
          {filtered && <button type="button" className="linkish" onClick={clear}>Clear filters</button>}
        </div>
      )}

      {shown.length === 0 && (
        <div className="card bempty">
          No units match these filters.{' '}
          <button type="button" className="linkish" onClick={clear}>Clear filters</button>
        </div>
      )}

      {shown.length > 0 && (
        <div className="bcols">
          {groups.map((g) => {
            const list = inGroup(g.group);
            const subs = subsOf(g.group);
            if (!list.length && (filtered || g.group === 'parked')) return null;
            return (
              <section key={g.group} className={`bcol bcol-${g.group}`} aria-label={g.word}>
                <div className="bcol-head">
                  <h3>{g.word} <span className="muted">· {list.length}</span></h3>
                  {subs.length > 0 && g.group !== 'parked' && (
                    <div className="bsubs" role="group" aria-label={`${g.word} by sub-status`}>
                      {subs.map((x) => (
                        <button key={x.key} type="button" className={`bsub bsub-${x.sub}`} aria-pressed={filter.subs.includes(x.key)} disabled={tv}
                          onClick={() => setFilter({ ...filter, subs: toggleIn(filter.subs, x.key) })}>
                          {BOARD_SUB_LABELS[x.sub]} <strong>{x.n}</strong>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {list.length === 0 ? <p className="small muted bcol-empty">{g.empty}</p> : (
                  <div className={g.group === 'operational' || g.group === 'parked' ? 'bcards bcards-small' : 'bcards'}>{list.map(card)}</div>
                )}
              </section>
            );
          })}
        </div>
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
          Press a status or a sub-status to show only those units, and again to undo. Tap a unit to {tech ? 'propose a down flag, update its stage or put it on standby' : 'flag it down, move its stage, release it or put it on standby'}.
          A unit is operational unless a down flag is open. Down time counts from the first flag of the stop; up time from the last release or standby.
        </p>
      )}

      {open && <FlagSheet asset={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
