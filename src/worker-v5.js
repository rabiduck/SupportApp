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
    ? [['Dashboard','/'],['Rota','/rota'],['My Leave','/leave'],...(user.isManager ? [['Leave Requests','/leave-requests']] : []),['Teams','/teams'],['Employees','/employees'],['Shift Patterns','/shift-patterns'],['Administration','/administration']]
    : user.isManager
      ? [['Dashboard','/'],['Rota','/rota'],['My Leave','/leave'],['Leave Requests','/leave-requests'],['Employees','/employees'],['Shift Patterns','/shift-patterns']]
      : [['Rota','/rota'],['My Leave','/leave']];
  return links.map(([name, href]) => `<a class="${active === name ? 'active' : ''}" href="${href}">${name}</a>`).join('');
}

function activeForPath(path) {
  if (path === '/') return 'Dashboard';
  if (path.startsWith('/rota')) return 'Rota';
  if (path.startsWith('/leave-requests')) return 'Leave Requests';
  if (path.startsWith('/leave')) return 'My Leave';
  if (path.startsWith('/teams')) return 'Teams';
  if (path.startsWith('/employees')) return 'Employees';
  if (path.startsWith('/shift-') || path.startsWith('/week-patterns') || path.startsWith('/rota-patterns')) return 'Shift Patterns';
  if (path.startsWith('/administration')) return 'Administration';
  return '';
}

async function unreadCount(db, userId) { return Number((await row(db, 'SELECT COUNT(*) AS c FROM notifications WHERE recipient_employee_id=? AND read_at IS NULL', userId))?.c || 0); }
function mailboxHtml(count) { return `<a id="notification-mailbox" href="/notifications" title="Notifications" style="position:relative;color:inherit;text-decoration:none;font-size:20px;margin-right:14px">✉<span id="notification-badge" style="position:absolute;top:-9px;right:-12px;background:#e11d48;color:white;border-radius:999px;min-width:18px;height:18px;line-height:18px;text-align:center;font-size:11px;font-weight:700;padding:0 3px;${count ? '' : 'display:none;'}">${count > 9 ? '9+' : count}</span></a>`; }
function notificationPollScript() { return `<script>(()=>{const refresh=async()=>{if(document.hidden)return;try{const r=await fetch('/api/notifications/unread-count',{cache:'no-store',credentials:'same-origin'});if(!r.ok)return;const d=await r.json();const b=document.getElementById('notification-badge');if(!b)return;const n=Number(d.unread)||0;b.textContent=n>9?'9+':String(n);b.style.display=n?'':'none';}catch(_){}};setInterval(refresh,30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});})();</script>`; }

