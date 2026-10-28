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
  | 'publish_weekly_pack'
  | 'export_reports'
  | 'edit_codes'
  | 'open_close_line'
  | 'edit_shop_structure'
  | 'change_flag_rules'
  | 'change_targets'
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
  publish_weekly_pack: { reliability_engineer: 'yes', superintendent: 'yes' },
  export_reports: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  edit_codes: { reliability_engineer: 'propose', admin: 'yes' },
  open_close_line: { supervisor: 'area', superintendent: 'yes', admin: 'yes' },
  edit_shop_structure: { reliability_engineer: 'propose', admin: 'yes' },
  change_flag_rules: { reliability_engineer: 'propose', superintendent: 'approve', admin: 'propose' },
  change_targets: { reliability_engineer: 'propose', superintendent: 'approve' },
  manage_users: { superintendent: 'approve', admin: 'yes' },
};

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
