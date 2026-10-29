// Plant structure editor (phase 3b part 2, docs/fixed-plant.md "Structure
// editor"). Plan 11.2 "Edit shops, shop lines, field locations, plant
// structure": admin yes, reliability engineer propose. Nodes are retired,
// never deleted. Pure functions; the database guard is the backstop.

import type { ConsoleContext, ConsoleResult } from './console.js';
import { can } from './permissions.js';
import { flSegments, plantTree, NODE_KIND_LABELS, type PlantNode, type PlantNodeKind } from './plant.js';
import type { Asset, AuditEntry } from './types.js';

export interface NodeInput {
  kind: PlantNodeKind;
  name: string;
  parentId?: string;
  order: number;
  needed?: number;
  functionalLocation?: string;
  plannedRateTph?: number;
}

/** Where each kind can sit. null: a root. */
export const PARENT_KINDS: Record<PlantNodeKind, Array<PlantNodeKind | null>> = {
  plant: [null],
  area: ['plant'],
  circuit: ['plant', 'area'],
  group: ['circuit', 'group'],
};

export interface PlacementChange {
  asset: Asset;
  from?: string;
  to?: string;
}

/** Equipment that would change node (or become unplaced) going from one structure to another. */
export function placementChanges(before: PlantNode[], after: PlantNode[], equipment: Asset[]): PlacementChange[] {
  const a = plantTree(before, equipment).parentOf;
  const b = plantTree(after, equipment).parentOf;
  const out: PlacementChange[] = [];
  for (const e of equipment) {
    if (e.assetClass !== 'fixed_plant') continue;
    const from = a.get(e.id);
    const to = b.get(e.id);
    if (from !== to) out.push({ asset: e, from, to });
  }
  return out;
}

const art = (w: string) => `${/^[aeiou]/i.test(w) ? 'An' : 'A'} ${w.toLowerCase()}`;
const active = (nodes: PlantNode[]) => nodes.filter((n) => !n.retiredAt);
const sameFl = (x?: string, y?: string) => {
  const a = flSegments(x);
  const b = flSegments(y);
  return a.length > 0 && a.length === b.length && a.every((s, i) => s === b[i]);
};

function under(nodes: PlantNode[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (p: string) => {
    for (const n of nodes) if (n.parentId === p && !out.has(n.id)) { out.add(n.id); walk(n.id); }
  };
  walk(id);
  return out;
}

/** Problems and warnings for a node as it would be saved. */
export function nodeProblems(nodes: PlantNode[], equipment: Asset[], id: string | null, input: NodeInput): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = input.name.trim();
  if (!name || name.length > 100) errors.push('Name it (1 to 100 characters).');
  if (!(input.kind in PARENT_KINDS)) errors.push('Pick the kind.');
  const live = active(nodes);
  const parent = input.parentId ? live.find((n) => n.id === input.parentId) : undefined;
  if (input.parentId && !parent) errors.push('The parent is not an active node.');
  const allowed = PARENT_KINDS[input.kind] ?? [];
  const pk = parent ? parent.kind : null;
  if (input.kind in PARENT_KINDS && !allowed.includes(pk)) {
    errors.push(input.kind === 'plant'
      ? 'A plant has no parent.'
      : `${art(NODE_KIND_LABELS[input.kind])} sits under ${allowed.map((k) => (k ? art(NODE_KIND_LABELS[k]).toLowerCase() : 'nothing')).join(' or ')}.`);
  }
  if (id && input.parentId) {
    if (input.parentId === id || under(nodes, id).has(input.parentId)) errors.push('A node cannot sit under itself or under a node below it.');
  }
  if (id) {
    for (const c of live.filter((n) => n.parentId === id)) {
      if (!PARENT_KINDS[c.kind].includes(input.kind)) errors.push(`${c.name} (${NODE_KIND_LABELS[c.kind].toLowerCase()}) cannot sit under ${art(NODE_KIND_LABELS[input.kind] ?? 'node').toLowerCase()}.`);
    }
  }
  if (input.functionalLocation?.trim()) {
    if (input.functionalLocation.trim().length > 100) errors.push('The functional location is up to 100 characters.');
    const clash = live.find((n) => n.id !== id && sameFl(n.functionalLocation, input.functionalLocation));
    if (clash) errors.push(`${clash.name} already uses that functional location.`);
  }
  if (input.needed !== undefined && (!Number.isInteger(input.needed) || input.needed < 1 || input.needed > 100)) errors.push('Needed is a whole number from 1 to 100.');
  if (input.plannedRateTph !== undefined && !(input.plannedRateTph > 0 && input.plannedRateTph <= 1_000_000)) errors.push('The planned rate is above 0 t/h.');
  if (!Number.isInteger(input.order) || input.order < 0 || input.order > 10_000) errors.push('The place in process order is a whole number from 0.');
  if (!errors.length && input.needed !== undefined) {
    const draft = draftNode(nodes, id, input, { tenantId: '', siteId: '' });
    const t = plantTree(id ? nodes.map((n) => (n.id === id ? draft : n)) : [...nodes, draft], equipment).byId.get(draft.id);
    const installed = t ? t.nodes.length + t.equipment.length : 0;
    if (input.needed > installed) warnings.push(`Needed (${input.needed}) is more than what is under it (${installed}), so it is down whenever anything under it is down.`);
  }
  return { errors, warnings };
}

