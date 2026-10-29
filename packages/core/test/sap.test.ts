// SAP PM file imports (docs/field-mapping.md): joined date and time columns,
// multi-word statuses, SAP number formats, and a round trip through sample files.

import { describe, expect, it } from 'vitest';
import type { ConsoleContext } from '../src/console.js';
import {
  MAXIMO_DEFAULT_MAPPING, SAP_PM_DEFAULT_MAPPING, importAssets, importSmu, importWorkOrders, isClosedStatus, mappingFor, parseCsv, parseSourceNumber,
  setImportSource, toSourceCsv, withImportDefaults, type ImportContext,
} from '../src/imports.js';
import { generateFleet } from '../src/synth/generate.js';
import { local } from '../src/time.js';
import type { WorkOrder } from '../src/types.js';
import { readiness } from '../src/work.js';
import { TZ, actor, cal } from './helpers.js';

let n = 0;
const ctx: ImportContext = { tenantId: 't', siteId: 's', timeZone: TZ, now: local(TZ, '2026-10-26 12:00'), newId: () => `new-${++n}`, mapping: SAP_PM_DEFAULT_MAPPING };

const EQUIP = `EQUNR;TIDNR;EQART;TYPBZ;SERGE;TPLNR;SWERK
000000000010000101;HT101;HAULTRUCK;793F;SSP1;MINE-PIT1;DEMO
000000000010000102;HT102;HAULTRUCK;793F;SSP2;MINE-PIT1;DEMO
000000000010000900;HT900;HAULTRUCK;793F;SSP9;OTHER;1000
`;
const ORDERS = `AUFNR;EQUNR;AUART;STTXT;USTXT;PRIOK;KTEXT;ERDAT;GETRI;GEUZI;GSTRP;ARBEI;ISMNW;SWERK
000004001234;000000000010000101;PM01;TECO CNF;;1;Replace hydraulic hose;20.10.2026;21.10.2026;14:30:00;20.10.2026;6,5;7,25;DEMO
000004001235;000000000010000102;PM02;REL MSPT;WSHD;3;250 h service;22.10.2026;;;03.11.2026;1.234,5;;DEMO
000004001236;000000000010000102;PM02;CRTD;;3;Next service;25.10.2026;;;10.11.2026;8;;DEMO
`;

describe('SAP number formats', () => {
  it('reads comma decimals, dot thousands and a trailing minus, and keeps 1.234 as 1.234', () => {
    expect(parseSourceNumber('6,5')).toBe(6.5);
    expect(parseSourceNumber('1.234,5')).toBe(1234.5);
    expect(parseSourceNumber('1.234.567')).toBe(1234567);
    expect(parseSourceNumber('12,5-')).toBe(-12.5);
    expect(parseSourceNumber('1.234')).toBe(1.234);
    expect(parseSourceNumber('1,234.5')).toBe(1234.5);
  });
});

