// Appendix E: each role attempts each action in the matrix (plan 11.2); only allowed ones succeed.

import { describe, expect, it } from 'vitest';
import { can, canPropose, permission, type Action } from '../src/permissions.js';
import type { Role } from '../src/types.js';
import { actor } from './helpers.js';

const ROLES: Role[] = ['viewer', 'technician', 'supervisor', 'reliability_engineer', 'superintendent', 'admin'];

const EXPECTED: Partial<Record<Action, Record<Role, string>>> = {
  view_status: { viewer: 'yes', technician: 'yes', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  view_cost: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  update_stage: { viewer: 'no', technician: 'area', supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  set_clear_flag: { viewer: 'no', technician: 'propose', supervisor: 'area', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  publish_weekly_pack: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  change_targets: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'propose', superintendent: 'approve', admin: 'no' },
  change_locked_period: { viewer: 'no', technician: 'no', supervisor: 'request', reliability_engineer: 'request', superintendent: 'approve', admin: 'request' },
  record_components: { viewer: 'no', technician: 'no', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  edit_life_targets: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'propose', superintendent: 'approve', admin: 'no' },
  record_condition: { viewer: 'no', technician: 'no', supervisor: 'yes', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  edit_condition_settings: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'yes', superintendent: 'yes', admin: 'yes' },
  edit_rcm: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  issue_job_plans: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  edit_spares: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  edit_assist: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'yes', superintendent: 'yes', admin: 'no' },
  manage_imports: { viewer: 'no', technician: 'no', supervisor: 'no', reliability_engineer: 'no', superintendent: 'no', admin: 'yes' },
};

describe('permission matrix (plan 11.2)', () => {
  for (const [action, row] of Object.entries(EXPECTED) as Array<[Action, Record<Role, string>]>) {
    for (const role of ROLES) {
      it(`${role} → ${action} = ${row[role]}`, () => expect(permission(role, action)).toBe(row[role]));
    }
  }
  it('area scope: a supervisor outside their area cannot flag, inside can', () => {
    expect(can(actor('supervisor', ['Loaders']), 'set_clear_flag', 'Haul trucks')).toBe(false);
    expect(can(actor('supervisor', ['Haul trucks']), 'set_clear_flag', 'Haul trucks')).toBe(true);
  });
  it('technicians can propose but not flag directly', () => {
    expect(can(actor('technician'), 'set_clear_flag', 'Haul trucks')).toBe(false);
    expect(canPropose(actor('technician'), 'set_clear_flag', 'Haul trucks')).toBe(true);
  });
  it('an unknown role is denied everything', () => {
    expect(permission('contractor' as Role, 'view_status')).toBe('no');
  });
});
