import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canManageTeam,
  canManageTeamOperations,
  hasScopedTeamManagementRole,
  isElevatedRoleName
} from '../src/permissions.js';

test('Team Leaders and Managers are both scoped team managers', () => {
  assert.equal(hasScopedTeamManagementRole({ isTeamLeader: true }), true);
  assert.equal(hasScopedTeamManagementRole({ isManager: true }), true);
  assert.equal(hasScopedTeamManagementRole({}), false);
});

test('team operations include Team Leaders, Managers and System Admins', () => {
  assert.equal(canManageTeamOperations({ isTeamLeader: true }), true);
  assert.equal(canManageTeamOperations({ isManager: true }), true);
  assert.equal(canManageTeamOperations({ isSystemAdmin: true }), true);
  assert.equal(canManageTeamOperations({}), false);
});

test('Team Leaders and Managers are limited to assigned teams', () => {
  const teamLeader = { isTeamLeader: true, managedTeamIds: [2, 4] };
  const manager = { isManager: true, managedTeamIds: [3] };
  assert.equal(canManageTeam(teamLeader, 2), true);
  assert.equal(canManageTeam(teamLeader, 3), false);
  assert.equal(canManageTeam(manager, 3), true);
  assert.equal(canManageTeam(manager, 4), false);
});

test('System Admin has global team scope and elevated roles are protected', () => {
  assert.equal(canManageTeam({ isSystemAdmin: true, managedTeamIds: [] }, 999), true);
  assert.equal(isElevatedRoleName('TeamLeader'), true);
  assert.equal(isElevatedRoleName('Manager'), true);
  assert.equal(isElevatedRoleName('SystemAdmin'), true);
  assert.equal(isElevatedRoleName('Employee'), false);
});