describe('SAP PM orders', () => {
  const eq = importAssets(parseCsv(EQUIP), [], ctx);
  const wo = importWorkOrders(parseCsv(ORDERS), [], eq.records, ctx);
  const by = (num: string) => wo.records.find((w) => w.numberNormalised === num)!;

  it('reads equipment by EQUNR with TIDNR as the unit number, leaving other plants out', () => {
    expect(eq.stats).toMatchObject({ inserted: 2, skipped: 1 });
    expect(eq.records[0]).toMatchObject({ unitNumber: 'HT101', externalAssetId: '000000000010000101', model: '793F', functionalLocation: 'MINE-PIT1' });
  });

  it('joins the finish date and time, and drops the leading zeros of the order number', () => {
    expect(wo.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const a = by('4001234');
    expect(a.completedAt).toBe(local(TZ, '2026-10-21 14:30'));
    expect(a.assetId).toBe(eq.records[0]!.id);
    expect(a).toMatchObject({ open: false, workClass: 'corrective', estimatedHours: 6.5, actualLabourHours: 7.25 });
    expect(by('4001235').estimatedHours).toBe(1234.5);
  });

  it('takes the most limiting word of a status for readiness, and closes on any closed word', () => {
    const map = SAP_PM_DEFAULT_MAPPING.readiness;
    expect(by('4001235')).toMatchObject({ open: true, status: 'REL MSPT WSHD' });
    expect(readiness(by('4001235'), map)).toBe('waiting_parts');
    expect(readiness(by('4001236'), map)).toBe('waiting_approval');
    expect(readiness({ status: 'REL' } as WorkOrder, map)).toBe('ready');
    expect(readiness({ status: 'REL PCNF' } as WorkOrder, map)).toBe('in_progress');
    expect(readiness({ status: 'NOPR' } as WorkOrder, map)).toBe('unknown');
    expect(isClosedStatus('REL CNF TECO', SAP_PM_DEFAULT_MAPPING.closedStatuses)).toBe(true);
    // A one-word Maximo status reads as before.
    expect(readiness({ status: 'wmatl' } as WorkOrder)).toBe('waiting_parts');
    expect(isClosedStatus('COMP', MAXIMO_DEFAULT_MAPPING.closedStatuses)).toBe(true);
  });
});

describe('SAP sample files round trip', () => {
  it('writes the synthetic fleet in SAP layout and reads it back the same', () => {
    const ds = generateFleet({ seed: 3, units: 6, days: 30, end: '2026-10-20T12:00:00.000Z' });
    const m = SAP_PM_DEFAULT_MAPPING;
    const f = toSourceCsv(ds, ds.site.timeZone, m);
    expect(parseCsv(f.workOrders).header).toEqual(expect.arrayContaining(['AUFNR', 'GETRI', 'GEUZI', 'SWERK']));
    const c: ImportContext = { ...ctx, timeZone: ds.site.timeZone, now: '2026-10-21T00:00:00.000Z' };
    const a = importAssets(parseCsv(f.assets), [], c);
    expect(a.stats.inserted).toBe(ds.assets.length);
    const w = importWorkOrders(parseCsv(f.workOrders), [], a.records, c);
    expect(w.stats.inserted).toBe(ds.workOrders.length);
    const done = ds.workOrders.find((x) => x.completedAt)!;
    const back = w.records.find((x) => x.numberNormalised === done.numberNormalised)!;
    expect(back.completedAt).toBe(new Date(Math.floor(Date.parse(done.completedAt!) / 1000) * 1000).toISOString());
    const s = importSmu(parseCsv(f.smu), [], a.records, c);
    expect(s.stats.failed).toBe(0);
    expect(s.records.length).toBe(ds.smu.length);
  });
});

describe('import source setting', () => {
  const cctx = (role: 'admin' | 'reliability_engineer'): ConsoleContext => ({ actor: actor(role), now: '2026-10-29T00:00:00.000Z', newId: () => 'x', timeZone: TZ, calendar: cal });
  it('is the data owner\'s, needs a reason, and sets the site value', () => {
    const cur = withImportDefaults(undefined);
    expect(cur).toEqual({ sourceSystem: 'maximo' });
    expect(setImportSource(cctx('reliability_engineer'), cur, { sourceSystem: 'sap_pm' }, 'Moving to SAP').ok).toBe(false);
    expect(setImportSource(cctx('admin'), cur, { sourceSystem: 'sap_pm' }, ' ').ok).toBe(false);
    const r = setImportSource(cctx('admin'), cur, { sourceSystem: 'sap_pm', siteValue: ' 1000 ' }, 'Moving to SAP');
    expect(r.ok && r.records[0]).toEqual({ sourceSystem: 'sap_pm', siteValue: '1000' });
    expect(mappingFor({ sourceSystem: 'sap_pm', siteValue: '1000' }).site).toEqual({ column: 'SWERK', value: '1000' });
    expect(mappingFor({ sourceSystem: 'maximo' })).toBe(MAXIMO_DEFAULT_MAPPING);
  });
});
