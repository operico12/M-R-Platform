// Inspections (phase 2, plan section 4 "Inspections"; docs/inspections.md):
// the due list, filling one in on a tablet (drafts kept on the device, an
// outbox that retries), sign-off by someone else, defects turned into
// follow-ups, and versioned forms. Every change runs a core command.

import {
  DEFECT_STATUS_LABELS, RESULT_LABELS, can, dueList, formVersion, itemFailed, latestForms, openDefects, permission, retireForm, saveForm,
  scoreInspection, signOff, smuNow, startInspection, submitInspection, submitProblems, updateDefect, voidInspection,
  type Answer, type Defect, type DefectStatus, type DueRow, type FormInput, type FormItem, type Inspection, type InspectionForm, type ItemKind,
} from '@mr/core';
import { useEffect, useMemo, useState } from 'react';
import { fmtNum, fmtPct, siteTime } from '../format';
import { newHref } from '../improve/describe';
import { Errors, NoteButton, Warnings } from '../improve/ui';
import { downscalePhoto, keepPhoto } from '../inspect/device';
import { useApp } from '../store';

const TABS: Array<[string, string]> = [['due', 'Due'], ['done', 'Inspections'], ['defects', 'Open defects'], ['forms', 'Forms']];
const DUE_LABELS: Record<DueRow['state'], string> = { overdue: 'Overdue', due_soon: 'Due soon', never: 'Never done', ok: 'Up to date' };
const STATUS_LABELS: Record<Inspection['status'], string> = { draft: 'Draft', submitted: 'Waiting for sign-off', signed_off: 'Signed off', voided: 'Voided' };
const go = (h: string) => { window.location.hash = h; };

