// Shop lines view (plan 4.2, Figure 6): every line occupied, free or closed;
// units down in the field; the queue waiting for a line with a suggested line.

import { currentLocation, currentStage, lineName, lineOccupancy } from '@mr/core';
import { useMemo } from 'react';
import { fmtHours, fmtPct, hoursSince, siteTime, stageLabel } from '../format';
import { useApp } from '../store';

export function ShopLines() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const unit = (id: string) => app.ds.assets.find((a) => a.id === id)!;
  const open = app.flags.filter((f) => f.state === 'open');
  const week = { from: new Date(Date.parse(app.now) - 7 * 864e5).toISOString(), to: app.now };

  const lines = useMemo(
    () =>
      app.ds.shopLines.map((l) => {
        const closure = app.ds.closures.find((c) => c.lineId === l.id && Date.parse(c.start) <= Date.parse(app.now) && (!c.end || Date.parse(app.now) < Date.parse(c.end)));
        const inLine = open.filter((f) => currentLocation(f)?.kind === 'shop_line' && currentLocation(f)?.shopLineId === l.id);
        const occ = lineOccupancy(l, app.flags, app.ds.closures, week, app.now);
        return { l, closure, inLine, occ };
      }),
    [app.flags, app.now],
  );
  const field = open.filter((f) => currentLocation(f)?.kind === 'field' || currentLocation(f)?.kind === 'towing');
  const waiting = open.filter((f) => currentStage(f)?.stage === 'waiting_line');
  const free = lines.filter((x) => !x.closure && x.inLine.length < x.l.capacity);

  return (
    <div className="stack">
      <div className="page-head"><h2>Shop lines</h2><span className="muted small">Occupancy is over the last 7 days, closed time excluded.</span></div>
      <div className="lines">
        {lines.map(({ l, closure, inLine, occ }) => (
          <div key={l.id} className={`line ${closure ? 'closed' : inLine.length ? '' : 'free'}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="name">{lineName(l)}</span>
              <span className="small muted">{l.lineType}</span>
            </div>
            {closure ? (
              <div className="small"><strong>Closed</strong>: {closure.reason}</div>
            ) : inLine.length ? (
              inLine.map((f) => (
                <div key={f.id} className="small">
                  <strong>{unit(f.unitId).unitNumber}</strong> · {f.reasonCode} · {stageLabel(f)} · {fmtHours(hoursSince(currentLocation(f)!.start, app.now))} in line
                  {f.etas.at(-1) && <> · ETA {siteTime(f.etas.at(-1)!.eta, tz)}</>}
                </div>
              ))
            ) : (
              <div className="small muted">Free</div>
            )}
            <div className="small muted">Occupancy {fmtPct(occ.occupancy, 0)}</div>
          </div>
        ))}
      </div>

      <div className="grid two">
        <section className="card">
          <h3>Down in field</h3>
          {field.length === 0 ? <p className="small muted">None.</p> : (
            <table><thead><tr><th>Unit</th><th>Where</th><th>Stage</th><th className="num">Down</th><th>ETA</th></tr></thead><tbody>
              {field.map((f) => {
                const l = currentLocation(f)!;
                return (
                  <tr key={f.id}>
                    <td>{unit(f.unitId).unitNumber}</td>
                    <td>{l.kind === 'towing' ? 'Towing' : l.fieldLocation}</td>
                    <td>{stageLabel(f)}</td>
                    <td className="num">{fmtHours(hoursSince(f.start, app.now))}</td>
                    <td>{f.etas.at(-1) ? siteTime(f.etas.at(-1)!.eta, tz) : <strong style={{ color: 'var(--down)' }}>No ETA</strong>}</td>
                  </tr>
                );
              })}
            </tbody></table>
          )}
        </section>
        <section className="card">
          <h3>Waiting for a line</h3>
          {waiting.length === 0 ? <p className="small muted">Nobody waiting.</p> : (
            <table><thead><tr><th>#</th><th>Unit</th><th className="num">Waiting</th><th>Suggested line</th></tr></thead><tbody>
              {waiting
                .sort((a, b) => Date.parse(currentStage(a)!.start) - Date.parse(currentStage(b)!.start))
                .map((f, i) => {
                  const a = unit(f.unitId);
                  const s = free.find((x) => x.l.lineType === 'general' && (x.l.fits.length === 0 || x.l.fits.includes(a.model)));
                  return (
                    <tr key={f.id}>
                      <td>{i + 1}</td>
                      <td>{a.unitNumber}</td>
                      <td className="num">{fmtHours(hoursSince(currentStage(f)!.start, app.now))}</td>
                      <td>{s ? lineName(s.l) : <span className="muted">None free</span>}</td>
                    </tr>
                  );
                })}
            </tbody></table>
          )}
        </section>
      </div>
    </div>
  );
}
