export const TEAM_MANAGEMENT_ROLE_NAMES = Object.freeze(['Manager', 'TeamLeader']);
export const ELEVATED_ROLE_NAMES = Object.freeze(['SystemAdmin', ...TEAM_MANAGEMENT_ROLE_NAMES]);

export function hasScopedTeamManagementRole(user) {
  return Boolean(user?.isManager || user?.isTeamLeader);
}

export function canManageTeamOperations(user) {
  return Boolean(user?.isSystemAdmin || hasScopedTeamManagementRole(user));
}

export function canManageTeam(user, teamId) {
  if (user?.isSystemAdmin) return true;
  if (!hasScopedTeamManagementRole(user)) return false;
  return (user.managedTeamIds || []).map(Number).includes(Number(teamId));
}

export function isElevatedRoleName(roleName) {
  return ELEVATED_ROLE_NAMES.includes(String(roleName || '').trim());
}
