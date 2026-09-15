import appWorker from './worker-v4.js';
import configWorker from './worker-v3.js';
import { managerEmployees } from './manager-employees.js';
import { authenticate } from './auth/index.js';
import { createLocalSession, clearSessionCookie, destroyLocalSession, sessionCookie, setLocalPassword, verifyLocalPassword } from './auth/local.js';
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

function redirect(request, path, headers = {}) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString(), ...headers } });
}

function withIdentityHeader(request, email) {
  const headers = new Headers(request.headers);
  headers.delete('Cf-Access-Authenticated-User-Email');
  if (email) headers.set('Cf-Access-Authenticated-User-Email', email);
  return new Request(request, { headers });
}

function simplePage(title, content, status = 200) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">Authentication</div></header><main class="page"><div class="page-header"><div><div class="page-title">${h(title)}</div></div></div>${content}</main></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function accessPage(title, message, status = 403) {
  return simplePage(title, `<div class="notice"><strong>${h(message)}</strong></div>`, status);
}

function loginPage(message = '') {
  return simplePage('Sign in', `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="form-card" style="max-width:520px"><form method="post" action="/login"><label>Username or email<input name="identity" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><div class="action-bar"><button type="submit">Sign in</button></div></form></div>`);
}

function setupPage(message = '') {
  return simplePage('Initial setup', `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="notice"><strong>Create the first local login</strong><br>Enter the username of an existing active SystemAdmin and choose its initial password.</div><div class="form-card" style="max-width:520px"><form method="post" action="/setup"><label>SystemAdmin username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="10" required></label><label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required></label><div class="action-bar"><button type="submit">Create login</button></div></form></div>`);
}

async function localAuthRoutes(request, db, path) {
  const method = request.method.toUpperCase();
  const credentialCount = Number((await row(db, 'SELECT COUNT(*) AS c FROM employee_credentials'))?.c || 0);

  if (path === '/setup') {
    if (credentialCount > 0) return redirect(request, '/login');
    if (method === 'GET') return setupPage();
    if (method === 'POST') {
      const form = await request.formData();
      const username = String(form.get('username') || '').trim().toLowerCase();
      const password = String(form.get('password') || '');
      const confirm = String(form.get('confirm_password') || '');
      if (password !== confirm) return setupPage('The passwords do not match.');
      const admin = await row(db, `SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id WHERE e.is_active=1 AND LOWER(e.username)=? AND r.name='SystemAdmin'`, username);
      if (!admin) return setupPage('That username is not an active SystemAdmin account.');
      try { await setLocalPassword(db, admin.id, password); }
      catch (error) { return setupPage(error?.message || String(error)); }
      const token = await createLocalSession(db, admin.id);
      return redirect(request, '/', { 'Set-Cookie': sessionCookie(token) });
    }
  }

  if (path === '/login') {
    if (credentialCount === 0) return redirect(request, '/setup');
    if (method === 'GET') return loginPage();
    if (method === 'POST') {
      const form = await request.formData();
      const supplied = String(form.get('identity') || '').trim().toLowerCase();
      const password = String(form.get('password') || '');
      const employee = await row(db, `SELECT id FROM employees WHERE is_active=1 AND (LOWER(username)=? OR LOWER(email)=?) LIMIT 1`, supplied, supplied);
      if (!employee || !(await verifyLocalPassword(db, employee.id, password))) return loginPage('The username/email or password was not recognised.');
      const token = await createLocalSession(db, employee.id);
      return redirect(request, '/', { 'Set-Cookie': sessionCookie(token) });
    }
  }

  if (path === '/logout') {
    await destroyLocalSession(request, db);
    return redirect(request, '/login', { 'Set-Cookie': clearSessionCookie() });
  }

  if (credentialCount === 0) return redirect(request, '/setup');
  return null;
}

async function resolveUser(db, identity) {
  if (identity?.employeeId) {
    const direct = await row(db, 'SELECT id,display_name,username,email,external_identity,team_id,is_active FROM employees WHERE id=? AND is_active=1', identity.employeeId);
    if (direct) return enrichUser(db, direct);
  }
  const email = String(identity?.email || '').trim().toLowerCase();
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!email && !username) return null;
  const employee = await row(db, `SELECT id,display_name,username,email,external_identity,team_id,is_active FROM employees WHERE is_active=1 AND ((?<>'' AND (LOWER(email)=? OR LOWER(external_identity)=?)) OR (?<>'' AND LOWER(username)=?)) LIMIT 1`, email,email,email,username,username);
  return employee ? enrichUser(db, employee) : null;
}