async function decorateResponse(response, user, path, localAuth = false, db = null) {
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;
  let text = await response.text();
  text = text.replace(/<nav class="side-nav">[\s\S]*?<\/nav>/, `<nav class="side-nav">${nav(user, activeForPath(path))}</nav>`);
  const signout = localAuth ? ' · <a href="/logout" style="color:inherit">Sign out</a>' : '';
  const count = db ? await unreadCount(db, user.id) : 0;
  text = text.replace(/<div class="user-area">[\s\S]*?<\/div>/, `<div class="user-area">${mailboxHtml(count)}${h(user.display_name || user.email || user.username)} · ${h(user.primaryRole)}${signout}</div>`);
  if (localAuth && path === '/employees' && (user.isManager || user.isSystemAdmin)) {
    text = text.replace(/<a class="button secondary" href="\/employees\/(\d+)\/edit">Edit<\/a>/g, (match, id) => `${match}<a class="button secondary" href="/employees/${id}/password">Password</a>`);
  }
  // Most application pages are rendered by the older workers and then decorated here,
  // so inject the live mailbox polling script during decoration as well.
  if (!text.includes('/api/notifications/unread-count')) {
    text = text.replace('</body>', `${notificationPollScript()}</body>`);
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

async function appPage(title, description, content, user, active = '', db = null) {
  const signout = ' · <a href="/logout" style="color:inherit">Sign out</a>';
  const count = db ? await unreadCount(db, user.id) : 0;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">${mailboxHtml(count)}${h(user.display_name || user.email || user.username)} · ${h(user.primaryRole)}${signout}</div></header><div class="app-shell"><nav class="side-nav">${nav(user, active)}</nav><main class="page"><div class="page-header"><div><div class="page-title">${h(title)}</div>${description ? `<div class="page-description">${h(description)}</div>` : ''}</div></div>${content}</main></div><footer class="footer">SupportApp · Cloudflare-native UAT</footer>${notificationPollScript()}</body></html>`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

function leaveStatus(status) {
  const label = String(status || '').replace(/^./, (x) => x.toUpperCase());
  return `<span class="status-badge ${status === 'approved' ? 'status-active' : status === 'rejected' || status === 'cancelled' ? 'status-inactive' : ''}">${h(label)}</span>`;
}

async function createNotification(db, recipientId, type, title, message, targetUrl = null) {
  await db.prepare('INSERT INTO notifications (recipient_employee_id,notification_type,title,message,target_url) VALUES (?,?,?,?,?)').bind(recipientId,type,title,message,targetUrl).run();
}

async function notificationsPage(request, db, user) {
  if (request.method.toUpperCase() === 'POST') {
    await db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE recipient_employee_id=?').bind(user.id).run();
    return redirect(request, '/notifications');
  }
  const items = await rows(db, 'SELECT * FROM notifications WHERE recipient_employee_id=? ORDER BY created_at DESC,id DESC LIMIT 100', user.id);
  const content = items.length ? `<div class="table-card"><table><thead><tr><th></th><th>Message</th><th>Received</th></tr></thead><tbody>${items.map(n=>`<tr><td>${n.read_at?'':'<strong>●</strong>'}</td><td><a href="/notifications/${n.id}"><strong>${h(n.title)}</strong></a><br><span class="muted">${h(n.message)}</span></td><td>${h(String(n.created_at||'').slice(0,16).replace('T',' '))}</td></tr>`).join('')}</tbody></table></div><form method="post" class="section-gap"><button type="submit" class="secondary">Mark all read</button></form>` : '<div class="empty">Your inbox is empty.</div>';
  return appPage('Notifications', 'Internal SupportApp messages and workflow updates.', content, user, '', db);
}

async function notificationOpen(request, db, user, id) {
  const n = await row(db, 'SELECT * FROM notifications WHERE id=? AND recipient_employee_id=?', id, user.id);
  if (!n) return accessPage('Notification not found','That notification does not exist.',404);
  await db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE id=?').bind(id).run();
  return redirect(request, n.target_url || '/notifications');
}

async function employeeRotaContext(db, employeeId) {
  return row(db, `SELECT e.id,e.team_id,COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) AS pattern_id,
    COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) AS pattern_start_date,
    COALESCE(orp.cycle_length_weeks,trp.cycle_length_weeks,1) AS cycle_length_weeks
    FROM employees e JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id WHERE e.id=?`, employeeId);
}
async function rotaAssignments(db, patternId) {
  return patternId ? rows(db, `SELECT rpw.week_number,wpd.day_of_week,st.is_working_day FROM rota_pattern_weeks rpw
    JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id JOIN shift_types st ON st.id=wpd.shift_type_id
    WHERE rpw.rota_pattern_id=?`, patternId) : [];
}
function cycleWeekOn(date, ctx) {
  if (!ctx.pattern_start_date || Number(ctx.cycle_length_weeks)<=0) return 1;
  const ps=new Date(`${ctx.pattern_start_date}T00:00:00Z`);
  const dw=Math.floor((date-ps)/(7*86400000)), n=Number(ctx.cycle_length_weeks);
  return ((dw%n)+n)%n+1;
}
function requestDays(request, ctx, amap, clipStart=null, clipEnd=null) {
  const start=new Date(`${request.start_date}T00:00:00Z`), end=new Date(`${request.end_date}T00:00:00Z`);
  let total=0;
  for(let d=new Date(start);d<=end;d.setUTCDate(d.getUTCDate()+1)){
    const day=d.toISOString().slice(0,10); if(clipStart&&day<clipStart)continue;if(clipEnd&&day>clipEnd)continue;
    const dow=(d.getUTCDay()+6)%7, shift=amap.get(`${cycleWeekOn(d,ctx)}:${dow}`);
    if(!shift?.is_working_day) continue;
    let portion='FULL'; if(day===request.start_date)portion=request.start_portion||'FULL'; if(day===request.end_date)portion=request.end_portion||'FULL';
    total += portion==='FULL' ? 1 : 0.5;
  }
  return total;
}
async function leaveBalance(db, employeeId, asOf=new Date().toISOString().slice(0,10)) {
  const annual=await row(db,"SELECT id FROM leave_types WHERE code='ANNUAL'"); if(!annual)return null;
  const year=await row(db,'SELECT id,name,start_date,end_date FROM leave_years WHERE is_active=1 AND start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1',asOf,asOf);
  if(!year)return null;
  const ent=await row(db,'SELECT entitlement_days,adjustment_days FROM employee_leave_entitlements WHERE employee_id=? AND leave_year_id=? AND leave_type_id=?',employeeId,year.id,annual.id);
  const ctx=await employeeRotaContext(db,employeeId); if(!ctx)return null;
  const assignments=await rotaAssignments(db,ctx.pattern_id), amap=new Map(assignments.map(a=>[`${a.week_number}:${a.day_of_week}`,a]));
  const reqs=await rows(db,'SELECT start_date,end_date,start_portion,end_portion,status FROM leave_requests WHERE employee_id=? AND leave_type_id=? AND end_date>=? AND start_date<=? AND status IN (\'approved\',\'pending\')',employeeId,annual.id,year.start_date,year.end_date);
  let taken=0,booked=0,pending=0;
  for(const r of reqs){
    if(r.status==='pending'){pending+=requestDays(r,ctx,amap,year.start_date,year.end_date);continue;}
    const before=new Date(asOf+'T00:00:00Z'); before.setUTCDate(before.getUTCDate()-1); const beforeIso=before.toISOString().slice(0,10);
    taken+=requestDays(r,ctx,amap,year.start_date,beforeIso);
    booked+=requestDays(r,ctx,amap,asOf,year.end_date);
  }
  const entitlement=Number(ent?.entitlement_days||0), adjustment=Number(ent?.adjustment_days||0);
  return {year,entitlement,adjustment,taken,booked,pending,remaining:entitlement+adjustment-taken-booked};
}
function balanceCard(b) {
  if(!b)return '<div class="notice"><strong>No active leave year configured.</strong></div>';
  const n=v=>Number(v||0).toFixed(1);
  const warning=b.remaining<0?`<div class="notice section-gap"><strong>⚠ Negative leave balance: ${n(b.remaining)} days</strong><br>Approved leave exceeds the current entitlement. This is advisory and does not prevent further requests or approvals.</div>`:'';
  return `<div class="card"><h2>Annual Leave · ${h(b.year.name)}</h2><p><strong>Entitlement:</strong> ${n(b.entitlement)} days &nbsp; <strong>Adjustment:</strong> ${b.adjustment>=0?'+':''}${n(b.adjustment)} &nbsp; <strong>Taken:</strong> ${n(b.taken)} &nbsp; <strong>Booked:</strong> ${n(b.booked)} &nbsp; <strong>Pending:</strong> ${n(b.pending)} &nbsp; <strong>Remaining:</strong> ${n(b.remaining)} days</p></div>${warning}`;
}

async function myLeavePage(request, db, user) {
  const method = request.method.toUpperCase();
  let message = '';
  if (method === 'POST') {
    const form = await request.formData();
    const startDate = String(form.get('start_date') || '').trim();
    const endDate = String(form.get('end_date') || '').trim();
    const notes = String(form.get('employee_notes') || '').trim() || null;
    const startPortion = String(form.get('start_portion') || 'FULL').toUpperCase();
    const endPortion = String(form.get('end_portion') || 'FULL').toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      message = 'Start and end dates are required.';
    } else if (endDate < startDate) {
      message = 'End date cannot be before start date.';
    } else if (!['FULL','AM','PM'].includes(startPortion) || !['FULL','AM','PM'].includes(endPortion)) {
      message = 'Choose a valid full-day or half-day option.';
    } else if (startDate === endDate && startPortion !== 'FULL' && endPortion !== 'FULL' && startPortion !== endPortion) {
      message = 'For a single-day request choose Full Day, AM or PM consistently.';
    } else {
      const effectiveEndPortion = startDate === endDate ? startPortion : endPortion;
      const annualType = await row(db, "SELECT id FROM leave_types WHERE code='ANNUAL'");
      if (!annualType) return errorPage('Annual Leave is not configured.', user, 500);
      const managerRecord = user.isManager;
      const created = await db.prepare("INSERT INTO leave_requests (employee_id,leave_type_id,start_date,end_date,start_portion,end_portion,status,employee_notes,reviewed_by,reviewed_at,manager_notes,entry_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(user.id,annualType.id,startDate,endDate,startPortion,effectiveEndPortion,managerRecord?'approved':'pending',notes,managerRecord?user.id:null,managerRecord?new Date().toISOString():null,managerRecord?'Recorded directly by Manager':null,managerRecord?'MANAGER_RECORD':'REQUEST').run();
      const leaveId = Number(created.meta?.last_row_id);
      if (!managerRecord) {
        const managers = await rows(db, `SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id LEFT JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`, user.team_id,user.id);
        for (const manager of managers) await createNotification(db, manager.id, 'leave_request', `Annual leave request · ${user.display_name}`, `${startDate} ${startPortion}${endDate!==startDate?` → ${endDate} ${effectiveEndPortion}`:''}`, `/leave-requests/${leaveId}`);
      }
      return redirect(request, '/leave');
    }
  }

  const balance = await leaveBalance(db, user.id);
  const requests = await rows(db, `SELECT lr.*, reviewer.display_name AS reviewer_name FROM leave_requests lr LEFT JOIN employees reviewer ON reviewer.id=lr.reviewed_by WHERE lr.employee_id=? ORDER BY lr.requested_at DESC,lr.id DESC`, user.id);
  const portionLabel = p => p === 'AM' ? 'AM' : p === 'PM' ? 'PM' : 'Full Day';
  const requestDates = r => r.start_date === r.end_date ? `${h(r.start_date)} <span class="muted">(${portionLabel(r.start_portion)})</span>` : `${h(r.start_date)} <span class="muted">(${portionLabel(r.start_portion)})</span> → ${h(r.end_date)} <span class="muted">(${portionLabel(r.end_portion)})</span>`;
  const today=new Date().toISOString().slice(0,10);
  const actions=r=>{ if(r.end_date<today)return '—'; if(r.status==='pending')return `<a class="button secondary" href="/leave/${r.id}/edit">Edit</a> <form method="post" action="/leave/${r.id}/cancel" style="display:inline"><button class="button secondary" type="submit">Withdraw</button></form>`; if(r.status==='approved'){const edit=user.isManager&&r.entry_mode==='MANAGER_RECORD'?`<a class="button secondary" href="/leave/${r.id}/edit">Edit</a> `:(!user.isManager?`<a class="button secondary" href="/leave/${r.id}/change">Request Change</a> `:'');return `${edit}<form method="post" action="/leave/${r.id}/cancel" style="display:inline"><button class="button secondary" type="submit">Cancel</button></form>`;} return '—';};
  const table = requests.length ? `<table><thead><tr><th>Dates</th><th>Status</th><th>Notes</th><th>Requested</th><th>Reviewed By</th><th>Actions</th></tr></thead><tbody>${requests.map((r) => `<tr><td><strong>${requestDates(r)}</strong></td><td>${leaveStatus(r.status)}</td><td>${h(r.employee_notes || '—')}</td><td>${h(String(r.requested_at || '').slice(0,16).replace('T',' '))}</td><td>${h(r.reviewer_name || '—')}</td><td>${actions(r)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">You have not submitted any annual leave requests yet.</div>';
  const content = `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}${balanceCard(balance)}<div class="form-card section-gap"><h2>${user.isManager?'Record Annual Leave':'Request Annual Leave'}</h2>${user.isManager?'<p class="muted">Manager leave is recorded directly as approved because authorisation takes place outside SupportApp.</p>':''}<form method="post" action="/leave"><label>Start Date<input name="start_date" type="date" required></label><label>Start Portion<select name="start_portion"><option value="FULL">Full Day</option><option value="AM">AM (Half Day)</option><option value="PM">PM (Half Day)</option></select></label><label>End Date<input name="end_date" type="date" required></label><label>End Portion<select name="end_portion"><option value="FULL">Full Day</option><option value="AM">AM (Half Day)</option><option value="PM">PM (Half Day)</option></select></label><label>Notes <span class="muted">(optional)</span><textarea name="employee_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">${user.isManager?'Record Leave':'Submit Request'}</button></div></form></div><div class="table-card section-gap"><h2>My Requests</h2>${table}</div>`;
  return appPage('My Leave', user.isManager ? 'Record approved annual leave and track your leave position.' : 'Request annual leave and track the status of your requests.', content, user, 'My Leave', db);
}

async function cancelOwnLeave(request, db, user, id) {
  const item=await row(db,'SELECT * FROM leave_requests WHERE id=? AND employee_id=?',id,user.id);
  if(!item) return errorPage('Leave request not found.',user,404);
  const today=new Date().toISOString().slice(0,10);
  if(item.end_date<today) return errorPage('Past leave cannot be changed through the normal leave workflow.',user,400);
  if(!['pending','approved'].includes(item.status)) return errorPage('Only pending or approved leave can be withdrawn or cancelled.',user,400);
  const wasPending=item.status==='pending';
  await db.prepare("UPDATE leave_requests SET status='cancelled', reviewed_by=?, reviewed_at=?, manager_notes=? WHERE id=?")
    .bind(user.id,new Date().toISOString(),wasPending?'Withdrawn by employee':'Cancelled by employee',id).run();
  if(!user.isManager){
    const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);
    const action=wasPending?'withdrawn':'cancelled';
    for(const manager of managers) await createNotification(db,manager.id,`leave_${action}`,`Annual leave ${action} · ${user.display_name}`,`${item.start_date}${item.end_date!==item.start_date?` → ${item.end_date}`:''}`,'/leave-requests');
  }
  return redirect(request,'/leave');
}

async function editOwnPendingLeave(request, db, user, id) {
  const item=await row(db,'SELECT * FROM leave_requests WHERE id=? AND employee_id=?',id,user.id);
  if(!item) return errorPage('Leave request not found.',user,404);
  const today=new Date().toISOString().slice(0,10);
  const direct=user.isManager && item.entry_mode==='MANAGER_RECORD' && item.end_date>=today;
  if(item.status!=='pending' && !direct) return errorPage('Only pending requests can be edited. Managers may also edit their own future recorded leave.',user,400);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(), start=String(form.get('start_date')||''), end=String(form.get('end_date')||'');
    const sp=String(form.get('start_portion')||'FULL').toUpperCase(), ep=String(form.get('end_portion')||'FULL').toUpperCase(), notes=String(form.get('employee_notes')||'').trim()||null;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start||!['FULL','AM','PM'].includes(sp)||!['FULL','AM','PM'].includes(ep)) return errorPage('Enter a valid leave period.',user,400);
    const effective=end===start?sp:ep;
    await db.prepare('UPDATE leave_requests SET start_date=?,end_date=?,start_portion=?,end_portion=?,employee_notes=? WHERE id=?').bind(start,end,sp,effective,notes,id).run();
    if(!direct){
      const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);
      for(const manager of managers) await createNotification(db,manager.id,'leave_modified',`Pending leave updated · ${user.display_name}`,`${start}${end!==start?` → ${end}`:''}`,`/leave-requests/${id}`);
    }
    return redirect(request,'/leave');
  }
  const opt=(v,label,current)=>`<option value="${v}" ${current===v?'selected':''}>${label}</option>`;
  const content=`<div class="form-card"><h2>${direct?'Edit Recorded Leave':'Edit Pending Leave'}</h2><form method="post"><label>Start Date<input type="date" name="start_date" value="${h(item.start_date)}" required></label><label>Start Portion<select name="start_portion">${opt('FULL','Full Day',item.start_portion)}${opt('AM','AM (Half Day)',item.start_portion)}${opt('PM','PM (Half Day)',item.start_portion)}</select></label><label>End Date<input type="date" name="end_date" value="${h(item.end_date)}" required></label><label>End Portion<select name="end_portion">${opt('FULL','Full Day',item.end_portion)}${opt('AM','AM (Half Day)',item.end_portion)}${opt('PM','PM (Half Day)',item.end_portion)}</select></label><label>Notes<textarea name="employee_notes" rows="3" maxlength="500">${h(item.employee_notes||'')}</textarea></label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/leave">Cancel</a></div></form></div>`;
  return appPage(direct?'Edit Recorded Leave':'Edit Pending Leave','Update the leave dates or half-day selection.',content,user,'My Leave',db);
}

