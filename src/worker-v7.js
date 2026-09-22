import workerV6 from './worker-v6.js';
import { authenticate } from './auth/index.js';
import { ensureSchema } from './schema.js';
import { ensureCertificationSchema, runCertificationExpirySweep } from './certifications.js';
import { handleScheduledActionRoute, runScheduledActionSweep } from './scheduled-actions.js';

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
  const roleRows = await rows(db, `SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? ORDER BY r.name`, employee.id);
  const roles = roleRows.map((r) => r.name);
  const managedTeamRows = await rows(db, 'SELECT team_id FROM team_managers WHERE employee_id=? ORDER BY team_id', employee.id);
  const isSystemAdmin = roles.includes('SystemAdmin');
  const isManager = roles.includes('Manager');
  const isTeamLeader = roles.includes('TeamLeader');
  return {
    ...employee,
    roles,
    isSystemAdmin,
    isManager,
    isTeamLeader,
    primaryRole: isSystemAdmin ? 'SystemAdmin' : isManager ? 'Manager' : isTeamLeader ? 'TeamLeader' : 'Employee',
    managedTeamIds: managedTeamRows.map((x) => Number(x.team_id))
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
  const employee = await row(db, `SELECT id,display_name,username,email,external_identity,team_id,is_active FROM employees WHERE is_active=1 AND ((?<>'' AND (LOWER(email)=? OR LOWER(external_identity)=?)) OR (?<>'' AND LOWER(username)=?)) LIMIT 1`, email,email,email,username,username);
  return employee ? enrichUser(db, employee) : null;
}

function certManager(user) {
  return Boolean(user?.isSystemAdmin || user?.isManager || user?.isTeamLeader);
}

function redirect(request, path) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString() } });
}

async function renderCertificationPage(request, env, title, description, content, status = 200) {
  const shellUrl = new URL('/certifications/admin', request.url);
  const shellRequest = new Request(shellUrl.toString(), { method: 'GET', headers: request.headers });
  const shellResponse = await workerV6.fetch(shellRequest, env);
  const type = shellResponse.headers.get('content-type') || '';
  if (!type.includes('text/html')) return shellResponse;
  let text = await shellResponse.text();
  const safeTitle = h(title);
  const desc = description ? `<div class="page-description">${h(description)}</div>` : '';
  const main = `<main class="page"><div class="page-header"><div><div class="page-title">${safeTitle}</div>${desc}</div></div>${content}</main>`;
  text = text.replace(/<title>[\s\S]*?<\/title>/, `<title>${safeTitle} · Support Portal</title>`);
  text = text.replace(/<main class="page">[\s\S]*?<\/main>/, main);
  const headers = new Headers(shellResponse.headers);
  headers.set('content-type', 'text/html; charset=UTF-8');
  return new Response(text, { status, headers });
}

function actionNavHref(path) {
  if (path === '/actions/all') return '/actions/all';
  if (path === '/actions/new') return '/actions/new';
  if (path.startsWith('/actions/schedules')) return '/actions/schedules';
  if (path.startsWith('/actions/team')) return '/actions/team';
  return '/actions';
}

export function activateActionNav(text, path) {
  const href = actionNavHref(path);
  text = text.replace(`class="" href="${href}"`, `class="active" href="${href}"`);
  const group = text.match(/data-nav-group="([^"]+)" aria-expanded="(?:true|false)"><span>Actions</);
  if (!group) return text;
  const groupId = group[1];
  return text
    .replace(`data-nav-group="${groupId}" aria-expanded="false"`, `data-nav-group="${groupId}" aria-expanded="true"`)
    .replace(`data-nav-children="${groupId}" hidden`, `data-nav-children="${groupId}"`);
}

async function renderScheduledActionPage(request, env, path, result) {
  // Use a known authenticated page as the shell. Passing an /actions path to
  // worker-v6 falls through to the minimal error shell because those routes are
  // owned by this worker layer.
  const shellUrl = new URL('/notifications', request.url);
  const shellRequest = new Request(shellUrl.toString(), { method: 'GET', headers: request.headers });
  const shellResponse = await workerV6.fetch(shellRequest, env);
  const type = shellResponse.headers.get('content-type') || '';
  if (!type.includes('text/html')) return shellResponse;
  let text = await shellResponse.text();
  const title = h(result.title || 'Scheduled Actions');
  const description = result.description ? `<div class="page-description">${h(result.description)}</div>` : '';
  const main = `<main class="page"><div class="page-header"><div><div class="page-title">${title}</div>${description}</div></div>${result.content || ''}</main>`;
  text = text.replace(/<title>[\s\S]*?<\/title>/, `<title>${title} · Support Portal</title>`);
  text = text.replace(/<main class="page">[\s\S]*?<\/main>/, main);
  text = activateActionNav(text, path);
  const headers = new Headers(shellResponse.headers);
  headers.set('content-type', 'text/html; charset=UTF-8');
  return new Response(text, { status: result.status || 200, headers });
}

