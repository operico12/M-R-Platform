// Fleet status board (plan 4.2, Figure 1, docs/status-board.md). Three statuses (Ope, 29 Oct 2026):
// operational, scheduled down, unscheduled down. Every unit is a table row listing what is open on it
// and for how long (Ope, 31 Oct 2026). Readable from 3 metres in TV mode.

import {
  ALERT_PLAIN, BOARD_SUB_LABELS, STAGE_LABELS, sortAlerts, activeAlerts, boardCounts, boardFilterFromQuery, boardFilterToQuery, boardPlace, currentStandby,
  downSince, filterBoard, openWaits, stageSince, subKey, toggleIn, upSince, waitBreakdown,
  type Alert, type Asset, type BoardFilter, type BoardGroup, type BoardSub, type DownFlag, type StandbyFlag,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagIcon } from '../components/FlagIcon';
import { FlagSheet } from '../components/FlagSheet';
import { fmtHours, hoursSince, locationLabel, siteTime, unitStatus } from '../format';
import { useApp } from '../store';

// Ope, 29 Oct 2026: four tiles on top (these three and Alerts). Parked is a tag under any of them;
// the alerts list replaces the downline queue at the bottom.
const GROUPS: { group: BoardGroup; word: string; empty: string }[] = [
  { group: 'operational', word: 'Operational', empty: 'No units are operational.' },
  { group: 'unsched', word: 'Unscheduled down', empty: 'Nothing is down unscheduled.' },
  { group: 'sched', word: 'Scheduled down', empty: 'Nothing is scheduled down.' },
];
const TILES = GROUPS;
const NO_READING_HOURS = 14;
// Alerts already shown another way on the card: the ETA line, the proposal line, the reading line, the stage line.
const SHOWN_ELSEWHERE = new Set<Alert['kind']>(['no_eta', 'eta_passed', 'proposal_unconfirmed', 'no_smu_reading', 'waiting_line', 'waiting_parts']);

interface Row {
  unitId: string; unitNumber: string; model: string; group: BoardGroup; sub: BoardSub; text?: string;
  a: Asset; flag?: DownFlag; standby?: StandbyFlag; proposal?: DownFlag; since?: string;
  noReadingSince?: string | null; alerts: Alert[]; stageLate: boolean; busy: boolean; parked: boolean; parkedSince?: string;
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

