// Plain words for an analysis slice, used as an action's or RCA's "for" label.

import { filterFromQuery, type Dataset } from '@mr/core';

export function describeQuery(query: string, ds: Dataset): string {
  const f = filterFromQuery(query);
  const unit = (id: string) => ds.assets.find((a) => a.id === id)?.unitNumber ?? id;
  const line = (id: string) => { const l = ds.shopLines.find((x) => x.id === id); return l ? l.name ?? `Line ${l.number}` : id; };
  const parts = [
    f.systems.length ? `${f.systemsExclude ? 'All but ' : ''}${f.systems.join(', ')}` : '',
    f.components.join(', '),
    f.units.map(unit).join(', '),
    f.models.join(', '),
    f.fleets.join(', '),
    f.types.join(', '),
    f.where.join(', '),
    f.lines.map(line).join(', '),
    f.shifts.length ? `${f.shifts.join(', ')} shift` : '',
    f.crews.length ? `crew ${f.crews.join(', ')}` : '',
    f.failuresOnly ? 'failures only' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Whole site';
}

/** A link to the analysis page for a slice. */
export const analysisHref = (query?: string) => `#/analysis${query ? `?${query}` : ''}`;

/** Query string for the "new action" and "new RCA" forms. */
export function newHref(kind: 'actions' | 'rca', src: { kind: string; query?: string; unitId?: string; flagId?: string; rcaId?: string }): string {
  const q = new URLSearchParams({ src: src.kind });
  if (src.query !== undefined) q.set('q', src.query);
  if (src.unitId) q.set('unit', src.unitId);
  if (src.flagId) q.set('flag', src.flagId);
  if (src.rcaId) q.set('rca', src.rcaId);
  return `#/${kind}/new?${q.toString()}`;
}
