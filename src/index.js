import { ensureSchema } from './schema.js';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

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

async function dashboardPage(db) {
  const counts = await row(db, `SELECT
    (SELECT COUNT(*) FROM users WHERE is_active=1) AS users,
    (SELECT COUNT(*) FROM teams WHERE is_active=1) AS teams,
    (SELECT COUNT(*) FROM employees WHERE is_active=1) AS employees,
    (SELECT COUNT(*) FROM rota_patterns WHERE is_active=1) AS patterns`);

  const content = `${pageHeader('Support Dashboard', 'Support administration and rota management.')}
  <div class="notice"><strong>Cloudflare-native UAT</strong><br>The D1-backed administration modules are now live. Authentication and production hardening remain to be added.</div>
  <div class="card-grid">
    <article class="card"><h2>Employees</h2><p class="muted">People currently represented in SupportApp.</p><div class="metric">${counts?.employees ?? 0}</div><a class="button" href="/employees">Manage employees</a></article>
    <article class="card"><h2>Teams</h2><p class="muted">Departments and operational teams.</p><div class="metric">${counts?.teams ?? 0}</div><a class="button" href="/teams">Manage teams</a></article>
    <article class="card"><h2>Users</h2><p class="muted">Portal identities and role assignments.</p><div class="metric">${counts?.users ?? 0}</div><a class="button" href="/users">Manage users</a></article>
    <article class="card"><h2>Rota Patterns</h2><p class="muted">Reusable weekly working patterns.</p><div class="metric">${counts?.patterns ?? 0}</div><a class="button" href="/shift-patterns">Manage patterns</a></article>
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
    <tr><td>${h(u.display_name)}</td><td>${h(u.username)}</td><td>${h(u.email || '—')}</td><td>${h(u.roles)}</td><td>${statusBadge(u.is_active)}</td><td>
      <form method="post" action="/users/${u.id}/toggle"><button class="secondary" type="submit">${u.is_active ? 'Deactivate' : 'Reactivate'}</button></form>
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

async function toggleUser(request, db, id) {
  await db.prepare('UPDATE users SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request, '/users');
}

async function teamsPage(db) {
  const teams = await rows(db, `SELECT t.*, d.name AS department_name, rp.name AS pattern_name,
    SUM(CASE WHEN e.is_active=1 THEN 1 ELSE 0 END) AS member_count
    FROM teams t
    JOIN departments d ON d.id=t.department_id
    LEFT JOIN rota_patterns rp ON rp.id=t.default_rota_pattern_id
    LEFT JOIN employees e ON e.team_id=t.id
    GROUP BY t.id ORDER BY d.name, t.name`);
  const departments = await rows(db, 'SELECT id, name FROM departments WHERE is_active=1 ORDER BY name');
  const patterns = await rows(db, 'SELECT id, name FROM rota_patterns WHERE is_active=1 ORDER BY name');

  const table = teams.length ? `<table><thead><tr><th>Team</th><th>Department</th><th>Members</th><th>Default Rota</th><th>Status</th><th></th></tr></thead><tbody>${teams.map((t) => `
    <tr><td>${h(t.name)}</td><td>${h(t.department_name)}</td><td>${t.member_count ?? 0}</td><td>${h(t.pattern_name || 'No Scheduled Hours')}</td><td>${statusBadge(t.is_active)}</td><td>
      <form method="post" action="/teams/${t.id}/toggle"><button class="secondary" type="submit">${t.is_active ? 'Deactivate' : 'Reactivate'}</button></form>
    </td></tr>`).join('')}</tbody></table>` : '<div class="empty">No teams have been created yet.</div>';

  const content = `${pageHeader('Teams', 'Departments, operational teams and default rota assignments.')}
  <div class="table-card">${table}</div>
  <div class="form-card section-gap"><h2>Create Team</h2>
    <form method="post" action="/teams">
      <label>Team Name<input name="name" required maxlength="100"></label>
      <label>Department<select name="department_id" required>${options(departments)}</select></label>
      <label>Description<textarea name="description" rows="3" maxlength="255"></textarea></label>
      <label>Default Rota Pattern<select name="default_rota_pattern_id">${options(patterns, null, true, 'No Scheduled Hours')}</select></label>
      <label>Pattern Start Date<input name="default_pattern_start_date" type="date"></label>
      <div class="action-bar"><button type="submit">Create Team</button></div>
    </form>
  </div>`;
  return htmlResponse('Teams', content, 'Teams');
}

async function createTeam(request, db) {
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const departmentId = Number(form.get('department_id'));
  const description = String(form.get('description') || '').trim() || null;
  let patternId = Number(form.get('default_rota_pattern_id')) || null;
  const startDate = String(form.get('default_pattern_start_date') || '').trim() || null;
  if (!patternId) {
    const nullPattern = await row(db, "SELECT id FROM rota_patterns WHERE name='No Scheduled Hours'");
    patternId = nullPattern?.id ?? null;
  }
  await db.prepare('INSERT INTO teams (department_id, name, description, default_rota_pattern_id, default_pattern_start_date) VALUES (?, ?, ?, ?, ?)')
    .bind(departmentId, name, description, patternId, startDate).run();
  return redirect(request, '/teams');
}

async function toggleTeam(request, db, id) {
  await db.prepare('UPDATE teams SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request, '/teams');
}

async function employeesPage(db) {
  const employees = await rows(db, `SELECT e.*, t.name AS team_name, u.username,
    COALESCE(orp.name, trp.name, 'No Scheduled Hours') AS effective_pattern
    FROM employees e
    JOIN teams t ON t.id=e.team_id
    LEFT JOIN users u ON u.id=e.user_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id
    ORDER BY e.display_name`);
  const teams = await rows(db, 'SELECT id, name FROM teams WHERE is_active=1 ORDER BY name');
  const users = await rows(db, `SELECT u.id, u.display_name || ' (' || u.username || ')' AS name
    FROM users u LEFT JOIN employees e ON e.user_id=u.id WHERE u.is_active=1 AND e.id IS NULL ORDER BY u.display_name`);
  const patterns = await rows(db, "SELECT id, name FROM rota_patterns WHERE is_active=1 AND name <> 'No Scheduled Hours' ORDER BY name");

  const table = employees.length ? `<table><thead><tr><th>Employee</th><th>Job Title</th><th>Team</th><th>User</th><th>Rota</th><th>Status</th><th></th></tr></thead><tbody>${employees.map((e) => `
    <tr><td>${h(e.display_name)}</td><td>${h(e.job_title || '—')}</td><td>${h(e.team_name)}</td><td>${h(e.username || '—')}</td><td>${h(e.effective_pattern)}</td><td>${statusBadge(e.is_active)}</td><td>
      <form method="post" action="/employees/${e.id}/toggle"><button class="secondary" type="submit">${e.is_active ? 'Deactivate' : 'Reactivate'}</button></form>
    </td></tr>`).join('')}</tbody></table>` : '<div class="empty">No employees have been created yet.</div>';

  const content = `${pageHeader('Employees', 'People, team membership and optional portal-user links.')}
  <div class="table-card">${table}</div>
  <div class="form-card section-gap"><h2>Create Employee</h2>
    <form method="post" action="/employees">
      <label>Display Name<input name="display_name" required maxlength="100"></label>
      <label>Team<select name="team_id" required>${options(teams)}</select></label>
      <label>User Account<select name="user_id">${options(users, null, true, '— No linked user —')}</select></label>
      <label>Job Title<input name="job_title" maxlength="100"></label>
      <label>Phone<input name="phone" maxlength="50"></label>
      <label>Rota Override<select name="override_rota_pattern_id">${options(patterns, null, true, '— Inherit team default —')}</select></label>
      <label>Override Start Date<input name="override_pattern_start_date" type="date"></label>
      <div class="action-bar"><button type="submit">Create Employee</button></div>
    </form>
  </div>`;
  return htmlResponse('Employees', content, 'Employees');
}

async function createEmployee(request, db) {
  const form = await request.formData();
  const displayName = String(form.get('display_name') || '').trim();
  const teamId = Number(form.get('team_id'));
  const userId = Number(form.get('user_id')) || null;
  const jobTitle = String(form.get('job_title') || '').trim() || null;
  const phone = String(form.get('phone') || '').trim() || null;
  const overridePatternId = Number(form.get('override_rota_pattern_id')) || null;
  const overrideStart = String(form.get('override_pattern_start_date') || '').trim() || null;
  await db.prepare(`INSERT INTO employees
    (user_id, team_id, display_name, job_title, phone, override_rota_pattern_id, override_pattern_start_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, teamId, displayName, jobTitle, phone, overridePatternId, overrideStart).run();
  return redirect(request, '/employees');
}

