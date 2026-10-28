// Two inspection forms and a few weeks of inspections for the demo fleet, so
// the pages are not empty. Fictional and synthetic (CLAUDE.md rule 9). Live
// sites start with no forms.

import { scoreInspection, smuNow, type Answer, type Dataset, type FormItem, type Inspection, type InspectionForm } from '@mr/core';

const item = (id: string, section: string, text: string, kind: FormItem['kind'], over: Partial<FormItem> = {}): FormItem =>
  ({ id, section, text, kind, critical: false, weight: 1, photoOnFail: false, ...over });

export function demoForms(ds: Dataset): InspectionForm[] {
  const at = new Date(Date.parse(ds.generatedAt) - 60 * 864e5).toISOString();
  const base = { createdBy: 'demo-reliability_engineer', createdAt: at, reason: 'First version' };
  return [
    {
      ...base, id: 'demo-form-prestart', version: 1, name: 'Haul truck pre-start', assetClass: 'mobile', models: ['793F', '797F'], every: { n: 1, unit: 'days' },
      items: [
        item('brakes', 'Safety', 'Service and park brakes hold', 'pass_fail', { critical: true, weight: 3 }),
        item('steering', 'Safety', 'Steering and emergency steering', 'pass_fail', { critical: true, weight: 3 }),
        item('alarms', 'Safety', 'Horn, reverse alarm and lights', 'pass_fail', { critical: true, weight: 2 }),
        item('tyres', 'Walk-around', 'Tyres and rims', 'rating'),
        item('leaks', 'Walk-around', 'No oil, fuel or coolant leaks', 'pass_fail', { photoOnFail: true }),
        item('oil', 'Fluids', 'Engine oil level', 'reading', { min: 40, max: 100, unit: '%' }),
        item('coolant', 'Fluids', 'Coolant level', 'reading', { min: 50, max: 100, unit: '%' }),
        item('cab', 'Cab', 'Cab, glass and mirrors', 'rating'),
        item('notes', 'Cab', 'Anything else', 'note'),
      ],
    },
    {
      ...base, id: 'demo-form-250h', version: 1, name: '250 h service check', assetClass: 'mobile', models: [], every: { n: 250, unit: 'smu_hours' },
      items: [
        item('grease', 'Lube', 'All grease points taking grease', 'pass_fail', { weight: 2 }),
        item('filters', 'Filters', 'Air filter restriction indicator', 'rating'),
        item('belt', 'Engine', 'Fan belt deflection', 'reading', { min: 8, max: 15, unit: 'mm' }),
        item('frame', 'Structure', 'Frame and welds, no cracks', 'pass_fail', { critical: true, weight: 3, photoOnFail: true }),
        item('notes', 'Structure', 'Notes', 'note'),
      ],
    },
  ];
}

/** Pre-starts on most trucks most days, and 250 h checks; a few with defects. */
export function demoInspections(ds: Dataset, forms: InspectionForm[]): Inspection[] {
  const now = Date.parse(ds.generatedAt);
  const [pre, svc] = forms as [InspectionForm, InspectionForm];
  const out: Inspection[] = [];
  let n = 0;
  const people = ['demo-technician', 'demo-reliability_engineer'];
  const add = (form: InspectionForm, unitId: string, atMs: number, answers: Record<string, Answer>, signed: boolean) => {
    const at = new Date(atMs).toISOString();
    const { score, result, failed } = scoreInspection(form, answers);
    const id = `demo-insp-${++n}`;
    out.push({
      id, formId: form.id, formVersion: form.version, unitId, smu: smuNow(ds.smu, unitId, at), status: signed ? 'signed_off' : 'submitted', answers,
      defects: failed.map((f, i) => ({ id: `${id}-d${i}`, itemId: f.id, text: `${f.text}${answers[f.id]?.note ? `: ${answers[f.id]!.note}` : ''}`, severity: f.critical ? 'high' : 'medium', status: 'open' })),
      startedBy: people[n % 2]!, startedAt: new Date(atMs - 15 * 60_000).toISOString(), submittedAt: at, score, result,
      ...(signed ? { signedOffBy: 'demo-superintendent', signedOffAt: new Date(atMs + 3 * 3600_000).toISOString() } : {}),
    });
  };
  const good = (): Record<string, Answer> => ({
    brakes: { value: 'pass' }, steering: { value: 'pass' }, alarms: { value: 'pass' }, tyres: { value: 4 }, leaks: { value: 'pass' },
    oil: { value: 80 }, coolant: { value: 90 }, cab: { value: 4 }, notes: { value: '' },
  });
  const trucks = ds.assets.filter((a) => pre.models.includes(a.model));
  trucks.forEach((t, ti) => {
    // Every few trucks skip the last days, so the due list has overdue and due-soon rows.
    const lastDay = ti % 7 === 3 ? 3 : ti % 9 === 5 ? 2 : 0;
    for (let d = 6; d >= lastDay; d--) {
      const at = now - d * 864e5 - 2 * 3600_000;
      const a = good();
      if ((ti + d) % 11 === 0) a.tyres = { value: 2, note: 'Cut in left rear sidewall' };
      if ((ti + d) % 17 === 0) a.oil = { value: 35, note: 'Topped up 10 L' };
      if (ti === 2 && d === 1) a.brakes = { value: 'fail', note: 'Park brake will not hold on the ramp' };
      add(pre, t.id, at, a, d >= 2);
    }
  });
  ds.assets.filter((a) => a.assetClass === 'mobile').forEach((u, i) => {
    const at = now - (1 + (i % 13)) * 864e5;
    add(svc, u.id, at, { grease: { value: 'pass' }, filters: { value: i % 6 === 1 ? 2 : 4, note: i % 6 === 1 ? 'Indicator in the red' : undefined }, belt: { value: 11 }, frame: { value: 'pass' }, notes: { value: '' } }, true);
  });
  return out;
}
