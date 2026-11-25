// Demo flag comments (synthetic only, rule 9): a few on each open flag, tied to its wait tags where
// there are some, and one on a sample of released flags, so the threads have something to show.

import type { Dataset, FlagComment, WaitTag } from '@mr/core';

const OPEN_TEXTS = [
  'Operator reports the fault came back after the restart.',
  'Parts requested from stores; the counter says tomorrow morning.',
  'Lowboy booked for the 14:00 slot.',
  'Waiting on the OEM rep to confirm the torque figure.',
  'Found a second leak behind the guard. Added to the job.',
];
const WAIT_TEXTS = ['Chasing stores for an ETA.', 'Vendor confirmed it ships today.', 'Short two techs this shift; asked the supervisor.'];
const CLOSED_TEXTS = ['Root cause confirmed by the lab.', 'Re-torqued after 4 h; no leak.', 'Test run clean. Handed back to ops.'];

export function demoComments(ds: Dataset, waits: WaitTag[]): FlagComment[] {
  let seed = 424242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: FlagComment[] = [];
  let n = 0;
  const gen = Date.parse(ds.generatedAt);
  const add = (f: Dataset['flags'][number], text: string, at: number, waitTagId?: string, by = 'demo-supervisor') => {
    if (at > gen) return;
    out.push({ id: `demo-fc-${++n}`, tenantId: ds.tenantId, siteId: ds.site.id, unitId: f.unitId, downFlagId: f.id, ...(waitTagId ? { waitTagId } : {}), text, setBy: by, enteredAt: new Date(at).toISOString(), state: 'active' });
  };
  ds.flags.filter((f) => f.state === 'open').forEach((f, i) => {
    const start = Date.parse(f.start);
    const span = Math.max(30 * 60_000, gen - start);
    add(f, OPEN_TEXTS[i % OPEN_TEXTS.length]!, start + span * 0.3, undefined, 'demo-technician');
    add(f, OPEN_TEXTS[(i + 2) % OPEN_TEXTS.length]!, start + span * 0.7);
    const w = waits.find((x) => x.downFlagId === f.id && x.state === 'open');
    if (w) add(f, WAIT_TEXTS[i % WAIT_TEXTS.length]!, Math.max(Date.parse(w.start) + 10 * 60_000, start + span * 0.5), w.id);
  });
  ds.flags.filter((f) => f.state === 'released' && f.end && rnd() < 0.06).forEach((f, i) => {
    add(f, CLOSED_TEXTS[i % CLOSED_TEXTS.length]!, Date.parse(f.end!) + 20 * 60_000, undefined, 'demo-technician');
  });
  return out;
}
