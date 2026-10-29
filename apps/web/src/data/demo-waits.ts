// Demo wait tags (synthetic only, rule 9), drawn from each demo flag's stages: a waiting
// stage gets the matching tag, and now and then labour overlaps a parts wait. Open flags
// get open tags so the board shows them.

import type { Dataset, Stage, WaitTag } from '@mr/core';

const FROM_STAGE: Partial<Record<Stage, string>> = {
  waiting_parts: 'PARTS', waiting_labour: 'LABOUR', waiting_crew: 'CREW', waiting_line: 'LINE', in_transit: 'TOW',
};

export function demoWaits(ds: Dataset): WaitTag[] {
  let seed = 7654321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: WaitTag[] = [];
  let n = 0;
  const add = (f: Dataset['flags'][number], kind: string, start: string, end: string | null) => {
    if ((end && Date.parse(end) <= Date.parse(start)) || Date.parse(start) > Date.parse(ds.generatedAt)) return;
    if (out.some((w) => w.unitId === f.unitId && w.kind === kind && w.state === 'open' && end === null)) return;
    out.push({ id: `demo-wt-${++n}`, tenantId: ds.tenantId, siteId: ds.site.id, unitId: f.unitId, downFlagId: f.id, kind, start, end, state: end === null ? 'open' : 'ended', setBy: 'demo-supervisor', enteredAt: start });
  };
  for (const f of ds.flags) {
    if (f.state !== 'open' && f.state !== 'released') continue;
    for (const st of f.stages) {
      const kind = FROM_STAGE[st.stage];
      if (!kind) continue;
      const end = st.end ?? (f.state === 'open' ? null : f.end);
      add(f, kind, st.start, end);
      // Labour short as well during part of a parts wait.
      if (kind === 'PARTS' && rnd() < 0.35) {
        const a = Date.parse(st.start) + 30 * 60_000;
        const b = end ? Date.parse(end) - 30 * 60_000 : null;
        add(f, 'LABOUR', new Date(a).toISOString(), b === null ? null : new Date(b).toISOString());
      }
    }
  }
  // Each open flag shows something it is waiting on.
  const kinds = ['PARTS', 'LABOUR', 'TOOLS', 'SPECIALIST'];
  ds.flags.filter((f) => f.state === 'open').forEach((f, i) => {
    const start = new Date(Math.max(Date.parse(f.start), Date.parse(ds.generatedAt) - (90 + i * 35) * 60_000)).toISOString();
    add(f, kinds[i % kinds.length]!, start, null);
    if (i % 2 === 0) add(f, kinds[(i + 1) % kinds.length]!, new Date(Date.parse(start) + 20 * 60_000).toISOString(), null);
  });
  return out;
}