async function changeOwnApprovedLeave(request, db, user, id) {
  const item=await row(db,'SELECT * FROM leave_requests WHERE id=? AND employee_id=?',id,user.id);
  if(!item)return errorPage('Leave request not found.',user,404);
  const today=new Date().toISOString().slice(0,10);
  if(item.status!=='approved'||item.end_date<today||user.isManager)return errorPage('Only future approved employee leave can be submitted for modification.',user,400);
  const existing=await row(db,"SELECT id FROM leave_change_requests WHERE leave_request_id=? AND status='pending'",id);
  if(existing)return errorPage('A modification request is already pending for this leave.',user,400);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),start=String(form.get('start_date')||''),end=String(form.get('end_date')||''),sp=String(form.get('start_portion')||'FULL').toUpperCase(),ep=String(form.get('end_portion')||'FULL').toUpperCase(),notes=String(form.get('employee_notes')||'').trim()||null;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start||!['FULL','AM','PM'].includes(sp)||!['FULL','AM','PM'].includes(ep))return errorPage('Enter a valid revised leave period.',user,400);
    const effective=end===start?sp:ep;
    const made=await db.prepare("INSERT INTO leave_change_requests (leave_request_id,employee_id,start_date,end_date,start_portion,end_portion,employee_notes) VALUES (?,?,?,?,?,?,?)").bind(id,user.id,start,end,sp,effective,notes).run();
    const changeId=Number(made.meta?.last_row_id);
    const managers=await rows(db,`SELECT DISTINCT e.id FROM employees e JOIN employee_roles er ON er.employee_id=e.id JOIN roles r ON r.id=er.role_id JOIN team_managers tm ON tm.employee_id=e.id WHERE e.is_active=1 AND r.name='Manager' AND tm.team_id=? AND e.id<>?`,user.team_id,user.id);
    for(const m of managers)await createNotification(db,m.id,'leave_change_request',`Annual leave modification · ${user.display_name}`,`${item.start_date} → ${item.end_date} changed to ${start} → ${end}`,`/leave-changes/${changeId}`);
    return redirect(request,'/leave');
  }
  const opt=(v,label,current)=>`<option value="${v}" ${current===v?'selected':''}>${label}</option>`;
  const content=`<div class="card"><h2>Currently Approved</h2><p><strong>${h(item.start_date)}</strong> ${h(item.start_portion||'FULL')} → <strong>${h(item.end_date)}</strong> ${h(item.end_portion||'FULL')}</p><p class="muted">The existing booking remains on the rota until a Manager approves this change.</p></div><div class="form-card section-gap"><h2>Request Modification</h2><form method="post"><label>Start Date<input type="date" name="start_date" value="${h(item.start_date)}" required></label><label>Start Portion<select name="start_portion">${opt('FULL','Full Day',item.start_portion)}${opt('AM','AM (Half Day)',item.start_portion)}${opt('PM','PM (Half Day)',item.start_portion)}</select></label><label>End Date<input type="date" name="end_date" value="${h(item.end_date)}" required></label><label>End Portion<select name="end_portion">${opt('FULL','Full Day',item.end_portion)}${opt('AM','AM (Half Day)',item.end_portion)}${opt('PM','PM (Half Day)',item.end_portion)}</select></label><label>Reason / Note <span class="muted">(optional)</span><textarea name="employee_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">Request Change</button><a class="button secondary" href="/leave">Cancel</a></div></form></div>`;
  return appPage('Modify Annual Leave','Request a change to approved annual leave.',content,user,'My Leave',db);
}

