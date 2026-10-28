// Audit log page (plan 11.4 "Audit log": every change, who, when, before,
// after, reason; filter and export). Read-only. The log holds two kinds of
// row: the app's own entries (what the person did and why) and the database's
// row changes (written by triggers, with the full row before and after).

import { DateTime } from 'luxon';
import { ms } from './time.js';
import type { AuditEntry, Iso } from './types.js';

/** An audit row as the page shows it: the app's entity names, or a database table name. */
export interface AuditRecord extends Omit<AuditEntry, 'entity'> {
  entity: string;
  /** Database rows have an id; app entries made this session do not. */
  id?: string;
}

/** Plain names for the app's entities and the database tables that hold them. */
export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  down_flag: 'Down flag', down_flags: 'Down flag',
  flag_stage_intervals: 'Flag stage', flag_location_intervals: 'Flag location', flag_etas: 'Flag ETA', flag_reopen_gaps: 'Flag reopen gap', flag_work_orders: 'Flag work order',
  import_run: 'Data import', sync_runs: 'Data import', raw_records: 'Imported record',
  target: 'Target', targets: 'Target',
  user: 'User', site_members: 'User', site_invites: 'User invite',
  code: 'Reason code', codes: 'Reason code',
  action: 'Action', improvement_actions: 'Action',
  rca: 'Root cause analysis', rcas: 'Root cause analysis',
  project: 'Project', projects: 'Project',
  settings: 'Settings', site_settings: 'Settings',
  alert: 'Alert answer', alert_answers: 'Alert answer',
  approval: 'Approval request', change_requests: 'Approval request',
  inspection: 'Inspection', inspections: 'Inspection', inspection_form: 'Inspection form', inspection_forms: 'Inspection form', inspection_photos: 'Inspection photo',
  analysis: 'Saved analysis', saved_analyses: 'Saved analysis', view: 'Saved view', saved_views: 'Saved view',
  component: 'Component', components: 'Component', component_events: 'Component', component_event_costs: 'Component cost', life_target: 'Target life', life_targets: 'Target life', oil_sample: 'Oil sample', oil_samples: 'Oil sample', cm_responses: 'Oil sample response',
  smu_readings: 'SMU reading', work_orders: 'Work order', assets: 'Asset', asset_attributes: 'Asset',
  shop_lines: 'Shop line', shop_line_closures: 'Shop line', periods: 'Period', flag_rules: 'Flag rules',
};

export const auditEntityLabel = (e: string) => AUDIT_ENTITY_LABELS[e] ?? e.replace(/_/g, ' ');

/** Database tables, as opposed to the app's own entries. */
export const isRowChange = (r: Pick<AuditRecord, 'entity' | 'action'>) => ['insert', 'update', 'delete'].includes(r.action);

export interface AuditFilter {
  /** Site-local dates, inclusive. */
  from?: string;
  to?: string;
  /** Entity labels (AUDIT_ENTITY_LABELS values), so an app entry and its table row match together. */
  entities: string[];
  users: string[];
  /** Free text over action, reason, record id and the values. */
  text: string;
  /** Leave out the database's row changes and show only what people did in the app. */
  appOnly: boolean;
}

export const EMPTY_AUDIT_FILTER: AuditFilter = { entities: [], users: [], text: '', appOnly: false };

export function filterAudit(rows: AuditRecord[], f: AuditFilter, timeZone: string): AuditRecord[] {
  const from = f.from ? ms(DateTime.fromISO(f.from, { zone: timeZone }).startOf('day').toUTC().toISO()!) : -Infinity;
  const to = f.to ? ms(DateTime.fromISO(f.to, { zone: timeZone }).plus({ days: 1 }).startOf('day').toUTC().toISO()!) : Infinity;
  const text = f.text.trim().toLowerCase();
  return rows
    .filter((r) => {
      const t = ms(r.at);
      if (t < from || t >= to) return false;
      if (f.entities.length && !f.entities.includes(auditEntityLabel(r.entity))) return false;
      if (f.users.length && !f.users.includes(r.userId)) return false;
      if (f.appOnly && isRowChange(r)) return false;
      if (text) {
        const hay = `${r.action} ${r.reason ?? ''} ${r.entityId} ${JSON.stringify(r.before ?? '')} ${JSON.stringify(r.after ?? '')}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    })
    .sort((a, b) => ms(b.at) - ms(a.at));
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Bookkeeping columns that change on every write and say nothing about the change. */
const NOISE = new Set(['updated_at', 'updated_by', 'updatedAt']);

/**
 * Field-level differences between before and after, one level deep (nested
 * values are compared as a whole). A new record lists every field it was
 * created with.
 */
export function auditDiff(before: unknown, after: unknown): FieldChange[] {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : v === null || v === undefined ? {} : { value: v });
  const b = obj(before);
  const a = obj(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return keys
    .filter((k) => !NOISE.has(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => ({ field: k, before: b[k], after: a[k] }));
}

/** One cell as text: short values in full, objects as JSON. */
export const auditValue = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** CSV for export, with site-local times and the changed fields spelled out. */
export function auditCsv(rows: AuditRecord[], timeZone: string, userName: (id: string) => string): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const local = (t?: Iso) => (t ? DateTime.fromISO(t, { zone: timeZone }).toFormat('yyyy-MM-dd HH:mm:ss') : '');
  const head = ['entered_at_site_time', 'effective_at_site_time', 'user', 'action', 'record_type', 'record_id', 'reason', 'changes'];
  const lines = rows.map((r) => [
    local(r.at), local(r.effectiveAt), userName(r.userId), r.action, auditEntityLabel(r.entity), r.entityId, r.reason ?? '',
    auditDiff(r.before, r.after).map((c) => `${c.field}: ${auditValue(c.before)} → ${auditValue(c.after)}`).join('; '),
  ].map((x) => q(String(x))).join(','));
  return [head.join(','), ...lines].join('\n');
}

/** Site-local dates (to inclusive) as the instants the database query needs. */
export function auditRange(from: string, to: string, timeZone: string): { from: Iso; to: Iso } {
  return {
    from: DateTime.fromISO(from, { zone: timeZone }).startOf('day').toUTC().toISO()!,
    to: DateTime.fromISO(to, { zone: timeZone }).plus({ days: 1 }).startOf('day').toUTC().toISO()!,
  };
}