async function enrichUser(db, employee) {
  const roleRows = await rows(db, `SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? ORDER BY r.name`, employee.id);
  const roles = roleRows.map((r) => r.name);
  const managedTeamRows = await rows(db, 'SELECT team_id FROM team_managers WHERE employee_id=? ORDER BY team_id', employee.id);
  const isSystemAdmin = roles.includes('SystemAdmin');
  const isManager = roles.includes('Manager');
  return { ...employee, roles, isSystemAdmin, isManager, primaryRole: isSystemAdmin ? 'SystemAdmin' : isManager ? 'Manager' : 'Employee', managedTeamIds: managedTeamRows.map((x) => Number(x.team_id)) };
}

function nav(user, active = '') {
  const links = user.isSystemAdmin
    ? [['Dashboard','/'],['Rota','/rota'],['My Leave','/leave'],['Teams','/teams'],['Employees','/employees'],['Shift Patterns','/shift-patterns'],['Administration','/administration']]
    : user.isManager
      ? [['Dashboard','/'],['Rota','/rota'],['My Leave','/leave'],['Employees','/employees'],['Shift Patterns','/shift-patterns']]
      : [['Rota','/rota'],['My Leave','/leave']];
  return links.map(([name, href]) => `<a class="${active === name ? 'active' : ''}" href="${href}">${name}</a>`).join('');
}

function activeForPath(path) {
  if (path === '/') return 'Dashboard';
  if (path.startsWith('/rota')) return 'Rota';
  if (path.startsWith('/leave')) return 'My Leave';
  if (path.startsWith('/teams')) return 'Teams';
  if (path.startsWith('/employees')) return 'Employees';
  if (path.startsWith('/shift-') || path.startsWith('/week-patterns') || path.startsWith('/rota-patterns')) return 'Shift Patterns';
  if (path.startsWith('/administration')) return 'Administration';
  return '';
}

async function decorateResponse(response, user, path, localAuth = false) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  text = text.replace(/<nav class="side-nav">[\s\S]*?<\/nav>/, `<nav class="side-nav">${nav(user, activeForPath(path))}</nav>`);
  const signout = localAuth ? ' · <a href="/logout" style="color:inherit">Sign out</a>' : '';
  text = text.replace(/<div class="user-area">[\s\S]*?<\/div>/, `<div class="user-area">${h(user.display_name || user.email || user.username)} · ${h(user.primaryRole)}${signout}</div>`);
  if (localAuth && path === '/employees' && (user.isManager || user.isSystemAdmin)) {
    text = text.replace(/<a class="button secondary" href="\/employees\/(\d+)\/edit">Edit<\/a>/g, (match, id) => `${match}<a class="button secondary" href="/employees/${id}/password">Password</a>`);
  }
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function isManagerConfigPath(path) {
  return path === '/shift-patterns' || path === '/week-patterns' || path === '/rota-patterns' || path === '/shift-types' || /^\/(week-patterns|rota-patterns|shift-types)\//.test(path);
}

async function passwordPage(request, db, currentUser, targetId) {
  const target = await row(db, `SELECT e.id,e.display_name,e.team_id,COALESCE(GROUP_CONCAT(r.name, ', '),'Employee') AS roles FROM employees e LEFT JOIN employee_roles er ON er.employee_id=e.id LEFT JOIN roles r ON r.id=er.role_id WHERE e.id=? GROUP BY e.id`, targetId);
  if (!target) return accessPage('Employee not found', 'The requested employee does not exist.', 404);
  const targetRoles = String(target.roles || '').split(',').map((x) => x.trim());
  const inScope = currentUser.isSystemAdmin || (currentUser.isManager && currentUser.managedTeamIds.includes(Number(target.team_id)) && !targetRoles.includes('Manager') && !targetRoles.includes('SystemAdmin'));
  if (!inScope) return accessPage('Access Denied', 'You cannot manage login credentials for this employee.', 403);

  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const password = String(form.get('password') || '');
    const confirm = String(form.get('confirm_password') || '');
    if (password !== confirm) return passwordForm(target, 'The passwords do not match.');
    try { await setLocalPassword(db, target.id, password); }
    catch (error) { return passwordForm(target, error?.message || String(error)); }
    return redirect(request, '/employees');
  }
  return passwordForm(target);
}

function passwordForm(target, message = '') {
  return simplePage(`Set password · ${target.display_name}`, `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="form-card" style="max-width:520px"><p class="muted">Setting a new password also signs this user out of any existing sessions.</p><form method="post"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" required autofocus></label><label>Confirm password<input name="confirm_password" type="password" autocomplete="new-password" minlength="10" required></label><div class="action-bar"><button type="submit">Set password</button><a class="button secondary" href="/employees">Cancel</a></div></form></div>`);
}

