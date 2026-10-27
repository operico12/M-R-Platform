// File imports (plan 6.2, 6.3): land, clean, upsert on source ID, safe to re-run.

import { describe, expect, it } from 'vitest';
import { importAssets, importSmu, importWorkOrders, normaliseWoNumber, parseCsv, toCsv, type ImportContext } from '../src/imports.js';
import type { Asset } from '../src/types.js';
import { local } from '../src/time.js';
import { TZ } from './helpers.js';

let n = 0;
const ctx: ImportContext = { tenantId: 't', siteId: 's', timeZone: TZ, now: local(TZ, '2026-10-26 12:00'), newId: () => `new-${++n}` };

const ASSETS = `ASSETNUM,ASSETTYPE,MODEL,SERIALNUM,SITEID
HT101,Haul trucks,793F,SSP1,DEMO
HT102,Haul trucks,793F,SSP2,DEMO
HT900,Haul trucks,793F,SSP9,OTHER
`;

describe('CSV', () => {
  it('reads quotes, embedded commas, CRLF, a BOM and semicolons', () => {
    expect(parseCsv('﻿A,B\r\n"x, y","say ""hi"""\r\n').rows).toEqual([['x, y', 'say "hi"']]);
    expect(parseCsv('A;B\n1;2\n').rows).toEqual([['1', '2']]);
    const t = toCsv([['A', 'B'], ['a,b', 'c']]);
    expect(parseCsv(t).rows).toEqual([['a,b', 'c']]);
  });
});

describe('asset import', () => {
  it('inserts, skips other sites, and changes nothing on a re-run', () => {
    const first = importAssets(parseCsv(ASSETS), [], ctx);
    expect(first.stats).toMatchObject({ read: 3, inserted: 2, skipped: 1, failed: 0 });
    expect(first.raw).toHaveLength(3); // land keeps every row
    const again = importAssets(parseCsv(ASSETS), first.records, ctx);
    expect(again.stats).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
  });

  it('updates a changed unit in place and never deletes a missing one', () => {
    const first = importAssets(parseCsv(ASSETS), [], ctx).records;
    const r = importAssets(parseCsv('ASSETNUM,MODEL,SITEID\nHT101,793F-XQ,DEMO\n'), first, ctx);
    expect(r.updated[0]!.after.model).toBe('793F-XQ');
    expect(r.records).toHaveLength(2);
    expect(r.issues.some((i) => i.rule === 'missing_from_source')).toBe(true);
  });

  it('reports a missing column instead of guessing', () => {
    const r = importAssets(parseCsv('UNIT,MODEL\nHT1,793F\n'), [], ctx);
    expect(r.stats.failed).toBe(1);
    expect(r.issues[0]!.rule).toBe('missing_column');
  });
});

describe('work order import', () => {
  const assets = importAssets(parseCsv(ASSETS), [], ctx).records;
  const WOS = `WONUM,ASSETNUM,WORKTYPE,STATUS,REPORTDATE,ACTFINISH,CHANGEDATE,SITEID
00123456,HT101,CM,COMP,2026-10-20 08:00:00,2026-10-20 14:00:00,2026-10-20 14:05:00,DEMO
123457,HT102,PM,APPR,2026-10-25 06:00:00,,2026-10-25 06:00:00,DEMO
123458,HT555,CM,WAPPR,10/25/2026 7:30 AM,,,DEMO
`;
  it('links units, reads site-local dates, and marks open work', () => {
    const r = importWorkOrders(parseCsv(WOS), [], assets, ctx);
    expect(r.stats).toMatchObject({ inserted: 3, failed: 0 });
    const [a, b, c] = r.records;
    expect(a!.numberNormalised).toBe('123456');
    expect(a!.reportedAt).toBe(local(TZ, '2026-10-20 08:00'));
    expect(a!.open).toBe(false);
    expect(b!.workClass).toBe('pm');
    expect(b!.open).toBe(true);
    expect(c!.assetId).toBeUndefined();
    expect(c!.reportedAt).toBe(local(TZ, '2026-10-25 07:30'));
    expect(r.issues.some((i) => i.rule === 'unknown_unit')).toBe(true);
  });

  it('is safe to re-run, and ignores an older copy of a record', () => {
    const first = importWorkOrders(parseCsv(WOS), [], assets, ctx).records;
    expect(importWorkOrders(parseCsv(WOS), first, assets, ctx).stats).toMatchObject({ inserted: 0, updated: 0, unchanged: 3 });
    const older = 'WONUM,ASSETNUM,STATUS,CHANGEDATE\n00123456,HT101,INPRG,2026-10-20 09:00:00\n';
    const r = importWorkOrders(parseCsv(older), first, assets, ctx);
    expect(r.stats.updated).toBe(0);
    expect(r.issues[0]!.rule).toBe('stale_record');
  });

  it('matches flag work order numbers with or without a prefix', () => {
    expect(normaliseWoNumber('WO-0123456')).toBe('123456');
    expect(normaliseWoNumber(' pm-77 ')).toBe('77');
  });
});

describe('SMU import', () => {
  const assets: Asset[] = importAssets(parseCsv(ASSETS), [], ctx).records;
  const head = 'ASSETNUM,METERNAME,READINGDATE,READING\n';
  it('loads good readings, skips other meters, and refuses ones that break SMU rules', () => {
    const csv = head + [
      'HT101,SMU,2026-10-25 06:00,1000',
      'HT101,SMU,2026-10-25 18:00,1011.5',
      'HT101,ODOMETER,2026-10-25 18:00,99999',
      'HT101,SMU,2026-10-26 06:00,1005', // backwards
      'HT102,SMU,2026-10-25 06:00,500',
      'HT102,SMU,2026-10-25 18:00,520', // 20 h in 12 clock hours
      'HT999,SMU,2026-10-25 06:00,1',
      'HT102,SMU,2026-10-27 06:00,530', // future
    ].join('\n');
    const r = importSmu(parseCsv(csv), [], assets, ctx);
    expect(r.stats).toMatchObject({ read: 8, inserted: 3, skipped: 1, failed: 4 });
    expect(r.issues.map((i) => i.rule).sort()).toEqual(['future_time', 'smu_backwards', 'smu_faster_than_clock', 'unknown_unit']);
  });

  it('never overwrites a held reading with a different value', () => {
    const first = importSmu(parseCsv(head + 'HT101,SMU,2026-10-25 06:00,1000\n'), [], assets, ctx).records;
    const same = importSmu(parseCsv(head + 'HT101,SMU,2026-10-25 06:00,1000\n'), first, assets, ctx);
    expect(same.stats.unchanged).toBe(1);
    const diff = importSmu(parseCsv(head + 'HT101,SMU,2026-10-25 06:00,1002\n'), first, assets, ctx);
    expect(diff.issues[0]!.rule).toBe('conflicting_reading');
    expect(diff.records).toEqual(first);
  });
});
