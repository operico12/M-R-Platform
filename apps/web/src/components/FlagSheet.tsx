// Flag sheet: flag down in 3 taps, move the stage in 2, release through the
// checklist (plan 10.4). Every button calls a core command; the rules decide.

import {
  LOCATION_LABELS,
  STAGE_LABELS,
  SYSTEMS,
  can,
  canPropose,
  changeStage,
  confirmProposal,
  currentLocation,
  currentStage,
  flagDown,
  lineName,
  moveLocation,
  proposeDown,
  rejectProposal,
  release,
  releaseChecklist,
  setEta,
  shiftAt,
  switchType,
  voidFlag,
  type Asset,
  type CommandResult,
  type DownFlag,
  type FlagType,
  type LocationKind,
  type ReleaseDetails,
  type Stage,
} from '@mr/core';
import { useMemo, useState } from 'react';
import { fmtHours, fromLocalInput, hoursSince, locationLabel, siteTime, stageLabel, toLocalInput } from '../format';
import { useApp } from '../store';

const UNSCHED_REASONS = Object.keys(SYSTEMS);
const SCHED_REASONS = ['PM 250', 'PM 500', 'PM 1000', 'Planned component change', 'Planned inspection', 'Shutdown'];

export function FlagSheet({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const app = useApp();
  const flag = app.flags.find((f) => f.unitId === asset.id && (f.state === 'open' || f.state === 'proposed'));
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="sheet" role="dialog" aria-label={`${asset.unitNumber} flag`}>
        <button className="btn close" onClick={onClose} aria-label="Close">✕</button>
        <h3>
          {asset.unitNumber} <span className="muted small">{asset.model} · {asset.fleet}</span>
        </h3>
        {!flag && <FlagDownForm asset={asset} onDone={onClose} />}
        {flag?.state === 'proposed' && <ProposalPanel asset={asset} flag={flag} />}
        {flag?.state === 'open' && <OpenFlagPanel asset={asset} flag={flag} onDone={onClose} />}
        <p className="small muted" style={{ marginTop: 24 }}>
          <a href={`#/unit/${asset.id}`} onClick={onClose}>Open unit page →</a>
        </p>
      </aside>
    </>
  );
}

function Result({ r }: { r: CommandResult | null }) {
  if (!r) return null;
  if (!r.ok) return <div className="errors" role="alert">{r.errors.map((e) => <div key={e}>{e}</div>)}</div>;
  if (r.warnings.length) return <div className="warns">{r.warnings.join(' ')}</div>;
  return null;
}

function Locked({ who }: { who: string }) {
  return <p className="locked">🔒 {who} can do this.</p>;
}

// ---------- flag down ----------