async function managerEditEmployeeLeave(request,db,user,id){
  const item=await row(db,`SELECT lr.*,e.display_name,e.team_id FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id WHERE lr.id=?`,id);
  if(!item)return errorPage('Leave request not found.',user,404);
  if(!user.managedTeamIds.includes(Number(item.team_id)))return accessPage('Access Denied','This leave record is outside your management scope.',403);
  if(item.status!=='approved')return errorPage('Only approved leave can be modified through this Manager action.',user,400);
  if(request.method.toUpperCase()==='POST'){
    const form=await request.formData(),start=String(form.get('start_date')||''),end=String(form.get('end_date')||''),sp=String(form.get('start_portion')||'FULL').toUpperCase(),ep=String(form.get('end_portion')||'FULL').toUpperCase(),notes=String(form.get('manager_notes')||'').trim()||null;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||end<start||!['FULL','AM','PM'].includes(sp)||!['FULL','AM','PM'].includes(ep))return errorPage('Enter a valid revised leave period.',user,400);
    const effective=end===start?sp:ep;
    await db.prepare('UPDATE leave_requests SET start_date=?,end_date=?,start_portion=?,end_portion=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?').bind(start,end,sp,effective,user.id,notes||'Modified by Manager',id).run();
    await createNotification(db,item.employee_id,'leave_modified_manager',`Annual leave modified by ${user.display_name}`,`${item.start_date} → ${item.end_date} changed to ${start} → ${end}${notes?` · ${notes}`:''}`,'/leave');
    return redirect(request,`/leave-requests/${id}`);
  }
  const opt=(v,label,current)=>`<option value="${v}" ${current===v?'selected':''}>${label}</option>`;
  const historical=item.end_date<new Date().toISOString().slice(0,10);
  const content=`<div class="card"><h2>${h(item.display_name)}</h2><p><strong>Current record:</strong> ${h(item.start_date)} ${h(item.start_portion||'FULL')} → ${h(item.end_date)} ${h(item.end_portion||'FULL')}</p>${historical?'<div class="notice"><strong>Historical leave</strong><br>This change will retrospectively alter the employee’s leave record and entitlement calculation.</div>':''}</div><div class="form-card section-gap"><h2>Modify Employee Leave</h2><form method="post"><label>Start Date<input type="date" name="start_date" value="${h(item.start_date)}" required></label><label>Start Portion<select name="start_portion">${opt('FULL','Full Day',item.start_portion)}${opt('AM','AM (Half Day)',item.start_portion)}${opt('PM','PM (Half Day)',item.start_portion)}</select></label><label>End Date<input type="date" name="end_date" value="${h(item.end_date)}" required></label><label>End Portion<select name="end_portion">${opt('FULL','Full Day',item.end_portion)}${opt('AM','AM (Half Day)',item.end_portion)}${opt('PM','PM (Half Day)',item.end_portion)}</select></label><label>Reason / Note <span class="muted">(recommended)</span><textarea name="manager_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit">Apply Change</button><a class="button secondary" href="/leave-requests/${id}">Cancel</a></div></form></div>`;
  return appPage('Modify Employee Leave','Managers can directly correct approved leave, including historical records.',content,user,'Leave Requests',db);
}

