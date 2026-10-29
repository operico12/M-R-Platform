// File imports (plan 5 "Data", 6.2 land and clean, 6.3 sync rules).
//
// Land: every row read is kept as a raw record, exactly as received.
// Clean: rows are mapped with a field mapping (A3, a setting, never hard-coded),
// checked, and upserted on source system plus source ID, so re-running the
// same file is safe and changes nothing. Problems go to the data-quality list.
// Nothing is deleted: a record missing from a file is reported, not removed.
//
// Pure functions: the same code runs in the browser preview and the server job.

import { DateTime } from 'luxon';
import type { ConsoleContext, ConsoleResult } from './console.js';
import { can } from './permissions.js';
import { HOUR_MS, ms } from './time.js';
import type { Asset, AuditEntry, Iso, SmuReading, WorkClass, WorkOrder, WorkReadiness } from './types.js';

// ---------- CSV ----------

export interface Table {
  header: string[];
  rows: string[][];
}

/** RFC 4180 CSV with quoted fields, CRLF or LF, a BOM, and comma, semicolon or tab delimiters (detected from the header). */
export function parseCsv(text: string): Table {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      out.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  const nonEmpty = out.filter((r) => r.some((v) => v.trim() !== ''));
  const [header = [], ...rows] = nonEmpty;
  return { header: header.map((h) => h.trim()), rows };
}

