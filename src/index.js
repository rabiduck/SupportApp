import { ensureSchema } from './schema.js';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MAX_CYCLE_WEEKS = 6;

const h = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const statusBadge = (active) => active
  ? '<span class="status-badge status-active">Active</span>'
  : '<span class="status-badge status-inactive">Inactive</span>';

const shell = (title, content, active = '') => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${h(title)} · Support Portal</title>
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
<header class="top-bar">
  <div class="brand">Support Portal</div>
  <div class="user-area">Cloudflare UAT</div>
</header>
<div class="app-shell">
  <nav class="side-nav">
    <a class="${active === 'Dashboard' ? 'active' : ''}" href="/">Dashboard</a>
    <a class="${active === 'Rota' ? 'active' : ''}" href="/rota">Rota</a>
    <a class="${active === 'Users' ? 'active' : ''}" href="/users">Users</a>
    <a class="${active === 'Teams' ? 'active' : ''}" href="/teams">Teams</a>
    <a class="${active === 'Employees' ? 'active' : ''}" href="/employees">Employees</a>
    <a class="${active === 'Shift Patterns' ? 'active' : ''}" href="/shift-patterns">Shift Patterns</a>
    <a class="${active === 'Administration' ? 'active' : ''}" href="/administration">Administration</a>
  </nav>
  <main class="page">${content}</main>
</div>
<footer class="footer">SupportApp · Cloudflare-native UAT</footer>
</body>
</html>`;

const pageHeader = (title, description, action = '') => `
<div class="page-header">
  <div>
    <div class="page-title">${h(title)}</div>
    ${description ? `<div class="page-description">${h(description)}</div>` : ''}
  </div>
  ${action}
