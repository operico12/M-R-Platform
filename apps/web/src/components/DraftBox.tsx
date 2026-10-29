// A cited draft from assist (docs/ai-assist.md AI-3, AI-4). Shown only when every
// line cites records it was given; otherwise refused. Copy it, then edit it where
// it is used. Nothing is saved by the draft itself.

import type { Draft } from '@mr/core';
import { useState } from 'react';

export function DraftBox({ title, draft, note, empty }: { title: string; draft: Draft; note: string; empty: string }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  if (!draft.lines.length) return <section className="card no-print"><h3>{title}</h3><p className="small muted">{empty}</p></section>;
  const c = draft.check;
  const copy = () => {
    navigator.clipboard?.writeText(draft.lines.join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => setCopied(false));
  };
  return (
    <section className="card no-print" aria-label={title}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <div className="row">
          {c.ok && <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : `Show ${draft.lines.length} lines`}</button>}
          {c.ok && <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
        </div>
      </div>
      <p className="small muted">{note}</p>
      {!c.ok ? (
        <div className="errors" role="status">
          Draft refused: {c.unknown.length ? `it cites records it was not given (${c.unknown.join(', ')})` : ''}{c.unknown.length && c.uncited.length ? '; ' : ''}{c.uncited.length ? `${c.uncited.length} lines have no source` : ''}.
        </div>
      ) : open && (
        <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 22, overflowWrap: 'anywhere' }}>
          {draft.lines.map((l, i) => <li key={i}>{l}</li>)}
        </ol>
      )}
    </section>
  );
}