async function reviewLeaveChange(request,db,user,id){
  const ch=await row(db,`SELECT lc.*,lr.start_date AS old_start,lr.end_date AS old_end,lr.start_portion AS old_sp,lr.end_portion AS old_ep,e.display_name,e.team_id FROM leave_change_requests lc JOIN leave_requests lr ON lr.id=lc.leave_request_id JOIN employees e ON e.id=lc.employee_id WHERE lc.id=?`,id);
  if(!ch)return errorPage('Leave modification not found.',user,404);
  if(!user.managedTeamIds.includes(Number(ch.team_id)))return accessPage('Access Denied','This modification is outside your management scope.',403);
  if(request.method.toUpperCase()==='POST'){
    if(ch.status!=='pending')return redirect(request,`/leave-changes/${id}`);
    const form=await request.formData(),decision=String(form.get('decision')||'').toLowerCase(),notes=String(form.get('manager_notes')||'').trim()||null;
    if(!['approved','rejected'].includes(decision))return errorPage('Choose Approve or Reject.',user,400);
    if(decision==='approved')await db.prepare('UPDATE leave_requests SET start_date=?,end_date=?,start_portion=?,end_portion=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?').bind(ch.start_date,ch.end_date,ch.start_portion,ch.end_portion,user.id,notes,ch.leave_request_id).run();
    await db.prepare('UPDATE leave_change_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=?').bind(decision,user.id,notes,id).run();
    await createNotification(db,ch.employee_id,'leave_change_review',`Annual leave modification ${decision}`,`${ch.start_date} → ${ch.end_date}${notes?` · ${notes}`:''}`,'/leave');
    return redirect(request,'/leave-requests');
  }
  const content=`<div class="card"><h2>${h(ch.display_name)}</h2><p><strong>Currently approved:</strong> ${h(ch.old_start)} ${h(ch.old_sp)} → ${h(ch.old_end)} ${h(ch.old_ep)}<br><strong>Requested:</strong> ${h(ch.start_date)} ${h(ch.start_portion)} → ${h(ch.end_date)} ${h(ch.end_portion)}</p>${ch.employee_notes?`<p><strong>Employee note:</strong><br>${h(ch.employee_notes)}</p>`:''}</div>${ch.status==='pending'?`<div class="form-card section-gap"><h2>Review Modification</h2><form method="post"><label>Manager Note <span class="muted">(optional)</span><textarea name="manager_notes" rows="3"></textarea></label><div class="action-bar"><button name="decision" value="approved">Approve Change</button><button name="decision" value="rejected" class="secondary">Reject Change</button></div></form></div>`:`<div class="notice section-gap"><strong>${h(ch.status)}</strong></div>`}`;
  return appPage('Review Leave Modification','Compare the approved booking with the requested change.',content,user,'Leave Requests',db);
}