</div>`;

const htmlResponse = (title, content, active, status = 200) => new Response(shell(title, content, active), {
  status,
  headers: { 'content-type': 'text/html; charset=UTF-8' },
});

const redirect = (request, path) => Response.redirect(new URL(path, request.url).toString(), 303);

async function rows(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

async function row(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

function options(items, selected = null, includeBlank = false, blankLabel = '— None —') {
  const blank = includeBlank ? `<option value="">${h(blankLabel)}</option>` : '';
  return blank + items.map((item) => `<option value="${item.id}" ${String(item.id) === String(selected) ? 'selected' : ''}>${h(item.name)}</option>`).join('');
}

function checked(value) { return value ? 'checked' : ''; }

async function dashboardPage(db) {
  const counts = await row(db, `SELECT
    (SELECT COUNT(*) FROM users WHERE is_active=1) AS users,
    (SELECT COUNT(*) FROM teams WHERE is_active=1) AS teams,
    (SELECT COUNT(*) FROM employees WHERE is_active=1) AS employees,
    (SELECT COUNT(*) FROM rota_patterns WHERE is_active=1) AS patterns`);

  const content = `${pageHeader('Support Dashboard', 'Support administration and rota management.')}
  <div class="notice"><strong>Cloudflare-native UAT</strong><br>D1-backed administration, editable records and multi-week rota patterns are available for testing.</div>
  <div class="card-grid">
    <article class="card"><h2>Employees</h2><p class="muted">People currently represented in SupportApp.</p><div class="metric">${counts?.employees ?? 0}</div><a class="button" href="/employees">Manage employees</a></article>
    <article class="card"><h2>Teams</h2><p class="muted">Departments and operational teams.</p><div class="metric">${counts?.teams ?? 0}</div><a class="button" href="/teams">Manage teams</a></article>
    <article class="card"><h2>Users</h2><p class="muted">Portal identities and role assignments.</p><div class="metric">${counts?.users ?? 0}</div><a class="button" href="/users">Manage users</a></article>
    <article class="card"><h2>Rota Patterns</h2><p class="muted">Reusable multi-week rota cycles built from week patterns.</p><div class="metric">${counts?.patterns ?? 0}</div><a class="button" href="/shift-patterns">Manage patterns</a></article>
  </div>`;
  return htmlResponse('Dashboard', content, 'Dashboard');
}

async function usersPage(db) {
  const users = await rows(db, `SELECT u.*, COALESCE(GROUP_CONCAT(r.name, ', '), '—') AS roles
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id=u.id
    LEFT JOIN roles r ON r.id=ur.role_id
    GROUP BY u.id ORDER BY u.display_name`);
  const roles = await rows(db, 'SELECT id, name FROM roles ORDER BY name');

  const table = users.length ? `<table><thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${users.map((u) => `
    <tr><td><a href="/users/${u.id}/edit"><strong>${h(u.display_name)}</strong></a></td><td>${h(u.username)}</td><td>${h(u.email || '—')}</td><td>${h(u.roles)}</td><td>${statusBadge(u.is_active)}</td><td class="text-right">
      <a class="button secondary" href="/users/${u.id}/edit">Edit</a>
      <form class="inline-form" method="post" action="/users/${u.id}/toggle"><button class="secondary" type="submit">${u.is_active ? 'Deactivate' : 'Reactivate'}</button></form>
    </td></tr>`).join('')}</tbody></table>` : '<div class="empty">No users have been created yet.</div>';

  const content = `${pageHeader('Users', 'Portal identities and role assignments.')}
  <div class="table-card">${table}</div>
  <div class="form-card section-gap"><h2>Create User</h2>
    <form method="post" action="/users">
      <label>Username<input name="username" required maxlength="100"></label>
      <label>Display Name<input name="display_name" required maxlength="100"></label>
      <label>Email<input name="email" type="email" maxlength="200"></label>
      <label>Role<select name="role_id" required>${options(roles)}</select></label>
      <div class="action-bar"><button type="submit">Create User</button></div>
    </form>
  </div>`;
  return htmlResponse('Users', content, 'Users');
}

async function createUser(request, db) {
  const form = await request.formData();
  const username = String(form.get('username') || '').trim();
  const displayName = String(form.get('display_name') || '').trim();
  const email = String(form.get('email') || '').trim() || null;
  const roleId = Number(form.get('role_id'));
  if (!username || !displayName || !roleId) return htmlResponse('Invalid User', pageHeader('Invalid User', 'Username, display name and role are required.'), 'Users', 400);
  const result = await db.prepare('INSERT INTO users (username, display_name, email) VALUES (?, ?, ?)').bind(username, displayName, email).run();
  const userId = result.meta?.last_row_id;
  if (userId) await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').bind(userId, roleId).run();
  return redirect(request, '/users');
}

async function editUserPage(db, id) {
  const user = await row(db, `SELECT u.*, ur.role_id FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id WHERE u.id=?`, id);
  if (!user) return notFound();
  const roles = await rows(db, 'SELECT id, name FROM roles ORDER BY name');
  const content = `${pageHeader('Edit User', 'Update portal identity and role assignment.')}
    <div class="form-card"><form method="post" action="/users/${id}/edit">
      <label>Username<input name="username" required maxlength="100" value="${h(user.username)}"></label>
      <label>Display Name<input name="display_name" required maxlength="100" value="${h(user.display_name)}"></label>
      <label>Email<input name="email" type="email" maxlength="200" value="${h(user.email || '')}"></label>
      <label>Role<select name="role_id" required>${options(roles, user.role_id)}</select></label>
      <label class="checkbox-label"><input type="checkbox" name="is_active" ${checked(user.is_active)}> Active</label>
      <div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/users">Cancel</a></div>
    </form></div>`;
  return htmlResponse('Edit User', content, 'Users');
}

async function updateUser(request, db, id) {
  const form = await request.formData();
  const username = String(form.get('username') || '').trim();
  const displayName = String(form.get('display_name') || '').trim();
  const email = String(form.get('email') || '').trim() || null;
  const roleId = Number(form.get('role_id'));
  const isActive = form.has('is_active') ? 1 : 0;
  await db.prepare('UPDATE users SET username=?, display_name=?, email=?, is_active=? WHERE id=?').bind(username, displayName, email, isActive, id).run();
  await db.prepare('DELETE FROM user_roles WHERE user_id=?').bind(id).run();
  await db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').bind(id, roleId).run();
  return redirect(request, '/users');
}

async function toggleUser(request, db, id) {
  await db.prepare('UPDATE users SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request, '/users');
}

async function teamsPage(db) {
  const teams = await rows(db, `SELECT t.*, d.name AS department_name, rp.name AS pattern_name,
    SUM(CASE WHEN e.is_active=1 THEN 1 ELSE 0 END) AS member_count
    FROM teams t JOIN departments d ON d.id=t.department_id
    LEFT JOIN rota_patterns rp ON rp.id=t.default_rota_pattern_id
    LEFT JOIN employees e ON e.team_id=t.id
    GROUP BY t.id ORDER BY d.name, t.name`);
  const departments = await rows(db, 'SELECT id, name FROM departments WHERE is_active=1 ORDER BY name');
  const patterns = await rows(db, 'SELECT id, name FROM rota_patterns WHERE is_active=1 ORDER BY name');
  const table = teams.length ? `<table><thead><tr><th>Team</th><th>Department</th><th>Members</th><th>Default Rota</th><th>Status</th><th></th></tr></thead><tbody>${teams.map((t) => `
    <tr><td><a href="/teams/${t.id}/edit"><strong>${h(t.name)}</strong></a></td><td>${h(t.department_name)}</td><td>${t.member_count ?? 0}</td><td>${h(t.pattern_name || 'No Scheduled Hours')}</td><td>${statusBadge(t.is_active)}</td><td class="text-right">
      <a class="button secondary" href="/teams/${t.id}/edit">Edit</a>
      <form class="inline-form" method="post" action="/teams/${t.id}/toggle"><button class="secondary" type="submit">${t.is_active ? 'Deactivate' : 'Reactivate'}</button></form>
    </td></tr>`).join('')}</tbody></table>` : '<div class="empty">No teams have been created yet.</div>';
  const content = `${pageHeader('Teams', 'Departments, operational teams and default rota assignments.')}
  <div class="table-card">${table}</div>
  <div class="form-card section-gap"><h2>Create Team</h2><form method="post" action="/teams">
    <label>Team Name<input name="name" required maxlength="100"></label>
    <label>Department<select name="department_id" required>${options(departments)}</select></label>
    <label>Description<textarea name="description" rows="3" maxlength="255"></textarea></label>
    <label>Default Rota Pattern<select name="default_rota_pattern_id">${options(patterns, null, true, 'No Scheduled Hours')}</select></label>
    <label>Pattern Start Date<input name="default_pattern_start_date" type="date"></label>
    <div class="action-bar"><button type="submit">Create Team</button></div></form></div>`;
  return htmlResponse('Teams', content, 'Teams');
}

async function createTeam(request, db) {
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const departmentId = Number(form.get('department_id'));
  const description = String(form.get('description') || '').trim() || null;
  let patternId = Number(form.get('default_rota_pattern_id')) || null;
  const startDate = String(form.get('default_pattern_start_date') || '').trim() || null;
  if (!patternId) patternId = (await row(db, "SELECT id FROM rota_patterns WHERE name='No Scheduled Hours'"))?.id ?? null;
  await db.prepare('INSERT INTO teams (department_id, name, description, default_rota_pattern_id, default_pattern_start_date) VALUES (?, ?, ?, ?, ?)').bind(departmentId, name, description, patternId, startDate).run();
  return redirect(request, '/teams');
}

async function editTeamPage(db, id) {
  const team = await row(db, 'SELECT * FROM teams WHERE id=?', id);
  if (!team) return notFound();
  const departments = await rows(db, 'SELECT id, name FROM departments WHERE is_active=1 OR id=? ORDER BY name', team.department_id);
  const patterns = await rows(db, 'SELECT id, name FROM rota_patterns WHERE is_active=1 OR id=? ORDER BY name', team.default_rota_pattern_id || -1);
  const content = `${pageHeader('Edit Team', 'Update organisational team details and default rota.')}
    <div class="form-card"><form method="post" action="/teams/${id}/edit">
      <label>Team Name<input name="name" required maxlength="100" value="${h(team.name)}"></label>
      <label>Department<select name="department_id" required>${options(departments, team.department_id)}</select></label>
      <label>Description<textarea name="description" rows="3" maxlength="255">${h(team.description || '')}</textarea></label>
      <label>Default Rota Pattern<select name="default_rota_pattern_id" required>${options(patterns, team.default_rota_pattern_id)}</select></label>
      <label>Pattern Start Date<input name="default_pattern_start_date" type="date" value="${h(team.default_pattern_start_date || '')}"></label>
      <label class="checkbox-label"><input type="checkbox" name="is_active" ${checked(team.is_active)}> Active</label>
      <div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/teams">Cancel</a></div>
    </form></div>`;
  return htmlResponse('Edit Team', content, 'Teams');
}

async function updateTeam(request, db, id) {
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const departmentId = Number(form.get('department_id'));
  const description = String(form.get('description') || '').trim() || null;
  const patternId = Number(form.get('default_rota_pattern_id')) || null;
  const startDate = String(form.get('default_pattern_start_date') || '').trim() || null;
  const isActive = form.has('is_active') ? 1 : 0;
  await db.prepare('UPDATE teams SET department_id=?, name=?, description=?, default_rota_pattern_id=?, default_pattern_start_date=?, is_active=? WHERE id=?')
    .bind(departmentId, name, description, patternId, startDate, isActive, id).run();
  return redirect(request, '/teams');
}

async function toggleTeam(request, db, id) {
  await db.prepare('UPDATE teams SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request, '/teams');
}

async function employeesPage(db) {
  const employees = await rows(db, `SELECT e.*, t.name AS team_name, u.username,
    COALESCE(orp.name, trp.name, 'No Scheduled Hours') AS effective_pattern
    FROM employees e JOIN teams t ON t.id=e.team_id
    LEFT JOIN users u ON u.id=e.user_id LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id ORDER BY e.display_name`);
  const teams = await rows(db, 'SELECT id, name FROM teams WHERE is_active=1 ORDER BY name');
  const users = await rows(db, `SELECT u.id, u.display_name || ' (' || u.username || ')' AS name FROM users u LEFT JOIN employees e ON e.user_id=u.id WHERE u.is_active=1 AND e.id IS NULL ORDER BY u.display_name`);
  const patterns = await rows(db, "SELECT id, name FROM rota_patterns WHERE is_active=1 AND name <> 'No Scheduled Hours' ORDER BY name");
  const table = employees.length ? `<table><thead><tr><th>Employee</th><th>Job Title</th><th>Team</th><th>User</th><th>Rota</th><th>Status</th><th></th></tr></thead><tbody>${employees.map((e) => `
    <tr><td><a href="/employees/${e.id}/edit"><strong>${h(e.display_name)}</strong></a></td><td>${h(e.job_title || '—')}</td><td>${h(e.team_name)}</td><td>${h(e.username || '—')}</td><td>${h(e.effective_pattern)}</td><td>${statusBadge(e.is_active)}</td><td class="text-right">
      <a class="button secondary" href="/employees/${e.id}/edit">Edit</a>
      <form class="inline-form" method="post" action="/employees/${e.id}/toggle"><button class="secondary" type="submit">${e.is_active ? 'Deactivate' : 'Reactivate'}</button></form>
    </td></tr>`).join('')}</tbody></table>` : '<div class="empty">No employees have been created yet.</div>';
  const content = `${pageHeader('Employees', 'People, team membership and optional portal-user links.')}
  <div class="table-card">${table}</div>
  <div class="form-card section-gap"><h2>Create Employee</h2><form method="post" action="/employees">
    <label>Display Name<input name="display_name" required maxlength="100"></label>
    <label>Team<select name="team_id" required>${options(teams)}</select></label>
    <label>User Account<select name="user_id">${options(users, null, true, '— No linked user —')}</select></label>
    <label>Job Title<input name="job_title" maxlength="100"></label><label>Phone<input name="phone" maxlength="50"></label>
    <label>Rota Override<select name="override_rota_pattern_id">${options(patterns, null, true, '— Inherit team default —')}</select></label>
    <label>Override Start Date<input name="override_pattern_start_date" type="date"></label>
    <div class="action-bar"><button type="submit">Create Employee</button></div></form></div>`;
  return htmlResponse('Employees', content, 'Employees');
}

async function createEmployee(request, db) {
  const form = await request.formData();
  await db.prepare(`INSERT INTO employees (user_id, team_id, display_name, job_title, phone, override_rota_pattern_id, override_pattern_start_date) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(Number(form.get('user_id')) || null, Number(form.get('team_id')), String(form.get('display_name') || '').trim(), String(form.get('job_title') || '').trim() || null, String(form.get('phone') || '').trim() || null, Number(form.get('override_rota_pattern_id')) || null, String(form.get('override_pattern_start_date') || '').trim() || null).run();
  return redirect(request, '/employees');
}

