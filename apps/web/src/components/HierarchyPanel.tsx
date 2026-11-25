// System and component panel for the Pareto and jack-knife (docs/analysis-hierarchy.md): events and hours for each
// system and its components, choose one to filter the page to it, hide one from the two charts, and set a minimum
// downtime. The page filter is the existing system and component filter; hiding is a view setting only.

import { hideComponentKey, hideSystemKey, type SystemRow } from '@mr/core';
import { useState } from 'react';
import { fmtHours } from '../format';

export function HierarchyPanel({ rows, selectedSystem, selectedComponent, hidden, minHours, onMinHours, onAll, onSystem, onComponent, onHide, onRestore, onClearHidden }: {
  rows: SystemRow[];
  selectedSystem?: string;
  selectedComponent?: string;
  hidden: ReadonlySet<string>;
  minHours: number;
  onMinHours: (h: number) => void;
  onAll: () => void;
  onSystem: (system: string) => void;
  onComponent: (system: string, component: string) => void;
  onHide: (key: string) => void;
  onRestore: (key: string) => void;
  onClearHidden: () => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(selectedSystem ? [selectedSystem] : []));
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const events = rows.reduce((s, r) => s + r.events, 0);
  const hours = rows.reduce((s, r) => s + r.hours, 0);
  const label = (k: string) => {
    const [kind, sys, comp] = k.split('::');
    return kind === 'sys' ? `System: ${sys}` : `Component: ${sys} › ${comp}`;
  };
  return (
    <aside className="hp" aria-label="Systems and components">
      <label className="hp-min small">Min downtime (h)
        <input type="number" min={0} step={1} value={minHours} onChange={(e) => onMinHours(Math.max(0, Number(e.target.value) || 0))} />
      </label>
      {hidden.size > 0 && (
        <div className="hp-hidden small">
          <span className="muted">Hidden from the charts</span>
          <div className="chips">
            {[...hidden].map((k) => <button key={k} type="button" className="chip" onClick={() => onRestore(k)} title="Bring it back">{label(k)} ×</button>)}
            <button type="button" className="linkish small" onClick={onClearHidden}>Clear all</button>
          </div>
        </div>
      )}
      <div className="hp-head small muted"><span>Hierarchy</span><span>evt / h</span></div>
      <ul className="hp-list">
        <li>
          <button type="button" className={`hp-row${!selectedSystem && !selectedComponent ? ' on' : ''}`} onClick={onAll}>
            <span>All systems</span><span className="num">{events} / {Math.round(hours)}</span>
          </button>
        </li>
        {rows.length === 0 && <li className="small muted" style={{ padding: 8 }}>Nothing at or above {fmtHours(minHours)}.</li>}
        {rows.map((s) => {
          const isOpen = open.has(s.key);
          return (
            <li key={s.key}>
              <div className={`hp-row${selectedSystem === s.key && !selectedComponent ? ' on' : ''}`} onContextMenu={(e) => { e.preventDefault(); onHide(hideSystemKey(s.key)); }}>
                <button type="button" className="hp-caret" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${s.key}`} onClick={() => toggle(s.key)}>{isOpen ? '▾' : '▸'}</button>
                <button type="button" className="hp-name" onClick={() => onSystem(s.key)} title="Filter the page to this system. Right-click to hide it from the charts.">{s.key}</button>
                <span className="num small">{s.events} / {Math.round(s.hours)}</span>
                <button type="button" className="hp-x" aria-label={`Hide ${s.key} from the charts`} onClick={() => onHide(hideSystemKey(s.key))}>×</button>
              </div>
              {isOpen && (
                <ul className="hp-sub">
                  {s.components.map((c) => (
                    <li key={c.key}>
                      <div className={`hp-row${selectedSystem === s.key && selectedComponent === c.key ? ' on' : ''}`} onContextMenu={(e) => { e.preventDefault(); onHide(hideComponentKey(s.key, c.key)); }}>
                        <button type="button" className="hp-name" onClick={() => onComponent(s.key, c.key)} title="Filter the page to this component. Right-click to hide it from the charts.">{c.key}</button>
                        <span className="num small">{c.events} / {Math.round(c.hours)}</span>
                        <button type="button" className="hp-x" aria-label={`Hide ${c.key} from the charts`} onClick={() => onHide(hideComponentKey(s.key, c.key))}>×</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
