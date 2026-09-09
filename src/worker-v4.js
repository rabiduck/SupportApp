import baseWorker from './worker-v3.js';
import { ensureSchema } from './schema.js';

const h = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

async function rows(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

async function row(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

const redirect = (request, path) => Response.redirect(new URL(path, request.url).toString(), 303);
const statusBadge = (active) => active
  ? '<span class="status-badge status-active">Active</span>'
  : '<span class="status-badge status-inactive">Inactive</span>';

function options(items, selected = null, includeBlank = false, blankLabel = '— None —') {
  const blank = includeBlank ? `<option value="">${h(blankLabel)}</option>` : '';
  return blank + items.map((item) => `<option value="${item.id}" ${String(item.id) === String(selected) ? 'selected' : ''}>${h(item.name)}</option>`).join('');
}

function nav(auth, active = '') {
  const links = [
    ['Dashboard', '/', true],
    ['Rota', '/rota', true],
    ['Teams', '/teams', auth.isSystemAdmin],
    ['Employees', '/employees', auth.isSystemAdmin || auth.isManager],
    ['Shift Patterns', '/shift-patterns', auth.isSystemAdmin],
    ['Administration', '/administration', auth.isSystemAdmin],
  ];
  return links.filter(([, , show]) => show).map(([name, href]) =>
    `<a class="${active === name ? 'active' : ''}" href="${href}">${name}</a>`).join('');
}

function shell(title, content, auth, active = '') {
  const identity = auth.bootstrap
    ? 'UAT Bootstrap · SystemAdmin'
    : `${h(auth.displayName || auth.email)} · ${h(auth.primaryRole || 'Engineer')}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body>
<header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">${identity}</div></header>
<div class="app-shell"><nav class="side-nav">${nav(auth, active)}</nav><main class="page">${content}</main></div>
<footer class="footer">SupportApp · Cloudflare-native UAT</footer></body></html>`;
}

const pageHeader = (title, description) => `<div class="page-header"><div><div class="page-title">${h(title)}</div>${description ? `<div class="page-description">${h(description)}</div>` : ''}</div></div>`;
function htmlResponse(title, content, auth, active = '', status = 200) {
  return new Response(shell(title, content, auth, active), { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
function accessPage(title, message, status = 403) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">Authentication</div></header><main class="page"><div class="page-header"><div><div class="page-title">${h(title)}</div></div></div><div class="notice"><strong>${h(message)}</strong></div></main></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}
function friendlyError(title, message, auth, active = '', status = 400) {
  return htmlResponse(title, `${pageHeader(title, 'The requested change could not be saved.')}<div class="notice"><strong>${h(message)}</strong></div><div class="action-bar"><a class="button secondary" href="/">Return to Dashboard</a></div>`, auth, active, status);
}

async function authContext(request, db, env) {
  const email = String(request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const required = String(env.AUTH_REQUIRED || '').toLowerCase() === 'true';

  if (!email) {
    if (required) return { authenticated: false, reason: 'Cloudflare Access authentication is required.' };
    return { authenticated: true, bootstrap: true, displayName: 'UAT Bootstrap', primaryRole: 'SystemAdmin', roles: ['SystemAdmin'], isSystemAdmin: true, isManager: false, managedTeamIds: [] };
  }

  const employee = await row(db, `SELECT id,display_name,email,external_identity,is_active FROM employees
    WHERE is_active=1 AND (LOWER(email)=? OR LOWER(external_identity)=?) LIMIT 1`, email, email);
  if (!employee) return { authenticated: true, provisioned: false, email };

  const roleRows = await rows(db, `SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? ORDER BY r.name`, employee.id);
  const rolesList = roleRows.map(r => r.name);
  const teamRows = await rows(db, 'SELECT team_id FROM team_managers WHERE employee_id=? ORDER BY team_id', employee.id);
  const isSystemAdmin = rolesList.includes('SystemAdmin');
  const isManager = rolesList.includes('Manager');
  return {
    authenticated: true,
    provisioned: true,
    employeeId: employee.id,
    email,
    displayName: employee.display_name,
    roles: rolesList,
    primaryRole: isSystemAdmin ? 'SystemAdmin' : isManager ? 'Manager' : 'Engineer',
    isSystemAdmin,
    isManager,
    managedTeamIds: teamRows.map(t => Number(t.team_id)),
  };
}

function canManageTeam(auth, teamId) {
  return auth.isSystemAdmin || (auth.isManager && auth.managedTeamIds.includes(Number(teamId)));
}

async function decorateResponse(response, auth, active = '') {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  text = text.replace(/<nav class="side-nav">[\s\S]*?<\/nav>/, `<nav class="side-nav">${nav(auth, active)}</nav>`);
  const identity = auth.bootstrap ? 'UAT Bootstrap · SystemAdmin' : `${h(auth.displayName || auth.email)} · ${h(auth.primaryRole)}`;
  text = text.replace(/<div class="user-area">[\s\S]*?<\/div>/, `<div class="user-area">${identity}</div>`);
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function dashboardPage(db, auth) {
  const teamClause = auth.isManager && !auth.isSystemAdmin && auth.managedTeamIds.length
    ? `WHERE id IN (${auth.managedTeamIds.map(() => '?').join(',')})`
    : '';
  const teamParams = teamClause ? auth.managedTeamIds : [];
  const teams = auth.isSystemAdmin ? (await row(db, 'SELECT COUNT(*) AS c FROM teams WHERE is_active=1'))?.c ?? 0
    : auth.isManager ? (await row(db, `SELECT COUNT(*) AS c FROM teams ${teamClause}`, ...teamParams))?.c ?? 0 : 0;
  const employees = auth.isSystemAdmin ? (await row(db, 'SELECT COUNT(*) AS c FROM employees WHERE is_active=1'))?.c ?? 0
    : auth.isManager && auth.managedTeamIds.length ? (await row(db, `SELECT COUNT(*) AS c FROM employees WHERE is_active=1 AND team_id IN (${auth.managedTeamIds.map(() => '?').join(',')})`, ...auth.managedTeamIds))?.c ?? 0 : 0;
  const patterns = auth.isSystemAdmin ? (await row(db, 'SELECT COUNT(*) AS c FROM rota_patterns WHERE is_active=1'))?.c ?? 0 : null;

  const cards = [];
  if (auth.isSystemAdmin || auth.isManager) cards.push(`<article class="card"><h2>Employees</h2><p class="muted">${auth.isManager && !auth.isSystemAdmin ? 'Employees in teams you manage.' : 'People currently represented in SupportApp.'}</p><div class="metric">${employees}</div><a class="button" href="/employees">Manage employees</a></article>`);
  if (auth.isSystemAdmin) {
    cards.push(`<article class="card"><h2>Teams</h2><p class="muted">Departments, managers and operational teams.</p><div class="metric">${teams}</div><a class="button" href="/teams">Manage teams</a></article>`);
    cards.push(`<article class="card"><h2>Rota Patterns</h2><p class="muted">Reusable multi-week rota cycles built from week patterns.</p><div class="metric">${patterns}</div><a class="button" href="/shift-patterns">Manage patterns</a></article>`);
  }
  if (!cards.length) cards.push(`<article class="card"><h2>Rota</h2><p class="muted">View the current support rota.</p><a class="button" href="/rota">View rota</a></article>`);

  const authNotice = auth.bootstrap ? '<div class="notice"><strong>Authentication staging mode</strong><br>Cloudflare Access integration is ready, but AUTH_REQUIRED is currently disabled so UAT remains reachable while the Access application is configured.</div>' : '';
  return htmlResponse('Dashboard', `${pageHeader('Support Dashboard', 'Support administration and rota management.')}${authNotice}<div class="card-grid">${cards.join('')}</div>`, auth, 'Dashboard');
}

async function managerCandidates(db) {
  return rows(db, `SELECT DISTINCT e.id,e.display_name AS name FROM employees e
    JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id
    WHERE e.is_active=1 AND r.name='Manager' ORDER BY e.display_name`);
}
function managerCheckboxes(candidates, selectedIds = []) {
  if (!candidates.length) return '<div class="muted">No employees currently have the Manager role.</div>';
  return `<div class="manager-grid">${candidates.map(m => `<label class="checkbox-label"><input type="checkbox" name="manager_ids" value="${m.id}" ${selectedIds.includes(Number(m.id)) ? 'checked' : ''}> ${h(m.name)}</label>`).join('')}</div>`;
}
async function saveTeamManagers(db, teamId, managerIds) {
  await db.prepare('DELETE FROM team_managers WHERE team_id=?').bind(teamId).run();
  const unique = [...new Set(managerIds.map(Number).filter(Boolean))];
  for (const employeeId of unique) {
    const eligible = await row(db, `SELECT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id WHERE e.id=? AND e.is_active=1 AND r.name='Manager'`, employeeId);
    if (eligible) await db.prepare('INSERT OR IGNORE INTO team_managers (team_id,employee_id) VALUES (?,?)').bind(teamId, employeeId).run();
  }
}

async function teamsPage(db, auth) {
  const teams = await rows(db, `SELECT t.*,d.name AS department_name,rp.name AS pattern_name,
    (SELECT COUNT(*) FROM employees e WHERE e.team_id=t.id AND e.is_active=1) AS member_count,
    COALESCE((SELECT GROUP_CONCAT(e.display_name, ', ') FROM team_managers tm JOIN employees e ON e.id=tm.employee_id WHERE tm.team_id=t.id),'—') AS managers
    FROM teams t JOIN departments d ON d.id=t.department_id LEFT JOIN rota_patterns rp ON rp.id=t.default_rota_pattern_id
    ORDER BY d.name,t.name`);
  const departments = await rows(db, 'SELECT id,name FROM departments WHERE is_active=1 ORDER BY name');
  const patterns = await rows(db, 'SELECT id,name FROM rota_patterns WHERE is_active=1 ORDER BY name');
  const managers = await managerCandidates(db);
  const table = teams.length ? `<table><thead><tr><th>Team</th><th>Department</th><th>Managers</th><th>Members</th><th>Default Rota</th><th>Status</th><th></th></tr></thead><tbody>${teams.map(t => `<tr><td><a href="/teams/${t.id}/edit"><strong>${h(t.name)}</strong></a></td><td>${h(t.department_name)}</td><td>${h(t.managers)}</td><td>${t.member_count ?? 0}</td><td>${h(t.pattern_name || 'No Scheduled Hours')}</td><td>${statusBadge(t.is_active)}</td><td class="text-right"><a class="button secondary" href="/teams/${t.id}/edit">Edit</a><form class="inline-form" method="post" action="/teams/${t.id}/toggle"><button class="secondary" type="submit">${t.is_active ? 'Deactivate' : 'Reactivate'}</button></form></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No teams have been created yet.</div>';
  const content = `${pageHeader('Teams', 'Departments, operational teams, rota defaults and manager scope.')}
    <div class="notice"><strong>Manager scope</strong><br>Managers and team leaders use the Manager role. Assigning them here determines which teams they may administer.</div>
    <div class="table-card">${table}</div>
    <div class="form-card section-gap"><h2>Create Team</h2><form method="post" action="/teams">
      <label>Team Name<input name="name" required maxlength="100"></label>
      <label>Department<select name="department_id" required>${options(departments)}</select></label>
      <label>Description<textarea name="description" rows="3" maxlength="255"></textarea></label>
      <label>Default Rota Pattern<select name="default_rota_pattern_id">${options(patterns, null, true, 'No Scheduled Hours')}</select></label>
      <label>Pattern Start Date<input name="default_pattern_start_date" type="date"></label>
      <label>Managers</label>${managerCheckboxes(managers)}
      <div class="action-bar"><button type="submit">Create Team</button></div></form></div>`;
  return htmlResponse('Teams', content, auth, 'Teams');
}

async function createTeam(request, db, auth) {
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const departmentId = Number(form.get('department_id'));
  const description = String(form.get('description') || '').trim() || null;
  let patternId = Number(form.get('default_rota_pattern_id')) || null;
  const startDate = String(form.get('default_pattern_start_date') || '').trim() || null;
  if (!name || !departmentId) return friendlyError('Invalid Team', 'Team name and department are required.', auth, 'Teams');
  if (!patternId) patternId = (await row(db, "SELECT id FROM rota_patterns WHERE name='No Scheduled Hours'"))?.id ?? null;
  const result = await db.prepare('INSERT INTO teams (department_id,name,description,default_rota_pattern_id,default_pattern_start_date) VALUES (?,?,?,?,?)').bind(departmentId,name,description,patternId,startDate).run();
  if (result.meta?.last_row_id) await saveTeamManagers(db, result.meta.last_row_id, form.getAll('manager_ids'));
  return redirect(request, '/teams');
}

async function editTeamPage(db, id, auth) {
  const team = await row(db, 'SELECT * FROM teams WHERE id=?', id);
  if (!team) return friendlyError('Team Not Found', 'The requested team does not exist.', auth, 'Teams', 404);
  const departments = await rows(db, 'SELECT id,name FROM departments WHERE is_active=1 OR id=? ORDER BY name', team.department_id);
  const patterns = await rows(db, 'SELECT id,name FROM rota_patterns WHERE is_active=1 OR id=? ORDER BY name', team.default_rota_pattern_id || -1);
  const managers = await managerCandidates(db);
  const selected = (await rows(db, 'SELECT employee_id FROM team_managers WHERE team_id=?', id)).map(x => Number(x.employee_id));
  const content = `${pageHeader('Edit Team', 'Update team details, rota default and manager scope.')}
    <div class="form-card"><form method="post" action="/teams/${id}/edit">
      <label>Team Name<input name="name" required maxlength="100" value="${h(team.name)}"></label>
      <label>Department<select name="department_id" required>${options(departments, team.department_id)}</select></label>
      <label>Description<textarea name="description" rows="3" maxlength="255">${h(team.description || '')}</textarea></label>
      <label>Default Rota Pattern<select name="default_rota_pattern_id" required>${options(patterns, team.default_rota_pattern_id)}</select></label>
      <label>Pattern Start Date<input name="default_pattern_start_date" type="date" value="${h(team.default_pattern_start_date || '')}"></label>
      <label>Managers</label>${managerCheckboxes(managers, selected)}
      <label class="checkbox-label"><input type="checkbox" name="is_active" ${team.is_active ? 'checked' : ''}> Active</label>
      <div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/teams">Cancel</a></div>
    </form></div>`;
  return htmlResponse('Edit Team', content, auth, 'Teams');
}

async function updateTeam(request, db, id) {
  const form = await request.formData();
  await db.prepare('UPDATE teams SET department_id=?,name=?,description=?,default_rota_pattern_id=?,default_pattern_start_date=?,is_active=? WHERE id=?')
    .bind(Number(form.get('department_id')),String(form.get('name')||'').trim(),String(form.get('description')||'').trim()||null,Number(form.get('default_rota_pattern_id'))||null,String(form.get('default_pattern_start_date')||'').trim()||null,form.has('is_active')?1:0,id).run();
  await saveTeamManagers(db, id, form.getAll('manager_ids'));
}

async function employeeRows(db, auth) {
  const scope = auth.isSystemAdmin ? '' : auth.managedTeamIds.length ? `WHERE e.team_id IN (${auth.managedTeamIds.map(() => '?').join(',')})` : 'WHERE 1=0';
  return rows(db, `SELECT e.*,t.name AS team_name,COALESCE(orp.name,trp.name,'No Scheduled Hours') AS effective_pattern,COALESCE(GROUP_CONCAT(r.name, ', '),'—') AS roles
    FROM employees e JOIN teams t ON t.id=e.team_id LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id
    LEFT JOIN employee_roles er ON er.employee_id=e.id LEFT JOIN roles r ON r.id=er.role_id ${scope} GROUP BY e.id ORDER BY e.display_name`, ...(auth.isSystemAdmin ? [] : auth.managedTeamIds));
}
async function scopedTeams(db, auth, includeId = null) {
  if (auth.isSystemAdmin) return rows(db, 'SELECT id,name FROM teams WHERE is_active=1 OR id=? ORDER BY name', includeId || -1);
  if (!auth.managedTeamIds.length) return [];
  return rows(db, `SELECT id,name FROM teams WHERE id IN (${auth.managedTeamIds.map(() => '?').join(',')}) AND (is_active=1 OR id=?) ORDER BY name`, ...auth.managedTeamIds, includeId || -1);
}

async function employeesPage(db, auth) {
  const employees = await employeeRows(db, auth);
  const teams = await scopedTeams(db, auth);
  const patterns = await rows(db, "SELECT id,name FROM rota_patterns WHERE is_active=1 AND name<>'No Scheduled Hours' ORDER BY name");
  const roles = await rows(db, 'SELECT id,name FROM roles ORDER BY name');
  const table = employees.length ? `<table><thead><tr><th>Employee</th><th>Username</th><th>Role</th><th>Job Title</th><th>Team</th><th>Rota</th><th>Status</th><th></th></tr></thead><tbody>${employees.map(e => `<tr><td><a href="/employees/${e.id}/edit"><strong>${h(e.display_name)}</strong></a>${!e.email ? '<br><span class="warning-text">Email required for Access</span>' : ''}</td><td>${h(e.username || '—')}</td><td>${h(e.roles)}</td><td>${h(e.job_title || '—')}</td><td>${h(e.team_name)}</td><td>${h(e.effective_pattern)}</td><td>${statusBadge(e.is_active)}</td><td class="text-right"><a class="button secondary" href="/employees/${e.id}/edit">Edit</a><form class="inline-form" method="post" action="/employees/${e.id}/toggle"><button class="secondary" type="submit">${e.is_active ? 'Deactivate' : 'Reactivate'}</button></form></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No employees are available in your management scope.</div>';
  const roleOptions = auth.isSystemAdmin ? options(roles) : options(roles.filter(r => r.name === 'Engineer'));
  const create = teams.length ? `<div class="form-card section-gap"><h2>Create Employee</h2><form method="post" action="/employees"><label>Display Name<input name="display_name" required maxlength="100"></label><label>Username<input name="username" required maxlength="100"></label><label>Email<input name="email" type="email" required maxlength="200"></label><label>Role<select name="role_id" required>${roleOptions}</select></label><label>Team<select name="team_id" required>${options(teams)}</select></label><label>Job Title<input name="job_title" maxlength="100"></label><label>Phone<input name="phone" maxlength="50"></label><label>Rota Override<select name="override_rota_pattern_id">${options(patterns,null,true,'— Inherit team default —')}</select></label><label>Override Start Date<input name="override_pattern_start_date" type="date"></label><div class="action-bar"><button type="submit">Create Employee</button></div></form></div>` : '';
  const scopeNotice = auth.isManager && !auth.isSystemAdmin ? '<div class="notice"><strong>Manager scope</strong><br>You can create and maintain employees only within teams assigned to you. Role changes to Manager or SystemAdmin require a SystemAdmin.</div>' : '';
  return htmlResponse('Employees', `${pageHeader('Employees','People, portal identity, access role, team membership and rota assignment.')}${scopeNotice}<div class="table-card">${table}</div>${create}`, auth, 'Employees');
}

async function editEmployeePage(db, id, auth) {
  const employee = await row(db, `SELECT e.*,er.role_id,r.name AS role_name FROM employees e LEFT JOIN employee_roles er ON er.employee_id=e.id LEFT JOIN roles r ON r.id=er.role_id WHERE e.id=?`, id);
  if (!employee) return friendlyError('Employee Not Found','The requested employee does not exist.',auth,'Employees',404);
  if (!canManageTeam(auth, employee.team_id)) return friendlyError('Access Denied','This employee is outside your management scope.',auth,'Employees',403);
  const teams = await scopedTeams(db, auth, employee.team_id);
  const patterns = await rows(db, "SELECT id,name FROM rota_patterns WHERE is_active=1 AND name<>'No Scheduled Hours' ORDER BY name");
  let roles = await rows(db, 'SELECT id,name FROM roles ORDER BY name');
  if (!auth.isSystemAdmin) roles = roles.filter(r => r.name === 'Engineer' || r.name === employee.role_name);
  const content = `${pageHeader('Edit Employee','Update identity, access, team membership and rota settings.')}
    <div class="form-card"><form method="post" action="/employees/${id}/edit"><label>Display Name<input name="display_name" required maxlength="100" value="${h(employee.display_name)}"></label><label>Username<input name="username" required maxlength="100" value="${h(employee.username||'')}"></label><label>Email<input name="email" type="email" required maxlength="200" value="${h(employee.email||'')}"></label><label>Role<select name="role_id" required>${options(roles,employee.role_id)}</select></label><label>Team<select name="team_id" required>${options(teams,employee.team_id)}</select></label><label>Job Title<input name="job_title" maxlength="100" value="${h(employee.job_title||'')}"></label><label>Phone<input name="phone" maxlength="50" value="${h(employee.phone||'')}"></label><label>Rota Override<select name="override_rota_pattern_id">${options(patterns,employee.override_rota_pattern_id,true,'— Inherit team default —')}</select></label><label>Override Start Date<input name="override_pattern_start_date" type="date" value="${h(employee.override_pattern_start_date||'')}"></label><label class="checkbox-label"><input type="checkbox" name="is_active" ${employee.is_active?'checked':''}> Active</label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/employees">Cancel</a></div></form></div>`;
  return htmlResponse('Edit Employee', content, auth, 'Employees');
}

async function saveEmployee(request, db, auth, id = null) {
  const form = await request.formData();
  const teamId = Number(form.get('team_id'));
  if (!canManageTeam(auth, teamId)) return friendlyError('Access Denied','The selected team is outside your management scope.',auth,'Employees',403);
  const roleId = Number(form.get('role_id'));
  const role = await row(db, 'SELECT name FROM roles WHERE id=?', roleId);
  if (!auth.isSystemAdmin && role?.name !== 'Engineer') return friendlyError('Access Denied','Managers may only assign the Engineer role. Manager and SystemAdmin roles require a SystemAdmin.',auth,'Employees',403);
  const displayName = String(form.get('display_name')||'').trim();
  const username = String(form.get('username')||'').trim();
  const email = String(form.get('email')||'').trim()||null;
  if (!displayName || !username || !email || !roleId || !teamId) return friendlyError('Invalid Employee','Display name, username, email, role and team are required.',auth,'Employees');
  try {
    let employeeId = id;
    if (id) {
      const current = await row(db, 'SELECT team_id FROM employees WHERE id=?', id);
      if (!current || !canManageTeam(auth, current.team_id)) return friendlyError('Access Denied','This employee is outside your management scope.',auth,'Employees',403);
      await db.prepare(`UPDATE employees SET display_name=?,username=?,email=?,team_id=?,job_title=?,phone=?,override_rota_pattern_id=?,override_pattern_start_date=?,is_active=? WHERE id=?`)
        .bind(displayName,username,email,teamId,String(form.get('job_title')||'').trim()||null,String(form.get('phone')||'').trim()||null,Number(form.get('override_rota_pattern_id'))||null,String(form.get('override_pattern_start_date')||'').trim()||null,form.has('is_active')?1:0,id).run();
      await db.prepare('DELETE FROM employee_roles WHERE employee_id=?').bind(id).run();
    } else {
      const result = await db.prepare(`INSERT INTO employees (team_id,display_name,username,email,job_title,phone,override_rota_pattern_id,override_pattern_start_date) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(teamId,displayName,username,email,String(form.get('job_title')||'').trim()||null,String(form.get('phone')||'').trim()||null,Number(form.get('override_rota_pattern_id'))||null,String(form.get('override_pattern_start_date')||'').trim()||null).run();
      employeeId = result.meta?.last_row_id;
    }
    if (employeeId) await db.prepare('INSERT INTO employee_roles (employee_id,role_id) VALUES (?,?)').bind(employeeId,roleId).run();
    if (role?.name !== 'Manager') await db.prepare('DELETE FROM team_managers WHERE employee_id=?').bind(employeeId).run();
    return redirect(request,'/employees');
  } catch (error) {
    const msg = String(error?.message||error);
    if (msg.includes('employees.username')) return friendlyError('Duplicate Username',`The username “${username}” is already in use.`,auth,'Employees',409);
    if (msg.includes('employees.email')) return friendlyError('Duplicate Email',`The email address “${email}” is already in use.`,auth,'Employees',409);
    throw error;
  }
}

async function toggleEmployee(request, db, id, auth) {
  const employee = await row(db,'SELECT team_id FROM employees WHERE id=?',id);
  if (!employee || !canManageTeam(auth, employee.team_id)) return friendlyError('Access Denied','This employee is outside your management scope.',auth,'Employees',403);
  await db.prepare('UPDATE employees SET is_active=CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request,'/employees');
}

function activeForPath(path) {
  if (path === '/') return 'Dashboard';
  if (path.startsWith('/rota')) return 'Rota';
  if (path.startsWith('/teams')) return 'Teams';
  if (path.startsWith('/employees')) return 'Employees';
  if (path.startsWith('/shift-') || path.startsWith('/week-patterns') || path.startsWith('/rota-patterns')) return 'Shift Patterns';
  if (path.startsWith('/administration')) return 'Administration';
  return '';
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error('D1 binding DB is not available to this Worker deployment.');
      await ensureSchema(env.DB);
      const auth = await authContext(request, env.DB, env);
      if (!auth.authenticated) return accessPage('Sign in required', auth.reason, 401);
      if (!auth.bootstrap && !auth.provisioned) return accessPage('Access not provisioned', `You authenticated as ${auth.email}, but no active SupportApp employee record matches that email address.`, 403);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = request.method.toUpperCase();

      if (method === 'GET' && path === '/') return dashboardPage(env.DB, auth);

      if (path === '/users' || /^\/users\//.test(path)) return redirect(request, '/employees');

      if (path === '/teams' || /^\/teams\//.test(path)) {
        if (!auth.isSystemAdmin) return friendlyError('Access Denied','Team configuration and manager assignment require SystemAdmin.',auth,'Teams',403);
        if (method === 'GET' && path === '/teams') return teamsPage(env.DB, auth);
        if (method === 'POST' && path === '/teams') return createTeam(request, env.DB, auth);
        if (method === 'GET' && /^\/teams\/\d+\/edit$/.test(path)) return editTeamPage(env.DB, Number(path.split('/')[2]), auth);
        if (method === 'POST' && /^\/teams\/\d+\/edit$/.test(path)) { await updateTeam(request, env.DB, Number(path.split('/')[2])); return redirect(request,'/teams'); }
        if (method === 'POST' && /^\/teams\/\d+\/toggle$/.test(path)) { await env.DB.prepare('UPDATE teams SET is_active=CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(Number(path.split('/')[2])).run(); return redirect(request,'/teams'); }
      }

      if (path === '/employees' || /^\/employees\//.test(path)) {
        if (!(auth.isSystemAdmin || auth.isManager)) return friendlyError('Access Denied','Employee administration requires Manager or SystemAdmin.',auth,'Employees',403);
        if (method === 'GET' && path === '/employees') return employeesPage(env.DB, auth);
        if (method === 'POST' && path === '/employees') return saveEmployee(request, env.DB, auth);
        if (method === 'GET' && /^\/employees\/\d+\/edit$/.test(path)) return editEmployeePage(env.DB, Number(path.split('/')[2]), auth);
        if (method === 'POST' && /^\/employees\/\d+\/edit$/.test(path)) return saveEmployee(request, env.DB, auth, Number(path.split('/')[2]));
        if (method === 'POST' && /^\/employees\/\d+\/toggle$/.test(path)) return toggleEmployee(request, env.DB, Number(path.split('/')[2]), auth);
      }

      const adminPath = path === '/administration' || path === '/shift-patterns' || /^\/(week-patterns|rota-patterns|shift-types)\//.test(path) || path === '/week-patterns' || path === '/rota-patterns';
      if (adminPath && !auth.isSystemAdmin) return friendlyError('Access Denied','Rota configuration and administration require SystemAdmin.',auth,'',403);

      const response = await baseWorker.fetch(request, env);
      return decorateResponse(response, auth, activeForPath(path));
    } catch (error) {
      console.error(error);
      return accessPage('SupportApp Error', error?.message || String(error), 500);
    }
  },
};