async function editEmployeePage(db, id) {
  const employee = await row(db, 'SELECT * FROM employees WHERE id=?', id);
  if (!employee) return notFound();
  const teams = await rows(db, 'SELECT id, name FROM teams WHERE is_active=1 OR id=? ORDER BY name', employee.team_id);
  const users = await rows(db, `SELECT u.id, u.display_name || ' (' || u.username || ')' AS name FROM users u LEFT JOIN employees e ON e.user_id=u.id AND e.id<>? WHERE u.is_active=1 AND e.id IS NULL ORDER BY u.display_name`, id);
  const patterns = await rows(db, "SELECT id, name FROM rota_patterns WHERE is_active=1 AND name <> 'No Scheduled Hours' ORDER BY name");
  const content = `${pageHeader('Edit Employee', 'Update employee details, team membership and rota override.')}
    <div class="form-card"><form method="post" action="/employees/${id}/edit">
      <label>Display Name<input name="display_name" required maxlength="100" value="${h(employee.display_name)}"></label>
      <label>Team<select name="team_id" required>${options(teams, employee.team_id)}</select></label>
      <label>User Account<select name="user_id">${options(users, employee.user_id, true, '— No linked user —')}</select></label>
      <label>Job Title<input name="job_title" maxlength="100" value="${h(employee.job_title || '')}"></label>
      <label>Phone<input name="phone" maxlength="50" value="${h(employee.phone || '')}"></label>
      <label>Rota Override<select name="override_rota_pattern_id">${options(patterns, employee.override_rota_pattern_id, true, '— Inherit team default —')}</select></label>
      <label>Override Start Date<input name="override_pattern_start_date" type="date" value="${h(employee.override_pattern_start_date || '')}"></label>
      <label class="checkbox-label"><input type="checkbox" name="is_active" ${checked(employee.is_active)}> Active</label>
      <div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/employees">Cancel</a></div>
    </form></div>`;
  return htmlResponse('Edit Employee', content, 'Employees');
}