async function toggleEmployee(request, db, id) {
  await db.prepare('UPDATE employees SET is_active = CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request, '/employees');
}

async function shiftPatternsPage(db) {
  const shifts = await rows(db, 'SELECT * FROM shift_types ORDER BY is_working_day, start_time, name');
  const patterns = await rows(db, `SELECT rp.id, rp.name, rp.description, rp.is_active,
    GROUP_CONCAT(st.code, '|') AS shift_codes
    FROM rota_patterns rp
    LEFT JOIN rota_pattern_days rpd ON rpd.rota_pattern_id=rp.id AND rpd.week_number=1
    LEFT JOIN shift_types st ON st.id=rpd.shift_type_id
    GROUP BY rp.id ORDER BY rp.name`);
  const patternDays = await rows(db, `SELECT rpd.rota_pattern_id, rpd.day_of_week, st.code, st.name
    FROM rota_pattern_days rpd JOIN shift_types st ON st.id=rpd.shift_type_id
    WHERE rpd.week_number=1 ORDER BY rpd.rota_pattern_id, rpd.day_of_week`);
  const daysByPattern = new Map();
  for (const d of patternDays) {
    if (!daysByPattern.has(d.rota_pattern_id)) daysByPattern.set(d.rota_pattern_id, []);
    daysByPattern.get(d.rota_pattern_id)[d.day_of_week] = d;
  }

  const shiftTable = `<table><thead><tr><th>Shift</th><th>Code</th><th>Start</th><th>End</th><th>Working Day</th></tr></thead><tbody>${shifts.map((s) => `
    <tr><td>${h(s.name)}</td><td>${h(s.code)}</td><td>${h(s.start_time || '—')}</td><td>${h(s.end_time || '—')}</td><td>${s.is_working_day ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table>`;

  const patternTable = `<table><thead><tr><th>Pattern</th>${DAY_NAMES.map((d) => `<th>${d.slice(0, 3)}</th>`).join('')}</tr></thead><tbody>${patterns.map((p) => {
    const days = daysByPattern.get(p.id) || [];
    return `<tr><td><strong>${h(p.name)}</strong><br><span class="muted">${h(p.description || '')}</span></td>${DAY_NAMES.map((_, i) => `<td>${h(days[i]?.code || '—')}</td>`).join('')}</tr>`;
  }).join('')}</tbody></table>`;

  const dayFields = DAY_NAMES.map((day, i) => `<label>${day}<select name="day_${i}" required>${options(shifts.map((s) => ({ id: s.id, name: `${s.name}${s.start_time ? ` (${s.start_time}–${s.end_time})` : ''}` })))}</select></label>`).join('');

  const content = `${pageHeader('Shift Patterns', 'Shift definitions and reusable one-week rota patterns.')}
  <div class="card"><h2>Shift Types</h2>${shiftTable}</div>
  <div class="card section-gap"><h2>Rota Patterns</h2>${patternTable}</div>
  <div class="form-card section-gap"><h2>Create One-Week Pattern</h2>
    <form method="post" action="/shift-patterns">
      <label>Pattern Name<input name="name" required maxlength="100"></label>
      <label>Description<textarea name="description" rows="3" maxlength="255"></textarea></label>
      <div class="pattern-days">${dayFields}</div>
      <div class="action-bar"><button type="submit">Create Pattern</button></div>
    </form>
  </div>`;
  return htmlResponse('Shift Patterns', content, 'Shift Patterns');
}

async function createShiftPattern(request, db) {
  const form = await request.formData();
  const name = String(form.get('name') || '').trim();
  const description = String(form.get('description') || '').trim() || null;
  const result = await db.prepare('INSERT INTO rota_patterns (name, description, cycle_length_weeks) VALUES (?, ?, 1)').bind(name, description).run();
  const patternId = result.meta?.last_row_id;
  const statements = [];
  for (let i = 0; i < 7; i++) {
    const shiftId = Number(form.get(`day_${i}`));
    statements.push(db.prepare('INSERT INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) VALUES (?, ?, 1, ?)').bind(patternId, shiftId, i));
  }
  await db.batch(statements);
  return redirect(request, '/shift-patterns');
}

async function rotaPage(db) {
  const employees = await rows(db, `SELECT e.id, e.display_name, t.name AS team_name,
    COALESCE(e.override_rota_pattern_id, t.default_rota_pattern_id) AS pattern_id,
    COALESCE(orp.name, trp.name, 'No Scheduled Hours') AS pattern_name
    FROM employees e
    JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id
    WHERE e.is_active=1 ORDER BY t.name, e.display_name`);
  const patternDays = await rows(db, `SELECT rpd.rota_pattern_id, rpd.day_of_week, st.code, st.name, st.start_time, st.end_time
    FROM rota_pattern_days rpd JOIN shift_types st ON st.id=rpd.shift_type_id
    WHERE rpd.week_number=1 ORDER BY rpd.rota_pattern_id, rpd.day_of_week`);
  const daysByPattern = new Map();
  for (const d of patternDays) {
    if (!daysByPattern.has(d.rota_pattern_id)) daysByPattern.set(d.rota_pattern_id, []);
    daysByPattern.get(d.rota_pattern_id)[d.day_of_week] = d;
  }
  const table = employees.length ? `<table><thead><tr><th>Employee</th><th>Team</th><th>Pattern</th>${DAY_NAMES.map((d) => `<th>${d.slice(0, 3)}</th>`).join('')}</tr></thead><tbody>${employees.map((e) => {
    const days = daysByPattern.get(e.pattern_id) || [];
    return `<tr><td>${h(e.display_name)}</td><td>${h(e.team_name)}</td><td>${h(e.pattern_name)}</td>${DAY_NAMES.map((_, i) => `<td title="${h(days[i]?.name || '')}">${h(days[i]?.code || 'OFF')}</td>`).join('')}</tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">Create employees and teams to populate the rota.</div>';

  const content = `${pageHeader('Rota', 'Current effective one-week rota by employee.')}
    <div class="notice">This is the first rota viewer. Multi-week cycle calculation, leave, sickness, WFH and on-call overlays remain separate roadmap items.</div>
    <div class="table-card rota-table">${table}</div>`;
  return htmlResponse('Rota', content, 'Rota');
}

async function administrationPage(db) {
  const roles = await rows(db, `SELECT r.name, r.description, GROUP_CONCAT(p.code, ', ') AS permissions
    FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id LEFT JOIN permissions p ON p.id=rp.permission_id
    GROUP BY r.id ORDER BY r.name`);
  const permissions = await rows(db, 'SELECT code, description FROM permissions ORDER BY code');
  const content = `${pageHeader('Administration', 'Application configuration and RBAC reference.')}
    <div class="card-grid">
      <article class="card"><h2>Roles</h2>${roles.map((r) => `<p><strong>${h(r.name)}</strong><br><span class="muted">${h(r.description || '')}</span><br><small>${h(r.permissions || 'No permissions')}</small></p>`).join('')}</article>
      <article class="card"><h2>Permissions</h2>${permissions.map((p) => `<p><strong>${h(p.code)}</strong><br><span class="muted">${h(p.description || '')}</span></p>`).join('')}</article>
    </div>
    <div class="notice section-gap"><strong>Authentication:</strong> intentionally not enabled in UAT yet. Cloudflare Access/OIDC will become the outer identity layer, with SupportApp retaining application RBAC.</div>`;
  return htmlResponse('Administration', content, 'Administration');
}

async function notFound() {
  return htmlResponse('Not Found', `${pageHeader('Page not found', 'The requested SupportApp route does not exist.')}<div class="action-bar"><a class="button" href="/">Return to dashboard</a></div>`, '', 404);
}

function errorPage(error) {
  const content = `${pageHeader('SupportApp Error', 'The request could not be completed.')}
    <div class="notice"><strong>Technical detail</strong><br><code>${h(error?.message || error)}</code></div>
    <div class="action-bar"><a class="button" href="/">Return to dashboard</a></div>`;
  return htmlResponse('Error', content, '', 500);
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error('D1 binding DB is not available to this Worker deployment.');
      await ensureSchema(env.DB);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = request.method.toUpperCase();

      if (method === 'GET' && path === '/') return dashboardPage(env.DB);
      if (method === 'GET' && path === '/users') return usersPage(env.DB);
      if (method === 'POST' && path === '/users') return createUser(request, env.DB);
      if (method === 'POST' && /^\/users\/\d+\/toggle$/.test(path)) return toggleUser(request, env.DB, Number(path.split('/')[2]));
      if (method === 'GET' && path === '/teams') return teamsPage(env.DB);
      if (method === 'POST' && path === '/teams') return createTeam(request, env.DB);
      if (method === 'POST' && /^\/teams\/\d+\/toggle$/.test(path)) return toggleTeam(request, env.DB, Number(path.split('/')[2]));
      if (method === 'GET' && path === '/employees') return employeesPage(env.DB);
      if (method === 'POST' && path === '/employees') return createEmployee(request, env.DB);
      if (method === 'POST' && /^\/employees\/\d+\/toggle$/.test(path)) return toggleEmployee(request, env.DB, Number(path.split('/')[2]));
      if (method === 'GET' && path === '/shift-patterns') return shiftPatternsPage(env.DB);
      if (method === 'POST' && path === '/shift-patterns') return createShiftPattern(request, env.DB);
      if (method === 'GET' && path === '/rota') return rotaPage(env.DB);
      if (method === 'GET' && path === '/administration') return administrationPage(env.DB);
      return notFound();
    } catch (error) {
      console.error(error);
      return errorPage(error);
    }
  },
};
