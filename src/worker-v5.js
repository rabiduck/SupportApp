import appWorker from './worker-v4.js';
import configWorker from './worker-v3.js';
import { managerEmployees } from './manager-employees.js';
import { authenticate } from './auth/index.js';
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

function withIdentityHeader(request, email) {
  const headers = new Headers(request.headers);
  headers.delete('Cf-Access-Authenticated-User-Email');
  if (email) headers.set('Cf-Access-Authenticated-User-Email', email);
  return new Request(request, { headers });
}

function accessPage(title, message, status = 403) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">Authentication</div></header><main class="page"><div class="page-header"><div><div class="page-title">${h(title)}</div></div></div><div class="notice"><strong>${h(message)}</strong></div></main></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

async function resolveUser(db, identity) {
  const email = String(identity?.email || '').trim().toLowerCase();
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!email && !username) return null;

  const employee = await row(db, `SELECT id,display_name,username,email,external_identity,team_id,is_active
    FROM employees
    WHERE is_active=1 AND (
      (? <> '' AND (LOWER(email)=? OR LOWER(external_identity)=?))
      OR (? <> '' AND LOWER(username)=?)
    ) LIMIT 1`, email, email, email, username, username);
  if (!employee) return null;

  const roleRows = await rows(db, `SELECT r.name FROM employee_roles er
    JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? ORDER BY r.name`, employee.id);
  const roles = roleRows.map((r) => r.name);
  const managedTeamRows = await rows(db, 'SELECT team_id FROM team_managers WHERE employee_id=? ORDER BY team_id', employee.id);
  const isSystemAdmin = roles.includes('SystemAdmin');
  const isManager = roles.includes('Manager');
  const primaryRole = isSystemAdmin ? 'SystemAdmin' : isManager ? 'Manager' : 'Employee';

  return {
    ...employee,
    roles,
    isSystemAdmin,
    isManager,
    primaryRole,
    managedTeamIds: managedTeamRows.map((x) => Number(x.team_id)),
  };
}

function nav(user, active = '') {
  const links = user.isSystemAdmin
    ? [['Dashboard','/'],['Rota','/rota'],['Teams','/teams'],['Employees','/employees'],['Shift Patterns','/shift-patterns'],['Administration','/administration']]
    : user.isManager
      ? [['Dashboard','/'],['Rota','/rota'],['Employees','/employees'],['Shift Patterns','/shift-patterns']]
      : [['Rota','/rota']];

  return links.map(([name, href]) => `<a class="${active === name ? 'active' : ''}" href="${href}">${name}</a>`).join('');
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

async function decorateResponse(response, user, path) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  text = text.replace(/<nav class="side-nav">[\s\S]*?<\/nav>/, `<nav class="side-nav">${nav(user, activeForPath(path))}</nav>`);
  text = text.replace(/<div class="user-area">[\s\S]*?<\/div>/, `<div class="user-area">${h(user.display_name || user.email || user.username)} · ${h(user.primaryRole)}</div>`);
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function isManagerConfigPath(path) {
  return path === '/shift-patterns'
    || path === '/week-patterns'
    || path === '/rota-patterns'
    || path === '/shift-types'
    || /^\/(week-patterns|rota-patterns|shift-types)\//.test(path);
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) throw new Error('D1 binding DB is not available to this Worker deployment.');
      await ensureSchema(env.DB);

      const identity = await authenticate(request, env);
      if (!identity.authenticated) {
        return accessPage('Sign in required', identity.reason || 'Authentication is required.', 401);
      }

      if (identity.bootstrap) {
        return appWorker.fetch(withIdentityHeader(request, null), { ...env, AUTH_REQUIRED: 'false' });
      }

      const user = await resolveUser(env.DB, identity);
      if (!user) {
        const supplied = identity.email || identity.username || 'the supplied identity';
        return accessPage('Access not provisioned', `You authenticated as ${supplied}, but no active SupportApp employee record matches that identity.`, 403);
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const requestForApp = withIdentityHeader(request, user.email || identity.email || null);

      if (!user.isManager && !user.isSystemAdmin) {
        if (path === '/') return Response.redirect(new URL('/rota', request.url).toString(), 303);
        if (!path.startsWith('/rota') && !path.startsWith('/assets/')) {
          return accessPage('Access Denied', 'Employees have rota access only.', 403);
        }
      }

      if (user.isManager && !user.isSystemAdmin) {
        if (path === '/employees' || /^\/employees\/\d+\/edit$/.test(path)) {
          return managerEmployees(request, env.DB, user);
        }
        if (isManagerConfigPath(path)) {
          return decorateResponse(await configWorker.fetch(requestForApp, env), user, path);
        }
      }

      const response = await appWorker.fetch(requestForApp, { ...env, AUTH_REQUIRED: 'true' });
      return decorateResponse(response, user, path);
    } catch (error) {
      console.error(error);
      return accessPage('SupportApp Error', error?.message || String(error), 500);
    }
  },
};