async function updateEmployee(request, db, id) {
  const form = await request.formData();
  await db.prepare(`UPDATE employees SET user_id=?, team_id=?, display_name=?, job_title=?, phone=?, override_rota_pattern_id=?, override_pattern_start_date=?, is_active=? WHERE id=?`)
    .bind(Number(form.get('user_id')) || null, Number(form.get('team_id')), String(form.get('display_name') || '').trim(), String(form.get('job_title') || '').trim() || null, String(form.get('phone') || '').trim() || null, Number(form.get('override_rota_pattern_id')) || null, String(form.get('override_pattern_start_date') || '').trim() || null, form.has('is_active') ? 1 : 0, id).run();
  return redirect(request, '/employees');
}

async function toggleEmployee(request, db, id) {
  await db.prepare('UPDATE employees SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request, '/employees');
}

async function shiftPatternsPage(db) {
  const shifts = await rows(db, 'SELECT * FROM shift_types ORDER BY is_working_day, start_time, name');
  const weekPatterns = await rows(db, 'SELECT * FROM week_patterns ORDER BY name');
  const weekDays = await rows(db, `SELECT wpd.week_pattern_id, wpd.day_of_week, st.code FROM week_pattern_days wpd JOIN shift_types st ON st.id=wpd.shift_type_id ORDER BY wpd.week_pattern_id, wpd.day_of_week`);
  const rotaPatterns = await rows(db, `SELECT rp.*, GROUP_CONCAT(wp.name, ' → ') AS weeks FROM rota_patterns rp LEFT JOIN rota_pattern_weeks rpw ON rpw.rota_pattern_id=rp.id LEFT JOIN week_patterns wp ON wp.id=rpw.week_pattern_id GROUP BY rp.id ORDER BY rp.name`);
  const daysByWeek = new Map();
  for (const d of weekDays) { if (!daysByWeek.has(d.week_pattern_id)) daysByWeek.set(d.week_pattern_id, []); daysByWeek.get(d.week_pattern_id)[d.day_of_week] = d.code; }

  const shiftTable = `<table><thead><tr><th>Shift</th><th>Code</th><th>Start</th><th>End</th><th>Working Day</th><th></th></tr></thead><tbody>${shifts.map((s) => `<tr><td>${h(s.name)}</td><td>${h(s.code)}</td><td>${h(s.start_time || '—')}</td><td>${h(s.end_time || '—')}</td><td>${s.is_working_day ? 'Yes' : 'No'}</td><td><a class="button secondary" href="/shift-types/${s.id}/edit">Edit</a></td></tr>`).join('')}</tbody></table>`;
  const weekTable = `<table><thead><tr><th>Week Pattern</th>${DAY_NAMES.map((d) => `<th>${d.slice(0,3)}</th>`).join('')}<th></th></tr></thead><tbody>${weekPatterns.map((p) => { const days=daysByWeek.get(p.id)||[]; return `<tr><td><strong>${h(p.name)}</strong><br><span class="muted">${h(p.description || '')}</span></td>${DAY_NAMES.map((_,i)=>`<td>${h(days[i] || '—')}</td>`).join('')}<td><a class="button secondary" href="/week-patterns/${p.id}/edit">Edit</a></td></tr>`; }).join('')}</tbody></table>`;
  const rotaTable = `<table><thead><tr><th>Rota Pattern</th><th>Cycle</th><th>Weeks</th><th>Status</th><th></th></tr></thead><tbody>${rotaPatterns.map((p)=>`<tr><td><strong>${h(p.name)}</strong><br><span class="muted">${h(p.description || '')}</span></td><td>${p.cycle_length_weeks} week${p.cycle_length_weeks===1?'':'s'}</td><td>${h(p.weeks || '—')}</td><td>${statusBadge(p.is_active)}</td><td><a class="button secondary" href="/rota-patterns/${p.id}/edit">Edit</a></td></tr>`).join('')}</tbody></table>`;
  const shiftChoices = shifts.map((s)=>({id:s.id,name:`${s.name}${s.start_time?` (${s.start_time}–${s.end_time})`:''}`}));
  const weekChoices = weekPatterns.map((w)=>({id:w.id,name:w.name}));
  const dayFields = DAY_NAMES.map((day,i)=>`<label>${day}<select name="day_${i}" required>${options(shiftChoices)}</select></label>`).join('');
  const rotaWeekFields = Array.from({length:MAX_CYCLE_WEEKS},(_,i)=>`<label>Week ${i+1}<select name="week_${i+1}">${options(weekChoices,null,true,'— Not used —')}</select></label>`).join('');

  const content = `${pageHeader('Shift Patterns', 'Build reusable weeks, then combine those weeks into repeating rota cycles.')}
    <div class="card"><h2>Shift Types</h2>${shiftTable}</div>
    <div class="card section-gap"><h2>Week Patterns</h2>${weekTable}</div>
    <div class="form-card section-gap"><h2>Create Week Pattern</h2><form method="post" action="/week-patterns">
      <label>Week Name<input name="name" required maxlength="100"></label><label>Description<textarea name="description" rows="2" maxlength="255"></textarea></label>
      <div class="pattern-days">${dayFields}</div><div class="action-bar"><button type="submit">Create Week Pattern</button></div></form></div>
    <div class="card section-gap"><h2>Rota Patterns</h2>${rotaTable}</div>
    <div class="form-card section-gap"><h2>Create Rota Pattern</h2><form method="post" action="/rota-patterns">
      <label>Pattern Name<input name="name" required maxlength="100"></label><label>Description<textarea name="description" rows="2" maxlength="255"></textarea></label>
      <label>Cycle Length<select name="cycle_length_weeks" required>${Array.from({length:MAX_CYCLE_WEEKS},(_,i)=>`<option value="${i+1}">${i+1} week${i?'s':''}</option>`).join('')}</select></label>
      ${rotaWeekFields}<div class="notice">Only the first number of weeks selected by Cycle Length are used.</div>
      <div class="action-bar"><button type="submit">Create Rota Pattern</button></div></form></div>`;
  return htmlResponse('Shift Patterns', content, 'Shift Patterns');
}

async function createWeekPattern(request, db) {
  const form = await request.formData();
  const result = await db.prepare('INSERT INTO week_patterns (name, description) VALUES (?, ?)').bind(String(form.get('name')||'').trim(), String(form.get('description')||'').trim()||null).run();
  const id = result.meta?.last_row_id;
  const statements=[]; for(let i=0;i<7;i++) statements.push(db.prepare('INSERT INTO week_pattern_days (week_pattern_id, shift_type_id, day_of_week) VALUES (?, ?, ?)').bind(id, Number(form.get(`day_${i}`)), i));
  await db.batch(statements); return redirect(request,'/shift-patterns');
}

async function editWeekPatternPage(db,id) {
  const pattern=await row(db,'SELECT * FROM week_patterns WHERE id=?',id); if(!pattern) return notFound();
  const shifts=await rows(db,'SELECT id,name,start_time,end_time FROM shift_types WHERE is_active=1 ORDER BY is_working_day,start_time,name');
  const days=await rows(db,'SELECT day_of_week,shift_type_id FROM week_pattern_days WHERE week_pattern_id=? ORDER BY day_of_week',id); const map=new Map(days.map(d=>[d.day_of_week,d.shift_type_id]));
  const choices=shifts.map(s=>({id:s.id,name:`${s.name}${s.start_time?` (${s.start_time}–${s.end_time})`:''}`}));
  const fields=DAY_NAMES.map((day,i)=>`<label>${day}<select name="day_${i}" required>${options(choices,map.get(i))}</select></label>`).join('');
  const content=`${pageHeader('Edit Week Pattern','Changes affect every rota pattern that uses this week.')}
    <div class="form-card"><form method="post" action="/week-patterns/${id}/edit"><label>Week Name<input name="name" required value="${h(pattern.name)}"></label><label>Description<textarea name="description" rows="2">${h(pattern.description||'')}</textarea></label><div class="pattern-days">${fields}</div><label class="checkbox-label"><input type="checkbox" name="is_active" ${checked(pattern.is_active)}> Active</label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/shift-patterns">Cancel</a></div></form></div>`;
  return htmlResponse('Edit Week Pattern',content,'Shift Patterns');
}

async function updateWeekPattern(request,db,id){
  const form=await request.formData(); await db.prepare('UPDATE week_patterns SET name=?,description=?,is_active=? WHERE id=?').bind(String(form.get('name')||'').trim(),String(form.get('description')||'').trim()||null,form.has('is_active')?1:0,id).run();
  const statements=[]; for(let i=0;i<7;i++) statements.push(db.prepare('INSERT INTO week_pattern_days (week_pattern_id,shift_type_id,day_of_week) VALUES (?,?,?) ON CONFLICT(week_pattern_id,day_of_week) DO UPDATE SET shift_type_id=excluded.shift_type_id').bind(id,Number(form.get(`day_${i}`)),i)); await db.batch(statements); return redirect(request,'/shift-patterns');
}

async function createRotaPattern(request,db){
  const form=await request.formData(); const length=Math.max(1,Math.min(MAX_CYCLE_WEEKS,Number(form.get('cycle_length_weeks'))||1));
  const result=await db.prepare('INSERT INTO rota_patterns (name,description,cycle_length_weeks) VALUES (?,?,?)').bind(String(form.get('name')||'').trim(),String(form.get('description')||'').trim()||null,length).run(); const id=result.meta?.last_row_id;
  const statements=[]; for(let i=1;i<=length;i++){const weekId=Number(form.get(`week_${i}`)); if(!weekId) throw new Error(`Week ${i} must be selected.`); statements.push(db.prepare('INSERT INTO rota_pattern_weeks (rota_pattern_id,week_number,week_pattern_id) VALUES (?,?,?)').bind(id,i,weekId));} await db.batch(statements); return redirect(request,'/shift-patterns');
}

async function editRotaPatternPage(db,id){
  const pattern=await row(db,'SELECT * FROM rota_patterns WHERE id=?',id); if(!pattern) return notFound();
  const weeks=await rows(db,'SELECT id,name FROM week_patterns WHERE is_active=1 ORDER BY name'); const assignments=await rows(db,'SELECT week_number,week_pattern_id FROM rota_pattern_weeks WHERE rota_pattern_id=? ORDER BY week_number',id); const map=new Map(assignments.map(a=>[a.week_number,a.week_pattern_id]));
  const fields=Array.from({length:MAX_CYCLE_WEEKS},(_,i)=>`<label>Week ${i+1}<select name="week_${i+1}">${options(weeks,map.get(i+1),true,'— Not used —')}</select></label>`).join('');
  const content=`${pageHeader('Edit Rota Pattern','Arrange reusable week patterns into a repeating cycle.')}
    <div class="form-card"><form method="post" action="/rota-patterns/${id}/edit"><label>Pattern Name<input name="name" required value="${h(pattern.name)}"></label><label>Description<textarea name="description" rows="2">${h(pattern.description||'')}</textarea></label><label>Cycle Length<select name="cycle_length_weeks">${Array.from({length:MAX_CYCLE_WEEKS},(_,i)=>`<option value="${i+1}" ${pattern.cycle_length_weeks===i+1?'selected':''}>${i+1} week${i?'s':''}</option>`).join('')}</select></label>${fields}<label class="checkbox-label"><input type="checkbox" name="is_active" ${checked(pattern.is_active)}> Active</label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/shift-patterns">Cancel</a></div></form></div>`;
  return htmlResponse('Edit Rota Pattern',content,'Shift Patterns');
}

async function updateRotaPattern(request,db,id){
  const form=await request.formData(); const length=Math.max(1,Math.min(MAX_CYCLE_WEEKS,Number(form.get('cycle_length_weeks'))||1));
  await db.prepare('UPDATE rota_patterns SET name=?,description=?,cycle_length_weeks=?,is_active=? WHERE id=?').bind(String(form.get('name')||'').trim(),String(form.get('description')||'').trim()||null,length,form.has('is_active')?1:0,id).run();
  await db.prepare('DELETE FROM rota_pattern_weeks WHERE rota_pattern_id=?').bind(id).run(); const statements=[]; for(let i=1;i<=length;i++){const weekId=Number(form.get(`week_${i}`)); if(!weekId) throw new Error(`Week ${i} must be selected.`); statements.push(db.prepare('INSERT INTO rota_pattern_weeks (rota_pattern_id,week_number,week_pattern_id) VALUES (?,?,?)').bind(id,i,weekId));} await db.batch(statements); return redirect(request,'/shift-patterns');
}

async function editShiftTypePage(db,id){
  const shift=await row(db,'SELECT * FROM shift_types WHERE id=?',id); if(!shift) return notFound();
  const content=`${pageHeader('Edit Shift Type','Update shift label and working hours.')}
    <div class="form-card"><form method="post" action="/shift-types/${id}/edit"><label>Name<input name="name" required value="${h(shift.name)}"></label><label>Code<input name="code" required value="${h(shift.code)}"></label><label>Start Time<input name="start_time" type="time" value="${h(shift.start_time||'')}"></label><label>End Time<input name="end_time" type="time" value="${h(shift.end_time||'')}"></label><label class="checkbox-label"><input type="checkbox" name="is_working_day" ${checked(shift.is_working_day)}> Working day</label><label class="checkbox-label"><input type="checkbox" name="is_active" ${checked(shift.is_active)}> Active</label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/shift-patterns">Cancel</a></div></form></div>`;
  return htmlResponse('Edit Shift Type',content,'Shift Patterns');
}

async function updateShiftType(request,db,id){const form=await request.formData(); await db.prepare('UPDATE shift_types SET name=?,code=?,start_time=?,end_time=?,is_working_day=?,is_active=? WHERE id=?').bind(String(form.get('name')||'').trim(),String(form.get('code')||'').trim().toUpperCase(),String(form.get('start_time')||'').trim()||null,String(form.get('end_time')||'').trim()||null,form.has('is_working_day')?1:0,form.has('is_active')?1:0,id).run(); return redirect(request,'/shift-patterns');}

function cycleWeek(startDate,cycleLength){
  if(!startDate||!cycleLength) return 1; const start=new Date(`${startDate}T00:00:00Z`); if(Number.isNaN(start.getTime())) return 1; const now=new Date(); const today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()); const diffWeeks=Math.floor((today-start.getTime())/(7*86400000)); return ((Math.max(0,diffWeeks)%cycleLength)+1);
}

