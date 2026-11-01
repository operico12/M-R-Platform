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
  | 'set_standby'
  | 'set_waits'
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
  | 'edit_alert_rules'
  | 'view_audit_log'
  | 'sign_off_inspections'
  | 'edit_inspection_forms'
  | 'record_components'
  | 'edit_life_targets'
  | 'record_condition'
  | 'edit_condition_settings'
  | 'edit_plant_settings'
  | 'run_shutdowns'
  | 'edit_rcm'
  | 'issue_job_plans'
  | 'edit_spares'
  | 'edit_assist'
  | 'ask_assist'
  | 'manage_imports'
  | 'manage_users'
  | 'add_site'
  | 'manage_api_keys'
  | 'manage_access';

const MATRIX: Record<Action, Partial<Record<Role, Permission>>> = {
  view_status: { viewer: 'yes', technician: 'yes', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  view_cost: { reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  add_notes: { technician: 'yes', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  update_stage: { technician: 'area', supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
  set_clear_flag: { technician: 'propose', supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
  // Standby flags (docs/standby.md): available but not in use. No approval step; down wins over standby.
  set_standby: { technician: 'yes', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  // Wait tags (docs/wait-tags.md): follows update_stage.
  set_waits: { technician: 'area', supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes' },
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
  // Plan 11.2 "Edit alert rules and thresholds" (docs/alert-rules.md).
  edit_alert_rules: { reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  // Plan 11.4 "Audit log": superintendent, data owner, system admin (read-only).
  view_audit_log: { superintendent: 'yes', admin: 'yes' },
  // docs/inspections.md: sign-off mirrors "sign shift handover"; forms are site setup.
  sign_off_inspections: { supervisor: 'yes', superintendent: 'yes' },
  edit_inspection_forms: { reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  // docs/component-life.md: component events are recorded by those who run change-outs; target life is a reliability setting.
  record_components: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  edit_life_targets: { reliability_engineer: 'propose', superintendent: 'approve' },
  // docs/condition-monitoring.md: recording mirrors component events; settings mirror alert rules.
  record_condition: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  edit_condition_settings: { reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  // docs/fixed-plant.md: plan 11.2 has no plant settings row; these follow the alert and condition settings.
  edit_plant_settings: { reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  // docs/fixed-plant.md "Shutdowns": plan 11.2 has no shutdown row; follows "Set or clear down flags" without the area limit.
  run_shutdowns: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  // docs/rcm.md: plan 11.2 has no RCM row; these follow "Lead root cause analyses".
  edit_rcm: { reliability_engineer: 'yes', superintendent: 'yes' },
  issue_job_plans: { reliability_engineer: 'yes', superintendent: 'yes' },
  // docs/spares.md: plan 11.2 has no spares row; settings follow the RCM settings.
  edit_spares: { reliability_engineer: 'yes', superintendent: 'yes' },
  // docs/ai-assist.md: plan 11.2 has no assist row; settings follow the RCM and spares settings.
  edit_assist: { reliability_engineer: 'yes', superintendent: 'yes' },
  // Each question costs money (docs/ai-assist.md AI-5); follows "Run analyses".
  ask_assist: { supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes' },
  // Field mapping, imports, data-quality rules: data owner only. In phase 1a the Admin role is the data owner (11.7).
  manage_imports: { admin: 'yes' },
  manage_users: { superintendent: 'approve', admin: 'yes' },
  // docs/multi-site.md: the Admin of a site of the tenant adds another site to it.
  add_site: { admin: 'yes' },
  // docs/public-api.md: the site's Admin makes and revokes read-only API keys.
  manage_api_keys: { admin: 'yes' },
  // docs/access.md: account requests, session limits and two-step sign-in.
  manage_access: { admin: 'yes' },
};

/** Plain-language names for the console's "what this person can do" list. */
export const ACTION_LABELS: Record<Action, string> = {
  view_status: 'View status, units and KPIs',
  view_cost: 'View cost and labour rates',
  add_notes: 'Add notes, photos and defects',
  update_stage: 'Update repair stage',
  set_clear_flag: 'Set or clear down flags',
  set_standby: 'Raise or end standby flags',
  set_waits: 'Raise or end wait tags on a down unit',
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
  edit_shop_structure: 'Edit shops, lines, field locations and plant structure',
  change_flag_rules: 'Change flag rules',
  change_targets: 'Change KPI targets',
  edit_alert_rules: 'Edit alert rules and thresholds',
  view_audit_log: 'Read the full audit log',
  sign_off_inspections: 'Sign off inspections',
  edit_inspection_forms: 'Edit inspection forms',
  record_components: 'Record component installs, removals and rebuilds',
  edit_life_targets: 'Set component target life',
  record_condition: 'Enter oil results and respond to them',
  edit_condition_settings: 'Change condition monitoring settings',
  edit_plant_settings: 'Change plant stop detection settings and process delay codes',
  run_shutdowns: 'Plan, start and end plant shutdowns',
  edit_rcm: 'Edit the RCM failure mode library',
  issue_job_plans: 'Issue PM job plan revisions',
  edit_spares: 'Change spares sizing settings',
  edit_assist: 'Change assist settings and switch code suggestions on',
  ask_assist: 'Ask Claude a question about the weekly numbers',
  manage_imports: 'Field mapping, imports and data-quality rules',
  manage_users: 'Manage users and roles',
  add_site: 'Add or retire a site of the tenant',
  manage_api_keys: 'Make and revoke API keys for other systems',
  manage_access: 'Answer account requests; set sign-in rules',
};

/** Everything a role may do, and how (yes, own area, propose, ...). Deny-by-default rows are left out. */
export function permissionsFor(role: Role): Array<{ action: Action; label: string; permission: Permission }> {
  return (Object.keys(MATRIX) as Action[])
    .map((action) => ({ action, label: ACTION_LABELS[action], permission: permission(role, action) }))
    .filter((x) => x.permission !== 'no');
}

/** A role, or a person (whose full control in test mode passes every check). */
export type Who = Role | Actor;
const isFull = (who: Who) => typeof who === 'object' && !!who.fullAccess;
const roleOf = (who: Who): Role => (typeof who === 'object' ? who.role : who);

const RANK: Permission[] = ['no', 'request', 'propose', 'approve', 'area', 'yes'];

/**
 * How a role or person may do an action. Admin full control gets the strongest permission any role
 * has for it, so approval steps still work (a target is still asked for and approved, by the Admin).
 */
export function permission(who: Who, action: Action): Permission {
  if (isFull(who)) {
    const best = Object.values(MATRIX[action]).reduce<Permission>((m, p) => (RANK.indexOf(p!) > RANK.indexOf(m) ? p! : m), 'no');
    return best === 'area' ? 'yes' : best;
  }
  return MATRIX[action][roleOf(who)] ?? 'no';
}

/** True if the person holds one of the roles, or has Admin full control in test mode. */
export function hasRole(actor: Actor, ...roles: Role[]): boolean {
  return !!actor.fullAccess || roles.includes(actor.role);
}

export function inScope(actor: Actor, area: string | undefined): boolean {
  return !!actor.fullAccess || actor.scope.includes('*') || (area !== undefined && actor.scope.includes(area));
}

/** True if the actor can perform the action directly (not just propose or request) on something in `area`. */
export function can(actor: Actor, action: Action, area?: string): boolean {
  const p = permission(actor, action);
  if (p === 'yes') return true;
  if (p === 'area') return inScope(actor, area);
  return false;
}

export function canPropose(actor: Actor, action: Action, area?: string): boolean {
  const p = permission(actor, action);
  return (p === 'propose' && inScope(actor, area)) || can(actor, action, area);
}
