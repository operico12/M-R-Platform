// Managing shop lines and line closures (docs/shop-lines.md). Pure commands: they check the rules,
// return the new records and audit entries, and never delete anything.

import type { ConsoleContext, ConsoleResult } from './console.js';
import { currentLocation, lineName } from './flags.js';
import { can } from './permissions.js';
import type { AuditEntry, DownFlag, ShopLine, ShopLineClosure } from './types.js';

export const LINE_TYPES: ShopLine['lineType'][] = ['general', 'pm', 'tyre', 'weld', 'wash', 'lube'];
export const LINE_TYPE_LABELS: Record<ShopLine['lineType'], string> = { general: 'General', pm: 'PM', tyre: 'Tyre', weld: 'Weld', wash: 'Wash', lube: 'Lube' };
export const LINE_LIMITS = { maxAdd: 20, maxCapacity: 10, nameMax: 40, reasonMax: 300 } as const;

const ms = (iso: string) => Date.parse(iso);
const refuse = <T>(...errors: string[]): ConsoleResult<T> => ({ ok: false, errors });
const entry = (ctx: ConsoleContext, entity: AuditEntry['entity'], action: string, id: string, before: unknown, after: unknown, reason?: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity, entityId: id, before, after, ...(reason ? { reason } : {}) });

/** Units on a line now (open flags whose current location is that line). */
export const unitsOnLine = (lineId: string, flags: DownFlag[]) =>
  flags.filter((f) => f.state === 'open' && currentLocation(f)?.kind === 'shop_line' && currentLocation(f)?.shopLineId === lineId);

/** The closure in force now, if any. */
export const closureNow = (lineId: string, closures: ShopLineClosure[], now: string) =>
  closures.find((c) => c.lineId === lineId && ms(c.start) <= ms(now) && (!c.end || ms(now) < ms(c.end)));

/** Open lines only (not retired), in display order. */
export const activeLines = (lines: ShopLine[]) => lines.filter((l) => !l.retiredAt);

export interface LineInput { number?: number; name?: string; lineType: ShopLine['lineType']; capacity: number; fits: string[] }

function lineProblems(input: LineInput, others: ShopLine[]): string[] {
  const e: string[] = [];
  const name = input.name?.trim();
  if (input.number === undefined && !name) e.push('Give the line a number, a name, or both.');
  if (input.number !== undefined && (!Number.isInteger(input.number) || input.number < 1 || input.number > 999)) e.push('The line number is a whole number from 1 to 999.');
  if (input.number !== undefined && others.some((l) => l.number === input.number)) e.push(`Another open line is already number ${input.number}.`);
  if (name && name.length > LINE_LIMITS.nameMax) e.push(`The name is at most ${LINE_LIMITS.nameMax} characters.`);
  if (!LINE_TYPES.includes(input.lineType)) e.push('Choose a line type.');
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > LINE_LIMITS.maxCapacity) e.push(`Capacity is 1 to ${LINE_LIMITS.maxCapacity} units.`);
  return e;
}

const clean = (l: ShopLine, input: LineInput): ShopLine => {
  const { number: _n, name: _m, ...rest } = l;
  const name = input.name?.trim();
  return { ...rest, ...(input.number !== undefined ? { number: input.number } : {}), ...(name ? { name } : {}), lineType: input.lineType, capacity: input.capacity,
    fits: [...new Set(input.fits.map((x) => x.trim()).filter(Boolean))].sort() };
};

/** Add `count` lines of a type with the next free numbers. Admin only. */
export function addLines(ctx: ConsoleContext, lines: ShopLine[], count: number, lineType: ShopLine['lineType'], siteId: string, shop: string): ConsoleResult<ShopLine> {
  if (!can(ctx.actor, 'edit_shop_structure')) return refuse("Only the site's Admin adds or changes lines.");
  if (!Number.isInteger(count) || count < 1 || count > LINE_LIMITS.maxAdd) return refuse(`Add 1 to ${LINE_LIMITS.maxAdd} lines at a time.`);
  if (!LINE_TYPES.includes(lineType)) return refuse('Choose a line type.');
  const used = new Set(activeLines(lines).map((l) => l.number).filter((n): n is number => n !== undefined));
  const added: ShopLine[] = [];
  let n = 1;
  while (added.length < count) {
    if (!used.has(n)) { added.push({ id: ctx.newId(), siteId, shop, number: n, lineType, capacity: 1, fits: [] }); used.add(n); }
    n++;
  }
  return { ok: true, records: [...lines, ...added], audit: added.map((l) => entry(ctx, 'shop_line', 'add_line', l.id, null, l)), warnings: [] };
}

