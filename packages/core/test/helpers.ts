import { DEFAULT_FLAG_RULES, type FlagRulesConfig } from '../src/config.js';
import type { CommandResult, FlagContext } from '../src/flags.js';
import { local, twelveHourCalendar } from '../src/time.js';
import type { Actor, Asset, DownFlag, Role, ShopLine, ShopLineClosure } from '../src/types.js';

export const TZ = 'America/Vancouver';
export const cal = twelveHourCalendar(TZ);
export const L = (text: string) => local(TZ, text);

export function truck(id: string, overrides: Partial<Asset> = {}): Asset {
  return {
    id,
    tenantId: 't1',
    siteId: 's1',
    unitNumber: id.toUpperCase(),
    fleet: 'Haul trucks',
    model: '793F',
    assetClass: 'mobile',
    ...overrides,
  };
}

export function actor(role: Role, scope: string[] = ['*']): Actor {
  return { userId: `${role}-1`, role, scope };
}

export const LINES: ShopLine[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `L${n}`,
  siteId: 's1',
  shop: 'Truck shop',
  number: n,
  lineType: 'general',
  capacity: 1,
  fits: [],
}));
LINES.push({ id: 'WASH', siteId: 's1', shop: 'Truck shop', name: 'Wash pad', lineType: 'wash', capacity: 1, fits: ['994K'] });

let seq = 0;
export const newId = () => `f${++seq}`;

/** A tiny in-memory store that applies command results, like the app does. */
export class Store {
  flags: DownFlag[] = [];
  closures: ShopLineClosure[] = [];
  audit: unknown[] = [];
  constructor(public asset: Asset, public rules: FlagRulesConfig = DEFAULT_FLAG_RULES, public openPeriodStart?: string) {}

  ctx(now: string, who: Actor = actor('supervisor')): FlagContext {
    return {
      now,
      actor: who,
      rules: this.rules,
      calendar: cal,
      asset: this.asset,
      unitFlags: this.flags.filter((f) => f.unitId === this.asset.id),
      siteOpenFlags: this.flags.filter((f) => f.state === 'open'),
      shopLines: LINES,
      lineClosures: this.closures,
      openPeriodStart: this.openPeriodStart,
      newId,
    };
  }

  apply(r: CommandResult): DownFlag[] {
    if (!r.ok) throw new Error(r.errors.join(' | '));
    for (const f of r.flags) {
      const i = this.flags.findIndex((x) => x.id === f.id);
      if (i >= 0) this.flags[i] = f;
      else this.flags.push(f);
    }
    this.audit.push(...r.audit);
    return r.flags;
  }

  get(id: string): DownFlag {
    const f = this.flags.find((x) => x.id === id);
    if (!f) throw new Error(`no flag ${id}`);
    return f;
  }

  get open(): DownFlag {
    const f = this.flags.find((x) => x.state === 'open');
    if (!f) throw new Error('no open flag');
    return f;
  }
}

/** Build a released flag directly, for KPI fixtures. */
export function fixtureFlag(p: Partial<DownFlag> & Pick<DownFlag, 'id' | 'unitId' | 'type' | 'start' | 'end'>): DownFlag {
  return {
    tenantId: 't1',
    siteId: 's1',
    state: 'released',
    reasonCode: p.type === 'scheduled' ? 'PM' : 'Breakdown',
    stages: [{ stage: 'in_repair', start: p.start, end: p.end, setBy: 'x', enteredAt: p.start }],
    locations: [{ kind: 'shop_line', shopLineId: 'L1', start: p.start, end: p.end, setBy: 'x', enteredAt: p.start }],
    etas: [],
    workOrders: [],
    source: 'app',
    setBy: 'x',
    enteredAt: p.start,
    ...p,
  };
}

export const round = (x: number | null, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
export const minutes = (h: number) => Math.round(h * 60);
