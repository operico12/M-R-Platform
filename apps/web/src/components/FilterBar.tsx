// Shared filter bar (plan 7.5, basic set for phase 1a). The filter lives in the
// page link, so a view can be bookmarked or sent to someone.

import { EMPTY_FILTER, SYSTEMS, type AnalyticsFilter, type Dataset, type RangePreset } from '@mr/core';
import { useEffect, useRef, type ReactNode } from 'react';

type ListKey = 'models' | 'units' | 'types' | 'systems' | 'components' | 'where' | 'lines' | 'detection' | 'shifts' | 'crews';

export interface Option { value: string; label: string }

export function filterOptions(ds: Dataset): Record<ListKey, { title: string; options: Option[] }> {
  const uniq = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  const systems = uniq([...Object.keys(SYSTEMS), ...ds.flags.map((f) => f.release?.system ?? f.system)]);
  return {
    models: { title: 'Model', options: uniq(ds.assets.map((a) => a.model)).map((v) => ({ value: v, label: v })) },
    units: { title: 'Unit', options: [...ds.assets].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)).map((a) => ({ value: a.id, label: a.unitNumber })) },
    types: { title: 'Type', options: [{ value: 'unscheduled', label: 'Unscheduled' }, { value: 'scheduled', label: 'Scheduled' }] },
    systems: { title: 'System', options: systems.map((v) => ({ value: v, label: v })) },
    components: { title: 'Component', options: uniq(ds.flags.map((f) => f.release?.component)).map((v) => ({ value: v, label: v })) },
    where: { title: 'Field or shop', options: [{ value: 'field', label: 'Fixed in the field' }, { value: 'shop', label: 'Went to the shop' }] },
    lines: { title: 'Shop line', options: ds.shopLines.map((l) => ({ value: l.id, label: l.name ?? `Line ${l.number}` })) },
    detection: { title: 'Detected by', options: ['operator', 'pm', 'inspection', 'condition_monitoring', 'alarm', 'other'].map((v) => ({ value: v, label: v === 'pm' ? 'PM' : v.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()) })) },
    shifts: { title: 'Shift', options: ds.calendar.shifts.map((s) => ({ value: s.name, label: `${s.name[0]!.toUpperCase()}${s.name.slice(1)} (from ${s.startLocal})` })) },
    crews: { title: 'Crew', options: uniq((ds.calendar.rotation?.pattern ?? []).flatMap((d) => Object.values(d))).map((v) => ({ value: v, label: `Crew ${v}` })) },
  };
}

const PRESETS: Array<[RangePreset, string]> = [['7d', '7 days'], ['28d', '28 days'], ['90d', '90 days']];

export function FilterBar({ ds, value, onChange, matched, extra }: { ds: Dataset; value: AnalyticsFilter; onChange: (f: AnalyticsFilter) => void; matched: ReactNode; extra?: ReactNode }) {
  const opts = filterOptions(ds);
  // One list open at a time; a click elsewhere closes it.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => bar.current?.querySelectorAll('details[open]').forEach((d) => { if (!d.contains(e.target as Node)) d.removeAttribute('open'); });
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const set = (patch: Partial<AnalyticsFilter>) => onChange({ ...value, ...patch });
  const toggle = (k: ListKey, v: string) => {
    const cur = value[k] as string[];
    set({ [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } as Partial<AnalyticsFilter>);
  };
  const custom = !('preset' in value.range);
  const range = value.range;
  const label = (k: ListKey, v: string) => opts[k].options.find((o) => o.value === v)?.label ?? v;

  const chips: Array<{ text: string; clear: () => void }> = [];
  for (const k of Object.keys(opts) as ListKey[]) {
    for (const v of value[k] as string[]) {
      const not = k === 'systems' && value.systemsExclude ? 'not ' : '';
      chips.push({ text: `${opts[k].title}: ${not}${label(k, v)}`, clear: () => toggle(k, v) });
    }
  }
  if (value.failuresOnly) chips.push({ text: 'Failures only', clear: () => set({ failuresOnly: false }) });

  return (
    <section className="card" aria-label="Filters">
      <div className="filterbar" ref={bar}>
        {PRESETS.map(([p, l]) => (
          <button key={p} className="chip" style={{ minHeight: 40 }} aria-pressed={'preset' in range && range.preset === p} onClick={() => set({ range: { preset: p } })}>{l}</button>
        ))}
        <button className="chip" style={{ minHeight: 40 }} aria-pressed={custom} onClick={() => !custom && set({ range: { from: isoDay(ds.site.timeZone, -28), to: isoDay(ds.site.timeZone, 0) } })}>Dates…</button>
        {'from' in range && (
          <>
            <input type="date" aria-label="From" value={range.from} max={range.to} onChange={(e) => e.target.value && set({ range: { from: e.target.value, to: range.to } })} />
            <span className="small muted">to</span>
            <input type="date" aria-label="To" value={range.to} min={range.from} onChange={(e) => e.target.value && set({ range: { from: range.from, to: e.target.value } })} />
          </>
        )}
        {(Object.keys(opts) as ListKey[]).map((k) => {
          const n = (value[k] as string[]).length;
          return (
            <details key={k}>
              <summary className={n ? 'on' : ''}>{opts[k].title}{n ? ` (${n})` : ''} ▾</summary>
              <div className="pop">
                {k === 'systems' && (
                  <label style={{ borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
                    <input type="checkbox" checked={value.systemsExclude} onChange={(e) => set({ systemsExclude: e.target.checked })} /> Everything except the ticked
                  </label>
                )}
                {opts[k].options.map((o) => (
                  <label key={o.value}><input type="checkbox" checked={(value[k] as string[]).includes(o.value)} onChange={() => toggle(k, o.value)} /> {o.label}</label>
                ))}
              </div>
            </details>
          );
        })}
        <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={value.failuresOnly} onChange={(e) => set({ failuresOnly: e.target.checked })} /> Failures only
        </label>
        {extra}
      </div>
      <div className="active-chips">
        <strong className="small">{matched}</strong>
        {chips.map((c) => <button key={c.text} onClick={c.clear} aria-label={`Remove filter ${c.text}`}>{c.text} ✕</button>)}
        {chips.length > 0 && <button onClick={() => onChange({ ...structuredClone(EMPTY_FILTER), range: value.range })}>Clear all</button>}
      </div>
    </section>
  );
}

/** A date in the site time zone, never the browser's (CLAUDE.md rule 7). */
function isoDay(timeZone: string, offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('en-CA', { timeZone });
}
