// Unit history (docs/unit-screen.md): one list, newest first, of everything that happened to a unit:
// stops and their steps, standby and parked time, waits, technicians and notes. Pure; the screen words it.

import { ms } from './time.js';
import type { AssetLifecycleInterval, DownFlag, Iso, LocationInterval, Stage } from './types.js';
import type { StandbyFlag } from './standby.js';
import type { WaitTag } from './waits.js';
import type { Assignment, UnitNote } from './unit-notes.js';

export type HistoryKind =
  | 'down' | 'proposed' | 'stage' | 'move' | 'eta' | 'details' | 'release' | 'void'
  | 'investigate' | 'investigate_clear'
  | 'standby' | 'standby_end' | 'parked' | 'parked_end'
  | 'wait' | 'wait_end' | 'assign' | 'unassign' | 'note';

export interface HistoryItem {
  at: Iso;
  kind: HistoryKind;
  /** The stop it belongs to, if any. */
  flagId?: string;
  by?: string;
  /** Short code: flag type, stage, wait kind, standby reason, note kind or a person's id. */
  code?: string;
  text?: string;
  /** Hours, for items that end something (wait, standby, assignment, release). */
  hours?: number;
  location?: LocationInterval;
  voided?: boolean;
  /** The record the item comes from. */
  refId: string;
}

export interface HistoryInput {
  unitId: string;
  flags: DownFlag[];
  standby?: StandbyFlag[];
  waits?: WaitTag[];
  assignments?: Assignment[];
  notes?: UnitNote[];
  lifecycle?: AssetLifecycleInterval[];
  now: Iso;
}

const hrs = (a: Iso, b: Iso) => Math.max(0, (ms(b) - ms(a)) / 3.6e6);

export function unitHistory(h: HistoryInput): HistoryItem[] {
  const out: HistoryItem[] = [];
  const push = (x: HistoryItem) => out.push(x);
  for (const f of h.flags.filter((x) => x.unitId === h.unitId)) {
    const voided = f.state === 'voided' || f.state === 'process_delay';
    if (f.state === 'proposed') { push({ at: f.start, kind: 'proposed', flagId: f.id, by: f.setBy, code: f.type, text: f.reasonCode, refId: f.id }); continue; }
    push({ at: f.start, kind: 'down', flagId: f.id, by: f.setBy, code: f.type, text: f.reasonCode, voided, refId: f.id });
    // A zero-length stage (Ready for release recorded at the release) adds nothing to read.
    f.stages.forEach((s, i) => { if (i > 0 && s.end !== s.start) push({ at: s.start, kind: 'stage', flagId: f.id, by: s.setBy, code: s.stage as Stage, voided, refId: f.id }); });
    f.locations.forEach((l, i) => { if (i > 0) push({ at: l.start, kind: 'move', flagId: f.id, by: l.setBy, location: l, voided, refId: f.id }); });
    for (const e of f.etas) push({ at: e.setAt, kind: 'eta', flagId: f.id, by: e.setBy, text: e.eta, voided, refId: f.id });
    if (f.investigation) {
      push({ at: f.investigation.at, kind: 'investigate', flagId: f.id, by: f.investigation.by, text: f.investigation.reason, refId: f.id });
      if (f.investigation.clearedAt) push({ at: f.investigation.clearedAt, kind: 'investigate_clear', flagId: f.id, by: f.investigation.clearedBy, text: f.investigation.clearReason, refId: f.id });
    }
    if (f.state === 'released' && f.end) push({ at: f.end, kind: 'release', flagId: f.id, by: f.releasedBy, code: f.type, hours: hrs(f.start, f.end), refId: f.id });
    if (voided) push({ at: f.end ?? f.start, kind: 'void', flagId: f.id, text: f.voidReason, refId: f.id });
  }
  for (const s of (h.standby ?? []).filter((x) => x.unitId === h.unitId)) {
    const voided = s.state === 'voided';
    push({ at: s.start, kind: 'standby', by: s.setBy, code: s.reasonCode, text: s.note, voided, refId: s.id });
    if (s.end && !voided) push({ at: s.end, kind: 'standby_end', code: s.reasonCode, hours: hrs(s.start, s.end), refId: s.id });
  }
  for (const l of (h.lifecycle ?? []).filter((x) => x.assetId === h.unitId && x.status !== 'active')) {
    push({ at: l.start, kind: 'parked', code: l.status, refId: `${l.assetId}:${l.start}` });
    if (l.end) push({ at: l.end, kind: 'parked_end', code: l.status, hours: hrs(l.start, l.end), refId: `${l.assetId}:${l.start}` });
  }
  for (const w of (h.waits ?? []).filter((x) => x.unitId === h.unitId)) {
    const voided = w.state === 'voided';
    push({ at: w.start, kind: 'wait', flagId: w.downFlagId, by: w.setBy, code: w.kind, text: w.note, voided, refId: w.id });
    if (w.end && !voided) push({ at: w.end, kind: 'wait_end', flagId: w.downFlagId, code: w.kind, hours: hrs(w.start, w.end), refId: w.id });
  }
  for (const a of (h.assignments ?? []).filter((x) => x.unitId === h.unitId)) {
    const voided = a.state === 'voided';
    push({ at: a.start, kind: 'assign', flagId: a.downFlagId, by: a.setBy, code: a.userId, voided, refId: a.id });
    if (a.end && !voided) push({ at: a.end, kind: 'unassign', flagId: a.downFlagId, code: a.userId, hours: hrs(a.start, a.end), refId: a.id });
  }
  for (const n of (h.notes ?? []).filter((x) => x.unitId === h.unitId)) {
    push({ at: n.at, kind: 'note', flagId: n.downFlagId, by: n.by, code: n.kind, text: n.text, voided: !!n.voidedAt, refId: n.id });
  }
  // Newest first; at the same time, the later step of a stop comes first (release before its last stage).
  const order: HistoryKind[] = ['release', 'void', 'unassign', 'wait_end', 'standby_end', 'parked_end', 'note', 'investigate_clear', 'investigate', 'details', 'eta', 'assign', 'wait', 'move', 'stage', 'standby', 'parked', 'down', 'proposed'];
  return out.sort((a, b) => ms(b.at) - ms(a.at) || order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** A unit's notes, newest first. */
export function notesFor(notes: UnitNote[], unitId: string): UnitNote[] {
  return notes.filter((n) => n.unitId === unitId).sort((a, b) => ms(b.at) - ms(a.at));
}