export function editLine(ctx: ConsoleContext, lines: ShopLine[], id: string, input: LineInput, reason?: string): ConsoleResult<ShopLine> {
  if (!can(ctx.actor, 'edit_shop_structure')) return refuse("Only the site's Admin adds or changes lines.");
  const l = lines.find((x) => x.id === id && !x.retiredAt);
  if (!l) return refuse('That line is not open.');
  const e = lineProblems(input, activeLines(lines).filter((x) => x.id !== id));
  if (e.length) return refuse(...e);
  const after = clean(l, input);
  return { ok: true, records: lines.map((x) => (x.id === id ? after : x)), audit: [entry(ctx, 'shop_line', 'edit_line', id, l, after, reason?.trim() || undefined)], warnings: [] };
}

export function retireLine(ctx: ConsoleContext, lines: ShopLine[], flags: DownFlag[], id: string, reason: string): ConsoleResult<ShopLine> {
  if (!can(ctx.actor, 'edit_shop_structure')) return refuse("Only the site's Admin adds or changes lines.");
  const l = lines.find((x) => x.id === id && !x.retiredAt);
  if (!l) return refuse('That line is not open.');
  const e: string[] = [];
  if (unitsOnLine(id, flags).length) e.push(`${lineName(l)} has a unit in it. Move the unit first.`);
  if (!reason.trim()) e.push('Give a reason for retiring the line.');
  if (reason.trim().length > LINE_LIMITS.reasonMax) e.push(`The reason is at most ${LINE_LIMITS.reasonMax} characters.`);
  if (e.length) return refuse(...e);
  const after: ShopLine = { ...l, retiredAt: ctx.now, retiredReason: reason.trim() };
  return { ok: true, records: lines.map((x) => (x.id === id ? after : x)), audit: [entry(ctx, 'shop_line', 'retire_line', id, l, after, reason.trim())], warnings: [] };
}

/** Close a line from now with a reason (supervisor in their area, superintendent, Admin). */
export function closeLine(ctx: ConsoleContext, line: ShopLine, closures: ShopLineClosure[], flags: DownFlag[], reason: string): ConsoleResult<ShopLineClosure> {
  if (!can(ctx.actor, 'open_close_line', line.shop)) return refuse('Only a supervisor of this shop, the superintendent or the Admin opens and closes lines.');
  const e: string[] = [];
  if (closureNow(line.id, closures, ctx.now)) e.push(`${lineName(line)} is already closed.`);
  if (unitsOnLine(line.id, flags).length) e.push(`${lineName(line)} has a unit in it. Move the unit before closing the line.`);
  if (!reason.trim()) e.push('Give a reason for closing the line.');
  if (reason.trim().length > LINE_LIMITS.reasonMax) e.push(`The reason is at most ${LINE_LIMITS.reasonMax} characters.`);
  if (e.length) return refuse(...e);
  const c: ShopLineClosure = { id: ctx.newId(), lineId: line.id, start: ctx.now, end: null, reason: reason.trim() };
  return { ok: true, records: [...closures, c], audit: [entry(ctx, 'shop_line_closure', 'close_line', c.id!, null, c, c.reason)], warnings: [] };
}

/** Open a closed line again: the closure in force ends now. */
export function openLine(ctx: ConsoleContext, line: ShopLine, closures: ShopLineClosure[]): ConsoleResult<ShopLineClosure> {
  if (!can(ctx.actor, 'open_close_line', line.shop)) return refuse('Only a supervisor of this shop, the superintendent or the Admin opens and closes lines.');
  const c = closureNow(line.id, closures, ctx.now);
  if (!c) return refuse(`${lineName(line)} is not closed.`);
  if (!c.id) return refuse('This closure cannot be ended here.');
  const after: ShopLineClosure = { ...c, end: ctx.now };
  return { ok: true, records: closures.map((x) => (x === c ? after : x)), audit: [entry(ctx, 'shop_line_closure', 'open_line', c.id, c, after)], warnings: [] };
}