async function rotaPage(db) {
  const employees = await rows(db, `SELECT e.id,e.display_name,t.name AS team_name,
    COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) AS pattern_id,
    COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) AS pattern_start_date,
    COALESCE(orp.name,trp.name,'No Scheduled Hours') AS pattern_name,
    COALESCE(orp.cycle_length_weeks,trp.cycle_length_weeks,1) AS cycle_length_weeks
    FROM employees e JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id
    WHERE e.is_active=1 ORDER BY t.name,e.display_name`);
  const assignments=await rows(db,`SELECT rpw.rota_pattern_id,rpw.week_number,wpd.day_of_week,st.code,st.name FROM rota_pattern_weeks rpw JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id JOIN shift_types st ON st.id=wpd.shift_type_id ORDER BY rpw.rota_pattern_id,rpw.week_number,wpd.day_of_week`);
  const map=new Map(); for(const a of assignments){const key=`${a.rota_pattern_id}:${a.week_number}`; if(!map.has(key)) map.set(key,[]); map.get(key)[a.day_of_week]=a;}
  const table=employees.length?`<table><thead><tr><th>Employee</th><th>Team</th><th>Pattern</th><th>Cycle Week</th>${DAY_NAMES.map(d=>`<th>${d.slice(0,3)}</th>`).join('')}</tr></thead><tbody>${employees.map(e=>{const week=cycleWeek(e.pattern_start_date,Number(e.cycle_length_weeks)||1); const days=map.get(`${e.pattern_id}:${week}`)||[]; return `<tr><td>${h(e.display_name)}</td><td>${h(e.team_name)}</td><td>${h(e.pattern_name)}</td><td>${week} / ${e.cycle_length_weeks}</td>${DAY_NAMES.map((_,i)=>`<td title="${h(days[i]?.name||'')}">${h(days[i]?.code||'OFF')}</td>`).join('')}</tr>`;}).join('')}</tbody></table>`:'<div class="empty">Create employees and teams to populate the rota.</div>';
  const content=`${pageHeader('Rota','Current effective rota week by employee.')}<div class="notice">The displayed week is calculated from the team default or employee override start date. If no start date is set, Week 1 is shown.</div><div class="table-card rota-table">${table}</div>`;
  return htmlResponse('Rota',content,'Rota');
}