function draftNode(nodes: PlantNode[], id: string | null, input: NodeInput, site: { tenantId: string; siteId: string }, newId?: () => string): PlantNode {
  const prev = id ? nodes.find((n) => n.id === id) : undefined;
  const fl = input.functionalLocation?.trim();
  return {
    id: prev?.id ?? (newId ? newId() : '__new__'),
    tenantId: prev?.tenantId ?? site.tenantId,
    siteId: prev?.siteId ?? site.siteId,
    kind: input.kind,
    name: input.name.trim(),
    order: input.order,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.needed !== undefined ? { needed: input.needed } : {}),
    ...(fl ? { functionalLocation: fl } : {}),
    ...(input.plannedRateTph !== undefined ? { plannedRateTph: input.plannedRateTph } : {}),
  };
}

const refuse = <T>(...errors: string[]): ConsoleResult<T> => ({ ok: false, errors });
const log = (ctx: ConsoleContext, action: string, id: string, before: unknown, after: unknown, reason: string): AuditEntry =>
  ({ at: ctx.now, userId: ctx.actor.userId, action, entity: 'plant_node', entityId: id, before, after, reason });

function placementWarnings(before: PlantNode[], after: PlantNode[], equipment: Asset[]): string[] {
  const name = (id?: string) => (id ? after.find((n) => n.id === id)?.name ?? before.find((n) => n.id === id)?.name ?? id : 'unplaced');
  return placementChanges(before, after, equipment).map((c) => `${c.asset.unitNumber} moves from ${name(c.from)} to ${name(c.to)}.`);
}

/** A new node, or a change to one. Returns the saved node; warnings list equipment that changes node. */
export function saveNode(
  ctx: ConsoleContext, nodes: PlantNode[], equipment: Asset[], site: { tenantId: string; siteId: string }, id: string | null, input: NodeInput, reason: string,
): ConsoleResult<PlantNode> {
  if (!can(ctx.actor, 'edit_shop_structure')) return refuse('The admin changes the plant structure (plan 11.2).');
  const prev = id ? nodes.find((n) => n.id === id) : undefined;
  if (id && !prev) return refuse('Node not found.');
  if (prev?.retiredAt) return refuse('That node is retired. Add a new one instead.');
  const { errors, warnings } = nodeProblems(nodes, equipment, id, input);
  if (!reason.trim()) errors.push('Give a reason.');
  if (errors.length) return { ok: false, errors };
  const node = draftNode(nodes, id, input, site, ctx.newId);
  const after = prev ? nodes.map((n) => (n.id === id ? node : n)) : [...nodes, node];
  return {
    ok: true, records: [node], audit: [log(ctx, prev ? 'change_plant_node' : 'add_plant_node', node.id, prev ?? null, node, reason.trim())],
    warnings: [...warnings, ...placementWarnings(nodes, after, equipment)],
  };
}

export function retireNode(ctx: ConsoleContext, nodes: PlantNode[], equipment: Asset[], id: string, reason: string): ConsoleResult<PlantNode> {
  if (!can(ctx.actor, 'edit_shop_structure')) return refuse('The admin changes the plant structure (plan 11.2).');
  const prev = nodes.find((n) => n.id === id);
  if (!prev || prev.retiredAt) return refuse('That node is not active.');
  const kids = active(nodes).filter((n) => n.parentId === id);
  if (kids.length) return refuse(`Retire or move what is under it first: ${kids.map((k) => k.name).join(', ')}.`);
  if (!reason.trim()) return refuse('Give a reason.');
  const node: PlantNode = { ...prev, retiredAt: ctx.now, retireReason: reason.trim() };
  const after = nodes.map((n) => (n.id === id ? node : n));
  return { ok: true, records: [node], audit: [log(ctx, 'retire_plant_node', id, prev, node, reason.trim())], warnings: placementWarnings(nodes, after, equipment) };
}