function Tag({ tone, children }: { tone?: 'bad' | 'warn' | 'good'; children: React.ReactNode }) {
  const bg = tone === 'bad' ? 'var(--down)' : tone === 'warn' ? 'var(--warn-bg)' : 'var(--surface-2)';
  const fg = tone === 'bad' ? '#fff' : tone === 'warn' ? 'var(--warn-ink)' : 'inherit';
  return <span className="small" style={{ padding: '2px 10px', borderRadius: 12, background: bg, color: fg, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>;
}
const resultTone = (r?: Inspection['result']) => (r === 'fail' ? 'bad' : r === 'defects' ? 'warn' : 'good');

export function Inspections({ arg, sub }: { arg?: string; sub?: string }) {
  const app = useApp();
  const tab = arg ?? 'due';
  if (tab === 'do' && sub) return <FillIn id={sub} />;
  if (tab === 'view' && sub) return <View id={sub} />;
  if (tab === 'form' && sub) return <FormEditor id={sub} />;
  const pending = app.outbox.filter((o) => !o.refused).length;
  const refused = app.outbox.filter((o) => o.refused);
  return (
    <>
      <h2 style={{ marginTop: 0 }}>Inspections</h2>
      <div className="chips" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map(([k, l]) => <button key={k} role="tab" className="chip" aria-pressed={tab === k} onClick={() => go(`#/inspections/${k}`)} style={{ minHeight: 40 }}>{l}</button>)}
      </div>
      {(pending > 0 || refused.length > 0) && <OutboxBox />}
      {tab === 'due' && <DueTab />}
      {tab === 'done' && <DoneTab />}
      {tab === 'defects' && <DefectsTab />}
      {tab === 'forms' && <FormsTab />}
    </>
  );
}

// ---------- outbox ----------

function OutboxBox() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const waiting = app.outbox.filter((o) => !o.refused);
  const refused = app.outbox.filter((o) => o.refused);
  return (
    <section className="card" aria-label="Outbox" style={{ marginBottom: 12 }}>
      {waiting.length > 0 && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span><strong>{waiting.length} waiting to send.</strong> <span className="small muted">Kept on this device and retried until saved{waiting[0]?.lastError ? `. Last try: ${waiting[0].lastError}` : ''}.</span></span>
          <button className="btn" onClick={app.sendOutbox}>Try now</button>
        </div>
      )}
      {refused.map((o) => (
        <div key={o.id} className="errors" role="alert" style={{ marginTop: 8 }}>
          Not saved: {o.kind === 'photo' ? 'a photo' : 'an inspection'} from {siteTime(o.queuedAt, tz, true)}. The database said: {o.lastError}
          <div className="row" style={{ marginTop: 6 }}>
            {o.inspection && <a href={`#/inspections/view/${o.inspectionId}`}>Open it</a>}
            <button className="btn" onClick={() => { if (window.confirm('Remove it from the outbox? It will not be saved.')) app.dropOutboxItem(o.id); }}>Remove from outbox</button>
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------- due ----------

function DueTab() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const rows = useMemo(() => dueList(app.forms, app.ds.assets, app.inspections, app.ds.smu, app.now, tz), [app.forms, app.ds, app.inspections, app.now, tz]);
  const [state, setState] = useState<'action' | 'all'>('action');
  const [errors, setErrors] = useState<string[] | null>(null);
  const canDo = can(app.actor, 'add_notes');
  const shown = state === 'action' ? rows.filter((r) => r.state !== 'ok') : rows;
  const count = (s: DueRow['state']) => rows.filter((r) => r.state === s).length;
  const start = (form: InspectionForm, unitId: string) => {
    const unit = app.ds.assets.find((a) => a.id === unitId)!;
    const r = app.runInspection((ctx) => startInspection(ctx, [], form, unit, smuNow(app.ds.smu, unitId, app.now)));
    if (!r.ok) return setErrors(r.errors);
    if (!app.saveDraft(r.records[0]!)) return setErrors(['This device could not keep the draft (storage full or blocked).']);
    go(`#/inspections/do/${r.records[0]!.id}`);
  };
  return (
    <>
      {app.drafts.length > 0 && (
        <section className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>Your drafts on this device ({app.drafts.length})</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {app.drafts.map((d) => (
              <li key={d.id}><a href={`#/inspections/do/${d.id}`}>{formVersion(app.forms, d.formId, d.formVersion)?.name ?? 'Form'}, {app.ds.assets.find((a) => a.id === d.unitId)?.unitNumber}</a>
                <span className="small muted"> started {siteTime(d.startedAt, tz, true)}, {Object.keys(d.answers).length} answered</span></li>
            ))}
          </ul>
        </section>
      )}
      <div className="grid kpis">
        <div className="card kpi"><div className="label">Overdue</div><div className="value">{count('overdue')}</div></div>
        <div className="card kpi"><div className="label">Due soon</div><div className="value">{count('due_soon')}</div><div className="sub">Within 2 days or 10% of the hours</div></div>
        <div className="card kpi"><div className="label">Never done</div><div className="value">{count('never')}</div></div>
        <div className="card kpi"><div className="label">Up to date</div><div className="value">{count('ok')}</div></div>
      </div>
      <div className="row" style={{ margin: '12px 0', justifyContent: 'space-between' }}>
        <div className="chips">
          <button className="chip" aria-pressed={state === 'action'} onClick={() => setState('action')} style={{ minHeight: 40 }}>Needs doing</button>
          <button className="chip" aria-pressed={state === 'all'} onClick={() => setState('all')} style={{ minHeight: 40 }}>All</button>
        </div>
        {canDo && <AdHoc onStart={start} />}
      </div>
      <Errors list={errors} />
      {shown.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Unit</th><th>Form</th><th>State</th><th>Due</th><th>Last done</th><th></th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={`${r.form.id}-${r.unit.id}`}>
              <td><a href={`#/unit/${r.unit.id}`}>{r.unit.unitNumber}</a></td>
              <td>{r.form.name}</td>
              <td><Tag tone={r.state === 'overdue' ? 'bad' : r.state === 'due_soon' ? 'warn' : undefined}>{DUE_LABELS[r.state]}</Tag></td>
              <td className="small">{r.dueDate ?? (r.dueSmu !== undefined ? `${fmtNum(r.dueSmu, 0)} h (now ${fmtNum(r.currentSmu, 0)} h)` : '—')}</td>
              <td className="small">{r.last ? <a href={`#/inspections/view/${r.last.id}`}>{siteTime(r.last.submittedAt!, tz, true)}</a> : '—'}</td>
              <td>{canDo && <button className="btn" onClick={() => start(r.form, r.unit.id)}>Start</button>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="muted">{app.forms.length ? 'Nothing due. Every unit is up to date.' : 'No inspection forms yet. A reliability engineer adds them under Forms.'}</p>}
    </>
  );
}

function AdHoc({ onStart }: { onStart: (f: InspectionForm, unitId: string) => void }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const active = latestForms(app.forms).filter((f) => !f.retiredAt);
  const [formId, setFormId] = useState('');
  const [unitId, setUnitId] = useState('');
  const form = active.find((f) => f.id === formId);
  const units = form ? app.ds.assets.filter((a) => a.assetClass === form.assetClass && (!form.models.length || form.models.includes(a.model))) : [];
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Start another inspection</button>;
  return (
    <div className="card row" style={{ flexBasis: '100%', alignItems: 'end' }}>
      <label className="field" style={{ margin: 0 }}><span>Form</span>
        <select value={formId} onChange={(e) => { setFormId(e.target.value); setUnitId(''); }}>
          <option value="">Pick a form</option>{active.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select></label>
      <label className="field" style={{ margin: 0 }}><span>Unit</span>
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)} disabled={!form}>
          <option value="">Pick a unit</option>{units.map((u) => <option key={u.id} value={u.id}>{u.unitNumber}</option>)}
        </select></label>
      <button className="btn primary" disabled={!form || !unitId} onClick={() => onStart(form!, unitId)}>Start</button>
      <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

// ---------- filling one in ----------

function FillIn({ id }: { id: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const stored = app.drafts.find((d) => d.id === id);
  const [draft, setDraft] = useState<Inspection | undefined>(stored);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<'yes' | 'no'>('yes');
  useEffect(() => { if (!draft && stored) setDraft(stored); }, [stored, draft]);
  if (!draft) {
    const done = app.inspections.find((i) => i.id === id);
    if (done) return <View id={id} />;
    return <p className="muted">This draft is not on this device. Drafts stay on the device they were started on. <a href="#/inspections">Back to inspections</a></p>;
  }
  const form = formVersion(app.forms, draft.formId, draft.formVersion);
  const unit = app.ds.assets.find((a) => a.id === draft.unitId);
  if (!form || !unit) return <p className="muted">The form or unit for this draft is missing.</p>;
  const update = (next: Inspection) => { setDraft(next); setSaved(app.saveDraft(next) ? 'yes' : 'no'); setErrors(null); };
  const answer = (itemId: string, a: Partial<Answer>) => update({ ...draft, answers: { ...draft.answers, [itemId]: { value: null, ...draft.answers[itemId], ...a } } });
  const { score, result } = scoreInspection(form, draft.answers);
  const problems = submitProblems(form, draft.answers);
  const sections = [...new Set(form.items.map((i) => i.section))];
  const submit = () => {
    const photos = Object.entries(draft.answers).flatMap(([itemId, a]) => (a.photos ?? []).map((p) => ({ id: p, itemId })));
    const r = app.runInspection((ctx) => submitInspection(ctx, [], form, draft), photos);
    if (!r.ok) return setErrors(r.errors);
    go(`#/inspections/view/${draft.id}${r.warnings.length ? '?warn=1' : ''}`);
  };
  return (
    <>
      <p className="small"><a href="#/inspections">Inspections</a> / {form.name}</p>
      <h2 style={{ margin: '0 0 4px' }}>{unit.unitNumber}: {form.name}</h2>
      <p className="small muted" style={{ marginTop: 0 }}>Version {form.version}. Started {siteTime(draft.startedAt, tz, true)}. {saved === 'yes' ? 'Saved on this device as you go.' : <strong>This device could not save the draft. Do not close the page.</strong>}</p>
      <label className="field" style={{ maxWidth: 220 }}><span>SMU reading (hours, optional)</span>
        <input type="number" inputMode="decimal" value={draft.smu ?? ''} onChange={(e) => update({ ...draft, smu: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
      {sections.map((sec) => (
        <section key={sec} className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>{sec}</h3>
          {form.items.filter((it) => it.section === sec).map((it) => <ItemInput key={it.id} it={it} n={form.items.indexOf(it) + 1} a={draft.answers[it.id]} onChange={(a) => answer(it.id, a)} />)}
        </section>
      ))}
      <ExtraDefects draft={draft} onChange={update} />
      <section className="card" style={{ position: 'sticky', bottom: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>Score {score === null ? '—' : fmtPct(score, 0)} · <Tag tone={resultTone(result)}>{RESULT_LABELS[result]}</Tag> <span className="small muted">{problems.length ? `${problems.length} to finish` : 'Ready to submit'}</span></span>
          <span className="row">
            <button className="btn" onClick={() => { if (window.confirm('Discard this draft? Its answers and photos are removed from this device.')) { app.discardDraft(draft.id); go('#/inspections'); } }}>Discard draft</button>
            <button className="btn primary big" onClick={submit}>Submit</button>
          </span>
        </div>
        <Errors list={errors} />
      </section>
    </>
  );
}

function ItemInput({ it, n, a, onChange }: { it: FormItem; n: number; a?: Answer; onChange: (a: Partial<Answer>) => void }) {
  const failed = itemFailed(it, a);
  const [photoErr, setPhotoErr] = useState<string | null>(null);
  const choice = (value: Answer['value'], label: string) => (
    <button type="button" className="chip" aria-pressed={a !== undefined && a.value === value} onClick={() => onChange({ value })} style={{ minWidth: 56 }}>{label}</button>
  );
  const addPhoto = async (f: File | undefined) => {
    if (!f) return;
    setPhotoErr(null);
    try {
      const data = await downscalePhoto(f);
      const pid = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `p-${Date.now()}`;
      if (!keepPhoto(pid, data)) return setPhotoErr('This device has no room left for the photo.');
      onChange({ photos: [...(a?.photos ?? []), pid] });
    } catch (e) {
      setPhotoErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }} aria-label={it.text}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{n}. {it.text} {it.critical && <Tag tone="bad">Critical</Tag>} {failed && <Tag tone="warn">Fail</Tag>}</div>
      {it.kind === 'pass_fail' && <div className="chips">{choice('pass', 'Pass')}{choice('fail', 'Fail')}{!it.critical && choice(null, 'N/A')}</div>}
      {it.kind === 'rating' && <div className="chips">{[1, 2, 3, 4, 5].map((r) => <span key={r}>{choice(r, String(r))}</span>)}{!it.critical && choice(null, 'N/A')}<span className="small muted" style={{ alignSelf: 'center' }}>1 bad, 5 good</span></div>}
      {it.kind === 'reading' && (
        <div className="row">
          <input aria-label={`${it.text} reading`} type="number" inputMode="decimal" style={{ minHeight: 44, width: 140, padding: '8px 10px' }} value={a?.value === null || a?.value === undefined ? '' : String(a.value)}
            onChange={(e) => onChange({ value: e.target.value === '' ? '' : Number(e.target.value) })} />
          <span className="small muted">{it.unit ?? ''} limits {it.min ?? '—'} to {it.max ?? '—'}</span>
          {!it.critical && choice(null, 'N/A')}
        </div>
      )}
      {it.kind === 'note' && <textarea aria-label={it.text} rows={2} style={{ width: '100%', padding: 8 }} value={String(a?.value ?? '')} onChange={(e) => onChange({ value: e.target.value })} />}
      {failed && (
        <div style={{ marginTop: 8 }}>
          <label className="field" style={{ marginBottom: 6 }}><span>What is wrong</span><input value={a?.note ?? ''} onChange={(e) => onChange({ note: e.target.value })} /></label>
          <div className="row">
            <label className="btn" style={{ display: 'inline-flex', alignItems: 'center' }}>
              {it.photoOnFail ? 'Add a photo (needed)' : 'Add a photo'}
              <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { void addPhoto(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {(a?.photos ?? []).map((p) => <Thumb key={p} id={p} />)}
          </div>
          {photoErr && <div className="errors" role="alert">{photoErr}</div>}
        </div>
      )}
    </div>
  );
}

function Thumb({ id }: { id: string }) {
  const app = useApp();
  const [src, setSrc] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);
  useEffect(() => { let on = true; app.photo(id).then((d) => { if (on) { setSrc(d); setMissing(!d); } }).catch(() => on && setMissing(true)); return () => { on = false; }; }, [id]);
  if (missing) return <span className="small muted">Photo not available</span>;
  if (!src) return <span className="small muted">Loading photo…</span>;
  return <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="Inspection photo" style={{ height: 64, borderRadius: 6, border: '1px solid var(--border)' }} /></a>;
}

function ExtraDefects({ draft, onChange }: { draft: Inspection; onChange: (i: Inspection) => void }) {
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState<Defect['severity']>('medium');
  const extra = draft.defects.filter((d) => !d.itemId);
  return (
    <section className="card" style={{ marginBottom: 12 }}>
      <h3 style={{ marginTop: 0 }}>Other defects</h3>
      <p className="small muted" style={{ marginTop: 0 }}>Failed items become defects when you submit. Add anything else you found here.</p>
      {extra.map((d) => (
        <div key={d.id} className="row"><Tag tone={d.severity === 'high' ? 'bad' : d.severity === 'medium' ? 'warn' : undefined}>{d.severity}</Tag> {d.text}
          <button className="linklike" onClick={() => onChange({ ...draft, defects: draft.defects.filter((x) => x.id !== d.id) })}>Remove</button></div>
      ))}
      <div className="row" style={{ alignItems: 'end' }}>
        <label className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}><span>Defect</span><input value={text} onChange={(e) => setText(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span>Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Defect['severity'])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <button className="btn" disabled={!text.trim()} onClick={() => { onChange({ ...draft, defects: [...draft.defects, { id: globalThis.crypto?.randomUUID?.() ?? `d-${Date.now()}`, text: text.trim(), severity, status: 'open' }] }); setText(''); }}>Add defect</button>
      </div>
    </section>
  );
}

// ---------- one inspection ----------

function View({ id }: { id: string }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const i = app.inspections.find((x) => x.id === id);
  const [errors, setErrors] = useState<string[] | null>(null);
  if (!i) return <p className="muted">Inspection not found. <a href="#/inspections/done">All inspections</a></p>;
  const form = formVersion(app.forms, i.formId, i.formVersion);
  const unit = app.ds.assets.find((a) => a.id === i.unitId);
  const waiting = app.outbox.filter((o) => o.inspectionId === i.id && !o.refused).length;
  const warn = window.location.hash.includes('warn=1') && i.result === 'fail';
  const canSign = permission(app.actor.role, 'sign_off_inspections') === 'yes';
  const run = (cmd: Parameters<typeof app.runInspection>[0]) => { const r = app.runInspection(cmd); setErrors(r.ok ? null : r.errors); return r.ok ? null : r.errors; };
  return (
    <>
      <p className="small"><a href="#/inspections/done">Inspections</a> / {form?.name}</p>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{unit?.unitNumber}: {form?.name ?? 'Form'}</h2>
        <span className="row"><Tag tone={resultTone(i.result)}>{i.result ? RESULT_LABELS[i.result] : '—'}</Tag> <Tag>{STATUS_LABELS[i.status]}</Tag></span>
      </div>
      <p className="small muted">
        By {app.userName(i.startedBy)}, submitted {i.submittedAt ? siteTime(i.submittedAt, tz, true) : '—'}. Score {i.score === null || i.score === undefined ? '—' : fmtPct(i.score, 0)}.
        {i.smu !== undefined ? ` SMU ${fmtNum(i.smu, 0)} h.` : ''} Form version {i.formVersion}.
        {waiting > 0 ? ' Waiting to send from this device.' : ''}
      </p>
      {warn && unit && <Warnings list={['A critical item failed. Check whether the unit should be flagged down.']} />}
      {warn && unit && <p><a className="btn primary" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={`#/unit/${unit.id}`}>Open {unit.unitNumber} to flag it down</a></p>}
      {i.status === 'signed_off' && <p>Signed off by {app.userName(i.signedOffBy!)} {siteTime(i.signedOffAt!, tz, true)}{i.signOffNote ? `: ${i.signOffNote}` : ''}.</p>}
      {i.status === 'voided' && <div className="warns">Voided by {app.userName(i.voidedBy!)} {siteTime(i.voidedAt!, tz, true)}: {i.voidReason}</div>}

      <section className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Defects ({i.defects.length})</h3>
        {i.defects.length ? <div style={{ display: 'grid', gap: 10 }}>{i.defects.map((d) => <DefectRow key={d.id} i={i} d={d} />)}</div> : <p className="muted">None.</p>}
      </section>

      <section className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Answers</h3>
        {form ? (
          <div className="table-wrap"><table>
            <thead><tr><th>Item</th><th>Answer</th><th>Note</th></tr></thead>
            <tbody>{form.items.map((it, n) => {
              const a = i.answers[it.id];
              return (
                <tr key={it.id}>
                  <td>{n + 1}. {it.text}{it.critical ? ' (critical)' : ''}</td>
                  <td>{a?.value === null ? 'N/A' : a?.value === 'pass' ? 'Pass' : a?.value === 'fail' ? 'Fail' : String(a?.value || '—')}{it.unit && typeof a?.value === 'number' ? ` ${it.unit}` : ''} {itemFailed(it, a) && a?.value !== 'fail' && <Tag tone="warn">Fail</Tag>}</td>
                  <td className="small">{a?.note ?? ''}<div className="row">{(a?.photos ?? []).map((p) => <Thumb key={p} id={p} />)}</div></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        ) : <p className="muted">The form version is missing.</p>}
      </section>

      {i.status === 'submitted' && (
        <div className="row">
          {canSign && i.startedBy !== app.actor.userId && <NoteButton label="Sign off" prompt="Note (optional)" onSubmit={(note) => run((ctx) => signOff(ctx, app.inspections, i.id, note))} />}
          {canSign && i.startedBy === app.actor.userId && <span className="small muted">Someone other than the inspector signs it off.</span>}
          {canSign && <NoteButton label="Void" danger prompt="Why is it wrong? It stays on record as voided." onSubmit={(reason) => run((ctx) => voidInspection(ctx, app.inspections, i.id, reason))} />}
        </div>
      )}
      <Errors list={errors} />
    </>
  );
}

function DefectRow({ i, d, showUnit }: { i: Inspection; d: Defect; showUnit?: boolean }) {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [mode, setMode] = useState<DefectStatus | null>(null);
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  const canFollow = can(app.actor, 'add_notes') && (i.status === 'submitted' || i.status === 'signed_off');
  const unit = app.ds.assets.find((a) => a.id === i.unitId);
  const openActions = app.actions.filter((x) => x.status === 'open' || x.status === 'in_progress');
  const save = (status: DefectStatus) => {
    const r = app.runInspection((ctx) => updateDefect(ctx, app.inspections, i.id, d.id, { status, actionId: status === 'action' ? value : undefined, workOrder: status === 'work_order' ? value : undefined, closeNote: status === 'closed' ? value : undefined }));
    if (!r.ok) return setErrors(r.errors);
    setMode(null); setValue(''); setErrors(null);
    if (status === 'flagged_down' && unit) go(`#/unit/${unit.id}`);
  };
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>
          <Tag tone={d.severity === 'high' ? 'bad' : d.severity === 'medium' ? 'warn' : undefined}>{d.severity}</Tag>{' '}
          {showUnit && unit && <><a href={`#/inspections/view/${i.id}`}>{unit.unitNumber}</a> · </>}{d.text}
        </span>
        <span className="small">{DEFECT_STATUS_LABELS[d.status]}
          {d.workOrder ? ` ${d.workOrder}` : ''}{d.actionId ? <> · <a href={`#/actions/${d.actionId}`}>action</a></> : null}{d.closeNote ? `: ${d.closeNote}` : ''}
          {d.updatedBy ? <span className="muted"> · {app.userName(d.updatedBy)} {siteTime(d.updatedAt!, tz, true)}</span> : null}</span>
      </div>
      {canFollow && d.status === 'open' && mode === null && (
        <div className="row" style={{ marginTop: 6 }}>
          {openActions.length > 0 && <button className="btn" onClick={() => setMode('action')}>Link an action</button>}
          {can(app.actor, 'create_actions') && <a className="btn" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }} href={newHref('actions', { kind: 'unit', unitId: i.unitId })}>Raise action</a>}
          <button className="btn" onClick={() => setMode('work_order')}>Work order raised</button>
          <button className="btn" onClick={() => save('flagged_down')}>Flag the unit down</button>
          <button className="btn" onClick={() => setMode('closed')}>Close with a note</button>
        </div>
      )}
      {mode && (
        <div className="row" style={{ marginTop: 6, alignItems: 'end' }}>
          {mode === 'action' ? (
            <label className="field" style={{ margin: 0 }}><span>Action</span>
              <select value={value} onChange={(e) => setValue(e.target.value)}><option value="">Pick an open action</option>{openActions.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
          ) : (
            <label className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}><span>{mode === 'work_order' ? 'Maximo work order number' : 'How it was closed'}</span>
              <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} /></label>
          )}
          <button className="btn primary" onClick={() => save(mode)}>Save</button>
          <button className="btn" onClick={() => { setMode(null); setErrors(null); }}>Cancel</button>
        </div>
      )}
      <Errors list={errors} />
    </div>
  );
}

// ---------- lists ----------

function DoneTab() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const [filter, setFilter] = useState<'all' | 'sign' | 'fail'>('all');
  const list = [...app.inspections].filter((i) => (filter === 'sign' ? i.status === 'submitted' : filter === 'fail' ? i.result === 'fail' && i.status !== 'voided' : true))
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  const shown = list.slice(0, 300);
  return (
    <>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')} style={{ minHeight: 40 }}>All</button>
        <button className="chip" aria-pressed={filter === 'sign'} onClick={() => setFilter('sign')} style={{ minHeight: 40 }}>Waiting for sign-off ({app.inspections.filter((i) => i.status === 'submitted').length})</button>
        <button className="chip" aria-pressed={filter === 'fail'} onClick={() => setFilter('fail')} style={{ minHeight: 40 }}>Failed</button>
      </div>
      {shown.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Submitted</th><th>Unit</th><th>Form</th><th>Result</th><th>Score</th><th>Defects</th><th>Status</th><th>By</th></tr></thead>
          <tbody>{shown.map((i) => (
            <tr key={i.id}>
              <td><a href={`#/inspections/view/${i.id}`}>{siteTime(i.submittedAt!, tz, true)}</a></td>
              <td>{app.ds.assets.find((a) => a.id === i.unitId)?.unitNumber}</td>
              <td>{formVersion(app.forms, i.formId, i.formVersion)?.name}</td>
              <td>{i.result && <Tag tone={resultTone(i.result)}>{RESULT_LABELS[i.result]}</Tag>}</td>
              <td>{i.score === null || i.score === undefined ? '—' : fmtPct(i.score, 0)}</td>
              <td>{i.defects.filter((d) => d.status === 'open').length} open / {i.defects.length}</td>
              <td className="small">{STATUS_LABELS[i.status]}</td>
              <td className="small">{app.userName(i.startedBy)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="muted">None.</p>}
      {list.length > shown.length && <p className="small muted">Showing the latest {shown.length} of {list.length}.</p>}
    </>
  );
}

function DefectsTab() {
  const app = useApp();
  const open = openDefects(app.inspections);
  return (
    <section className="card">
      <h3 style={{ marginTop: 0 }}>Open defects ({open.length})</h3>
      <p className="small muted" style={{ marginTop: 0 }}>Each is followed up by an action, a Maximo work order, a down flag, or closed with a note. Nothing is written back to Maximo.</p>
      {open.length ? <div style={{ display: 'grid', gap: 10 }}>{open.map(({ inspection, defect }) => <DefectRow key={defect.id} i={inspection} d={defect} showUnit />)}</div> : <p className="muted">No open defects.</p>}
    </section>
  );
}

// ---------- forms ----------

function FormsTab() {
  const app = useApp();
  const tz = app.ds.site.timeZone;
  const canEdit = can(app.actor, 'edit_inspection_forms');
  const [errors, setErrors] = useState<string[] | null>(null);
  const latest = latestForms(app.forms).sort((a, b) => Number(!!a.retiredAt) - Number(!!b.retiredAt) || a.name.localeCompare(b.name));
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <p className="small muted" style={{ margin: 0 }}>A change saves a new version; past inspections keep the version they used. Forms are retired, never deleted.</p>
        {canEdit && <button className="btn primary" onClick={() => go('#/inspections/form/new')}>New form</button>}
      </div>
      <Errors list={errors} />
      {latest.length ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Form</th><th>Applies to</th><th>Every</th><th>Items</th><th>Version</th><th></th></tr></thead>
          <tbody>{latest.map((f) => (
            <tr key={f.id}>
              <td>{f.name}{f.retiredAt ? <div className="small muted">Retired {siteTime(f.retiredAt, tz, true)}: {f.retiredReason}</div> : null}</td>
              <td className="small">{f.assetClass === 'mobile' ? 'Mobile' : 'Fixed plant'}{f.models.length ? `, ${f.models.join(', ')}` : ', all models'}</td>
              <td>{f.every.n} {f.every.unit === 'days' ? (f.every.n === 1 ? 'day' : 'days') : 'SMU hours'}</td>
              <td>{f.items.length}{f.items.some((i) => i.critical) ? `, ${f.items.filter((i) => i.critical).length} critical` : ''}</td>
              <td className="small">v{f.version} by {app.userName(f.createdBy)}, {siteTime(f.createdAt, tz, true)}: {f.reason}</td>
              <td>{canEdit && !f.retiredAt && (
                <div className="row">
                  <button className="btn" onClick={() => go(`#/inspections/form/${f.id}`)}>Change</button>
                  <NoteButton label="Retire" danger prompt="Why retire this form?" onSubmit={(reason) => { const r = app.runForms((ctx) => retireForm(ctx, app.forms, f.id, reason)); setErrors(r.ok ? null : r.errors); return r.ok ? null : r.errors; }} />
                </div>
              )}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p className="muted">No forms yet.</p>}
    </>
  );
}

const KIND_LABELS: Record<ItemKind, string> = { pass_fail: 'Pass / fail', rating: 'Rating 1 to 5', reading: 'Reading', note: 'Note' };

function FormEditor({ id }: { id: string }) {
  const app = useApp();
  const prev = id === 'new' ? undefined : latestForms(app.forms).find((f) => f.id === id);
  const [input, setInput] = useState<FormInput>(() => prev
    ? { name: prev.name, assetClass: prev.assetClass, models: prev.models, every: prev.every, items: prev.items.map((i) => ({ ...i })) }
    : { name: '', assetClass: 'mobile', models: [], every: { n: 1, unit: 'days' }, items: [] });
  const [models, setModels] = useState(input.models.join(', '));
  const [reason, setReason] = useState(prev ? '' : 'First version');
  const [errors, setErrors] = useState<string[] | null>(null);
  if (!can(app.actor, 'edit_inspection_forms')) return <p className="muted">Your role cannot change inspection forms.</p>;
  if (id !== 'new' && !prev) return <p className="muted">Form not found.</p>;
  const setItem = (n: number, p: Partial<FormItem>) => setInput({ ...input, items: input.items.map((it, i) => (i === n ? { ...it, ...p } : it)) });
  const move = (n: number, d: -1 | 1) => { const items = [...input.items]; const [x] = items.splice(n, 1); items.splice(n + d, 0, x!); setInput({ ...input, items }); };
  const addItem = () => setInput({ ...input, items: [...input.items, { id: `i${Date.now().toString(36)}${input.items.length}`, section: input.items[input.items.length - 1]?.section ?? 'General', text: '', kind: 'pass_fail', critical: false, weight: 1, photoOnFail: false }] });
  const save = () => {
    const r = app.runForms((ctx) => saveForm(ctx, app.forms, prev?.id ?? null, { ...input, models: models.split(',').map((m) => m.trim()).filter(Boolean) }, reason));
    if (!r.ok) return setErrors(r.errors);
    go('#/inspections/forms');
  };
  const num = (v: string) => (v === '' ? undefined : Number(v));
  return (
    <>
      <p className="small"><a href="#/inspections/forms">Forms</a> / {prev ? `${prev.name} (new version ${prev.version + 1})` : 'New form'}</p>
      <section className="card" style={{ marginBottom: 12 }}>
        <div className="grid two">
          <label className="field"><span>Name</span><input value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} /></label>
          <label className="field"><span>Asset class</span>
            <select value={input.assetClass} onChange={(e) => setInput({ ...input, assetClass: e.target.value as FormInput['assetClass'] })}><option value="mobile">Mobile</option><option value="fixed_plant">Fixed plant</option></select></label>
          <label className="field"><span>Models (comma separated; blank for all)</span><input value={models} onChange={(e) => setModels(e.target.value)} /></label>
          <div className="row" style={{ alignItems: 'end' }}>
            <label className="field" style={{ width: 110 }}><span>Every</span><input type="number" min={1} value={input.every.n} onChange={(e) => setInput({ ...input, every: { ...input.every, n: Number(e.target.value) } })} /></label>
            <label className="field"><span>Unit</span>
              <select value={input.every.unit} onChange={(e) => setInput({ ...input, every: { ...input.every, unit: e.target.value as 'days' | 'smu_hours' } })}><option value="days">Site days</option><option value="smu_hours">SMU hours</option></select></label>
          </div>
        </div>
      </section>
      {input.items.map((it, n) => (
        <section key={it.id} className="card" style={{ marginBottom: 8 }} aria-label={`Item ${n + 1}`}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>Item {n + 1}</strong>
            <span className="row">
              <button className="btn" disabled={n === 0} onClick={() => move(n, -1)} aria-label="Move up">↑</button>
              <button className="btn" disabled={n === input.items.length - 1} onClick={() => move(n, 1)} aria-label="Move down">↓</button>
              <button className="btn" onClick={() => setInput({ ...input, items: input.items.filter((_, i) => i !== n) })}>Remove</button>
            </span>
          </div>
          <div className="grid two">
            <label className="field"><span>Question</span><input value={it.text} onChange={(e) => setItem(n, { text: e.target.value })} /></label>
            <label className="field"><span>Section</span><input value={it.section} onChange={(e) => setItem(n, { section: e.target.value })} /></label>
            <label className="field"><span>Kind</span>
              <select value={it.kind} onChange={(e) => setItem(n, { kind: e.target.value as ItemKind, critical: e.target.value === 'note' ? false : it.critical })}>
                {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field"><span>Weight</span><input type="number" min={0.1} max={10} step={0.5} value={it.weight} onChange={(e) => setItem(n, { weight: Number(e.target.value) })} /></label>
            {it.kind === 'reading' && (
              <div className="row">
                <label className="field" style={{ width: 100 }}><span>Lower</span><input type="number" style={{ width: '100%' }} value={it.min ?? ''} onChange={(e) => setItem(n, { min: num(e.target.value) })} /></label>
                <label className="field" style={{ width: 100 }}><span>Upper</span><input type="number" style={{ width: '100%' }} value={it.max ?? ''} onChange={(e) => setItem(n, { max: num(e.target.value) })} /></label>
                <label className="field" style={{ width: 90 }}><span>Unit</span><input style={{ width: '100%' }} value={it.unit ?? ''} onChange={(e) => setItem(n, { unit: e.target.value || undefined })} /></label>
              </div>
            )}
          </div>
          {it.kind !== 'note' && (
            <div className="row">
              <label><input type="checkbox" checked={it.critical} onChange={(e) => setItem(n, { critical: e.target.checked })} /> Critical (a fail fails the inspection; no N/A)</label>
              <label><input type="checkbox" checked={it.photoOnFail} onChange={(e) => setItem(n, { photoOnFail: e.target.checked })} /> Photo needed when it fails</label>
            </div>
          )}
        </section>
      ))}
      <button className="btn" onClick={addItem} style={{ marginBottom: 12 }}>Add an item</button>
      <section className="card">
        <label className="field"><span>Reason for this {prev ? 'change' : 'form'}</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <Errors list={errors} />
        <div className="row"><button className="btn primary" onClick={save}>{prev ? `Save version ${prev.version + 1}` : 'Save form'}</button><a href="#/inspections/forms">Cancel</a></div>
      </section>
    </>
  );
}