  const alerts = useMemo(
    () => activeAlerts({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, rules: app.rules, calendar: app.ds.calendar, now: app.now }),
    [app.ds, app.flags, app.rules, app.now],
  );
  const sbLabel = (code: string) => app.standbyReasons.find((x) => x.code === code)?.label ?? code;
  const waitLabel = (code: string) => app.waitKinds.find((x) => x.code === code)?.label ?? code;

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
      const isParked = parked;
      const parkedSince = parked ? app.ds.lifecycle.filter((l) => l.assetId === a.id && l.status !== 'active' && !l.end).map((l) => l.start).sort().at(-1) : undefined;
      const proposal = !flag && !parked ? app.flags.find((f) => f.unitId === a.id && f.state === 'proposed') : undefined;
      const last = lastReading.get(a.id);
      const noReadingSince = group === 'operational' && !parked && (!last || hoursSince(last, app.now) > NO_READING_HOURS) ? (last ?? null) : undefined;
      const since = flag ? downSince(flag, app.flags) : group === 'operational' ? upSince(a.id, app.flags, app.now, app.standby) : undefined;
      const mine = alerts.filter((x) => x.unitId === a.id);
      const stageLate = mine.some((x) => x.kind === 'waiting_line' || x.kind === 'waiting_parts');
      const text = flag
        ? `${flag.reasonCode} ${locationLabel(flag, app.ds)} ${openWaits(a.id, app.waits).map((w) => `waiting ${waitLabel(w.kind)}`).join(' ')}`
        : sb ? `standby ${sbLabel(sb.reasonCode)}` : proposal ? `proposed ${proposal.reasonCode}` : undefined;
      const shownAlerts = mine.filter((x) => !SHOWN_ELSEWHERE.has(x.kind));
      const busy = Boolean(sb || proposal || isParked || noReadingSince !== undefined || shownAlerts.length);
      return { unitId: a.id, unitNumber: a.unitNumber, model: a.model, group, sub, text: isParked ? `${text ?? ''} parked` : text, a, flag, standby: sb, proposal, since, noReadingSince, alerts: shownAlerts, stageLate, busy, parked: isParked, parkedSince };
    });
  }, [app.ds, app.flags, app.now, app.standby, app.standbyReasons, app.waits, app.waitKinds, alerts]);

  const counts = boardCounts(rows, filter);
  const total = Object.values(counts.groups).reduce((s, n) => s + n, 0);
  const shown = filterBoard(rows, filter);
  const models = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.model, (m.get(r.model) ?? 0) + 1);
    return [...m].sort((x, y) => x[0].localeCompare(y[0]));
  }, [rows]);

  // A missing reading is shown on the unit's row, not counted as an alert.
  const alertList = useMemo(() => sortAlerts(alerts.filter((a) => a.kind !== 'no_smu_reading')), [alerts]);
  const alertCount = alertList.length;
  const alertKinds = Object.entries(alertList.reduce<Record<string, number>>((m, a) => ({ ...m, [a.kind]: (m[a.kind] ?? 0) + 1 }), {}));
  const unitOf = (id: string) => app.ds.assets.find((a) => a.id === id);
  const toAlerts = () => document.getElementById('board-alerts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const tech = app.actor.role === 'technician';
  const filtered = filter.groups.length > 0 || filter.subs.length > 0 || filter.models.length > 0 || filter.q.trim() !== '';
  const clear = () => setFilter({ groups: [], subs: [], models: [], q: '' });

  const byNumber = (x: Row, y: Row) => x.unitNumber.localeCompare(y.unitNumber, undefined, { numeric: true });
  const longest = (x: Row, y: Row) => Date.parse(x.since ?? x.flag!.start) - Date.parse(y.since ?? y.flag!.start);
  const opOrder = (x: Row, y: Row) => {
    // Something open first: standby longest first, then other open items, then in use by unit number.
    const rank = (r: Row) => (r.standby ? 0 : r.parked ? 2 : r.busy ? 1 : 3);
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (x.standby && y.standby) return Date.parse(x.standby.start) - Date.parse(y.standby.start);
    return byNumber(x, y);
  };
  const inGroup = (g: BoardGroup) => shown.filter((r) => r.group === g).sort(g === 'operational' ? opOrder : longest);
  // Sub-statuses of a status with a count, largest first.
  const subsOf = (g: BoardGroup) => Object.entries(counts.subs)
    .filter(([k]) => k.startsWith(`${g}:`))
    .map(([k, n]) => ({ key: k, sub: k.slice(g.length + 1) as BoardSub, n }))
    .sort((x, y) => y.n - x.n || BOARD_SUB_LABELS[x.sub].localeCompare(BOARD_SUB_LABELS[y.sub]));
  const pick = (a: Asset) => { if (!tv) setOpen(a); };
  const hrs = (iso?: string | null) => (iso ? fmtHours(hoursSince(iso, app.now)) : '');
  const pct = (n: number) => (total ? `${Math.round((n / total) * 100)}%` : '');
  const groups = GROUPS;
  const bar = [
    { key: 'operational:in_use', cls: 'fb-run', word: 'in use' },
    { key: 'operational:standby', cls: 'fb-standby', word: 'on standby' },
    { key: 'operational:parked', cls: 'fb-parked', word: 'parked' },
  ].map((b) => ({ ...b, n: counts.subs[b.key] ?? 0 }))
    .concat([
      { key: 'sched', cls: 'fb-sched', word: 'scheduled down', n: counts.groups.sched },
      { key: 'unsched', cls: 'fb-down', word: 'unscheduled down', n: counts.groups.unsched },
    ]);

  // One table row per unit (Ope, 31 Oct 2026). The Flags column lists only what takes time from the unit,
  // one sub-row each with its hours: wait tags of the stop for a down unit; standby, parked or a proposal when up.
  type Item = { key: string; code: string; label: string; time: string; running: boolean; cls: string };
  const items = (r: Row): Item[] => {
    const out: Item[] = [];
    const f = r.flag;
    if (f) {
      const from = Date.parse(r.since ?? f.start);
      const stop = app.waits.filter((w) => w.unitId === r.unitId && w.state !== 'voided' && Date.parse(w.start) >= from)
        .sort((x, y) => Number(!!x.end) - Number(!!y.end) || Date.parse(x.start) - Date.parse(y.start));
      for (const w of stop) {
        const h = ((w.end ? Date.parse(w.end) : Date.parse(app.now)) - Date.parse(w.start)) / 3_600_000;
        out.push({ key: w.id, code: w.kind, label: `${waitLabel(w.kind)}${w.note ? ` · ${w.note}` : ''}`, time: fmtHours(h), running: !w.end, cls: 'fi-wait' });
      }
    } else {
      if (r.standby) out.push({ key: 'sb', code: r.standby.reasonCode, label: `Standby: ${sbLabel(r.standby.reasonCode)}`, time: hrs(r.standby.start), running: true, cls: 'fi-standby' });
      if (r.proposal) out.push({ key: 'pr', code: 'proposed', label: `Down proposed: ${r.proposal.reasonCode}`, time: hrs(r.proposal.enteredAt), running: true, cls: 'fi-warn' });
    }
    if (r.parked) out.push({ key: 'pk', code: 'parked', label: 'Parked', time: hrs(r.parkedSince), running: true, cls: 'fi-parked' });
    return out;
  };
  // Hours of the stop with at least one wait open (overlaps counted once, KPI-046).
  const waitingOf = (r: Row) => {
    if (!r.flag || !r.since) return 0;
    const stop = app.waits.filter((w) => w.unitId === r.unitId && Date.parse(w.start) >= Date.parse(r.since!));
    return waitBreakdown(stop, { from: r.since, to: app.now }, app.now).waiting;
  };
  const STATUS_WORD: Record<BoardGroup, string> = { operational: 'Operational', unsched: 'Unscheduled', sched: 'Scheduled' };
  const etaCell = (f?: DownFlag) => {
    if (!f) return <span className="muted">—</span>;
    const eta = f.etas.at(-1);
    if (eta) {
      const late = Date.parse(eta.eta) < Date.parse(app.now);
      return <span className={late ? 'eta-late' : ''}>{siteTime(eta.eta, tz, true)}{late && <span className="bt-sub">passed {hrs(eta.eta)} ago</span>}</span>;
    }
    if (hoursSince(f.start, app.now) >= app.rules.etaRequiredAfterHours) return <span className="eta-late">No ETA</span>;
    return <span className="muted">—</span>;
  };
  const row = (r: Row) => {
    const f = r.flag;
    const st = f?.stages.at(-1);
    const list = items(r);
    const statusText = STATUS_WORD[r.group];
    const waiting = list.length && f ? waitingOf(r) : 0;
    return (
      <tr key={r.unitId} className={`brow br-${r.group}`} onClick={() => pick(r.a)} tabIndex={tv ? -1 : 0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r.a); } }}
        aria-label={`${r.unitNumber}, ${statusText}${r.since ? `, ${f ? 'down' : 'up'} ${hrs(r.since)}` : ''}`}>
        <td className="bt-unit"><strong>{r.unitNumber}</strong><span className="muted small">{r.model}</span></td>
        <td className="bt-status"><span className={`spill sp-${r.group}`}><span className="dot" />{statusText}</span></td>
        <td className="bt-where" data-label="Where">{f ? locationLabel(f, app.ds) : <span className="muted">In the field</span>}</td>
        <td className="bt-problem" data-label="Problem">{f ? f.reasonCode : <span className="muted">—</span>}</td>
        <td className="bt-stage" data-label="Stage">{f ? <span className={r.stageLate ? 'ch-warn-text' : ''}><FlagIcon code={st?.stage ?? 'no_stage'} /> {st ? STAGE_LABELS[st.stage] : BOARD_SUB_LABELS.no_stage}<span className="bt-sub">{hrs(stageSince(f))}</span></span> : <span className="muted">—</span>}</td>
        <td className="bt-time" data-label="Time">{r.since
          ? <span className={f ? 'tm-down' : 'tm-up'}><span className="tm-arrow" aria-hidden="true">{f ? '↓' : '↑'}</span>{hrs(r.since)}</span>
          : <span className="muted small">no stops on record</span>}</td>
        <td className="bt-eta" data-label="ETA">{etaCell(f)}</td>
        <td className="bt-flags" data-label="Flags">
          {list.length === 0 ? <span className="muted">—</span> : (
            <ul className="fitems">
              {list.map((c) => (
                <li key={c.key} className={`${c.cls}${c.running ? ' fi-run' : ''}`}>
                  <span className="fi-l"><FlagIcon code={c.code} size={14} /> {c.label}</span><span className="fi-t">{c.time}</span>
                </li>
              ))}
              {f && waiting > 0 && <li className="fi-total"><span className="fi-l">Waiting, of {hrs(r.since)} down</span><span className="fi-t">{fmtHours(waiting)}</span></li>}
            </ul>
          )}
        </td>
      </tr>
    );
  };
  // Unscheduled down first (longest first), then scheduled down, then operational (something open first).
  const tableRows = [...inGroup('unsched'), ...inGroup('sched'), ...inGroup('operational')];
  const allSubs = groups.flatMap((g) => subsOf(g.group).map((x) => ({ ...x, group: g.group })));

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
          disabled={tv}
          onClick={toAlerts}
          title={tv ? undefined : 'Go to the alerts list'}
        >
          <span className="bs-w">Alerts</span>
          <span className="bs-n">{alertCount}<span className="bs-pct">{alertCount && !tv ? 'see list ▾' : ''}</span></span>
          <span className="bs-subs">{alertCount ? alertKinds.slice(0, 2).map(([k, n]) => `${n} ${ALERT_PLAIN[k as Alert['kind']].title}`).join(' · ') : 'Nothing needs action'}</span>
        </button>
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
        <>
          {!tv && allSubs.length > 0 && (
            <div className="bsubs" role="group" aria-label="Sub-status">
              {allSubs.map((x) => (
                <button key={x.key} type="button" className={`bsub bsub-${x.sub} bsub-g-${x.group}`} aria-pressed={filter.subs.includes(x.key)}
                  onClick={() => setFilter({ ...filter, subs: toggleIn(filter.subs, x.key) })}>
                  <FlagIcon code={x.sub} size={14} /> {BOARD_SUB_LABELS[x.sub]} <strong>{x.n}</strong>
                </button>
              ))}
            </div>
          )}
          <div className="btable-wrap">
            <table className="btable">
              <thead>
                <tr><th>Unit</th><th>Status</th><th>Where</th><th>Problem</th><th>Stage</th><th>Time</th><th>ETA</th><th>Flags</th></tr>
              </thead>
              <tbody>{tableRows.map(row)}</tbody>
            </table>
          </div>
        </>
      )}

      <section id="board-alerts" className="balerts" aria-label="Alerts">
        <h3><FlagIcon code="alert" size={18} /> Alerts · {alertCount}{alertCount > 0 ? ', most urgent first' : ''}</h3>
        {alertCount === 0 ? <p className="muted small">No alerts. Nothing needs action right now.</p> : (
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
        )}
        {!tv && <a className="small" href="#/alerts">Open the alerts page</a>}
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
