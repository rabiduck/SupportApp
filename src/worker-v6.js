import workerV5 from './worker-v5.js';
import { authenticate } from './auth/index.js';
import { ensureSchema } from './schema.js';
import {
  certificationAttentionCount,
  ensureCertificationSchema,
  handleCertificationRoute,
  runCertificationExpirySweep
} from './certifications.js';

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

function certificationNav(user, activePath, attentionCount) {
  const open = activePath.startsWith('/certifications');
  const canManage = user.isSystemAdmin || user.isManager || user.isTeamLeader;
  const myActive = activePath === '/certifications';
  const typesActive = activePath.startsWith('/certifications/types');
  const registerActive = !typesActive && activePath.startsWith('/certifications/admin');
  const items = [
    `<a class="${myActive?'active':''}" href="/certifications">My Certifications</a>`,
    ...(canManage ? [`<a class="${registerActive?'active':''}" href="/certifications/admin">Certification Register</a>`] : []),
    ...(user.isSystemAdmin ? [`<a class="${typesActive?'active':''}" href="/certifications/types">Certification Types</a>`] : [])
  ];
  return `<div class="nav-group"><button type="button" class="nav-group-toggle" data-nav-group="certifications" aria-expanded="${open?'true':'false'}"><span>Certifications${attentionCount?`<span class="nav-callout">${attentionCount}</span>`:''}</span><span class="nav-chevron">›</span></button><div class="nav-children" data-nav-children="certifications" ${open?'':'hidden'}>${items.join('')}</div></div>`;
}

async function decorateCertificationNav(response, user, path, db) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  if (!text.includes('<nav class="side-nav">') || text.includes('data-nav-group="certifications"')) {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const attention = await certificationAttentionCount(db, user.id);
  text = text.replace('</nav>', `${certificationNav(user, path, attention)}</nav>`);
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function redirect(request, path) {
  return new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString() } });
}

async function renderCertificationPage(request, env, user, result, path) {
  const shellUrl = new URL('/notifications', request.url);
  const shellRequest = new Request(shellUrl.toString(), { method: 'GET', headers: request.headers });
  const shellResponse = await workerV5.fetch(shellRequest, env);
  const type = shellResponse.headers.get('content-type') || '';
  if (!type.includes('text/html')) return shellResponse;
  let text = await shellResponse.text();
  const title = h(result.title || 'Certifications');
  const description = result.description ? `<div class="page-description">${h(result.description)}</div>` : '';
  const main = `<main class="page"><div class="page-header"><div><div class="page-title">${title}</div>${description}</div></div>${result.content || ''}</main>`;
  text = text.replace(/<title>[\s\S]*?<\/title>/, `<title>${title} · Support Portal</title>`);
  text = text.replace(/<main class="page">[\s\S]*?<\/main>/, main);
  const headers = new Headers(shellResponse.headers);
  headers.set('content-type', 'text/html; charset=UTF-8');
  const response = new Response(text, { status: result.status || 200, headers });
  return decorateCertificationNav(response, user, path, env.DB);
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.DB) return workerV5.fetch(request, env, ctx);
      await ensureSchema(env.DB);
      await ensureCertificationSchema(env.DB);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const identity = await authenticate(request, env);
      const user = identity?.authenticated && !identity.bootstrap ? await resolveUser(env.DB, identity) : null;

      if (path.startsWith('/certifications')) {
        if (!user) return workerV5.fetch(request, env, ctx);
        await runCertificationExpirySweep(env.DB, user.id);
        const result = await handleCertificationRoute(request, env.DB, user);
        if (!result) return workerV5.fetch(request, env, ctx);
        if (result.kind === 'redirect') return redirect(request, result.path);
        return renderCertificationPage(request, env, user, result, path);
      }

      const response = await workerV5.fetch(request, env, ctx);
      return user ? decorateCertificationNav(response, user, path, env.DB) : response;
    } catch (error) {
      console.error(error);
      return workerV5.fetch(request, env, ctx);
    }
  },

  async scheduled(controller, env, ctx) {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    await ensureCertificationSchema(env.DB);
    const task = runCertificationExpirySweep(env.DB);
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else await task;
  }
};