function appPage(title, description, content, user, active = '') {
  const signout = ' · <a href="/logout" style="color:inherit">Sign out</a>';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">${h(user.display_name || user.email || user.username)} · ${h(user.primaryRole)}${signout}</div></header><div class="app-shell"><nav class="side-nav">${nav(user, active)}</nav><main class="page"><div class="page-header"><div><div class="page-title">${h(title)}</div>${description ? `<div class="page-description">${h(description)}</div>` : ''}</div></div>${content}</main></div><footer class="footer">SupportApp · Cloudflare-native UAT</footer></body></html>`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function leaveStatus(status) {
  const label = String(status || '').replace(/^./, (x) => x.toUpperCase());
  return `<span class="status-badge ${status === 'approved' ? 'status-active' : status === 'rejected' || status === 'cancelled' ? 'status-inactive' : ''}">${h(label)}</span>`;
}

async function myLeavePage(request, db, user) {
  const method = request.method.toUpperCase();
  let message = '';
  if (method === 'POST') {
    const form = await request.formData();
    const startDate = String(form.get('start_date') || '').trim();
    const endDate = String(form.get('end_date') || '').trim();
    const notes = String(form.get('employee_notes') || '').trim() || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      message = 'Start and end dates are required.';
    } else if (endDate < startDate) {
      message = 'End date cannot be before start date.';
    } else {
      await db.prepare("INSERT INTO leave_requests (employee_id,start_date,end_date,status,employee_notes) VALUES (?,?,?,'pending',?)").bind(user.id,startDate,endDate,notes).run();
      return redirect(request, '/leave');
    }
  }

  const requests = await rows(db, `SELECT lr.*, reviewer.display_name AS reviewer_name FROM leave_requests lr LEFT JOIN employees reviewer ON reviewer.id=lr.reviewed_by WHERE lr.employee_id=? ORDER BY lr.requested_at DESC,lr.id DESC`, user.id);
  const table = requests.length ? `<table><thead><tr><th>Dates</th><th>Status</th><th>Notes</th><th>Requested</th><th>Reviewed By</th></tr></thead><tbody>${requests.map((r) => `<tr><td><strong>${h(r.start_date)}</strong>${r.end_date !== r.start_date ? ` → <strong>${h(r.end_date)}</strong>` : ''}</td><td>${leaveStatus(r.status)}</td><td>${h(r.employee_notes || '—')}</td><td>${h(String(r.requested_at || '').slice(0,16).replace('T',' '))}</td><td>${h(r.reviewer_name || '—')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">You have not submitted any annual leave requests yet.</div>';
  const content = `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="form-card"><h2>Request Annual Leave</h2><form method="post" action="/leave"><label>Start Date<input name="start_date" type="date" required></label><label>End Date<input name="end_date" type="date" required></label><label>Notes <span class="muted">(optional)</span><textarea name="employee_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">Submit Request</button></div></form></div><div class="table-card section-gap"><h2>My Requests</h2>${table}</div>`;
  return appPage('My Leave', 'Request annual leave and track the status of your requests.', content, user, 'My Leave');
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error('D1 binding DB is not available to this Worker deployment.');
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const provider = String(env.AUTH_PROVIDER || 'bootstrap').trim().toLowerCase();
      const localAuth = provider === 'local';

      if (localAuth) {
        const authRoute = await localAuthRoutes(request, env.DB, path);
        if (authRoute) return authRoute;
      }

      const identity = await authenticate(request, env);
      if (!identity.authenticated) return localAuth ? redirect(request, '/login') : accessPage('Sign in required', identity.reason || 'Authentication is required.', 401);

      if (identity.bootstrap) return appWorker.fetch(withIdentityHeader(request, null), { ...env, AUTH_REQUIRED: 'false' });

      const user = await resolveUser(env.DB, identity);
      if (!user) {
        const supplied = identity.email || identity.username || 'the supplied identity';
        return accessPage('Access not provisioned', `You authenticated as ${supplied}, but no active SupportApp employee record matches that identity.`, 403);
      }

      if (localAuth && /^\/employees\/\d+\/password$/.test(path)) return passwordPage(request, env.DB, user, Number(path.split('/')[2]));

      if (path === '/leave' && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return myLeavePage(request, env.DB, user);

      const requestForApp = withIdentityHeader(request, user.email || identity.email || null);
      if (!user.isManager && !user.isSystemAdmin) {
        if (path === '/') return redirect(request, '/rota');
        if (!path.startsWith('/rota') && !path.startsWith('/assets/')) return accessPage('Access Denied', 'Employees have rota access only.', 403);
      }

      if (user.isManager && !user.isSystemAdmin) {
        if (path === '/employees' || /^\/employees\/\d+\/edit$/.test(path)) return decorateResponse(await managerEmployees(request, env.DB, user), user, path, localAuth);
        if (isManagerConfigPath(path)) return decorateResponse(await configWorker.fetch(requestForApp, env), user, path, localAuth);
      }

      return decorateResponse(await appWorker.fetch(requestForApp, { ...env, AUTH_REQUIRED: 'true' }), user, path, localAuth);
    } catch (error) {
      console.error(error);
      return accessPage('SupportApp Error', error?.message || String(error), 500);
    }
  },
};
