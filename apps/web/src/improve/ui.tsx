// Small shared pieces for the actions and RCA pages.

import { useState } from 'react';

export function Errors({ list }: { list: string[] | null }) {
  if (!list?.length) return null;
  return <div className="errors" role="alert">{list.map((e) => <div key={e}>{e}</div>)}</div>;
}

export function Warnings({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <div className="warns" role="status">{list.map((e) => <div key={e}>{e}</div>)}</div>;
}

/** A button that opens a note box; the command runs with the note. Returns errors to show, or null when done. */
export function NoteButton({ label, prompt, danger, disabled, onSubmit }: {
  label: string; prompt: string; danger?: boolean; disabled?: boolean; onSubmit: (note: string) => string[] | null;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<string[] | null>(null);
  if (!open) return <button className={`btn${danger ? ' danger' : ''}`} disabled={disabled} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <div className="card" style={{ flexBasis: '100%' }}>
      <label className="field"><span>{prompt}</span><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></label>
      <Errors list={errors} />
      <div className="row">
        <button className={`btn${danger ? ' danger' : ' primary'}`} onClick={() => { const e = onSubmit(note); if (e) setErrors(e); else { setOpen(false); setNote(''); setErrors(null); } }}>{label}</button>
        <button className="btn" onClick={() => { setOpen(false); setErrors(null); }}>Back</button>
      </div>
    </div>
  );
}

/** Audit entries for one record, newest first. */
export function History({ entries, userName, tz, fmt }: {
  entries: Array<{ at: string; userId: string; action: string; reason?: string }>; userName: (id: string) => string; tz: string; fmt: (iso: string, tz: string, d: boolean) => string;
}) {
  if (!entries.length) return <p className="small muted">No changes in this session yet. Earlier changes are in the audit log.</p>;
  return (
    <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
      {entries.map((e, i) => <li key={i}>{fmt(e.at, tz, true)} · {userName(e.userId)} · {e.action.replace(/_/g, ' ')}{e.reason ? `: ${e.reason}` : ''}</li>)}
    </ul>
  );
}
