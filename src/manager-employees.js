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

function shell(title, content, user, active = 'Employees') {
  const nav = [
    ['Dashboard','/'],['Rota','/rota'],['Employees','/employees'],['Shift Patterns','/shift-patterns']
  ].map(([name,href]) => `<a class="${active === name ? 'active' : ''}" href="${href}">${name}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body><header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">${h(user.display_name)} · Manager</div></header><div class="app-shell"><nav class="side-nav">${nav}</nav><main class="page">${content}</main></div><footer class="footer">SupportApp · Cloudflare-native UAT</footer></body></html>`;
}

const pageHeader = (title, description) => `<div class="page-header"><div><div class="page-title">${h(title)}</div><div class="page-description">${h(description)}</div></div></div>`;
const response = (title, content, user, status = 200) => new Response(shell(title, content, user), { status, headers: { 'content-type': 'text/html; charset=UTF-8' } });
const errorPage = (message, user, status = 400) => response('Unable to save', `${pageHeader('Unable to save','The requested change could not be completed.')}<div class="notice"><strong>${h(message)}</strong></div>`, user, status);

function teamScope(user) {
  const ids = user.managedTeamIds || [];
  return ids.length ? { sql: `(${ids.map(() => '?').join(',')})`, params: ids } : null;
}

async function listPage(db, user) {
  const scope = teamScope(user);
  const employees = scope ? await rows(db, `SELECT e.*,t.name AS team_name,COALESCE(orp.name,trp.name,'No Scheduled Hours') AS rota_name,
    COALESCE((SELECT GROUP_CONCAT(r.name, ', ') FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=e.id),'Employee') AS role_name
    FROM employees e JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id
    WHERE e.team_id IN ${scope.sql} ORDER BY e.display_name`, ...scope.params) : [];
  const teams = scope ? await rows(db, `SELECT id,name FROM teams WHERE id IN ${scope.sql} AND is_active=1 ORDER BY name`, ...scope.params) : [];
  const patterns = await rows(db, "SELECT id,name FROM rota_patterns WHERE is_active=1 AND name<>'No Scheduled Hours' ORDER BY name");

  const table = employees.length ? `<table><thead><tr><th>Employee</th><th>Username</th><th>Role</th><th>Team</th><th>Rota</th><th>Status</th><th></th></tr></thead><tbody>${employees.map(e => `<tr><td><a href="/employees/${e.id}/edit"><strong>${h(e.display_name)}</strong></a></td><td>${h(e.username || '—')}</td><td>${h(e.role_name || 'Employee')}</td><td>${h(e.team_name)}</td><td>${h(e.rota_name)}</td><td>${e.is_active ? 'Active' : 'Inactive'}</td><td><a class="button secondary" href="/employees/${e.id}/edit">Edit</a></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No employees are available in your management scope.</div>';

  const create = teams.length ? `<div class="form-card section-gap"><h2>Create Employee</h2><form method="post" action="/employees"><label>Display Name<input name="display_name" required maxlength="100"></label><label>Username<input name="username" required maxlength="100"></label><label>Email<input name="email" type="email" required maxlength="200"></label><label>Role<input value="Employee" disabled></label><label>Team<select name="team_id" required>${teams.map(t => `<option value="${t.id}">${h(t.name)}</option>`).join('')}</select></label><label>Job Title<input name="job_title" maxlength="100"></label><label>Phone<input name="phone" maxlength="50"></label><label>Rota Override<select name="override_rota_pattern_id"><option value="">— Inherit team default —</option>${patterns.map(p => `<option value="${p.id}">${h(p.name)}</option>`).join('')}</select></label><label>Override Start Date<input name="override_pattern_start_date" type="date"></label><div class="action-bar"><button type="submit">Create Employee</button></div></form></div>` : '';

  return response('Employees', `${pageHeader('Employees','People and identities within the teams you manage.')}<div class="notice"><strong>Manager access</strong><br>Managers may create and maintain Employees in their assigned teams. Manager and SystemAdmin role changes remain restricted to SystemAdmin.</div><div class="table-card">${table}</div>${create}`, user);
}

async function editPage(db, id, user) {
  const scope = teamScope(user);
  if (!scope) return errorPage('This manager has no assigned team scope.', user, 403);
  const employee = await row(db, `SELECT e.* FROM employees e WHERE e.id=? AND e.team_id IN ${scope.sql}`, id, ...scope.params);
  if (!employee) return errorPage('This employee is outside your management scope.', user, 403);
  const role = await row(db, `SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? LIMIT 1`, id);
  if (role?.name === 'Manager' || role?.name === 'SystemAdmin') return errorPage('Manager and SystemAdmin accounts may only be edited by SystemAdmin.', user, 403);
  const teams = await rows(db, `SELECT id,name FROM teams WHERE id IN ${scope.sql} AND (is_active=1 OR id=?) ORDER BY name`, ...scope.params, employee.team_id);
  const patterns = await rows(db, "SELECT id,name FROM rota_patterns WHERE is_active=1 AND name<>'No Scheduled Hours' ORDER BY name");
  const teamOptions = teams.map(t => `<option value="${t.id}" ${Number(t.id)===Number(employee.team_id)?'selected':''}>${h(t.name)}</option>`).join('');
  const patternOptions = `<option value="">— Inherit team default —</option>${patterns.map(p => `<option value="${p.id}" ${Number(p.id)===Number(employee.override_rota_pattern_id)?'selected':''}>${h(p.name)}</option>`).join('')}`;
  const leaveYears = await rows(db, 'SELECT id,name,start_date,end_date FROM leave_years WHERE is_active=1 ORDER BY start_date DESC');
  const annualType = await row(db, "SELECT id FROM leave_types WHERE code='ANNUAL'");
  const entitlements = annualType ? await rows(db, 'SELECT leave_year_id,entitlement_hours,adjustment_hours,notes FROM employee_leave_entitlements WHERE employee_id=? AND leave_type_id=?', id, annualType.id) : [];
  const entitlementMap = new Map(entitlements.map(e => [Number(e.leave_year_id), e]));
  const leaveSection = leaveYears.length ? `<div class="form-card section-gap"><h2>Annual Leave Entitlement</h2><p class="muted">Enter the authoritative entitlement in hours. Use adjustment for carry-over or exceptional changes.</p><form method="post" action="/employees/${id}/leave-entitlement">${leaveYears.map(y => { const e=entitlementMap.get(Number(y.id))||{}; return `<div class="card section-gap"><strong>${h(y.name)}</strong> <span class="muted">${h(y.start_date)} → ${h(y.end_date)}</span><input type="hidden" name="leave_year_id" value="${y.id}"><label>Entitlement Hours<input type="number" name="entitlement_hours_${y.id}" min="0" step="0.25" value="${h(e.entitlement_hours ?? 0)}"></label><label>Adjustment Hours<input type="number" name="adjustment_hours_${y.id}" step="0.25" value="${h(e.adjustment_hours ?? 0)}"></label><label>Notes<input name="entitlement_notes_${y.id}" maxlength="255" value="${h(e.notes||'')}"></label></div>`; }).join('')}<div class="action-bar"><button type="submit">Save Entitlement</button></div></form></div>` : '<div class="notice section-gap"><strong>No active leave year configured.</strong></div>';
  return response('Edit Employee', `${pageHeader('Edit Employee','Update identity, team membership and rota settings.')}<div class="form-card"><form method="post" action="/employees/${id}/edit"><label>Display Name<input name="display_name" required value="${h(employee.display_name)}"></label><label>Username<input name="username" required value="${h(employee.username||'')}"></label><label>Email<input name="email" type="email" required value="${h(employee.email||'')}"></label><label>Role<input value="Employee" disabled></label><label>Team<select name="team_id" required>${teamOptions}</select></label><label>Job Title<input name="job_title" value="${h(employee.job_title||'')}"></label><label>Phone<input name="phone" value="${h(employee.phone||'')}"></label><label>Rota Override<select name="override_rota_pattern_id">${patternOptions}</select></label><label>Override Start Date<input name="override_pattern_start_date" type="date" value="${h(employee.override_pattern_start_date||'')}"></label><label class="checkbox-label"><input type="checkbox" name="is_active" ${employee.is_active?'checked':''}> Active</label><div class="action-bar"><button type="submit">Save Changes</button><a class="button secondary" href="/employees">Cancel</a></div></form></div>${leaveSection}`, user);
}

async function saveEntitlement(request, db, user, id) {
  const scope=teamScope(user);
  const employee=scope ? await row(db,`SELECT id FROM employees WHERE id=? AND team_id IN ${scope.sql}`,id,...scope.params) : null;
  if(!employee) return errorPage('This employee is outside your management scope.',user,403);
  const annualType=await row(db,"SELECT id FROM leave_types WHERE code='ANNUAL'");
  if(!annualType) return errorPage('Annual Leave is not configured.',user,500);
  const form=await request.formData();
  for(const raw of form.getAll('leave_year_id')) {
    const yearId=Number(raw); if(!yearId) continue;
    const entitlement=Math.max(0,Number(form.get(`entitlement_hours_${yearId}`))||0);
    const adjustment=Number(form.get(`adjustment_hours_${yearId}`))||0;
    const notes=String(form.get(`entitlement_notes_${yearId}`)||'').trim()||null;
    await db.prepare(`INSERT INTO employee_leave_entitlements (employee_id,leave_year_id,leave_type_id,entitlement_hours,adjustment_hours,notes) VALUES (?,?,?,?,?,?)
      ON CONFLICT(employee_id,leave_year_id,leave_type_id) DO UPDATE SET entitlement_hours=excluded.entitlement_hours,adjustment_hours=excluded.adjustment_hours,notes=excluded.notes,updated_at=CURRENT_TIMESTAMP`)
      .bind(id,yearId,annualType.id,entitlement,adjustment,notes).run();
  }
  return redirect(request,`/employees/${id}/edit`);
}

async function saveEmployee(request, db, user, id = null) {
  const form = await request.formData();
  const teamId = Number(form.get('team_id'));
  if (!(user.managedTeamIds || []).includes(teamId)) return errorPage('The selected team is outside your management scope.', user, 403);
  if (id) {
    const current = await row(db, 'SELECT team_id FROM employees WHERE id=?', id);
    if (!current || !(user.managedTeamIds || []).includes(Number(current.team_id))) return errorPage('This employee is outside your management scope.', user, 403);
    const role = await row(db, `SELECT r.name FROM employee_roles er JOIN roles r ON r.id=er.role_id WHERE er.employee_id=? LIMIT 1`, id);
    if (role?.name === 'Manager' || role?.name === 'SystemAdmin') return errorPage('Manager and SystemAdmin accounts may only be edited by SystemAdmin.', user, 403);
  }

  const displayName = String(form.get('display_name') || '').trim();
  const username = String(form.get('username') || '').trim();
  const email = String(form.get('email') || '').trim();
  if (!displayName || !username || !email) return errorPage('Display name, username and email are required.', user);
  const employeeRole = await row(db, "SELECT id FROM roles WHERE name='Employee'");
  if (!employeeRole) return errorPage('Employee role is not available.', user, 500);

  try {
    let employeeId = id;
    if (id) {
      await db.prepare(`UPDATE employees SET display_name=?,username=?,email=?,team_id=?,job_title=?,phone=?,override_rota_pattern_id=?,override_pattern_start_date=?,is_active=? WHERE id=?`)
        .bind(displayName,username,email,teamId,String(form.get('job_title')||'').trim()||null,String(form.get('phone')||'').trim()||null,Number(form.get('override_rota_pattern_id'))||null,String(form.get('override_pattern_start_date')||'').trim()||null,form.has('is_active')?1:0,id).run();
    } else {
      const result = await db.prepare(`INSERT INTO employees (team_id,display_name,username,email,job_title,phone,override_rota_pattern_id,override_pattern_start_date) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(teamId,displayName,username,email,String(form.get('job_title')||'').trim()||null,String(form.get('phone')||'').trim()||null,Number(form.get('override_rota_pattern_id'))||null,String(form.get('override_pattern_start_date')||'').trim()||null).run();
      employeeId = result.meta?.last_row_id;
    }
    if (employeeId) {
      await db.prepare('DELETE FROM employee_roles WHERE employee_id=?').bind(employeeId).run();
      await db.prepare('INSERT INTO employee_roles (employee_id,role_id) VALUES (?,?)').bind(employeeId, employeeRole.id).run();
      await db.prepare('DELETE FROM team_managers WHERE employee_id=?').bind(employeeId).run();
    }
    return redirect(request, '/employees');
  } catch (error) {
    const msg = String(error?.message || error);
    if (msg.includes('employees.username')) return errorPage(`The username “${username}” is already in use.`, user, 409);
    if (msg.includes('employees.email')) return errorPage(`The email address “${email}” is already in use.`, user, 409);
    throw error;
  }
}

export async function managerEmployees(request, db, user) {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  const method = request.method.toUpperCase();
  if (method === 'GET' && path === '/employees') return listPage(db, user);
  if (method === 'POST' && path === '/employees') return saveEmployee(request, db, user);
  const entitlementMatch = path.match(/^\/employees\/(\d+)\/leave-entitlement$/);
  if (entitlementMatch && method === 'POST') return saveEntitlement(request, db, user, Number(entitlementMatch[1]));
  const match = path.match(/^\/employees\/(\d+)\/edit$/);
  if (match && method === 'GET') return editPage(db, Number(match[1]), user);
  if (match && method === 'POST') return saveEmployee(request, db, user, Number(match[1]));
  return errorPage('Unsupported employee operation.', user, 404);
}