async function leaveRequestsPage(request, db, user) {
  const scopeSql = ` AND e.team_id IN (${user.managedTeamIds.map(() => '?').join(',') || 'NULL'})`;
  const scopeParams = user.managedTeamIds;
  const requests = await rows(db, `SELECT lr.id,lr.start_date,lr.end_date,lr.start_portion,lr.end_portion,lr.status,lr.employee_notes,lr.requested_at,lr.manager_notes,e.display_name,t.name AS team_name,reviewer.display_name AS reviewer_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN teams t ON t.id=e.team_id LEFT JOIN employees reviewer ON reviewer.id=lr.reviewed_by WHERE 1=1${scopeSql} ORDER BY CASE lr.status WHEN 'pending' THEN 0 ELSE 1 END,lr.start_date,lr.requested_at`, ...scopeParams);
  const table = requests.length ? `<table><thead><tr><th>Employee</th><th>Team</th><th>Dates</th><th>Status</th><th>Employee Note</th><th></th></tr></thead><tbody>${requests.map((r) => `<tr><td><strong>${h(r.display_name)}</strong></td><td>${h(r.team_name)}</td><td>${h(r.start_date)} ${h(r.start_portion==='FULL'?'Full Day':r.start_portion)}${r.end_date !== r.start_date ? ` → ${h(r.end_date)} ${h(r.end_portion==='FULL'?'Full Day':r.end_portion)}` : ''}</td><td>${leaveStatus(r.status)}</td><td>${h(r.employee_notes || '—')}</td><td><a class="button secondary" href="/leave-requests/${r.id}">${r.status === 'pending' ? 'Review' : 'View'}</a></td></tr>`).join('')}</tbody></table>` : '<div class="empty">There are no leave requests in your management scope.</div>';
  return appPage('Leave Requests', 'Review annual leave requests for employees in your managed teams.', `<div class="table-card">${table}</div>`, user, 'Leave Requests', db);
}

