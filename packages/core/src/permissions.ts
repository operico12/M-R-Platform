// Permission matrix (build plan 11.2). Deny by default: an action or role not
// listed here is not allowed. Values mirror the plan's matrix.

import type { Actor, Role } from './types.js';

export type Permission = 'yes' | 'area' | 'propose' | 'approve' | 'request' | 'no';

export type Action =
  | 'view_status'
  | 'view_cost'
  | 'add_notes'
  | 'update_stage'
  | 'set_clear_flag'
  | 'move_location'
  | 'reclassify_flag'
  | 'void_flag'
  | 'change_locked_period'
  | 'run_analyses'
  | 'create_actions'
  | 'run_rcas'
  | 'run_projects'
  | 'approve_projects'
  | 'publish_weekly_pack'
  | 'export_reports'
  | 'edit_codes'
  | 'open_close_line'
  | 'edit_shop_structure'
  | 'change_flag_rules'
  | 'change_targets'
  | 'manage_imports'
  | 'manage_users';

const MATRIX: Record<Action, Partial<Record<Role, Permission>>> = {
  view_status: { viewer: 'yes', technician: 'yes', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  view_cost: { reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  add_notes: { technician: 'yes', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  update_stage: { technician: 'area', supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
  set_clear_flag: { technician: 'propose', supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
  // A7 D7: technicians move stage only; supervisors move locations. Overridable via rules.technicianCanMoveLocation.
  move_location: { supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
  reclassify_flag: { supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
  void_flag: { supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
  change_locked_period: { supervisor: 'request', reliability_engineer: 'request', superintendent: 'approve', admin: 'request' },
  run_analyses: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  // Phase 2 improvement loop. Anyone can be an action's owner; the owner can start and close it.
  create_actions: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  run_rcas: { reliability_engineer: 'yes', superintendent: 'yes' },
  // Plan 11.2: create and run projects; approve project gates and budgets.
  run_projects: { reliability_engineer: 'yes', superintendent: 'yes' },
  approve_projects: { superintendent: 'yes' },
  publish_weekly_pack: { reliability_engineer: 'yes', superintendent: 'yes' },
  export_reports: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  edit_codes: { reliability_engineer: 'propose', admin: 'yes' },
  open_close_line: { supervisor: 'area', superintendent: 'yes', admin: 'yes' },
  edit_shop_structure: { reliability_engineer: 'propose', admin: 'yes' },
  change_flag_rules: { reliability_engineer: 'propose', superintendent: 'approve', admin: 'propose' },
  change_targets: { reliability_engineer: 'propose', superintendent: 'approve' },
  // Field mapping, imports, data-quality rules: data owner only. In phase 1a the Admin role is the data owner (11.7).
  manage_imports: { admin: 'yes' },
  manage_users: { superintendent: 'approve', admin: 'yes' },
};

/** Plain-language names for the console's "what this person can do" list. */
export const ACTION_LABELS: Record<Action, string> = {
  view_status: 'View status, units and KPIs',
  view_cost: 'View cost and labour rates',
  add_notes: 'Add notes, photos and defects',
  update_stage: 'Update repair stage',
  set_clear_flag: 'Set or clear down flags',
  move_location: 'Move a unit between locations',
  reclassify_flag: 'Reclassify flag type or reason',
  void_flag: 'Void a flag',
  change_locked_period: 'Change data in a locked period',
  run_analyses: 'Run calculators and analyses',
  create_actions: 'Raise and manage improvement actions',
  run_rcas: 'Lead root cause analyses',
  run_projects: 'Create and run projects',
  approve_projects: 'Approve project gates, budgets and change requests',
  publish_weekly_pack: 'Publish the weekly pack',
  export_reports: 'Export reports and data',
  edit_codes: 'Edit reason codes',
  open_close_line: 'Open or close a shop line',
  edit_shop_structure: 'Edit shops, lines and field locations',
  change_flag_rules: 'Change flag rules',
  change_targets: 'Change KPI targets',
  manage_imports: 'Field mapping, imports and data-quality rules',
  manage_users: 'Manage users and roles',
};

/** Everything a role may do, and how (yes, own area, propose, ...). Deny-by-default rows are left out. */
export function permissionsFor(role: Role): Array<{ action: Action; label: string; permission: Permission }> {
  return (Object.keys(MATRIX) as Action[])
    .map((action) => ({ action, label: ACTION_LABELS[action], permission: permission(role, action) }))
    .filter((x) => x.permission !== 'no');
}

export function permission(role: Role, action: Action): Permission {
  return MATRIX[action][role] ?? 'no';
}

export function inScope(actor: Actor, area: string | undefined): boolean {
  return actor.scope.includes('*') || (area !== undefined && actor.scope.includes(area));
}

/** True if the actor can perform the action directly (not just propose or request) on something in `area`. */
export function can(actor: Actor, action: Action, area?: string): boolean {
  const p = permission(actor.role, action);
  if (p === 'yes') return true;
  if (p === 'area') return inScope(actor, area);
  return false;
}

export function canPropose(actor: Actor, action: Action, area?: string): boolean {
  const p = permission(actor.role, action);
  return (p === 'propose' && inScope(actor, area)) || can(actor, action, area);
}