async function certificationTypeCreatePage(request, env, user) {
  if (!certManager(user)) {
    return renderCertificationPage(request, env, 'Access Denied', '', '<div class="notice"><strong>Manager, Team Leader or System Administrator access is required.</strong></div>', 403);
  }

  let values = { name: '', issuing_body: '', default_valid_months: '', description: '' };
  let message = '';
  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const name = String(form.get('name') || '').trim();
    const issuingBody = String(form.get('issuing_body') || '').trim() || null;
    const description = String(form.get('description') || '').trim() || null;
    const monthsRaw = String(form.get('default_valid_months') || '').trim();
    const months = monthsRaw ? Number(monthsRaw) : null;
    values = { name, issuing_body: issuingBody || '', default_valid_months: monthsRaw, description: description || '' };

    if (!name) message = 'Certification name is required.';
    else if (months !== null && (!Number.isInteger(months) || months < 1 || months > 240)) message = 'Default validity must be between 1 and 240 months.';
    else {
      const duplicate = await row(env.DB, 'SELECT id FROM certification_types WHERE LOWER(name)=LOWER(?)', name);
      if (duplicate) message = 'A certification type with that name already exists.';
    }

    if (!message) {
      await env.DB.prepare('INSERT INTO certification_types(name,issuing_body,description,default_valid_months,is_active) VALUES(?,?,?,?,1)')
        .bind(name,issuingBody,description,months).run();
      return redirect(request, '/certifications/admin');
    }
  }

  const content = `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="form-card"><h2>Add Certification Type</h2><p class="muted">New types are added to the global certification catalogue and become available to all teams.</p><form method="post"><label>Name<input name="name" value="${h(values.name)}" required autofocus></label><label>Issuing Body<input name="issuing_body" value="${h(values.issuing_body)}" placeholder="e.g. Microsoft, Check Point"></label><label>Default Validity (months) <span class="muted">(optional)</span><input name="default_valid_months" type="number" min="1" max="240" value="${h(values.default_valid_months)}"></label><label>Description<textarea name="description" rows="3">${h(values.description)}</textarea></label><div class="action-bar"><button type="submit">Add Type</button><a class="button secondary" href="/certifications/admin">Cancel</a></div></form></div>`;
  return renderCertificationPage(request, env, 'Add Certification Type', 'Create a certification type for use across SupportApp.', content);
}

async function decorateManagerCertificationActions(response, user, path) {
  if (user.isSystemAdmin || !(user.isManager || user.isTeamLeader)) return response;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();

  if (path === '/certifications/admin') {
    const addCert = '<a class="button" href="/certifications/admin/new">Add Certification</a>';
    if (text.includes(addCert) && !text.includes('/certifications/types/new')) {
      text = text.replace(addCert, `${addCert}<a class="button secondary" href="/certifications/types/new">Add Certification Type</a>`);
    }
  }

  if (path === '/certifications/admin/new' && !text.includes('/certifications/types/new')) {
    const marker = '</select></label><label>Certificate / Credential ID';
    if (text.includes(marker)) {
      text = text.replace(marker, `</select></label><p class="muted" style="margin-top:-8px"><a href="/certifications/types/new">Certification type not listed? Add it here.</a></p><label>Certificate / Credential ID`);
    }
  }

  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export default {
  async fetch(request, env, ctx) {
    if (!env.DB) return workerV6.fetch(request, env, ctx);
    await ensureSchema(env.DB);
    await ensureCertificationSchema(env.DB);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const identity = await authenticate(request, env);
    const user = identity?.authenticated && !identity.bootstrap ? await resolveUser(env.DB, identity) : null;

    if (path === '/certifications/types/new' && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) {
      if (!user) return workerV6.fetch(request, env, ctx);
      return certificationTypeCreatePage(request, env, user);
    }

    if (path.startsWith('/actions')) {
      if (!user) return workerV6.fetch(request, env, ctx);
      const result = await handleScheduledActionRoute(request, env.DB, user, path);
      if (result?.kind === 'redirect') return redirect(request, result.path);
      if (result?.kind === 'page') return renderScheduledActionPage(request, env, path, result);
    }

    const response = await workerV6.fetch(request, env, ctx);
    return user ? decorateManagerCertificationActions(response, user, path) : response;
  },

  async scheduled(controller, env, ctx) {
    if (!env.DB) return;
    const task = (async () => {
      await ensureSchema(env.DB);
      await ensureCertificationSchema(env.DB);
      const now = new Date(Number(controller?.scheduledTime || Date.now()));
      await Promise.all([runCertificationExpirySweep(env.DB), runScheduledActionSweep(env.DB, now)]);
    })();
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
  }
};