async function administrationPage(db) {
  const roles = await rows(db, `SELECT r.name,r.description,GROUP_CONCAT(p.code, ', ') AS permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id GROUP BY r.id ORDER BY r.name`);
  const permissions = await rows(db, 'SELECT code, description FROM permissions ORDER BY code');
  const content = `${pageHeader('Administration', 'Application configuration and RBAC reference.')}
    <div class="card-grid"><article class="card"><h2>Roles</h2>${roles.map((r)=>`<p><strong>${h(r.name)}</strong><br><span class="muted">${h(r.description||'')}</span><br><small>${h(r.permissions||'No permissions')}</small></p>`).join('')}</article><article class="card"><h2>Permissions</h2>${permissions.map((p)=>`<p><strong>${h(p.code)}</strong><br><span class="muted">${h(p.description||'')}</span></p>`).join('')}</article></div>
    <div class="notice section-gap"><strong>Authentication:</strong> intentionally not enabled in UAT yet. Cloudflare Access/OIDC will become the outer identity layer, with SupportApp retaining application RBAC.</div>`;
  return htmlResponse('Administration', content, 'Administration');
}

async function notFound() { return htmlResponse('Not Found', `${pageHeader('Page not found', 'The requested SupportApp route does not exist.')}<div class="action-bar"><a class="button" href="/">Return to dashboard</a></div>`, '', 404); }
function errorPage(error) { return htmlResponse('Error', `${pageHeader('SupportApp Error', 'The request could not be completed.')}<div class="notice"><strong>Technical detail</strong><br><code>${h(error?.message || error)}</code></div><div class="action-bar"><a class="button" href="/">Return to dashboard</a></div>`, '', 500); }

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error('D1 binding DB is not available to this Worker deployment.');
      await ensureSchema(env.DB);
      const url = new URL(request.url); const path = url.pathname.replace(/\/$/, '') || '/'; const method = request.method.toUpperCase();

      if (method==='GET' && path==='/') return dashboardPage(env.DB);
      if (method==='GET' && path==='/users') return usersPage(env.DB);
      if (method==='POST' && path==='/users') return createUser(request,env.DB);
      if (method==='GET' && /^\/users\/\d+\/edit$/.test(path)) return editUserPage(env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/users\/\d+\/edit$/.test(path)) return updateUser(request,env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/users\/\d+\/toggle$/.test(path)) return toggleUser(request,env.DB,Number(path.split('/')[2]));

      if (method==='GET' && path==='/teams') return teamsPage(env.DB);
      if (method==='POST' && path==='/teams') return createTeam(request,env.DB);
      if (method==='GET' && /^\/teams\/\d+\/edit$/.test(path)) return editTeamPage(env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/teams\/\d+\/edit$/.test(path)) return updateTeam(request,env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/teams\/\d+\/toggle$/.test(path)) return toggleTeam(request,env.DB,Number(path.split('/')[2]));

      if (method==='GET' && path==='/employees') return employeesPage(env.DB);
      if (method==='POST' && path==='/employees') return createEmployee(request,env.DB);
      if (method==='GET' && /^\/employees\/\d+\/edit$/.test(path)) return editEmployeePage(env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/employees\/\d+\/edit$/.test(path)) return updateEmployee(request,env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/employees\/\d+\/toggle$/.test(path)) return toggleEmployee(request,env.DB,Number(path.split('/')[2]));

      if (method==='GET' && path==='/shift-patterns') return shiftPatternsPage(env.DB);
      if (method==='POST' && path==='/week-patterns') return createWeekPattern(request,env.DB);
      if (method==='GET' && /^\/week-patterns\/\d+\/edit$/.test(path)) return editWeekPatternPage(env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/week-patterns\/\d+\/edit$/.test(path)) return updateWeekPattern(request,env.DB,Number(path.split('/')[2]));
      if (method==='POST' && path==='/rota-patterns') return createRotaPattern(request,env.DB);
      if (method==='GET' && /^\/rota-patterns\/\d+\/edit$/.test(path)) return editRotaPatternPage(env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/rota-patterns\/\d+\/edit$/.test(path)) return updateRotaPattern(request,env.DB,Number(path.split('/')[2]));
      if (method==='GET' && /^\/shift-types\/\d+\/edit$/.test(path)) return editShiftTypePage(env.DB,Number(path.split('/')[2]));
      if (method==='POST' && /^\/shift-types\/\d+\/edit$/.test(path)) return updateShiftType(request,env.DB,Number(path.split('/')[2]));

      if (method==='GET' && path==='/rota') return rotaPage(env.DB);
      if (method==='GET' && path==='/administration') return administrationPage(env.DB);
      return notFound();
    } catch (error) {
      console.error(error);
      return errorPage(error);
    }
  },
};
