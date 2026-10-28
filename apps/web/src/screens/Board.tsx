// Fleet status board (plan 4.2, Figure 1). Answers "what is down, why, and
// when is it back?" Readable from 3 metres in TV mode.

import { STAGE_LABELS, activeAlerts, downlineQueue, type Asset } from '@mr/core';
import { useMemo, useState } from 'react';
import { FlagSheet } from '../components/FlagSheet';
import { STATUS_WORD, fmtHours, hoursSince, locationLabel, siteTime, stageLabel, unitStatus, type UnitStatus } from '../format';
import { useApp } from '../store';

export function Board({ tv }: { tv: boolean }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [open, setOpen] = useState<Asset | null>(null);

  const rows = useMemo(
    () => app.ds.assets.map((a) => ({ a, ...unitStatus(a.id, app.flags, app.ds, app.now) })),
    [app.ds, app.flags, app.now],
  );
  const counts = rows.reduce<Record<UnitStatus, number>>((m, r) => ({ ...m, [r.status]: m[r.status] + 1 }), { run: 0, sched: 0, down: 0, stale: 0, parked: 0 });
  const queue = downlineQueue(app.flags, app.now);
  const alerts = useMemo(
    () => activeAlerts({ assets: app.ds.assets, flags: app.flags, smu: app.ds.smu, rules: app.rules, calendar: app.ds.calendar, now: app.now }),
    [app.ds, app.flags, app.rules, app.now],
  );
  const proposals = app.flags.filter((f) => f.state === 'proposed');
  const order: Record<UnitStatus, number> = { down: 0, sched: 1, stale: 2, run: 3, parked: 4 };
  const sorted = [...rows].sort((x, y) => order[x.status] - order[y.status] || x.a.unitNumber.localeCompare(y.a.unitNumber));
  const tech = app.actor.role === 'technician';

  return (
    <div>
      <div className="page-head">
        <h2>Fleet status · Haul trucks</h2>
        <div className="trust">
          <span>Site time {siteTime(app.now, tz)}</span>
          <span>Last sync {siteTime(app.lastSync, tz, true)}</span>
          <span>Data: synthetic fleet</span>
        </div>
      </div>

      <div className="counts" aria-label="Counts by status">
        <Count cls="run" word={STATUS_WORD.run} n={counts.run} />
        <Count cls="sched" word={STATUS_WORD.sched} n={counts.sched} />
        <Count cls="down" word={STATUS_WORD.down} n={counts.down} />
        <Count cls="stale" word={STATUS_WORD.stale} n={counts.stale} />
        {counts.parked > 0 && <Count cls="stale" word={STATUS_WORD.parked} n={counts.parked} />}
        <div className="count"><div className="muted small">Downline queue</div><div className="n">{queue.length}</div></div>
        <div className="count"><div className="muted small">Alerts</div><div className="n">{alerts.filter((a) => a.kind !== 'no_smu_reading').length}</div></div>
      </div>

      {proposals.length > 0 && !tv && (
        <div className="warns">{proposals.length} proposed down flag{proposals.length > 1 ? 's' : ''} waiting for a supervisor: {proposals.map((p) => app.ds.assets.find((a) => a.id === p.unitId)?.unitNumber).join(', ')}</div>
      )}

      <div className="tiles">
        {sorted.map(({ a, status, flag }) => {
          const eta = flag?.etas.at(-1);
          const noEta = flag && !eta && hoursSince(flag.start, app.now) >= app.rules.etaRequiredAfterHours;
          return (
            <button
              key={a.id}
              className={`tile ${status === 'parked' ? 'stale' : status} ${flag ? 'wide' : ''}`}
              onClick={() => !tv && setOpen(a)}
              aria-label={`${a.unitNumber} ${STATUS_WORD[status]}`}
            >
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="unit">{a.unitNumber}</span>
                <span className={`status ${status === 'parked' ? 'stale' : status}`}>{STATUS_WORD[status]}</span>
              </div>
              {flag ? (
                <>
                  <div className="detail"><strong>{flag.reasonCode}</strong> · {fmtHours(hoursSince(flag.start, app.now))} · {stageLabel(flag)}</div>
                  <div className="detail">{locationLabel(flag, app.ds)}</div>
                  {eta ? <div className="detail">ETA {siteTime(eta.eta, tz, true)}</div> : noEta ? <div className="noeta">NO ETA</div> : null}
                </>
              ) : (
                <div className="detail">{a.model}</div>
              )}
            </button>
          );
        })}
      </div>

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
          Tap a unit to {tech ? 'propose a down flag or update its stage' : 'flag it down, move its stage or release it'}. Units show ● UP when no flag is open; standby needs the fleet system (phase 1b).
        </p>
      )}

      {open && <FlagSheet asset={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Count({ cls, word, n }: { cls: string; word: string; n: number }) {
  return (
    <div className="count">
      <div className={`status ${cls}`}>{word}</div>
      <div className="n">{n}</div>
    </div>
  );
}
