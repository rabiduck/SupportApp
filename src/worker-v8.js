import workerV7 from './worker-v7.js';
import { authenticate } from './auth/index.js';
import { ensureSchema } from './schema.js';
import { handleKeyholderRoute } from './closing-cover.js';

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

async function enrichUser(db, employee) {
  const roleRows = await rows(db, 'SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? ORDER BY r.name', employee.id);
  const roles = roleRows.map((x) => x.name);
  const managedTeams = await rows(db, 'SELECT team_id FROM team_managers WHERE employee_id=? ORDER BY team_id', employee.id);
  return {
    ...employee,
    roles,
    isSystemAdmin: roles.includes('SystemAdmin'),
    isManager: roles.includes('Manager'),
    isTeamLeader: roles.includes('TeamLeader'),
    managedTeamIds: managedTeams.map((x) => Number(x.team_id))
  };
}

async function resolveUser(db, identity) {
  if (identity?.employeeId) {
    const direct = await row(db, 'SELECT id,display_name,username,email,external_identity,team_id,is_active FROM employees WHERE id=? AND is_active=1', identity.employeeId);
    if (direct) return enrichUser(db, direct);
  }
  const email = String(identity?.email || '').trim().toLowerCase();
  const username = String(identity?.username || '').trim().toLowerCase();
  if (!email && !username) return null;
  const employee = await row(db, `SELECT id,display_name,username,email,external_identity,team_id,is_active FROM employees WHERE is_active=1
    AND ((?<>'' AND (LOWER(email)=? OR LOWER(external_identity)=?)) OR (?<>'' AND LOWER(username)=?)) LIMIT 1`, email, email, email, username, username);
  return employee ? enrichUser(db, employee) : null;
}

function redirect(request, path) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString() } });
}

async function renderPage(request, env, result) {
  const shellRequest = new Request(new URL('/notifications', request.url).toString(), { method: 'GET', headers: request.headers });
  const shellResponse = await workerV7.fetch(shellRequest, env);
  const type = shellResponse.headers.get('content-type') || '';
  if (!type.includes('text/html')) return shellResponse;
  let text = await shellResponse.text();
  const title = h(result.title || 'Closing Cover');
  const description = result.description ? `<div class="page-description">${h(result.description)}</div>` : '';
  const content = result.kind === 'denied'
    ? `<div class="notice"><strong>${h(result.message)}</strong></div>`
    : result.content || '';
  text = text.replace(/<title>[\s\S]*?<\/title>/, `<title>${title} · Support Portal</title>`);
  text = text.replace(/<main class="page">[\s\S]*?<\/main>/, `<main class="page"><div class="page-header"><div><div class="page-title">${title}</div>${description}</div></div>${content}</main>`);
  text = text.replace('class="" href="/keyholders"', 'class="active" href="/keyholders"');
  const headers = new Headers(shellResponse.headers);
  headers.set('content-type', 'text/html; charset=UTF-8');
  return new Response(text, { status: result.status || 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    if (!env.DB) return workerV7.fetch(request, env, ctx);
    await ensureSchema(env.DB);
    const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
    if (!path.startsWith('/keyholders')) return workerV7.fetch(request, env, ctx);

    const identity = await authenticate(request, env);
    const user = identity?.authenticated && !identity.bootstrap ? await resolveUser(env.DB, identity) : null;
    if (!user) return workerV7.fetch(request, env, ctx);
    const result = await handleKeyholderRoute(request, env.DB, user, path);
    if (!result) return workerV7.fetch(request, env, ctx);
    if (result.kind === 'redirect') return redirect(request, result.path);
    return renderPage(request, env, result);
  },

  async scheduled(controller, env, ctx) {
    return workerV7.scheduled(controller, env, ctx);
  }
};
