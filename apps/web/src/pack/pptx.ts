// Weekly pack as PowerPoint. Charts are native PowerPoint charts, so they can
// be restyled or have their data edited after export. Loaded only when used.

import { STAGE_LABELS, type WeeklyPack } from '@mr/core';
import { FORMULAS, fmtH, fmtP, packFileName, siteStamp } from './common';

const NAVY = '1F3A5F';
/** pptxgenjs table rows take cell objects, not bare strings. */
const row = (xs: string[]) => xs.map((text) => ({ text }));
const RED = 'C62828';
const GREY = '4A525D';
const LIGHT = 'EEF0F3';
const GREEN = '2E7D32';
const AMBER = 'B26A00';

export async function downloadPptx(pack: WeeklyPack): Promise<void> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = `${pack.title}, week of ${pack.week.label}`;
  pptx.company = pack.siteName;

  const W = 13.33;
  const head = (title: string, sub?: string) => {
    const s = pptx.addSlide();
    s.background = { color: 'FFFFFF' };
    s.addShape('rect', { x: 0, y: 0, w: W, h: 0.9, fill: { color: NAVY } });
    s.addText(title, { x: 0.4, y: 0.12, w: W - 0.8, h: 0.66, fontSize: 24, bold: true, color: 'FFFFFF', fontFace: 'Calibri' });
    s.addText(`${pack.fleetName} · week of ${pack.week.label}${pack.partial ? ' (in progress)' : ''} · ${pack.siteName}`, { x: 0.4, y: 7.05, w: W - 0.8, h: 0.3, fontSize: 10, color: GREY });
    if (sub) s.addText(sub, { x: 0.4, y: 0.98, w: W - 0.8, h: 0.4, fontSize: 13, color: GREY, italic: true });
    return s;
  };

  // 1. Title
  const t = pptx.addSlide();
  t.background = { color: NAVY };
  t.addText(pack.title, { x: 0.6, y: 2.2, w: W - 1.2, h: 1, fontSize: 40, bold: true, color: 'FFFFFF' });
  t.addText(`Week of ${pack.week.label}${pack.partial ? ' (week in progress)' : ''}`, { x: 0.6, y: 3.2, w: W - 1.2, h: 0.6, fontSize: 24, color: 'FFFFFF' });
  t.addText(`${pack.siteName} · generated ${siteStamp(pack.generatedAt, pack.timeZone)} site time · source: down flags and SMU readings`, { x: 0.6, y: 6.4, w: W - 1.2, h: 0.5, fontSize: 12, color: 'C9D6E8' });

  // 2. Headline
  const k = pack.kpis;
  const p = pack.prior;
  const s2 = head('Headline', pack.notes.join(' ') || undefined);
  const cards: Array<[string, string, string, string?]> = [
    ['Physical availability', fmtP(k.pa), `Target ${fmtP(pack.targets.pa, 0)} · prior week ${fmtP(p.pa)}`, rag(k.pa, pack.targets.pa)],
    ['Utilisation', fmtP(k.utilisation), `Target ${fmtP(pack.targets.utilisation, 0)} · prior week ${fmtP(p.utilisation)}`, rag(k.utilisation, pack.targets.utilisation)],
    ['MTBF (operating h)', k.mtbf === null ? '—' : k.mtbf.toFixed(0), `${k.failures} failures · prior week ${p.mtbf === null ? '—' : p.mtbf.toFixed(0)}`],
    ['MTTR', fmtH(k.mttr), `${k.repairs} repairs · prior week ${fmtH(p.mttr)}`],
    ['Mean downtime', fmtH(k.meanDowntime), `per failure · prior week ${fmtH(p.meanDowntime)}`],
  ];
  const cw = (W - 0.8 - 4 * 0.25) / 5;
  cards.forEach(([label, v, sub, colour], i) => {
    const x = 0.4 + i * (cw + 0.25);
    s2.addShape('rect', { x, y: 1.6, w: cw, h: 2.1, fill: { color: LIGHT }, line: { color: colour ?? LIGHT, width: colour ? 3 : 0 } });
    s2.addText(label, { x: x + 0.15, y: 1.7, w: cw - 0.3, h: 0.4, fontSize: 13, color: GREY });
    s2.addText(v, { x: x + 0.15, y: 2.15, w: cw - 0.3, h: 0.8, fontSize: 34, bold: true, color: colour ?? NAVY });
    s2.addText(sub, { x: x + 0.15, y: 3.0, w: cw - 0.3, h: 0.6, fontSize: 11, color: GREY, valign: 'top' });
  });
  s2.addTable(
    [
      [{ text: 'Hours this week', options: { bold: true } }, { text: 'Calendar', options: { bold: true } }, { text: 'Scheduled down', options: { bold: true } }, { text: 'Unscheduled down', options: { bold: true } }, { text: 'Operating', options: { bold: true } }, { text: 'Standby', options: { bold: true } }],
      row(['All units', k.calendarHours.toFixed(0), k.scheduledDownHours.toFixed(0), k.unscheduledDownHours.toFixed(0), k.operatingHours.toFixed(0), k.standbyHours.toFixed(0)]),
    ],
    { x: 0.4, y: 4.2, w: W - 0.8, fontSize: 13, color: '1B1F24', border: { type: 'solid', color: 'D9DDE3', pt: 1 } },
  );
  s2.addText('PA and utilisation colour: green on target, amber within 3 points, red below.', { x: 0.4, y: 5.3, w: W - 0.8, h: 0.4, fontSize: 11, color: GREY });

  // 3. Trend
  const s3 = head('PA and utilisation, last 12 weeks');
  const labels = pack.trend.map((x) => x.label);
  const pct = (v: number | null) => (v === null ? 0 : Math.round(v * 1000) / 10);
  s3.addChart(
    pptx.ChartType.line,
    [
      { name: 'PA %', labels, values: pack.trend.map((x) => pct(x.pa)) },
      { name: 'Utilisation %', labels, values: pack.trend.map((x) => pct(x.utilisation)) },
      { name: 'PA target', labels, values: pack.trend.map(() => pack.targets.pa * 100) },
    ],
    {
      x: 0.4, y: 1.2, w: W - 0.8, h: 5.6, chartColors: [NAVY, '607D8B', RED], lineSize: 2, lineDataSymbol: 'none',
      valAxisMinVal: 60, valAxisMaxVal: 100, showLegend: true, legendPos: 'b', catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
    },
  );

  // 4. Pareto
  const s4 = head('Unscheduled downtime by system', 'Hours down this week, largest first. The line is the running share of the total.');
  const top = pack.pareto.slice(0, 10);
  if (top.length) {
    s4.addChart(
      pptx.ChartType.bar,
      [{ name: 'Hours down', labels: top.map((r) => r.system), values: top.map((r) => Math.round(r.hours * 10) / 10) }],
      { x: 0.4, y: 1.5, w: 8.2, h: 5.3, barDir: 'col', chartColors: [RED], showValue: true, dataLabelFontSize: 10, catAxisLabelFontSize: 11, valAxisLabelFontSize: 11, showLegend: false },
    );
    s4.addTable(
      [
        ['System', 'Hours', 'Events', 'Running %'].map((h) => ({ text: h, options: { bold: true } })),
        ...top.map((r) => row([r.system, r.hours.toFixed(1), String(r.events), fmtP(r.cumulative, 0)])),
      ],
      { x: 8.9, y: 1.5, w: 4.0, fontSize: 11, border: { type: 'solid', color: 'D9DDE3', pt: 1 } },
    );
  } else s4.addText('No unscheduled downtime this week.', { x: 0.4, y: 2, w: 8, h: 0.5, fontSize: 16 });

  // 5. Downline, repair and the shop
  const s5 = head('Downline, repair and the shop', 'Downline is waiting for crew, in transit or waiting for a line. Only "In repair" is wrench time.');
  const ts = pack.timeSplit;
  s5.addChart(
    pptx.ChartType.bar,
    [{ name: 'Hours', // Horizontal bars draw bottom-up, so list them in reverse.
      labels: ['Ready for release', 'Waiting labour or other', 'Waiting parts', 'In repair', 'Downline'], values: [ts.ready, ts.waitingOther, ts.waitingParts, ts.repair, ts.downline].map((v) => Math.round(v)) }],
    { x: 0.4, y: 1.5, w: 6.2, h: 5.3, barDir: 'bar', chartColors: [NAVY], showValue: true, dataLabelFontSize: 10, catAxisLabelFontSize: 11, valAxisLabelFontSize: 11, showLegend: false },
  );
  const sh = pack.shop;
  s5.addTable(
    [
      [{ text: 'Shop measure', options: { bold: true } }, { text: 'This week', options: { bold: true } }],
      row(['Shop release vs plan', `${fmtP(sh.releaseVsPlan.rate, 0)} (${sh.releaseVsPlan.onTime} of ${sh.releaseVsPlan.due} on time)`]),
      row(['Fixed in the field', `${fmtP(sh.fieldRepair.share, 0)} (${sh.fieldRepair.field} of ${sh.fieldRepair.events})`]),
      ...sh.lines.map((l) => row([`${l.name} occupancy`, fmtP(l.occupancy, 0)])),
    ],
    { x: 6.9, y: 1.5, w: 6.0, fontSize: 11, border: { type: 'solid', color: 'D9DDE3', pt: 1 } },
  );

  // 6. Bad actors
  const s6 = head('Top 10 bad actors', 'Units with the most unscheduled downtime this week.');
  s6.addTable(
    [
      ['Unit', 'Model', 'Unscheduled down', 'Failures', 'PA', 'Main system'].map((h) => ({ text: h, options: { bold: true, fill: { color: LIGHT } } })),
      ...pack.badActors.map((b) => row([b.unit, b.model, `${b.unscheduledDownHours.toFixed(1)} h`, String(b.failures), fmtP(b.pa), b.topSystem])),
    ],
    { x: 0.4, y: 1.5, w: W - 0.8, fontSize: 13, border: { type: 'solid', color: 'D9DDE3', pt: 1 } },
  );

  // 7. Down now
  const s7 = head('Down at time of report', `${pack.downNow.length} units down at ${siteStamp(pack.generatedAt, pack.timeZone)} site time.`);
  s7.addTable(
    [
      ['Unit', 'Down since', 'Hours', 'Reason', 'Stage', 'Downline'].map((h) => ({ text: h, options: { bold: true, fill: { color: LIGHT } } })),
      ...pack.downNow.slice(0, 14).map((d) => row([d.unit, siteStamp(d.since, pack.timeZone), d.hours.toFixed(1), d.reason, d.stage ? STAGE_LABELS[d.stage] : '—', d.downline ? 'Yes' : ''])),
    ],
    { x: 0.4, y: 1.5, w: W - 0.8, fontSize: 12, border: { type: 'solid', color: 'D9DDE3', pt: 1 } },
  );

  // 8. Definitions
  const s8 = head('How the numbers are worked out');
  s8.addText(
    FORMULAS.map(([k2, v]) => ({ text: `${k2}: ${v}`, options: { bullet: true, breakLine: true } })),
    { x: 0.4, y: 1.3, w: W - 0.8, h: 5.4, fontSize: 15, color: '1B1F24', valign: 'top', paraSpaceAfter: 8 },
  );

  await pptx.writeFile({ fileName: `${packFileName(pack)}.pptx` });
}

function rag(v: number | null, target: number): string | undefined {
  if (v === null) return undefined;
  if (v >= target) return GREEN;
  if (v >= target - 0.03) return AMBER;
  return RED;
}