function FlagDownForm({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const area = asset.fleet;
  const direct = can(app.actor, 'set_clear_flag', area);
  const propose = !direct && canPropose(app.actor, 'set_clear_flag', area);
  const [type, setType] = useState<FlagType>('unscheduled');
  const [reason, setReason] = useState('');
  const [earlier, setEarlier] = useState(false);
  const [start, setStart] = useState(() => toLocalInput(new Date().toISOString(), tz));
  const [locKind, setLocKind] = useState<LocationKind>('field');
  const [fieldLoc, setFieldLoc] = useState(app.ds.fieldLocations[0]!);
  const [lineId, setLineId] = useState('');
  const [override, setOverride] = useState('');
  const [etaH, setEtaH] = useState<number | null>(null);
  const [r, setR] = useState<CommandResult | null>(null);
  const freeLines = useFreeLines(asset);

  if (!direct && !propose) return <Locked who="Supervisors, reliability engineers and superintendents" />;
  const reasons = type === 'unscheduled' ? UNSCHED_REASONS : SCHED_REASONS;

  const submit = () => {
    const startIso = earlier ? fromLocalInput(start, tz) : new Date().toISOString();
    const location = {
      kind: locKind,
      fieldLocation: locKind === 'field' ? fieldLoc : undefined,
      shopLineId: locKind === 'shop_line' ? lineId : undefined,
      overrideReason: override || undefined,
    };
    const res = propose
      ? app.run(asset, (ctx) => proposeDown(ctx, { reasonCode: reason, start: startIso, location, typeSuggestion: type }))
      : app.run(asset, (ctx) =>
          flagDown(ctx, {
            type,
            reasonCode: reason,
            system: type === 'unscheduled' ? reason : undefined,
            start: startIso,
            location,
            eta: etaH ? new Date(Date.parse(startIso) + etaH * 3_600_000).toISOString() : undefined,
            plannedDurationHours: type === 'scheduled' && etaH ? etaH : undefined,
          }),
        );
    setR(res);
    if (res.ok) onDone();
  };

  return (
    <div>
      <p className="muted small">{propose ? 'Technicians propose; a supervisor confirms.' : 'Start time defaults to now.'}</p>
      <div className="field">
        <span>Type</span>
        <div className="chips">
          {(['unscheduled', 'scheduled'] as const).map((t) => (
            <button key={t} className="chip" aria-pressed={type === t} onClick={() => { setType(t); setReason(''); }}>
              {t === 'unscheduled' ? '■ Unscheduled' : '▲ Scheduled'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>{type === 'unscheduled' ? 'System' : 'Reason'}</span>
        <div className="chips">
          {reasons.map((x) => (
            <button key={x} className="chip" aria-pressed={reason === x} onClick={() => setReason(x)}>{x}</button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Where is it?</span>
        <div className="chips">
          {(['field', 'shop_yard', 'shop_line'] as const).map((k) => (
            <button key={k} className="chip" aria-pressed={locKind === k} onClick={() => setLocKind(k)}>{LOCATION_LABELS[k]}</button>
          ))}
        </div>
      </div>
      {locKind === 'field' && (
        <label className="field">
          <span>Field location</span>
          <select value={fieldLoc} onChange={(e) => setFieldLoc(e.target.value)}>
            {app.ds.fieldLocations.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
      )}
      {locKind === 'shop_line' && (
        <LinePicker lines={freeLines} value={lineId} onChange={setLineId} override={override} setOverride={setOverride} />
      )}
      {!propose && (
        <div className="field">
          <span>ETA (optional; required after {app.rules.etaRequiredAfterHours} h)</span>
          <div className="chips">
            {[null, 2, 4, 8, 12, 24].map((h) => (
              <button key={String(h)} className="chip" aria-pressed={etaH === h} onClick={() => setEtaH(h)}>{h === null ? 'Later' : `+${h} h`}</button>
            ))}
          </div>
        </div>
      )}
      <div className="field">
        <label className="row">
          <input type="checkbox" checked={earlier} onChange={(e) => setEarlier(e.target.checked)} /> Started earlier
        </label>
        {earlier && <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start time (site time)" />}
        {earlier && <span className="small muted">Back-dated entries keep the real entry time and your name in the audit trail.</span>}
      </div>
      <Result r={r} />
      <button className="btn primary big" disabled={!reason} onClick={submit}>{propose ? 'Propose down' : 'Flag down'}</button>
    </div>
  );
}

function useFreeLines(asset: Asset) {
  const app = useApp();
  return useMemo(() => {
    const now = app.now;
    return app.ds.shopLines.map((l) => {
      const closed = app.ds.closures.some((c) => c.lineId === l.id && Date.parse(c.start) <= Date.parse(now) && (!c.end || Date.parse(now) < Date.parse(c.end)));
      const used = app.flags.filter((f) => f.state === 'open' && f.unitId !== asset.id && currentLocation(f)?.kind === 'shop_line' && currentLocation(f)?.shopLineId === l.id).length;
      const fits = l.fits.length === 0 || l.fits.includes(asset.model);
      return { line: l, closed, full: used >= l.capacity, fits };
    });
  }, [app.ds, app.flags, app.now, asset]);
}

function LinePicker({ lines, value, onChange, override, setOverride }: {
  lines: ReturnType<typeof useFreeLines>;
  value: string;
  onChange: (v: string) => void;
  override: string;
  setOverride: (v: string) => void;
}) {
  const chosen = lines.find((l) => l.line.id === value);
  return (
    <div className="field">
      <span>Shop line</span>
      <div className="chips">
        {lines.map(({ line, closed, full, fits }) => (
          <button key={line.id} className="chip" aria-pressed={value === line.id} disabled={closed || full} onClick={() => onChange(line.id)} title={closed ? 'Closed' : full ? 'Full' : fits ? 'Free' : 'Free, but the unit does not fit this line type'}>
            {lineName(line)} {closed ? '(closed)' : full ? '(full)' : fits ? '' : '(!)'}
          </button>
        ))}
      </div>
      {chosen && !chosen.fits && (
        <label className="field">
          <span>This unit does not fit {lineName(chosen.line)}. Override reason</span>
          <input value={override} onChange={(e) => setOverride(e.target.value)} />
        </label>
      )}
    </div>
  );
}

// ---------- proposal ----------

function ProposalPanel({ asset, flag }: { asset: Asset; flag: DownFlag }) {
  const app = useApp();
  const [r, setR] = useState<CommandResult | null>(null);
  const [why, setWhy] = useState('');
  const ok = can(app.actor, 'set_clear_flag', asset.fleet);
  return (
    <div>
      <p><strong>Proposed down</strong> by {flag.setBy} at {siteTime(flag.start, app.ds.site.timeZone)}: {flag.reasonCode}, {locationLabel(flag, app.ds)}.</p>
      <p className="small muted">It does not count until a supervisor confirms it.</p>
      <Result r={r} />
      {ok ? (
        <div className="stack">
          <div className="row">
            <button className="btn primary" onClick={() => setR(app.run(asset, (ctx) => confirmProposal(ctx, flag, { type: 'unscheduled' })))}>Confirm unscheduled</button>
            <button className="btn" onClick={() => setR(app.run(asset, (ctx) => confirmProposal(ctx, flag, { type: 'scheduled' })))}>Confirm scheduled</button>
          </div>
          <label className="field"><span>Reject reason</span><input value={why} onChange={(e) => setWhy(e.target.value)} /></label>
          <button className="btn danger" onClick={() => setR(app.run(asset, (ctx) => rejectProposal(ctx, flag, why)))}>Reject</button>
        </div>
      ) : (
        <Locked who="Supervisors" />
      )}
    </div>
  );
}

// ---------- open flag ----------

function OpenFlagPanel({ asset, flag, onDone }: { asset: Asset; flag: DownFlag; onDone: () => void }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [r, setR] = useState<CommandResult | null>(null);
  const [mode, setMode] = useState<'none' | 'move' | 'release' | 'switch' | 'void' | 'eta'>('none');
  const cur = currentStage(flag);
  const loc = currentLocation(flag);
  const eta = flag.etas.at(-1);
  const canStage = can(app.actor, 'update_stage', asset.fleet);
  const canFlag = can(app.actor, 'set_clear_flag', asset.fleet);
  const canMove = can(app.actor, 'move_location', asset.fleet);
  const shift = shiftAt(app.ds.calendar, app.now);

  const stages: Stage[] = ['waiting_crew', 'in_repair', 'waiting_parts', 'waiting_labour', 'waiting_other', 'ready_for_release'];
  return (
    <div className="stack">
      <div className="card">
        <div className={`status ${flag.type === 'scheduled' ? 'sched' : 'down'}`}>{flag.type === 'scheduled' ? '▲ SCHEDULED' : '■ UNSCHEDULED'}</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{flag.reasonCode}</div>
        <div className="small">
          Down {fmtHours(hoursSince(flag.start, app.now))} since {siteTime(flag.start, tz, true)} · {stageLabel(flag)} · {locationLabel(flag, app.ds)}
        </div>
        <div className="small">
          ETA: {eta ? siteTime(eta.eta, tz, true) : <strong style={{ color: 'var(--down)' }}>No ETA</strong>}
          {flag.etas.length > 1 && <span className="muted"> (first: {siteTime(flag.etas[0]!.eta, tz)})</span>}
        </div>
        <div className="small muted">Shift: {shift.name}, crew {shift.crew ?? '—'} · Source: {flag.source}</div>
      </div>

      <div>
        <div className="field">
          <span>Stage</span>
          {canStage ? (
            <div className="chips">
              {stages.map((s) => (
                <button
                  key={s}
                  className="chip"
                  aria-pressed={cur?.stage === s}
                  disabled={loc?.kind === 'towing'}
                  onClick={() => {
                    if (cur?.stage === s) return;
                    const reason = s === 'waiting_other' ? window.prompt(`Reason (${app.rules.waitingOtherReasons.join(', ')})`) ?? '' : undefined;
                    setR(app.run(asset, (ctx) => changeStage(ctx, flag, { stage: s, reason })));
                  }}
                >
                  {STAGE_LABELS[s]}
                </button>
              ))}
            </div>
          ) : (
            <Locked who="Technicians and supervisors in this area" />
          )}
        </div>
      </div>

      <Result r={r} />

      <div className="row">
        <button className="btn" disabled={!canMove} onClick={() => setMode('move')}>Move</button>
        <button className="btn" disabled={!canFlag} onClick={() => setMode('eta')}>ETA</button>
        <button className="btn" disabled={!can(app.actor, 'reclassify_flag', asset.fleet)} onClick={() => setMode('switch')}>Switch type</button>
        <button className="btn primary" disabled={!canFlag} onClick={() => setMode('release')}>Release</button>
        <button className="btn danger" disabled={!can(app.actor, 'void_flag', asset.fleet)} onClick={() => setMode('void')}>Void</button>
      </div>
      {!canFlag && <Locked who="Supervisors, reliability engineers and superintendents" />}

      {mode === 'move' && <MovePanel asset={asset} flag={flag} setR={setR} done={() => setMode('none')} />}
      {mode === 'eta' && <EtaPanel asset={asset} flag={flag} setR={setR} done={() => setMode('none')} />}
      {mode === 'switch' && <ReasonPanel label={`Switch to ${flag.type === 'scheduled' ? 'unscheduled' : 'scheduled'}`} hint="Closes this flag now and opens a linked one with the same stage and location (R7)." onGo={(reason) => { const x = app.run(asset, (ctx) => switchType(ctx, flag, { reason })); setR(x); if (x.ok) setMode('none'); }} />}
      {mode === 'void' && <ReasonPanel label="Void flag" hint="Entered in error. Kept in the audit trail, removed from every KPI." onGo={(reason) => { const x = app.run(asset, (ctx) => voidFlag(ctx, flag, reason)); setR(x); if (x.ok) onDone(); }} />}
      {mode === 'release' && <ReleasePanel asset={asset} flag={flag} setR={setR} onDone={onDone} />}
    </div>
  );
}

function MovePanel({ asset, flag, setR, done }: { asset: Asset; flag: DownFlag; setR: (r: CommandResult) => void; done: () => void }) {
  const app = useApp();
  const [kind, setKind] = useState<LocationKind>('towing');
  const [lineId, setLineId] = useState('');
  const [fieldLoc, setFieldLoc] = useState(app.ds.fieldLocations[0]!);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const lines = useFreeLines(asset);
  return (
    <div className="card">
      <h3>Move unit</h3>
      <div className="chips" style={{ marginBottom: 12 }}>
        {(['field', 'towing', 'shop_yard', 'shop_line'] as const).map((k) => (
          <button key={k} className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{LOCATION_LABELS[k]}</button>
        ))}
      </div>
      {kind === 'field' && (
        <label className="field"><span>Field location</span>
          <select value={fieldLoc} onChange={(e) => setFieldLoc(e.target.value)}>{app.ds.fieldLocations.map((f) => <option key={f}>{f}</option>)}</select>
        </label>
      )}
      {kind === 'shop_line' && <LinePicker lines={lines} value={lineId} onChange={setLineId} override={override} setOverride={setOverride} />}
      <label className="field"><span>Reason (needed for some moves)</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button
        className="btn primary"
        onClick={() => {
          const x = app.run(asset, (ctx) => moveLocation(ctx, flag, { kind, shopLineId: kind === 'shop_line' ? lineId : undefined, fieldLocation: kind === 'field' ? fieldLoc : undefined, reason: reason || undefined, overrideReason: override || undefined }));
          setR(x);
          if (x.ok) done();
        }}
      >
        Move
      </button>
    </div>
  );
}

function EtaPanel({ asset, flag, setR, done }: { asset: Asset; flag: DownFlag; setR: (r: CommandResult) => void; done: () => void }) {
  const app = useApp();
  const set = (h: number) => {
    const x = app.run(asset, (ctx) => setEta(ctx, flag, new Date(Date.now() + h * 3_600_000).toISOString()));
    setR(x);
    if (x.ok) done();
  };
  return (
    <div className="card">
      <h3>ETA from now</h3>
      <div className="chips">{[1, 2, 4, 8, 12, 24, 48].map((h) => <button key={h} className="chip" onClick={() => set(h)}>+{h} h</button>)}</div>
      <p className="small muted">Every ETA is kept. The first one counts for shop release vs plan (D10).</p>
    </div>
  );
}

function ReasonPanel({ label, hint, onGo }: { label: string; hint: string; onGo: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="card">
      <h3>{label}</h3>
      <p className="small muted">{hint}</p>
      <label className="field"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button className="btn primary" disabled={!reason} onClick={() => onGo(reason)}>{label}</button>
    </div>
  );
}

function ReleasePanel({ asset, flag, setR, onDone }: { asset: Asset; flag: DownFlag; setR: (r: CommandResult) => void; onDone: () => void }) {
  const app = useApp();
  const sys = flag.system && SYSTEMS[flag.system] ? flag.system : '';
  const [d, setD] = useState<ReleaseDetails>({ system: sys, failureModes: [], workOrder: flag.workOrders[0], pmOrWorkOrder: flag.workOrders[0] });
  const [reason, setReason] = useState('');
  const missing = releaseChecklist(flag, d);
  const def = d.system ? SYSTEMS[d.system] : undefined;
  const u = flag.type === 'unscheduled';
  return (
    <div className="card">
      <h3>Release checklist</h3>
      {u ? (
        <>
          <label className="field"><span>System</span>
            <select value={d.system ?? ''} onChange={(e) => setD({ ...d, system: e.target.value, component: undefined, failureModes: [] })}>
              <option value="">Choose…</option>{Object.keys(SYSTEMS).map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          {def && (
            <>
              <label className="field"><span>Component</span>
                <select value={d.component ?? ''} onChange={(e) => setD({ ...d, component: e.target.value })}>
                  <option value="">Choose…</option>{def.components.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <div className="field"><span>Failure mode (one or more)</span>
                <div className="chips">
                  {def.modes.map((m) => {
                    const on = d.failureModes?.includes(m);
                    return <button key={m} className="chip" aria-pressed={on} onClick={() => setD({ ...d, failureModes: on ? d.failureModes!.filter((x) => x !== m) : [...(d.failureModes ?? []), m] })}>{m}</button>;
                  })}
                </div>
              </div>
            </>
          )}
          <label className="field"><span>Work order</span><input value={d.workOrder ?? ''} onChange={(e) => setD({ ...d, workOrder: e.target.value })} /></label>
          <label className="field"><span>Detection method (optional)</span>
            <select value={d.detectionMethod ?? ''} onChange={(e) => setD({ ...d, detectionMethod: (e.target.value || undefined) as ReleaseDetails['detectionMethod'] })}>
              <option value="">—</option>{['operator', 'pm', 'inspection', 'condition_monitoring', 'alarm', 'other'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
        </>
      ) : (
        <>
          <label className="field"><span>PM or work order</span><input value={d.pmOrWorkOrder ?? ''} onChange={(e) => setD({ ...d, pmOrWorkOrder: e.target.value })} /></label>
          <label className="field"><span>Findings (write "None" if none)</span><input value={d.findings ?? ''} onChange={(e) => setD({ ...d, findings: e.target.value || undefined })} /></label>
        </>
      )}
      <label className="field"><span>Repair summary</span><textarea rows={2} value={d.repairSummary ?? ''} onChange={(e) => setD({ ...d, repairSummary: e.target.value })} /></label>
      {currentLocation(flag)?.kind === 'shop_yard' && (
        <label className="field"><span>Reason for releasing from the yard</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      )}
      {missing.length > 0 && <p className="small muted">Still needed: {missing.join(', ')}</p>}
      <button
        className="btn primary big"
        disabled={missing.length > 0}
        onClick={() => {
          const x = app.run(asset, (ctx) => release(ctx, flag, { details: d, reason: reason || undefined }));
          setR(x);
          if (x.ok) onDone();
        }}
      >
        Release {asset.unitNumber}
      </button>
    </div>
  );
}
