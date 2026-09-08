import baseWorker from './worker.js';
import { ensureSchema } from './schema.js';

const h = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const statusBadge = (active) => active
  ? '<span class="status-badge status-active">Active</span>'
  : '<span class="status-badge status-inactive">Inactive</span>';

async function rows(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

async function row(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

const redirect = (request, path) => Response.redirect(new URL(path, request.url).toString(), 303);

function options(items, selected = null, includeBlank = false, blankLabel = '— None —') {
  const blank = includeBlank ? `<option value="">${h(blankLabel)}</option>` : '';
  return blank + items.map((item) => `<option value="${item.id}" ${String(item.id) === String(selected) ? 'selected' : ''}>${h(item.name)}</option>`).join('');
}

const shell = (title, content, active = 'Employees') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body>
<header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">Cloudflare UAT</div></header>
<div class="app-shell"><nav class="side-nav">
<a href="/">Dashboard</a><a href="/rota">Rota</a><a href="/teams">Teams</a><a class="${active === 'Employees' ? 'active' : ''}" href="/employees">Employees</a><a href="/shift-patterns">Shift Patterns</a><a href="/administration">Administration</a>
</nav><main class="page">${content}</main></div>
<footer class="footer">SupportApp · Cloudflare-native UAT</footer></body></html>`;

const pageHeader = (title, description) => `<div class="page-header"><div><div class="page-title">${h(title)}</div><div class="page-description">${h(description)}</div></div></div>`;

function htmlResponse(title, content, status = 200) {
  return new Response(shell(title, content), { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function friendlyError(title, message, status = 400) {
  return htmlResponse(title, `${pageHeader(title, 'The requested change could not be saved.')}<div class="notice"><strong>${h(message)}</strong></div><div class="action-bar"><a class="button secondary" href="/employees">Return to Employees</a></div>`, status);
}

async function employeesPage(db) {
  const employees = await rows(db, `SELECT e.*, t.name AS team_name,
      COALESCE(orp.name, trp.name, 'No Scheduled Hours') AS effective_pattern,
      COALESCE(GROUP_CONCAT(r.name, ', '), '—') AS roles
    FROM employees e
    JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id
    LEFT JOIN employee_roles er ON er.employee_id=e.id
    LEFT JOIN roles r ON r.id=er.role_id
    GROUP BY e.id
    ORDER BY e.display_name`);
  const teams = await rows(db, 'SELECT id, name FROM teams WHERE is_active=1 ORDER BY name');
  const patterns = await rows(db, "SELECT id, name FROM rota_patterns WHERE is_active=1 AND name <> 'No Scheduled Hours' ORDER BY name");
  const roles = await rows(db, 'SELECT id, name FROM roles ORDER BY name');

  const table = employees.length ? `<table><thead><tr><th>Employee</th><th>Username</th><th>Role</th><th>Job Title</th><th>Team</th><th>Rota</th><th>Status</th><th></th></tr></thead><tbody>${employees.map((e) => `
    <tr><td><a href="/employees/${e.id}/edit"><strong>${h(e.display_name)}</strong></a>${!e.username ? '<br><span class="warning-text">Identity required</span>' : ''}</td>
    <td>${h(e.username || '—')}</td><td>${h(e.roles)}</td><td>${h(e.job_title || '—')}</td><td>${h(e.team_name)}</td><td>${h(e.effective_pattern)}</td><td>${statusBadge(e.is_active)}</td>
    <td class="text-right"><a class="button secondary" href="/employees/${e.id}/edit">Edit</a><form class="inline-form" method="post" action="/employees/${e.id}/toggle"><button class="secondary" type="submit">${e.is_active ? 'Deactivate' : 'Reactivate'}</button></form></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No employees have been created yet.</div>';

  const content = `${pageHeader('Employees', 'People, portal identity, access role, team membership and rota assignment in one record.')}
  <div class="notice"><strong>Unified employee model</strong><br>Every employee is also a SupportApp user. Login identity and application role are managed here alongside organisational and rota details.</div>
  <div class="table-card">${table}</div>
  <div class="form-card section-gap"><h2>Create Employee</h2><form method="post" action="/employees">
    <label>Display Name<input name="display_name" required maxlength="100"></label>
    <label>Username<input name="username" required maxlength="100"></label>
    <label>Email<input name="email" type="email" maxlength="200"></label>
    <label>Role<select name="role_id" required>${options(roles)}</select></label>
    <label>Team<select name="team_id" required>${options(teams)}</select></label>
    <label>Job Title<input name="job_title" maxlength="100"></label>
    <label>Phone<input name="phone" maxlength="50"></label>
    <label>Rota Override<select name="override_rota_pattern_id">${options(patterns, null, true, '— Inherit team default —')}</select></label>
    <label>Override Start Date<input name="override_pattern_start_date" type="date"></label>
    <div class="action-bar"><button type="submit">Create Employee</button></div></form></div>`;
  return htmlResponse('Employees', content);
}

async function createEmployee(request, db) {
  const form = await request.formData();
  const displayName = String(form.get('display_name') || '').trim();
  const username = String(form.get('username') || '').trim();
  const email = String(form.get('email') || '').trim() || null;
  const roleId = Number(form.get('role_id'));
  const teamId = Number(form.get('team_id'));
  if (!displayName || !username || !roleId || !teamId) return friendlyError('Invalid Employee', 'Display name, username, role and team are required.');

  try {
    const result = await db.prepare(`INSERT INTO employees
      (team_id, display_name, username, email, job_title, phone, override_rota_pattern_id, override_pattern_start_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(teamId, displayName, username, email,
        String(form.get('job_title') || '').trim() || null,
        String(form.get('phone') || '').trim() || null,
        Number(form.get('override_rota_pattern_id')) || null,
        String(form.get('override_pattern_start_date') || '').trim() || null).run();
    const employeeId = result.meta?.last_row_id;
    if (employeeId) await db.prepare('INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)').bind(employeeId, roleId).run();
    return redirect(request, '/employees');
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('employees.username')) return friendlyError('Duplicate Username', `The username “${username}” is already in use.`, 409);
    if (message.includes('employees.email')) return friendlyError('Duplicate Email', `The email address “${email}” is already in use.`, 409);
    throw error;
  }
}

async function editEmployeePage(db, id) {
  const employee = await row(db, `SELECT e.*, er.role_id FROM employees e LEFT JOIN employee_roles er ON er.employee_id=e.id WHERE e.id=?`, id);
  if (!employee) return friendlyError('Employee Not Found', 'The requested employee does not exist.', 404);
  const teams = await rows(db, 'SELECT id, name FROM teams WHERE is_active=1 OR id=? ORDER BY name', employee.team_id);
  const patterns = await rows(db, "SELECT id, name FROM rota_patterns WHERE is_active=1 AND name <> 'No Scheduled Hours' ORDER BY name");
  const roles = await rows(db, 'SELECT id, name FROM roles ORDER BY name');

  const content = `${pageHeader('Edit Employee', 'Update identity, access, team membership and rota settings.')}
  <div class="form-card"><form method="post" action="/employees/${id}/edit">
    <label>Display Name<input name="display_name" required maxlength="100" value="${h(employee.display_name)}"></label>
    <label>Username<input name="username" required maxlength="100" value="${h(employee.username || '')}"></label>
    <label>Email<input name="email" type="email" maxlength="200" value="${h(employee.email || '')}"></label>
    <label>Role<select name="role_id" required>${options(roles, employee.role_id)}</select></label>
    <label>Team<select name="team_id" required>${options(teams, employee.team_id)}</select></label>
    <label>Job Title<input name="job_title" maxlength="100" value="${h(employee.job_title || '')}"></label>
    <label>Phone<input name="phone" maxlength="50" value="${h(employee.phone || '')}"></label>
    <label>Rota Override<select name="override_rota_pattern_id">${options(patterns, employee.override_rota_pattern_id, true, '— Inherit team default —')}</select></label>
    <label>Override Start Date<input name="override_pattern_start_date" type="date" value="${h(employee.override_pattern_start_date || '')}"></label>
    <label class="checkbox-label"><input type="checkbox" name="is_active" ${employee.is_active ? 'checked' : ''}> Active</label>
    <div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/employees">Cancel</a></div>
  </form></div>`;
  return htmlResponse('Edit Employee', content);
}

async function updateEmployee(request, db, id) {
  const form = await request.formData();
  const displayName = String(form.get('display_name') || '').trim();
  const username = String(form.get('username') || '').trim();
  const email = String(form.get('email') || '').trim() || null;
  const roleId = Number(form.get('role_id'));
  const teamId = Number(form.get('team_id'));
  if (!displayName || !username || !roleId || !teamId) return friendlyError('Invalid Employee', 'Display name, username, role and team are required.');

  try {
    await db.prepare(`UPDATE employees SET display_name=?, username=?, email=?, team_id=?, job_title=?, phone=?,
      override_rota_pattern_id=?, override_pattern_start_date=?, is_active=? WHERE id=?`)
      .bind(displayName, username, email, teamId,
        String(form.get('job_title') || '').trim() || null,
        String(form.get('phone') || '').trim() || null,
        Number(form.get('override_rota_pattern_id')) || null,
        String(form.get('override_pattern_start_date') || '').trim() || null,
        form.has('is_active') ? 1 : 0, id).run();
    await db.prepare('DELETE FROM employee_roles WHERE employee_id=?').bind(id).run();
    await db.prepare('INSERT INTO employee_roles (employee_id, role_id) VALUES (?, ?)').bind(id, roleId).run();
    return redirect(request, '/employees');
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('employees.username')) return friendlyError('Duplicate Username', `The username “${username}” is already in use.`, 409);
    if (message.includes('employees.email')) return friendlyError('Duplicate Email', `The email address “${email}” is already in use.`, 409);
    throw error;
  }
}

async function toggleEmployee(request, db, id) {
  await db.prepare('UPDATE employees SET is_active=CASE is_active WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();
  return redirect(request, '/employees');
}

async function stripLegacyUserUi(response) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  text = text.replace(/<a[^>]*href="\/users"[^>]*>Users<\/a>/g, '');
  text = text.replace(/<article class="card"><h2>Users<\/h2>[\s\S]*?<\/article>/g, '');
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error('D1 binding DB is not available to this Worker deployment.');
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const method = request.method.toUpperCase();

      if (path === '/users' || /^\/users\//.test(path)) return redirect(request, '/employees');
      if (method === 'GET' && path === '/employees') return employeesPage(env.DB);
      if (method === 'POST' && path === '/employees') return createEmployee(request, env.DB);
      if (method === 'GET' && /^\/employees\/\d+\/edit$/.test(path)) return editEmployeePage(env.DB, Number(path.split('/')[2]));
      if (method === 'POST' && /^\/employees\/\d+\/edit$/.test(path)) return updateEmployee(request, env.DB, Number(path.split('/')[2]));
      if (method === 'POST' && /^\/employees\/\d+\/toggle$/.test(path)) return toggleEmployee(request, env.DB, Number(path.split('/')[2]));

      return stripLegacyUserUi(await baseWorker.fetch(request, env));
    } catch (error) {
      console.error(error);
      return friendlyError('SupportApp Error', error?.message || String(error), 500);
    }
  },
};
