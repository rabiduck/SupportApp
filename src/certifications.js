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

function page(title, description, content, status = 200) {
  return { kind: 'page', title, description, content, status };
}

function redirect(path) {
  return { kind: 'redirect', path };
}

function certManager(user) {
  return Boolean(user?.isSystemAdmin || user?.isManager || user?.isTeamLeader);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
}

function certificationStatus(expiryDate) {
  if (!expiryDate) return { key: 'no_expiry', label: 'No expiry', days: null };
  const today = todayIso();
  const days = daysBetween(today, expiryDate);
  if (days < 0) return { key: 'expired', label: 'Expired', days };
  if (days <= 60) return { key: 'due', label: days === 0 ? 'Expires today' : `Due in ${days} day${days === 1 ? '' : 's'}`, days };
  return { key: 'valid', label: 'Valid', days };
}

function statusBadge(expiryDate) {
  const status = certificationStatus(expiryDate);
  const cls = status.key === 'valid' || status.key === 'no_expiry' ? 'status-active' : status.key === 'expired' ? 'status-inactive' : '';
  return `<span class="status-badge ${cls}">${h(status.label)}</span>`;
}

function addMonthsIso(dateString, months) {
  if (!dateString || !Number.isInteger(months) || months <= 0) return '';
  const [year, month, day] = dateString.split('-').map(Number);
  if (!year || !month || !day) return '';
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

export async function ensureCertificationSchema(db) {
  const current = await row(db, "SELECT value FROM app_meta WHERE key='certification_schema_version'");
  const version = Number(current?.value || 0);
  if (version >= 1) return;

  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS certification_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, issuing_body TEXT, description TEXT, default_valid_months INTEGER, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK (default_valid_months IS NULL OR default_valid_months > 0))"),
    db.prepare("CREATE TABLE IF NOT EXISTS employee_certifications (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, certification_type_id INTEGER NOT NULL, certificate_number TEXT, achieved_date TEXT, expiry_date TEXT, notes TEXT, last_notified_expiry TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(employee_id,certification_type_id), FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE, FOREIGN KEY(certification_type_id) REFERENCES certification_types(id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_employee_certifications_employee ON employee_certifications(employee_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_employee_certifications_expiry ON employee_certifications(expiry_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_certification_types_active ON certification_types(is_active,name)"),
    db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('certification_schema_version','1')")
  ]);
}

export async function certificationAttentionCount(db, employeeId) {
  const today = todayIso();
  const upper = new Date(`${today}T00:00:00Z`);
  upper.setUTCDate(upper.getUTCDate() + 60);
  const upperIso = upper.toISOString().slice(0, 10);
  return Number((await row(db, `SELECT COUNT(*) c FROM employee_certifications WHERE employee_id=? AND expiry_date IS NOT NULL AND expiry_date<=?`, employeeId, upperIso))?.c || 0);
}