async function leaveRequestReviewPage(request, db, user, id) {
  const item = await row(db, `SELECT lr.*,e.display_name,e.team_id,t.name AS team_name,COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) AS pattern_id,COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) AS pattern_start_date,COALESCE(orp.cycle_length_weeks,trp.cycle_length_weeks,1) AS cycle_length_weeks,reviewer.display_name AS reviewer_name FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id JOIN teams t ON t.id=e.team_id LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id LEFT JOIN employees reviewer ON reviewer.id=lr.reviewed_by WHERE lr.id=?`, id);
  if (!item) return accessPage('Leave request not found', 'The requested leave request does not exist.', 404);
  if (!user.managedTeamIds.includes(Number(item.team_id))) return accessPage('Access Denied', 'This leave request is outside your management scope.', 403);

  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const decision = String(form.get('decision') || '').toLowerCase();
    const notes = String(form.get('manager_notes') || '').trim() || null;
    if (decision === 'cancelled') {
      if (item.status !== 'approved') return accessPage('Cannot cancel leave', 'Managers can cancel approved leave for employees in their managed teams, including historical leave.', 400);
      await db.prepare("UPDATE leave_requests SET status='cancelled',reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=? AND status='approved'").bind(user.id,notes||'Cancelled by Manager',id).run();
      await createNotification(db,item.employee_id,'leave_cancelled_manager',`Annual leave cancelled by ${user.display_name}`,`${item.start_date}${item.end_date!==item.start_date?` → ${item.end_date}`:''}${notes?` · ${notes}`:''}`,'/leave');
      return redirect(request,'/leave-requests');
    }
    if (item.status !== 'pending') return redirect(request, `/leave-requests/${id}`);
    if (!['approved','rejected'].includes(decision)) return accessPage('Invalid decision', 'Choose Approve or Reject.', 400);
    await db.prepare('UPDATE leave_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP,manager_notes=? WHERE id=? AND status=\'pending\'').bind(decision,user.id,notes,id).run();
    const verb = decision === 'approved' ? 'approved' : 'rejected';
    await createNotification(db, item.employee_id, 'leave_review', `Annual leave ${verb}`, `${item.start_date} ${item.start_portion||'FULL'}${item.end_date!==item.start_date?` → ${item.end_date} ${item.end_portion||'FULL'}`:''}${notes?` · ${notes}`:''}`, '/leave');
    return redirect(request, '/leave-requests');
  }

  const start = new Date(`${item.start_date}T00:00:00Z`), end = new Date(`${item.end_date}T00:00:00Z`);
  const assignments = item.pattern_id ? await rows(db, `SELECT rpw.week_number,wpd.day_of_week,st.code,st.name,st.is_working_day FROM rota_pattern_weeks rpw JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id JOIN shift_types st ON st.id=wpd.shift_type_id WHERE rpw.rota_pattern_id=?`, item.pattern_id) : [];
  const amap = new Map(assignments.map((a) => [`${a.week_number}:${a.day_of_week}`, a]));
  const rotaDays = [];
  for (let d = new Date(start); d <= end && rotaDays.length < 62; d.setUTCDate(d.getUTCDate()+1)) {
    let week=1;
    if(item.pattern_start_date && Number(item.cycle_length_weeks)>0){const ps=new Date(`${item.pattern_start_date}T00:00:00Z`); const dw=Math.floor((d-ps)/(7*86400000)); week=((dw%Number(item.cycle_length_weeks))+Number(item.cycle_length_weeks))%Number(item.cycle_length_weeks)+1;}
    const dow=(d.getUTCDay()+6)%7; const shift=amap.get(`${week}:${dow}`);
    const day=d.toISOString().slice(0,10); let portion='FULL';
    if(day===item.start_date) portion=item.start_portion||'FULL';
    if(day===item.end_date) portion=item.end_portion||'FULL';
    rotaDays.push({date:day,shift:shift?.code||'OFF',working:Boolean(shift?.is_working_day),portion});
  }
  const rotaTable = `<table><thead><tr><th>Date</th><th>Scheduled Shift</th><th>Leave Impact</th></tr></thead><tbody>${rotaDays.map((d)=>`<tr><td>${h(d.date)}</td><td>${h(d.shift)}</td><td>${d.working?`Working day → ${d.portion==='FULL'?'Full Day':d.portion+' Half Day'} Leave`:'Non-working day'}</td></tr>`).join('')}</tbody></table>`;
  const balance = await leaveBalance(db,item.employee_id);
  const requestCost = rotaDays.reduce((sum,d)=>sum+(d.working?(d.portion==='FULL'?1:0.5):0),0);
  const projected = balance ? balance.remaining - requestCost : null;
  const approvalWarning = item.status==='pending' && balance && projected < 0 ? `<div class="notice section-gap"><strong>⚠ Approval would create a negative balance</strong><br>This request uses ${requestCost.toFixed(1)} days. Current remaining balance is ${balance.remaining.toFixed(1)} days; after approval it would be ${projected.toFixed(1)} days. Approval is still permitted.</div>` : '';
  const today = new Date().toISOString().slice(0,10);
  const decision = item.status === 'pending' ? `<div class="form-card section-gap"><h2>Review</h2><form method="post"><label>Manager Note <span class="muted">(optional)</span><textarea name="manager_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit" name="decision" value="approved">Approve</button><button type="submit" name="decision" value="rejected" class="secondary">Reject</button><a class="button secondary" href="/leave-requests">Cancel</a></div></form></div>` : `<div class="notice section-gap"><strong>${h(String(item.status).replace(/^./,x=>x.toUpperCase()))}</strong>${item.reviewer_name?` by ${h(item.reviewer_name)}`:''}${item.manager_notes?`<br>${h(item.manager_notes)}`:''}</div>${item.status==='approved'?`<div class="form-card section-gap"><h2>Manager Actions</h2><p><a class="button secondary" href="/leave-requests/${id}/edit">Modify Employee Leave</a></p><form method="post"><label>Reason / Note <span class="muted">(optional)</span><textarea name="manager_notes" rows="3" maxlength="500"></textarea></label><div class="action-bar"><button type="submit" name="decision" value="cancelled" class="secondary">Cancel Employee Leave</button></div></form></div>`:''}`;
  const content = `<div class="card"><h2>${h(item.display_name)}</h2><p><strong>Team:</strong> ${h(item.team_name)}<br><strong>Requested:</strong> ${h(item.start_date)} ${h(item.start_portion==='FULL'?'Full Day':item.start_portion)}${item.end_date!==item.start_date?` → ${h(item.end_date)} ${h(item.end_portion==='FULL'?'Full Day':item.end_portion)}`:''}<br><strong>Status:</strong> ${leaveStatus(item.status)}</p>${item.employee_notes?`<p><strong>Employee note:</strong><br>${h(item.employee_notes)}</p>`:''}</div>${balanceCard(balance)}${approvalWarning}<div class="table-card section-gap"><h2>Scheduled Rota</h2>${rotaTable}</div>${decision}`;
  return appPage('Review Leave Request', 'Review the request against the employee’s scheduled rota.', content, user, 'Leave Requests', db);
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

      if (path === '/api/notifications/unread-count' && request.method.toUpperCase() === 'GET') {
        const unread = await unreadCount(env.DB, user.id);
        return new Response(JSON.stringify({ unread }), { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', 'cache-control': 'no-store' } });
      }

      if (path === '/notifications' && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return notificationsPage(request, env.DB, user);
      if (/^\/notifications\/\d+$/.test(path) && request.method.toUpperCase() === 'GET') return notificationOpen(request, env.DB, user, Number(path.split('/')[2]));

      if (path === '/leave' && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return myLeavePage(request, env.DB, user);
      if (/^\/leave\/\d+\/cancel$/.test(path) && request.method.toUpperCase() === 'POST') return cancelOwnLeave(request, env.DB, user, Number(path.split('/')[2]));
      if (/^\/leave\/\d+\/change$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return changeOwnApprovedLeave(request, env.DB, user, Number(path.split('/')[2]));
      if (user.isManager && /^\/leave-changes\/\d+$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return reviewLeaveChange(request, env.DB, user, Number(path.split('/')[2]));

      if (/^\/leave\/\d+\/edit$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return editOwnPendingLeave(request, env.DB, user, Number(path.split('/')[2]));


      if (user.isManager && /^\/leave-requests\/\d+\/edit$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return managerEditEmployeeLeave(request, env.DB, user, Number(path.split('/')[2]));

      if (user.isManager && path === '/leave-requests' && request.method.toUpperCase() === 'GET') return leaveRequestsPage(request, env.DB, user);
      if (user.isManager && /^\/leave-requests\/\d+$/.test(path) && (request.method.toUpperCase() === 'GET' || request.method.toUpperCase() === 'POST')) return leaveRequestReviewPage(request, env.DB, user, Number(path.split('/')[2]));

      const requestForApp = withIdentityHeader(request, user.email || identity.email || null);
      if (!user.isManager && !user.isSystemAdmin) {
        if (path === '/') return redirect(request, '/rota');
        if (!path.startsWith('/rota') && !path.startsWith('/assets/')) return accessPage('Access Denied', 'Employees have rota access only.', 403);
      }

      if (user.isManager && !user.isSystemAdmin) {
        if (path === '/employees' || /^\/employees\/\d+\/edit$/.test(path)) return decorateResponse(await managerEmployees(request, env.DB, user), user, path, localAuth, env.DB);
        if (isManagerConfigPath(path)) return decorateResponse(await configWorker.fetch(requestForApp, env), user, path, localAuth, env.DB);
      }

      return decorateResponse(await appWorker.fetch(requestForApp, { ...env, AUTH_REQUIRED: 'true' }), user, path, localAuth, env.DB);
    } catch (error) {
      console.error(error);
      return accessPage('SupportApp Error', error?.message || String(error), 500);
    }
  },
};