export function toCsv(rows: Array<Array<string | number | undefined | null>>): string {
  return rows
    .map((r) => r.map((v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
    .join('\r\n') + '\r\n';
}

// ---------- mapping (A3) ----------

export type ImportKind = 'assets' | 'work_orders' | 'smu';

/**
 * Which source column feeds which platform field. A3 (data source and field
 * mapping) is not written yet, so these defaults are common Maximo export column
 * names. The data owner changes them in the console; nothing here is assumed.
 */
export interface ImportMapping {
  sourceSystem: string;
  /** Luxon formats tried in order after ISO-8601. Times without an offset are read in the site time zone. */
  dateFormats: string[];
  /** Only rows for this site are taken, when the export has a site column. */
  site?: { column: string; value: string };
  assets: { unitNumber: string; externalAssetId: string; fleet?: string; model?: string; serial?: string; functionalLocation?: string };
  workOrders: {
    number: string; asset: string; type?: string; status?: string; priority?: string; description?: string;
    reportedAt?: string; completedAt?: string; modifiedAt?: string;
    targetStart?: string; targetFinish?: string; scheduledStart?: string; scheduledFinish?: string;
    estimatedHours?: string; actualLabourHours?: string; pmNumber?: string; origin?: string;
  };
  smu: { asset: string; at: string; hours: string; meter?: string; meterValue?: string };
  /** ERP work type → how it is treated. Unlisted types are "other". */
  workClasses: Record<string, WorkClass>;
  /** ERP statuses that mean the work order is finished. */
  closedStatuses: string[];
  /** ERP status → whether open work can be scheduled. Unlisted open statuses are "unknown". */
  readiness: Record<string, WorkReadiness>;
  /** Removed from work order numbers before matching, as a regular expression. */
  woNumberPrefix: string;
  /** How dates are written in sample files made for this source. Default yyyy-MM-dd HH:mm:ss. */
  writeDateFormat?: string;
}

export const MAXIMO_DEFAULT_MAPPING: ImportMapping = {
  sourceSystem: 'maximo',
  dateFormats: ['yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm', 'M/d/yyyy H:mm', 'M/d/yyyy h:mm a', 'M/d/yy h:mm a', 'dd-LLL-yyyy HH:mm', 'yyyy-MM-dd'],
  site: { column: 'SITEID', value: 'DEMO' },
  assets: { unitNumber: 'ASSETNUM', externalAssetId: 'ASSETNUM', fleet: 'ASSETTYPE', model: 'MODEL', serial: 'SERIALNUM', functionalLocation: 'LOCATION' },
  workOrders: {
    number: 'WONUM', asset: 'ASSETNUM', type: 'WORKTYPE', status: 'STATUS', priority: 'WOPRIORITY', description: 'DESCRIPTION',
    reportedAt: 'REPORTDATE', completedAt: 'ACTFINISH', modifiedAt: 'CHANGEDATE',
    targetStart: 'TARGSTARTDATE', targetFinish: 'TARGCOMPDATE', scheduledStart: 'SCHEDSTART', scheduledFinish: 'SCHEDFINISH',
    estimatedHours: 'ESTDUR', actualLabourHours: 'ACTLABHRS', pmNumber: 'PMNUM', origin: 'ORIGRECORDID',
  },
  smu: { asset: 'ASSETNUM', at: 'READINGDATE', hours: 'READING', meter: 'METERNAME', meterValue: 'SMU' },
  workClasses: { PM: 'pm', CM: 'corrective', EM: 'corrective', BD: 'corrective', INSP: 'inspection', CAP: 'project', PROJ: 'project' },
  closedStatuses: ['COMP', 'CLOSE', 'CAN'],
  readiness: { WAPPR: 'waiting_approval', WMATL: 'waiting_parts', WPCOND: 'waiting_shutdown', APPR: 'ready', WSCH: 'ready', INPRG: 'in_progress' },
  woNumberPrefix: '^(WO|PM)[-\\s#]*',
};

/**
 * SAP PM list exports (docs/field-mapping.md): equipment IH08, orders IW38/IW39, measurement
 * documents IK17, with technical column names. A starting point to confirm against a real export.
 */
export const SAP_PM_DEFAULT_MAPPING: ImportMapping = {
  sourceSystem: 'sap_pm',
  dateFormats: ['dd.MM.yyyy HH:mm:ss', 'dd.MM.yyyy HH:mm', 'dd.MM.yyyy', 'yyyyMMdd HHmmss', 'yyyyMMdd', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd'],
  site: { column: 'SWERK', value: 'DEMO' },
  assets: { unitNumber: 'TIDNR', externalAssetId: 'EQUNR', fleet: 'EQART', model: 'TYPBZ', serial: 'SERGE', functionalLocation: 'TPLNR' },
  workOrders: {
    number: 'AUFNR', asset: 'EQUNR', type: 'AUART', status: 'STTXT+USTXT', priority: 'PRIOK', description: 'KTEXT',
    reportedAt: 'ERDAT', completedAt: 'GETRI+GEUZI', modifiedAt: 'AEDAT',
    targetStart: 'GSTRP', targetFinish: 'GLTRP', scheduledStart: 'GSTRS', scheduledFinish: 'GLTRS',
    estimatedHours: 'ARBEI', actualLabourHours: 'ISMNW', pmNumber: 'WARPL',
  },
  smu: { asset: 'EQUNR', at: 'IDATE+ITIME', hours: 'RECDV', meter: 'PSORT', meterValue: 'SMU' },
  workClasses: { PM01: 'corrective', PM02: 'pm', PM03: 'inspection', PM04: 'project', PM05: 'corrective' },
  closedStatuses: ['TECO', 'CLSD', 'DLFL'],
  readiness: { CRTD: 'waiting_approval', MSPT: 'waiting_parts', WSHD: 'waiting_shutdown', PCNF: 'in_progress', REL: 'ready' },
  woNumberPrefix: '^(WO|PM)[-\\s#]*',
  writeDateFormat: 'dd.MM.yyyy HH:mm:ss',
};

export type SourceSystem = 'maximo' | 'sap_pm';
export const SOURCE_SYSTEM_LABELS: Record<SourceSystem, string> = { maximo: 'IBM Maximo', sap_pm: 'SAP PM' };

/** Site setting `imports` (docs/field-mapping.md): which ERP the files come from, and the site value they use. */
export interface ImportSource {
  sourceSystem: SourceSystem;
  /** The site column value of this site's rows, e.g. a Maximo SITEID or an SAP maintenance plant. */
  siteValue?: string;
}
export const DEFAULT_IMPORT_SOURCE: ImportSource = { sourceSystem: 'maximo' };

export function withImportDefaults(v: Partial<ImportSource> | undefined): ImportSource {
  const sys = v?.sourceSystem === 'sap_pm' ? 'sap_pm' : 'maximo';
  const sv = typeof v?.siteValue === 'string' && v.siteValue.trim() ? v.siteValue.trim() : undefined;
  return { sourceSystem: sys, ...(sv ? { siteValue: sv } : {}) };
}

/** The mapping a site's files are read with. */
export function mappingFor(src: ImportSource): ImportMapping {
  const m = src.sourceSystem === 'sap_pm' ? SAP_PM_DEFAULT_MAPPING : MAXIMO_DEFAULT_MAPPING;
  return src.siteValue && m.site ? { ...m, site: { ...m.site, value: src.siteValue } } : m;
}

export function setImportSource(ctx: ConsoleContext, current: ImportSource, next: ImportSource, reason: string): ConsoleResult<ImportSource> {
  if (!can(ctx.actor, 'manage_imports')) return { ok: false, errors: ['The data owner (Admin in phase 1a) chooses the source system.'] };
  const e: string[] = [];
  if (next.sourceSystem !== 'maximo' && next.sourceSystem !== 'sap_pm') e.push('Pick Maximo or SAP PM.');
  if (next.siteValue !== undefined && next.siteValue.trim().length > 40) e.push('The site value is up to 40 characters.');
  if (!reason.trim()) e.push('Give a reason for the change.');
  if (e.length) return { ok: false, errors: e };
  const clean = withImportDefaults(next);
  const audit: AuditEntry = { at: ctx.now, userId: ctx.actor.userId, action: 'set_import_source', entity: 'settings', entityId: 'imports', before: current, after: clean, reason: reason.trim() };
  return { ok: true, records: [clean], audit: [audit], warnings: current.sourceSystem !== clean.sourceSystem ? ['Files imported before keep the source system they came from.'] : [] };
}

/** The words of a status. SAP writes several together, e.g. "REL MACM WSHD"; Maximo writes one. */
export const statusWords = (status?: string) => (status ?? '').toUpperCase().split(/[\s,;]+/).filter(Boolean);

/** Closed when any word of the status is a closed status. */
export const isClosedStatus = (status: string | undefined, closed: string[]) => {
  const c = new Set(closed.map((x) => x.toUpperCase()));
  return statusWords(status).some((w) => c.has(w));
};

export interface ImportSettings {
  /** SMU may rise this much more than clock time between two readings (rounding, clock drift). */
  smuClockToleranceHours: number;
  /** Times this far past "now" are accepted (clock drift). */
  futureToleranceMinutes: number;
}

export const DEFAULT_IMPORT_SETTINGS: ImportSettings = { smuClockToleranceHours: 0.25, futureToleranceMinutes: 10 };

/** Guess what a file holds from its columns, so the user does not have to say. */
export function detectKind(header: string[], m: ImportMapping = MAXIMO_DEFAULT_MAPPING): ImportKind | null {
  // A joined column "DATE+TIME" is there when its first column is.
  const has = (c?: string) => { const f = c?.split('+')[0]?.trim(); return !!f && header.some((h) => h.toUpperCase() === f.toUpperCase()); };
  if (has(m.workOrders.number)) return 'work_orders';
  if (has(m.smu.hours) && has(m.smu.at)) return 'smu';
  if (has(m.assets.unitNumber)) return 'assets';
  return null;
}

// ---------- results ----------

export type DqRule =
  | 'missing_column'
  | 'missing_field'
  | 'bad_date'
  | 'bad_number'
  | 'future_time'
  | 'time_order'
  | 'duplicate_in_file'
  | 'unknown_unit'
  | 'other_site'
  | 'stale_record'
  | 'missing_from_source'
  | 'conflicting_reading'
  | 'smu_backwards'
  | 'smu_faster_than_clock';

export const DQ_RULE_LABELS: Record<DqRule, string> = {
  missing_column: 'Column missing from the file',
  missing_field: 'Required value missing',
  bad_date: 'Date not understood',
  bad_number: 'Number not understood',
  future_time: 'Time is in the future',
  time_order: 'Finish before start',
  duplicate_in_file: 'Same record twice in the file',
  unknown_unit: 'Unit not in the asset register',
  other_site: 'Row for another site',
  stale_record: 'Older than the copy already held',
  missing_from_source: 'Held here but not in the export',
  conflicting_reading: 'Different SMU for the same unit and time',
  smu_backwards: 'SMU went backwards',
  smu_faster_than_clock: 'SMU rose faster than the clock',
};

export interface ImportIssue {
  /** Spreadsheet row number (the header is row 1). 0 for file-level issues. */
  row: number;
  /** error: the row was not loaded. warning: loaded, but check it. */
  severity: 'error' | 'warning';
  rule: DqRule;
  message: string;
  sourceId?: string;
}

/** Land step: the row exactly as received. */
export interface RawRecord {
  sourceSystem: string;
  objectType: ImportKind;
  sourceId: string;
  row: number;
  payload: Record<string, string>;
  loadedAt: Iso;
}

export interface ImportStats {
  read: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Not for this site, or not the SMU meter. Not a problem. */
  skipped: number;
  failed: number;
}

export interface ImportResult<T> {
  kind: ImportKind;
  /** The full set after the upsert: what was held, plus inserts, with updates applied. */
  records: T[];
  inserted: T[];
  updated: Array<{ before: T; after: T }>;
  raw: RawRecord[];
  issues: ImportIssue[];
  stats: ImportStats;
}

export interface ImportContext {
  tenantId: string;
  siteId: string;
  timeZone: string;
  now: Iso;
  newId: () => string;
  mapping?: ImportMapping;
  settings?: ImportSettings;
}

// ---------- helpers ----------

/** Read a date from an export. ISO with an offset is taken as is; anything without one is site local time. */
export function parseSourceDate(value: string, formats: string[], timeZone: string): Iso | null {
  const v = value.trim();
  if (!v) return null;
  let dt = DateTime.fromISO(v, { zone: timeZone, setZone: false });
  if (!dt.isValid) {
    for (const f of formats) {
      dt = DateTime.fromFormat(v, f, { zone: timeZone, locale: 'en-US' });
      if (dt.isValid) break;
    }
  }
  return dt.isValid ? dt.toUTC().toISO()! : null;
}

export function parseSourceNumber(value: string): number | null {
  let v = value.trim().replace(/\s/g, '');
  if (!v) return null;
  // SAP writes negatives with a trailing minus: "12,5-".
  if (/^\d[\d.,]*-$/.test(v)) v = `-${v.slice(0, -1)}`;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
  else if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(v) || /^-?\d{1,3}(\.\d{3}){2,}$/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(v)) v = v.replace(',', '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normaliseWoNumber(n: string, prefix = MAXIMO_DEFAULT_MAPPING.woNumberPrefix): string {
  const s = n.trim().toUpperCase().replace(new RegExp(prefix, 'i'), '');
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}

/** Finds an asset by ERP asset number, then by unit number, ignoring case. */
export function assetMatcher(assets: Asset[]): (key: string) => Asset | undefined {
  const byExt = new Map<string, Asset>();
  const byUnit = new Map<string, Asset>();
  for (const a of assets) {
    if (a.externalAssetId) byExt.set(a.externalAssetId.trim().toUpperCase(), a);
    byUnit.set(a.unitNumber.trim().toUpperCase(), a);
  }
  return (key) => {
    const k = key.trim().toUpperCase();
    return byExt.get(k) ?? byUnit.get(k);
  };
}

class Reader {
  private index = new Map<string, number>();
  constructor(readonly table: Table) {
    table.header.forEach((h, i) => this.index.set(h.toUpperCase(), i));
  }
  /** "A+B" joins two columns (an SAP date and its time); only the first must be present. */
  has(col?: string): boolean {
    return !!col && this.index.has(col.split('+')[0]!.trim().toUpperCase());
  }
  get(row: string[], col?: string): string {
    if (!col) return '';
    return col.split('+').map((c) => {
      const i = this.index.get(c.trim().toUpperCase());
      return i === undefined ? '' : (row[i] ?? '').trim();
    }).filter(Boolean).join(' ');
  }
  payload(row: string[]): Record<string, string> {
    return Object.fromEntries(this.table.header.map((h, i) => [h, row[i] ?? '']));
  }
}

function start<T>(kind: ImportKind, ctx: ImportContext, table: Table, required: Array<string | undefined>) {
  const m = ctx.mapping ?? MAXIMO_DEFAULT_MAPPING;
  const s = ctx.settings ?? DEFAULT_IMPORT_SETTINGS;
  const rd = new Reader(table);
  const issues: ImportIssue[] = [];
  const stats: ImportStats = { read: table.rows.length, inserted: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const missing = required.filter((c): c is string => !!c && !rd.has(c));
  for (const c of missing) issues.push({ row: 0, severity: 'error', rule: 'missing_column', message: `The file has no ${c} column. Check the file, or change the field mapping.` });
  const result: ImportResult<T> = { kind, records: [], inserted: [], updated: [], raw: [], issues, stats };
  return { m, s, rd, issues, stats, result, ok: missing.length === 0 };
}

/** One summary issue instead of one per row, for rows that are simply not ours. */
function otherSiteFilter(rd: Reader, m: ImportMapping) {
  const col = m.site && rd.has(m.site.column) ? m.site : undefined;
  return (row: string[]) => !col || rd.get(row, col.column).toUpperCase() === col.value.toUpperCase();
}

const span = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);
const rowsWord = (n: number) => (n === 1 ? '1 row was' : `${n} rows were`);
const m0 = (ctx: ImportContext) => ctx.mapping ?? MAXIMO_DEFAULT_MAPPING;
/** Field-by-field equality that ignores key order and undefined fields. */
const same = (a: object, b: object) => {
  const norm = (o: object) => JSON.stringify(Object.entries(o).filter(([, v]) => v !== undefined).sort(([x], [y]) => (x < y ? -1 : 1)));
  return norm(a) === norm(b);
};
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;

// ---------- assets ----------

export function importAssets(table: Table, existing: Asset[], ctx: ImportContext): ImportResult<Asset> {
  const { m, rd, issues, stats, result, ok } = start<Asset>('assets', ctx, table, [m0(ctx).assets.unitNumber, m0(ctx).assets.externalAssetId]);
  result.records = [...existing];
  if (!ok) { stats.failed = stats.read; return result; }
  const ours = otherSiteFilter(rd, m);
  const seen = new Map<string, number>();
  const pos = new Map(existing.map((a, i) => [a.id, i]));
  // Rebuilt after each insert, so a later row in the same file finds it.
  let find = assetMatcher(existing);
  let otherSite = 0;

  table.rows.forEach((row, i) => {
    const line = i + 2;
    const ext = rd.get(row, m.assets.externalAssetId);
    const unitNumber = rd.get(row, m.assets.unitNumber);
    result.raw.push({ sourceSystem: m.sourceSystem, objectType: 'assets', sourceId: ext, row: line, payload: rd.payload(row), loadedAt: ctx.now });
    if (!ours(row)) { otherSite++; stats.skipped++; return; }
    if (!ext || !unitNumber) {
      issues.push({ row: line, severity: 'error', rule: 'missing_field', message: `No ${!ext ? m.assets.externalAssetId : m.assets.unitNumber}.` });
      stats.failed++;
      return;
    }
    const key = ext.toUpperCase();
    if (seen.has(key)) issues.push({ row: line, severity: 'warning', rule: 'duplicate_in_file', sourceId: ext, message: `${ext} is also on row ${seen.get(key)}. The later row was used.` });
    seen.set(key, line);

    const fields: Partial<Asset> = clean({
      unitNumber,
      externalAssetId: ext,
      fleet: rd.get(row, m.assets.fleet) || undefined,
      model: rd.get(row, m.assets.model) || undefined,
      serial: rd.get(row, m.assets.serial) || undefined,
      functionalLocation: rd.get(row, m.assets.functionalLocation) || undefined,
    });
    // Look at what is held now, including rows earlier in this file.
    const current = find(ext) ?? find(unitNumber);
    const at = current ? pos.get(current.id) : undefined;
    const held = at !== undefined ? result.records[at]! : undefined;
    if (held) {
      const next: Asset = { ...held, ...fields };
      if (same(next, held)) { stats.unchanged++; return; }
      result.records[at!] = next;
      const prev = result.updated.find((u) => u.after.id === held.id);
      if (prev) prev.after = next;
      else if (!result.inserted.some((x) => x.id === held.id)) result.updated.push({ before: held, after: next });
      else result.inserted[result.inserted.findIndex((x) => x.id === held.id)] = next;
      stats.updated++;
    } else {
      const a: Asset = { id: ctx.newId(), tenantId: ctx.tenantId, siteId: ctx.siteId, assetClass: 'mobile', fleet: 'Unassigned', model: 'Unknown', ...fields } as Asset;
      pos.set(a.id, result.records.length);
      result.records.push(a);
      result.inserted.push(a);
      find = assetMatcher(result.records);
      stats.inserted++;
    }
  });
  if (otherSite) issues.push({ row: 0, severity: 'warning', rule: 'other_site', message: `${rowsWord(otherSite)} for another site and left out.` });
  const inFile = new Set([...seen.keys()]);
  const notInFile = result.records.filter((a) => a.externalAssetId && !inFile.has(a.externalAssetId.toUpperCase()) && !result.inserted.includes(a));
  if (notInFile.length && seen.size) {
    issues.push({ row: 0, severity: 'warning', rule: 'missing_from_source', message: `${notInFile.length} units held here are not in this export (${notInFile.slice(0, 5).map((a) => a.unitNumber).join(', ')}${notInFile.length > 5 ? ', …' : ''}). They were kept. Retire them in the console if they have left the site.` });
  }
  return result;
}


// ---------- work orders ----------

export function importWorkOrders(table: Table, existing: WorkOrder[], assets: Asset[], ctx: ImportContext): ImportResult<WorkOrder> {
  const mm = m0(ctx);
  const { m, s, rd, issues, stats, result, ok } = start<WorkOrder>('work_orders', ctx, table, [mm.workOrders.number, mm.workOrders.asset]);
  result.records = [...existing];
  if (!ok) { stats.failed = stats.read; return result; }
  const ours = otherSiteFilter(rd, m);
  const find = assetMatcher(assets);
  const byKey = new Map(existing.map((w, i) => [`${w.sourceSystem}|${w.sourceId}`.toUpperCase(), i]));
  const fileRow = new Map<string, number>();
  const futureLimit = ms(ctx.now) + s.futureToleranceMinutes * 60_000;
  const unknownUnits = new Map<string, number>();
  let otherSite = 0;

  table.rows.forEach((row, i) => {
    const line = i + 2;
    const number = rd.get(row, m.workOrders.number);
    result.raw.push({ sourceSystem: m.sourceSystem, objectType: 'work_orders', sourceId: number, row: line, payload: rd.payload(row), loadedAt: ctx.now });
    if (!ours(row)) { otherSite++; stats.skipped++; return; }
    if (!number) {
      issues.push({ row: line, severity: 'error', rule: 'missing_field', message: `No ${m.workOrders.number}.` });
      stats.failed++;
      return;
    }
    const date = (col?: string) => {
      const v = rd.get(row, col);
      if (!v) return undefined;
      const d = parseSourceDate(v, m.dateFormats, ctx.timeZone);
      if (!d) {
        issues.push({ row: line, severity: 'warning', rule: 'bad_date', sourceId: number, message: `${col?.replace("+", " and ")} "${v}" is not a date the mapping understands. Left blank.` });
        return undefined;
      }
      if (ms(d) > futureLimit) {
        issues.push({ row: line, severity: 'warning', rule: 'future_time', sourceId: number, message: `${col} ${v} is in the future. Left blank.` });
        return undefined;
      }
      return d;
    };
    const plannedDate = (col?: string) => {
      const v = rd.get(row, col);
      if (!v) return undefined;
      const d = parseSourceDate(v, m.dateFormats, ctx.timeZone);
      if (!d) issues.push({ row: line, severity: 'warning', rule: 'bad_date', sourceId: number, message: `${col?.replace("+", " and ")} "${v}" is not a date the mapping understands. Left blank.` });
      return d ?? undefined;
    };
    const ext = rd.get(row, m.workOrders.asset);
    const asset = ext ? find(ext) : undefined;
    if (!ext) issues.push({ row: line, severity: 'warning', rule: 'missing_field', sourceId: number, message: `Work order ${number} has no asset. Loaded without a unit.` });
    else if (!asset) unknownUnits.set(ext, (unknownUnits.get(ext) ?? 0) + 1);

    const status = rd.get(row, m.workOrders.status) || undefined;
    const woType = rd.get(row, m.workOrders.type) || undefined;
    const reportedAt = date(m.workOrders.reportedAt);
    const completedAt = date(m.workOrders.completedAt);
    const sourceModifiedAt = date(m.workOrders.modifiedAt);
    if (reportedAt && completedAt && ms(completedAt) < ms(reportedAt)) {
      issues.push({ row: line, severity: 'warning', rule: 'time_order', sourceId: number, message: `Work order ${number} finished before it was reported.` });
    }
    const num = (col?: string) => {
      const v = rd.get(row, col);
      if (!v) return undefined;
      const n = parseSourceNumber(v);
      if (n === null || n < 0) {
        issues.push({ row: line, severity: 'warning', rule: 'bad_number', sourceId: number, message: `${col} "${v}" is not a number of hours. Left blank.` });
        return undefined;
      }
      return n;
    };
    const fields: Omit<WorkOrder, 'id'> = clean({
      tenantId: ctx.tenantId,
      siteId: ctx.siteId,
      assetId: asset?.id,
      sourceSystem: m.sourceSystem,
      sourceId: number,
      number,
      numberNormalised: normaliseWoNumber(number, m.woNumberPrefix),
      externalAssetId: ext || undefined,
      woType,
      workClass: (woType && m.workClasses[woType.toUpperCase()]) || 'other',
      status,
      open: !isClosedStatus(status, m.closedStatuses),
      priority: rd.get(row, m.workOrders.priority) || undefined,
      description: rd.get(row, m.workOrders.description) || undefined,
      reportedAt,
      completedAt,
      sourceModifiedAt,
      // Planned dates may be in the future, so they skip the future check.
      targetStart: plannedDate(m.workOrders.targetStart),
      targetFinish: plannedDate(m.workOrders.targetFinish),
      scheduledStart: plannedDate(m.workOrders.scheduledStart),
      scheduledFinish: plannedDate(m.workOrders.scheduledFinish),
      estimatedHours: num(m.workOrders.estimatedHours),
      actualLabourHours: num(m.workOrders.actualLabourHours),
      pmNumber: rd.get(row, m.workOrders.pmNumber) || undefined,
      originWorkOrder: rd.get(row, m.workOrders.origin) || undefined,
    }) as Omit<WorkOrder, 'id'>;
    if (fields.open === undefined) fields.open = true;

    const key = `${m.sourceSystem}|${number}`.toUpperCase();
    const dupOf = fileRow.get(key);
    const at = byKey.get(key);
    const held = at !== undefined ? result.records[at]! : undefined;
    if (held?.sourceModifiedAt && sourceModifiedAt && ms(sourceModifiedAt) < ms(held.sourceModifiedAt)) {
      issues.push({
        row: line, severity: 'warning', rule: dupOf ? 'duplicate_in_file' : 'stale_record', sourceId: number,
        message: dupOf ? `Work order ${number} is also on row ${dupOf}, with a later change date. That row was kept.` : `Work order ${number} is older than the copy already held. Not loaded.`,
      });
      stats.unchanged++;
      return;
    }
    if (dupOf) issues.push({ row: line, severity: 'warning', rule: 'duplicate_in_file', sourceId: number, message: `Work order ${number} is also on row ${dupOf}. This row was used.` });
    fileRow.set(key, line);

    if (held) {
      const next: WorkOrder = { id: held.id, ...fields };
      if (same(next, held)) { stats.unchanged++; return; }
      result.records[at!] = next;
      const ins = result.inserted.findIndex((x) => x.id === held.id);
      const upd = result.updated.find((u) => u.after.id === held.id);
      if (ins >= 0) result.inserted[ins] = next;
      else if (upd) upd.after = next;
      else result.updated.push({ before: held, after: next });
      stats.updated++;
    } else {
      const w: WorkOrder = { id: ctx.newId(), ...fields };
      byKey.set(key, result.records.length);
      result.records.push(w);
      result.inserted.push(w);
      stats.inserted++;
    }
  });
  for (const [ext, n] of unknownUnits) {
    issues.push({ row: 0, severity: 'warning', rule: 'unknown_unit', sourceId: ext, message: `${n} work order${n > 1 ? 's' : ''} for ${ext}, which is not in the asset register. Loaded without a unit; import the asset list first.` });
  }
  if (otherSite) issues.push({ row: 0, severity: 'warning', rule: 'other_site', message: `${rowsWord(otherSite)} for another site and left out.` });
  return result;
}

/** Work orders that are still open for a unit, newest first. */
export function openWorkOrders(workOrders: WorkOrder[], assetId: string): WorkOrder[] {
  return workOrders
    .filter((w) => w.assetId === assetId && w.open)
    .sort((a, b) => (b.reportedAt ? ms(b.reportedAt) : 0) - (a.reportedAt ? ms(a.reportedAt) : 0));
}

/** The work orders a flag names, matched on the normalised number. */
export function workOrdersForFlag(flagWorkOrders: string[], workOrders: WorkOrder[], prefix?: string): WorkOrder[] {
  const want = new Set(flagWorkOrders.map((n) => normaliseWoNumber(n, prefix)));
  return workOrders.filter((w) => want.has(w.numberNormalised));
}

// ---------- SMU readings ----------

/**
 * SMU readings from a meter export (Maximo meter readings, or the fleet system).
 * A reading is never overwritten: a different value for the same unit and time
 * is a conflict to sort out, not an update. Readings that would make SMU go
 * backwards, or rise faster than the clock, are refused, because they would
 * corrupt utilisation and MTBF.
 */
export function importSmu(table: Table, existing: SmuReading[], assets: Asset[], ctx: ImportContext): ImportResult<SmuReading> {
  const mm = m0(ctx);
  const { m, s, rd, issues, stats, result, ok } = start<SmuReading>('smu', ctx, table, [mm.smu.asset, mm.smu.at, mm.smu.hours]);
  result.records = [...existing];
  if (!ok) { stats.failed = stats.read; return result; }
  const ours = otherSiteFilter(rd, m);
  const find = assetMatcher(assets);
  const futureLimit = ms(ctx.now) + s.futureToleranceMinutes * 60_000;
  const meterCol = m.smu.meter && rd.has(m.smu.meter) ? m.smu.meter : undefined;
  const unknownUnits = new Map<string, number[]>();
  let otherSite = 0;

  type Cand = { r: SmuReading; line: number; ext: string };
  const cands: Cand[] = [];
  table.rows.forEach((row, i) => {
    const line = i + 2;
    const ext = rd.get(row, m.smu.asset);
    const atText = rd.get(row, m.smu.at);
    result.raw.push({ sourceSystem: m.sourceSystem, objectType: 'smu', sourceId: `${ext}@${atText}`, row: line, payload: rd.payload(row), loadedAt: ctx.now });
    if (!ours(row)) { otherSite++; stats.skipped++; return; }
    if (meterCol && m.smu.meterValue && rd.get(row, meterCol).toUpperCase() !== m.smu.meterValue.toUpperCase()) { stats.skipped++; return; }
    const fail = (rule: DqRule, message: string) => { issues.push({ row: line, severity: 'error', rule, sourceId: ext, message }); stats.failed++; };
    if (!ext) return fail('missing_field', `No ${m.smu.asset}.`);
    const asset = find(ext);
    if (!asset) { unknownUnits.set(ext, [...(unknownUnits.get(ext) ?? []), line]); stats.failed++; return; }
    const at = parseSourceDate(atText, m.dateFormats, ctx.timeZone);
    if (!at) return fail(atText ? 'bad_date' : 'missing_field', atText ? `${m.smu.at.replace("+", " and ")} "${atText}" is not a date the mapping understands.` : `No ${m.smu.at.replace("+", " and ")}.`);
    if (ms(at) > futureLimit) return fail('future_time', `${asset.unitNumber}: reading time ${atText} is in the future.`);
    const hText = rd.get(row, m.smu.hours);
    const hours = parseSourceNumber(hText);
    if (hours === null) return fail(hText ? 'bad_number' : 'missing_field', hText ? `${m.smu.hours} "${hText}" is not a number.` : `No ${m.smu.hours}.`);
    if (hours < 0) return fail('bad_number', `${asset.unitNumber}: SMU cannot be negative.`);
    cands.push({ r: { unitId: asset.id, at, hours }, line, ext });
  });

  // Check each new reading against its neighbours in time, per unit.
  const byUnit = new Map<string, SmuReading[]>();
  for (const r of existing) byUnit.set(r.unitId, [...(byUnit.get(r.unitId) ?? []), r]);
  for (const list of byUnit.values()) list.sort((a, b) => ms(a.at) - ms(b.at));
  const unitName = new Map(assets.map((a) => [a.id, a.unitNumber]));
  cands.sort((a, b) => ms(a.r.at) - ms(b.r.at) || a.line - b.line);
  const firstLine = new Map<string, number>();
  for (const { r, line } of cands) {
    const name = unitName.get(r.unitId) ?? r.unitId;
    const list = byUnit.get(r.unitId) ?? [];
    const t = ms(r.at);
    const fail = (rule: DqRule, message: string) => { issues.push({ row: line, severity: 'error', rule, sourceId: name, message }); stats.failed++; };
    const k = `${r.unitId}|${t}`;
    const sameTime = list.find((x) => ms(x.at) === t);
    if (sameTime) {
      if (sameTime.hours === r.hours) {
        if (firstLine.has(k)) issues.push({ row: line, severity: 'warning', rule: 'duplicate_in_file', sourceId: name, message: `${name}: same reading as row ${firstLine.get(k)}.` });
        stats.unchanged++;
      } else {
        fail('conflicting_reading', `${name} at ${DateTime.fromISO(r.at, { zone: ctx.timeZone }).toFormat('yyyy-MM-dd HH:mm')}: ${r.hours} h here, ${sameTime.hours} h already held. Not loaded; void the wrong one first.`);
      }
      continue;
    }
    let lo = -1;
    for (let j = 0; j < list.length && ms(list[j]!.at) < t; j++) lo = j;
    const prev = lo >= 0 ? list[lo] : undefined;
    const next = list[lo + 1];
    const tol = s.smuClockToleranceHours;
    if (prev && r.hours < prev.hours) { fail('smu_backwards', `${name}: ${r.hours} h is lower than ${prev.hours} h read earlier. If the meter was replaced, record the meter change before loading.`); continue; }
    if (next && next.hours < r.hours) { fail('smu_backwards', `${name}: ${r.hours} h is higher than ${next.hours} h read later.`); continue; }
    if (prev && r.hours - prev.hours > (t - ms(prev.at)) / HOUR_MS + tol) { fail('smu_faster_than_clock', `${name}: rose ${(r.hours - prev.hours).toFixed(1)} h in ${span((t - ms(prev.at)) / HOUR_MS)} of clock time.`); continue; }
    if (next && next.hours - r.hours > (ms(next.at) - t) / HOUR_MS + tol) { fail('smu_faster_than_clock', `${name}: the next reading rises ${(next.hours - r.hours).toFixed(1)} h in ${span((ms(next.at) - t) / HOUR_MS)} of clock time after this one.`); continue; }
    list.splice(lo + 1, 0, r);
    byUnit.set(r.unitId, list);
    firstLine.set(k, line);
    result.records.push(r);
    result.inserted.push(r);
    stats.inserted++;
  }
  for (const [ext, lines] of unknownUnits) {
    issues.push({ row: lines[0]!, severity: 'error', rule: 'unknown_unit', sourceId: ext, message: `${lines.length} reading${lines.length > 1 ? 's' : ''} for ${ext}, which is not in the asset register. Not loaded.` });
  }
  if (otherSite) issues.push({ row: 0, severity: 'warning', rule: 'other_site', message: `${rowsWord(otherSite)} for another site and left out.` });
  result.records.sort((a, b) => ms(a.at) - ms(b.at));
  return result;
}

/** Share of rows read that loaded (or were already held). Skipped rows are not counted. */
export function importScore(stats: ImportStats): number | null {
  const n = stats.read - stats.skipped;
  return n > 0 ? (n - stats.failed) / n : null;
}

// ---------- export in the same shape (for synthetic files and round trips) ----------

export function formatSourceDate(iso: Iso | undefined | null, timeZone: string, format = 'yyyy-MM-dd HH:mm:ss'): string {
  return iso ? DateTime.fromISO(iso, { zone: timeZone }).toFormat(format) : '';
}

/** Write assets, work orders and SMU readings as Maximo-style CSV files, using the mapping's column names. */
export function toSourceCsv(
  data: { assets: Asset[]; workOrders: WorkOrder[]; smu: SmuReading[] },
  timeZone: string,
  m: ImportMapping = MAXIMO_DEFAULT_MAPPING,
): { assets: string; workOrders: string; smu: string } {
  const site = m.site;
  const ext = new Map(data.assets.map((a) => [a.id, a.externalAssetId ?? a.unitNumber]));
  const cols = <T>(pairs: Array<[string | undefined, (x: T) => string | number | undefined]>) => pairs.filter((p): p is [string, (x: T) => string | number | undefined] => !!p[0]);
  const withSite = <T>(pairs: Array<[string, (x: T) => string | number | undefined]>) => (site ? [...pairs, [site.column, () => site.value] as [string, (x: T) => string]] : pairs);
  const fd = (iso: Iso | undefined | null) => formatSourceDate(iso, timeZone, m.writeDateFormat);
  // Work types and statuses are written in the target system's words. A word the mapping
  // already knows is kept; otherwise the type follows the work class and the status follows
  // open or closed and the readiness the word has in the Maximo mapping.
  const keyFor = (map: Record<string, string>, v: string | undefined) => (v ? Object.keys(map).find((k) => map[k] === v) : undefined);
  const typeWord = (w: WorkOrder) => (w.woType && m.workClasses[w.woType.toUpperCase()] ? w.woType : keyFor(m.workClasses, w.workClass) ?? w.woType);
  const statusWord = (w: WorkOrder) => {
    const words = statusWords(w.status);
    if (words.some((x) => m.closedStatuses.includes(x) || m.readiness[x])) return w.status;
    if (!w.open) return m.closedStatuses[0] ?? w.status;
    const r = words.map((x) => MAXIMO_DEFAULT_MAPPING.readiness[x]).find(Boolean);
    return keyFor(m.readiness, r) ?? w.status;
  };
  // A joined column "DATE+TIME" is written as two columns: the date, then the time.
  const write = <T>(rows: T[], pairs: Array<[string, (x: T) => string | number | undefined]>) => {
    const out: Array<[string, (x: T) => string | number | undefined]> = pairs.flatMap(([c, f]): Array<[string, (x: T) => string | number | undefined]> => {
      const parts = c.split('+');
      if (parts.length < 2) return [[c, f]];
      const piece = (x: T, n: number) => { const v = String(f(x) ?? ''); const k = v.indexOf(' '); return n === 0 ? (k < 0 ? v : v.slice(0, k)) : k < 0 ? '' : v.slice(k + 1); };
      return [[parts[0]!.trim(), (x: T) => piece(x, 0)], [parts[1]!.trim(), (x: T) => piece(x, 1)]];
    });
    return toCsv([out.map((p) => p[0]), ...rows.map((r) => out.map((p) => p[1](r)))]);
  };

  const assetCols = withSite(cols<Asset>([
    [m.assets.externalAssetId, (a) => a.externalAssetId ?? a.unitNumber],
    ...(m.assets.unitNumber !== m.assets.externalAssetId ? [[m.assets.unitNumber, (a: Asset) => a.unitNumber] as [string, (a: Asset) => string]] : []),
    [m.assets.fleet, (a) => a.fleet],
    [m.assets.model, (a) => a.model],
    [m.assets.serial, (a) => a.serial],
    [m.assets.functionalLocation, (a) => a.functionalLocation],
  ]));
  const woCols = withSite(cols<WorkOrder>([
    [m.workOrders.number, (w) => w.number],
    [m.workOrders.asset, (w) => w.externalAssetId ?? (w.assetId ? ext.get(w.assetId) : '')],
    [m.workOrders.type, typeWord],
    [m.workOrders.status, statusWord],
    [m.workOrders.priority, (w) => w.priority],
    [m.workOrders.description, (w) => w.description],
    [m.workOrders.reportedAt, (w) => fd(w.reportedAt)],
    [m.workOrders.completedAt, (w) => fd(w.completedAt)],
    [m.workOrders.modifiedAt, (w) => fd(w.sourceModifiedAt)],
    [m.workOrders.targetStart, (w) => fd(w.targetStart)],
    [m.workOrders.targetFinish, (w) => fd(w.targetFinish)],
    [m.workOrders.scheduledStart, (w) => fd(w.scheduledStart)],
    [m.workOrders.scheduledFinish, (w) => fd(w.scheduledFinish)],
    [m.workOrders.estimatedHours, (w) => w.estimatedHours],
    [m.workOrders.actualLabourHours, (w) => w.actualLabourHours],
    [m.workOrders.pmNumber, (w) => w.pmNumber],
    [m.workOrders.origin, (w) => w.originWorkOrder],
  ]));
  const smuCols = withSite(cols<SmuReading>([
    [m.smu.asset, (r) => ext.get(r.unitId)],
    [m.smu.meter, () => m.smu.meterValue],
    [m.smu.at, (r) => fd(r.at)],
    [m.smu.hours, (r) => r.hours],
  ]));
  return { assets: write(data.assets, assetCols), workOrders: write(data.workOrders, woCols), smu: write(data.smu, smuCols) };
}