export async function runCertificationExpirySweep(db, employeeId = null) {
  const today = todayIso();
  const upper = new Date(`${today}T00:00:00Z`);
  upper.setUTCDate(upper.getUTCDate() + 60);
  const upperIso = upper.toISOString().slice(0, 10);
  const employeeClause = employeeId ? ' AND e.id=?' : '';
  const params = [today, upperIso, ...(employeeId ? [employeeId] : [])];
  const expiring = await rows(db, `SELECT ec.id,ec.employee_id,ec.expiry_date,ec.last_notified_expiry,ct.name,ct.issuing_body,e.display_name
    FROM employee_certifications ec
    JOIN certification_types ct ON ct.id=ec.certification_type_id
    JOIN employees e ON e.id=ec.employee_id
    WHERE e.is_active=1 AND ec.expiry_date IS NOT NULL AND ec.expiry_date>=? AND ec.expiry_date<=?
      AND (ec.last_notified_expiry IS NULL OR ec.last_notified_expiry<>ec.expiry_date)${employeeClause}
    ORDER BY ec.expiry_date,e.display_name,ct.name`, ...params);

  let created = 0;
  for (const cert of expiring) {
    const days = daysBetween(today, cert.expiry_date);
    const title = days === 0 ? `Certification expires today · ${cert.name}` : `Certification expires in ${days} days · ${cert.name}`;
    const issuer = cert.issuing_body ? ` (${cert.issuing_body})` : '';
    const message = `${cert.name}${issuer} expires on ${cert.expiry_date}.`;
    await db.prepare("INSERT INTO notifications(recipient_employee_id,notification_type,title,message,target_url) VALUES(?,?,?,?,?)")
      .bind(cert.employee_id, 'certification_expiry', title, message, '/certifications').run();
    await db.prepare('UPDATE employee_certifications SET last_notified_expiry=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .bind(cert.expiry_date, cert.id).run();
    created += 1;
  }
  return created;
}

async function employeeInScope(db, user, employeeId) {
  const employee = await row(db, 'SELECT id,team_id,display_name,is_active FROM employees WHERE id=?', employeeId);
  if (!employee || !employee.is_active) return null;
  if (user.isSystemAdmin) return employee;
  const managed = new Set((user.managedTeamIds || []).map(Number));
  return managed.has(Number(employee.team_id)) ? employee : null;
}

async function scopedEmployees(db, user) {
  if (user.isSystemAdmin) return rows(db, `SELECT e.id,e.display_name,e.team_id,t.name team_name FROM employees e JOIN teams t ON t.id=e.team_id WHERE e.is_active=1 ORDER BY t.name,e.display_name`);
  const ids = [...new Set((user.managedTeamIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  return rows(db, `SELECT e.id,e.display_name,e.team_id,t.name team_name FROM employees e JOIN teams t ON t.id=e.team_id WHERE e.is_active=1 AND e.team_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.name,e.display_name`, ...ids);
}

async function myCertificationsPage(db, user) {
  const certs = await rows(db, `SELECT ec.*,ct.name,ct.issuing_body,ct.description FROM employee_certifications ec JOIN certification_types ct ON ct.id=ec.certification_type_id WHERE ec.employee_id=? ORDER BY CASE WHEN ec.expiry_date IS NULL THEN 1 ELSE 0 END,ec.expiry_date,ct.name`, user.id);
  const due = certs.filter(c => ['due','expired'].includes(certificationStatus(c.expiry_date).key)).length;
  const summary = certs.length ? `<div class="notice"><strong>${certs.length} certification${certs.length===1?'':'s'} recorded</strong>${due ? `<br>${due} require${due===1?'s':''} attention because they are expired or within 60 days of expiry.` : '<br>No certifications currently require attention.'}</div>` : '';
  const table = certs.length ? `<div class="table-card section-gap"><table><thead><tr><th>Certification</th><th>Issuer</th><th>Achieved</th><th>Expires</th><th>Status</th><th>Certificate / ID</th></tr></thead><tbody>${certs.map(c=>`<tr><td><strong>${h(c.name)}</strong>${c.description?`<br><span class="muted">${h(c.description)}</span>`:''}</td><td>${h(c.issuing_body||'—')}</td><td>${h(c.achieved_date||'—')}</td><td>${h(c.expiry_date||'—')}</td><td>${statusBadge(c.expiry_date)}</td><td>${h(c.certificate_number||'—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No certifications have been recorded for you yet.</div>';
  return page('My Certifications', 'Professional certifications and renewal dates held against your employee record.', `${summary}${table}`);
}

async function certificationAdminPage(request, db, user) {
  if (!certManager(user)) return page('Access Denied', '', '<div class="notice"><strong>Manager, Team Leader or System Administrator access is required.</strong></div>', 403);
  const employees = await scopedEmployees(db, user);
  const url = new URL(request.url);
  const statusFilter = String(url.searchParams.get('status') || 'all').toLowerCase();
  const teamFilter = Number(url.searchParams.get('team') || 0);
  const query = String(url.searchParams.get('q') || '').trim().toLowerCase();
  const allowedEmployeeIds = new Set(employees.map(e => Number(e.id)));
  let certs = [];
  if (allowedEmployeeIds.size) {
    const ids = [...allowedEmployeeIds];
    certs = await rows(db, `SELECT ec.*,ct.name,ct.issuing_body,e.display_name,e.team_id,t.name team_name FROM employee_certifications ec JOIN certification_types ct ON ct.id=ec.certification_type_id JOIN employees e ON e.id=ec.employee_id JOIN teams t ON t.id=e.team_id WHERE ec.employee_id IN (${ids.map(()=>'?').join(',')}) ORDER BY t.name,e.display_name,ct.name`, ...ids);
  }
  certs = certs.filter(c => {
    const status = certificationStatus(c.expiry_date).key;
    if (statusFilter !== 'all' && status !== statusFilter) return false;
    if (teamFilter && Number(c.team_id) !== teamFilter) return false;
    if (query && !`${c.display_name} ${c.name} ${c.issuing_body||''} ${c.certificate_number||''}`.toLowerCase().includes(query)) return false;
    return true;
  });
  const teams = [...new Map(employees.map(e => [Number(e.team_id), e.team_name])).entries()].sort((a,b)=>a[1].localeCompare(b[1]));
  const filters = `<div class="card" style="padding:14px 18px;margin-bottom:16px"><form method="get" action="/certifications/admin" style="display:flex;gap:14px;align-items:end;flex-wrap:wrap"><label style="margin:0">Status<select name="status">${[['all','All statuses'],['due','Due ≤60 days'],['expired','Expired'],['valid','Valid'],['no_expiry','No expiry']].map(([v,l])=>`<option value="${v}" ${statusFilter===v?'selected':''}>${l}</option>`).join('')}</select></label><label style="margin:0">Team<select name="team"><option value="0">All teams</option>${teams.map(([id,name])=>`<option value="${id}" ${teamFilter===id?'selected':''}>${h(name)}</option>`).join('')}</select></label><label style="margin:0">Search<input name="q" value="${h(url.searchParams.get('q')||'')}" placeholder="Employee or certification"></label><button type="submit" class="secondary">Apply Filters</button><a class="button secondary" href="/certifications/admin">Reset</a></form></div>`;
  const table = certs.length ? `<div class="table-card"><table><thead><tr><th>Employee</th><th>Team</th><th>Certification</th><th>Achieved</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody>${certs.map(c=>`<tr><td><strong>${h(c.display_name)}</strong></td><td>${h(c.team_name)}</td><td>${h(c.name)}${c.issuing_body?`<br><span class="muted">${h(c.issuing_body)}</span>`:''}</td><td>${h(c.achieved_date||'—')}</td><td>${h(c.expiry_date||'—')}</td><td>${statusBadge(c.expiry_date)}</td><td><a class="button secondary" href="/certifications/admin/${c.id}/edit">Edit</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No certifications match the selected filters.</div>';
  const actions = `<div class="action-bar"><a class="button" href="/certifications/admin/new">Add Certification</a>${user.isSystemAdmin?'<a class="button secondary" href="/certifications/types">Certification Types</a>':''}</div>`;
  return page('Certification Register', 'Track certifications and expiry dates for employees in your management scope.', `${actions}<div class="section-gap">${filters}${table}</div>`);
}

async function certificationFormPage(request, db, user, id = null) {
  if (!certManager(user)) return page('Access Denied', '', '<div class="notice"><strong>Manager, Team Leader or System Administrator access is required.</strong></div>', 403);
  const employees = await scopedEmployees(db, user);
  let item = { employee_id: '', certification_type_id: '', certificate_number: '', achieved_date: '', expiry_date: '', notes: '', last_notified_expiry: null };
  if (id) {
    item = await row(db, 'SELECT * FROM employee_certifications WHERE id=?', id);
    if (!item) return page('Certification Not Found', '', '<div class="notice"><strong>That certification record does not exist.</strong></div>', 404);
    const target = await employeeInScope(db, user, item.employee_id);
    if (!target) return page('Access Denied', '', '<div class="notice"><strong>That employee is outside your management scope.</strong></div>', 403);
  }
  const types = await rows(db, `SELECT id,name,issuing_body,default_valid_months,is_active FROM certification_types WHERE is_active=1 ${id?'OR id=?':''} ORDER BY is_active DESC,name`, ...(id ? [item.certification_type_id] : []));
  const url = new URL(request.url);
  if (!id && url.searchParams.get('employee')) item.employee_id = Number(url.searchParams.get('employee')) || '';

  let message = '';
  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const originalTypeId = Number(item.certification_type_id) || 0;
    const employeeId = Number(form.get('employee_id'));
    const typeId = Number(form.get('certification_type_id'));
    const certificateNumber = String(form.get('certificate_number') || '').trim() || null;
    const achievedDate = String(form.get('achieved_date') || '').trim() || null;
    let expiryDate = String(form.get('expiry_date') || '').trim() || null;
    const notes = String(form.get('notes') || '').trim() || null;
    item = { ...item, employee_id: employeeId, certification_type_id: typeId, certificate_number: certificateNumber || '', achieved_date: achievedDate || '', expiry_date: expiryDate || '', notes: notes || '' };

    const target = await employeeInScope(db, user, employeeId);
    const type = await row(db, 'SELECT id,name,default_valid_months,is_active FROM certification_types WHERE id=?', typeId);
    if (!target) message = 'Choose an active employee within your management scope.';
    else if (!type || (!type.is_active && Number(type.id) !== originalTypeId)) message = 'Choose an active certification type.';
    else if (achievedDate && !/^\d{4}-\d{2}-\d{2}$/.test(achievedDate)) message = 'Achieved date must be a valid date.';
    else if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) message = 'Expiry date must be a valid date.';
    else {
      if (!expiryDate && achievedDate && Number(type.default_valid_months) > 0) expiryDate = addMonthsIso(achievedDate, Number(type.default_valid_months));
      if (expiryDate && achievedDate && expiryDate < achievedDate) message = 'Expiry date cannot be before the achieved date.';
      const duplicate = !message ? await row(db, `SELECT id FROM employee_certifications WHERE employee_id=? AND certification_type_id=?${id?' AND id<>?':''}`, employeeId, typeId, ...(id ? [id] : [])) : null;
      if (duplicate) message = 'That employee already has this certification type recorded. Edit the existing record instead.';
    }

    if (!message) {
      if (id) {
        const original = await row(db, 'SELECT expiry_date,last_notified_expiry FROM employee_certifications WHERE id=?', id);
        const notifiedValue = (original?.expiry_date || null) === expiryDate ? original?.last_notified_expiry || null : null;
        await db.prepare('UPDATE employee_certifications SET employee_id=?,certification_type_id=?,certificate_number=?,achieved_date=?,expiry_date=?,notes=?,last_notified_expiry=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .bind(employeeId,typeId,certificateNumber,achievedDate,expiryDate,notes,notifiedValue,id).run();
      } else {
        await db.prepare('INSERT INTO employee_certifications(employee_id,certification_type_id,certificate_number,achieved_date,expiry_date,notes) VALUES(?,?,?,?,?,?)')
          .bind(employeeId,typeId,certificateNumber,achievedDate,expiryDate,notes).run();
      }
      await runCertificationExpirySweep(db, employeeId);
      return redirect('/certifications/admin');
    }
  }

  const typeOptions = types.map(t=>`<option value="${t.id}" ${Number(item.certification_type_id)===Number(t.id)?'selected':''}>${h(t.name)}${t.issuing_body?` · ${h(t.issuing_body)}`:''}${t.default_valid_months?` · ${t.default_valid_months} months`:''}</option>`).join('');
  const employeeOptions = employees.map(e=>`<option value="${e.id}" ${Number(item.employee_id)===Number(e.id)?'selected':''}>${h(e.display_name)} · ${h(e.team_name)}</option>`).join('');
  const content = `${message?`<div class="notice"><strong>${h(message)}</strong></div>`:''}<div class="form-card"><form method="post"><label>Employee<select name="employee_id" required><option value="">Select employee</option>${employeeOptions}</select></label><label>Certification Type<select name="certification_type_id" required><option value="">Select certification</option>${typeOptions}</select></label><label>Certificate / Credential ID<input name="certificate_number" value="${h(item.certificate_number||'')}"></label><div class="form-grid"><label>Achieved Date<input name="achieved_date" type="date" value="${h(item.achieved_date||'')}"></label><label>Expiry Date <span class="muted">(leave blank for non-expiring; defaults from type when configured)</span><input name="expiry_date" type="date" value="${h(item.expiry_date||'')}"></label></div><label>Notes<textarea name="notes" rows="4">${h(item.notes||'')}</textarea></label><div class="action-bar"><button type="submit">${id?'Save Changes':'Add Certification'}</button><a class="button secondary" href="/certifications/admin">Cancel</a></div></form>${id?`<form method="post" action="/certifications/admin/${id}/delete" class="section-gap"><button type="submit" class="secondary">Delete Certification Record</button></form>`:''}</div>`;
  return page(id ? 'Edit Certification' : 'Add Certification', 'Maintain an employee certification record and its renewal date.', content);
}

async function deleteCertification(db, user, id) {
  if (!certManager(user)) return page('Access Denied', '', '<div class="notice"><strong>Manager, Team Leader or System Administrator access is required.</strong></div>', 403);
  const item = await row(db, 'SELECT employee_id FROM employee_certifications WHERE id=?', id);
  if (!item) return redirect('/certifications/admin');
  const target = await employeeInScope(db, user, item.employee_id);
  if (!target) return page('Access Denied', '', '<div class="notice"><strong>That employee is outside your management scope.</strong></div>', 403);
  await db.prepare('DELETE FROM employee_certifications WHERE id=?').bind(id).run();
  return redirect('/certifications/admin');
}

async function certificationTypesPage(request, db, user) {
  if (!user.isSystemAdmin) return page('Access Denied', '', '<div class="notice"><strong>System Administrator access is required to maintain certification types.</strong></div>', 403);
  const url = new URL(request.url);
  const editId = Number(url.searchParams.get('edit') || 0);
  let editing = editId ? await row(db, 'SELECT * FROM certification_types WHERE id=?', editId) : null;
  let message = '';

  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const id = Number(form.get('id') || 0);
    const name = String(form.get('name') || '').trim();
    const issuingBody = String(form.get('issuing_body') || '').trim() || null;
    const description = String(form.get('description') || '').trim() || null;
    const monthsRaw = String(form.get('default_valid_months') || '').trim();
    const months = monthsRaw ? Number(monthsRaw) : null;
    const active = form.get('is_active') === '1' ? 1 : 0;
    editing = { id, name, issuing_body: issuingBody || '', description: description || '', default_valid_months: monthsRaw, is_active: active };
    if (!name) message = 'Certification name is required.';
    else if (months !== null && (!Number.isInteger(months) || months < 1 || months > 240)) message = 'Default validity must be between 1 and 240 months.';
    else {
      const duplicate = await row(db, `SELECT id FROM certification_types WHERE LOWER(name)=LOWER(?)${id?' AND id<>?':''}`, name, ...(id ? [id] : []));
      if (duplicate) message = 'A certification type with that name already exists.';
    }
    if (!message) {
      if (id) await db.prepare('UPDATE certification_types SET name=?,issuing_body=?,description=?,default_valid_months=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(name,issuingBody,description,months,active,id).run();
      else await db.prepare('INSERT INTO certification_types(name,issuing_body,description,default_valid_months,is_active) VALUES(?,?,?,?,?)').bind(name,issuingBody,description,months,active).run();
      return redirect('/certifications/types');
    }
  }

  const types = await rows(db, 'SELECT ct.*,COUNT(ec.id) employee_count FROM certification_types ct LEFT JOIN employee_certifications ec ON ec.certification_type_id=ct.id GROUP BY ct.id ORDER BY ct.is_active DESC,ct.name');
  const form = `<div class="form-card"><h2>${editing?.id?'Edit Certification Type':'Add Certification Type'}</h2>${message?`<div class="notice"><strong>${h(message)}</strong></div>`:''}<form method="post"><input type="hidden" name="id" value="${editing?.id||''}"><label>Name<input name="name" value="${h(editing?.name||'')}" required></label><label>Issuing Body<input name="issuing_body" value="${h(editing?.issuing_body||'')}" placeholder="e.g. Microsoft, Check Point"></label><label>Default Validity (months) <span class="muted">(optional)</span><input name="default_valid_months" type="number" min="1" max="240" value="${h(editing?.default_valid_months??'')}"></label><label>Description<textarea name="description" rows="3">${h(editing?.description||'')}</textarea></label><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="is_active" value="1" ${editing?.id ? (editing.is_active?'checked':'') : 'checked'} style="width:auto"> Active</label><div class="action-bar"><button type="submit">${editing?.id?'Save Type':'Add Type'}</button>${editing?.id?'<a class="button secondary" href="/certifications/types">Cancel</a>':''}</div></form></div>`;
  const table = types.length ? `<div class="table-card section-gap"><table><thead><tr><th>Certification</th><th>Issuer</th><th>Default Validity</th><th>Employees</th><th>Status</th><th></th></tr></thead><tbody>${types.map(t=>`<tr><td><strong>${h(t.name)}</strong>${t.description?`<br><span class="muted">${h(t.description)}</span>`:''}</td><td>${h(t.issuing_body||'—')}</td><td>${t.default_valid_months?`${t.default_valid_months} months`:'—'}</td><td>${t.employee_count}</td><td>${t.is_active?'<span class="status-badge status-active">Active</span>':'<span class="status-badge status-inactive">Inactive</span>'}</td><td><a class="button secondary" href="/certifications/types?edit=${t.id}">Edit</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty section-gap">No certification types configured yet.</div>';
  return page('Certification Types', 'Global catalogue of certifications that can be assigned to employees.', `${form}${table}`);
}

export async function handleCertificationRoute(request, db, user) {
  const path = new URL(request.url).pathname.replace(/\/$/, '') || '/';
  const method = request.method.toUpperCase();
  if (path === '/certifications' && method === 'GET') return myCertificationsPage(db, user);
  if (path === '/certifications/admin' && method === 'GET') return certificationAdminPage(request, db, user);
  if (path === '/certifications/admin/new' && (method === 'GET' || method === 'POST')) return certificationFormPage(request, db, user, null);
  if (/^\/certifications\/admin\/\d+\/edit$/.test(path) && (method === 'GET' || method === 'POST')) return certificationFormPage(request, db, user, Number(path.split('/')[3]));
  if (/^\/certifications\/admin\/\d+\/delete$/.test(path) && method === 'POST') return deleteCertification(db, user, Number(path.split('/')[3]));
  if (path === '/certifications/types' && (method === 'GET' || method === 'POST')) return certificationTypesPage(request, db, user);
  return null;
}
