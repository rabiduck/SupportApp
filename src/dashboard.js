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

function londonDateParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'long', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return {
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    label: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now),
    hour: Number(parts.hour || 12)
  };
}

function addDays(dateText, amount) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function mondayFor(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function fridayFor(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - 5 + 7) % 7));
  return date.toISOString().slice(0, 10);
}

function cycleWeek(dateText, patternStart, length) {
  if (!patternStart || Number(length) <= 0) return 1;
  const weeks = Math.floor((new Date(`${dateText}T12:00:00Z`) - new Date(`${patternStart}T12:00:00Z`)) / 604800000);
  return ((weeks % Number(length)) + Number(length)) % Number(length) + 1;
}

async function scopeTeamIds(db, user) {
  if (user.isSystemAdmin) return (await rows(db, 'SELECT id FROM teams WHERE is_active=1 ORDER BY name')).map((x) => Number(x.id));
  if (user.isManager || user.isTeamLeader) return [...new Set((user.managedTeamIds || []).map(Number))];
  return [Number(user.team_id)];
}

function placeholders(values) {
  return values.map(() => '?').join(',') || 'NULL';
}

async function scopedEmployees(db, user, teamIds) {
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) {
    return rows(db, `SELECT e.id,e.display_name,e.team_id,t.name team_name,
      COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) pattern_id,
      COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) pattern_start_date,
      COALESCE(op.cycle_length_weeks,tp.cycle_length_weeks,1) cycle_length_weeks
      FROM employees e JOIN teams t ON t.id=e.team_id
      LEFT JOIN rota_patterns op ON op.id=e.override_rota_pattern_id
      LEFT JOIN rota_patterns tp ON tp.id=t.default_rota_pattern_id
      WHERE e.id=? AND e.is_active=1`, user.id);
  }
  return rows(db, `SELECT e.id,e.display_name,e.team_id,t.name team_name,
    COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) pattern_id,
    COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) pattern_start_date,
    COALESCE(op.cycle_length_weeks,tp.cycle_length_weeks,1) cycle_length_weeks
    FROM employees e JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns op ON op.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns tp ON tp.id=t.default_rota_pattern_id
    WHERE e.is_active=1 AND e.team_id IN (${placeholders(teamIds)}) ORDER BY t.name,e.display_name`, ...teamIds);
}

async function todayPositions(db, employees, today) {
  if (!employees.length) return [];
  const employeeIds = employees.map((x) => Number(x.id));
  const patternIds = [...new Set(employees.map((x) => Number(x.pattern_id)).filter(Boolean))];
  const [assignments, overrides, leave, wfh, absences, sickness] = await Promise.all([
    patternIds.length ? rows(db, `SELECT rpw.rota_pattern_id,rpw.week_number,wpd.day_of_week,st.name,st.code,st.start_time,st.end_time,st.is_working_day
      FROM rota_pattern_weeks rpw JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id
      JOIN shift_types st ON st.id=wpd.shift_type_id WHERE rpw.rota_pattern_id IN (${placeholders(patternIds)})`, ...patternIds) : [],
    rows(db, `SELECT o.employee_id,st.name,st.code,st.start_time,st.end_time,st.is_working_day FROM shift_overrides o
      JOIN shift_types st ON st.id=o.shift_type_id WHERE o.is_active=1 AND o.override_date=?
      AND o.employee_id IN (${placeholders(employeeIds)}) ORDER BY o.id DESC`, today, ...employeeIds),
    rows(db, `SELECT employee_id,status,start_portion,end_portion,start_date,end_date FROM leave_requests
      WHERE status IN ('pending','approved') AND start_date<=? AND end_date>=? AND employee_id IN (${placeholders(employeeIds)})
      ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END,id DESC`, today, today, ...employeeIds),
    rows(db, `SELECT employee_id,status FROM wfh_requests WHERE status IN ('pending','approved') AND request_date=?
      AND employee_id IN (${placeholders(employeeIds)}) ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END,id DESC`, today, ...employeeIds),
    rows(db, `SELECT a.employee_id,t.name type_name FROM absences a JOIN absence_types t ON t.id=a.absence_type_id
      WHERE a.is_active=1 AND a.start_date<=? AND a.end_date>=? AND a.employee_id IN (${placeholders(employeeIds)}) ORDER BY a.id DESC`, today, today, ...employeeIds),
    rows(db, `SELECT employee_id FROM sickness WHERE is_active=1 AND start_date<=? AND end_date>=?
      AND employee_id IN (${placeholders(employeeIds)}) ORDER BY id DESC`, today, today, ...employeeIds)
  ]);
  const firstMap = (items) => { const map = new Map(); for (const item of items) if (!map.has(Number(item.employee_id))) map.set(Number(item.employee_id), item); return map; };
  const assignmentMap = new Map(assignments.map((x) => [`${x.rota_pattern_id}:${x.week_number}:${x.day_of_week}`, x]));
  const overrideMap = firstMap(overrides), leaveMap = firstMap(leave), wfhMap = firstMap(wfh), absenceMap = firstMap(absences), sicknessMap = firstMap(sickness);
  const dayOfWeek = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  return employees.map((employee) => {
    const id = Number(employee.id), override = overrideMap.get(id);
    const shift = override || assignmentMap.get(`${employee.pattern_id}:${cycleWeek(today, employee.pattern_start_date, employee.cycle_length_weeks)}:${dayOfWeek}`) || null;
    const leaveItem = leaveMap.get(id), wfhItem = wfhMap.get(id), absence = absenceMap.get(id), sick = sicknessMap.get(id);
    let state = shift?.is_working_day ? 'Working' : shift ? 'Not working' : 'No rota';
    let tone = shift?.is_working_day ? 'success' : 'muted';
    if (wfhItem) { state = wfhItem.status === 'approved' ? 'WFH' : 'WFH pending'; tone = wfhItem.status === 'approved' ? 'info' : 'warning'; }
    if (leaveItem) { state = leaveItem.status === 'approved' ? 'Annual leave' : 'Leave pending'; tone = leaveItem.status === 'approved' ? 'muted' : 'warning'; }
    if (absence) { state = absence.type_name; tone = 'warning'; }
    if (sick) { state = 'Sickness'; tone = 'danger'; }
    return { ...employee, shift, shiftOverride: Boolean(override), state, tone, duties: [] };
  });
}

async function onCallFor(db, today) {
  const override = await row(db, `SELECT o.employee_id,e.display_name FROM oncall_overrides o JOIN employees e ON e.id=o.employee_id
    WHERE o.is_active=1 AND o.start_date<=? AND o.end_date>=? ORDER BY o.id DESC LIMIT 1`, today, today);
  if (override) return override;
  const members = await rows(db, `SELECT m.id,m.employee_id,e.display_name FROM oncall_members m JOIN employees e ON e.id=m.employee_id
    WHERE m.is_active=1 AND e.is_active=1 ORDER BY m.display_order,m.id`);
  const settings = await row(db, 'SELECT anchor_friday,anchor_member_id FROM oncall_settings WHERE id=1');
  if (!members.length || !settings?.anchor_friday) return null;
  const weeks = Math.floor((new Date(`${fridayFor(today)}T12:00:00Z`) - new Date(`${settings.anchor_friday}T12:00:00Z`)) / 604800000);
  const anchor = Math.max(0, members.findIndex((x) => Number(x.id) === Number(settings.anchor_member_id)));
  return members[((anchor + weeks) % members.length + members.length) % members.length];
}

async function gatekeepersFor(db, teamIds, today) {
  if (!teamIds.length || [0, 6].includes(new Date(`${today}T12:00:00Z`).getUTCDay())) return [];
  const teams = await rows(db, `SELECT id,name FROM teams WHERE is_active=1 AND gatekeeper_enabled=1 AND id IN (${placeholders(teamIds)}) ORDER BY name`, ...teamIds);
  const result = [];
  for (const team of teams) {
    const override = await row(db, `SELECT o.employee_id,e.display_name FROM gatekeeper_overrides o JOIN employees e ON e.id=o.employee_id
      WHERE o.team_id=? AND o.is_active=1 AND o.start_date<=? AND o.end_date>=? ORDER BY o.id DESC LIMIT 1`, team.id, today, today);
    if (override) { result.push({ ...override, team_id: team.id, team_name: team.name }); continue; }
    const members = await rows(db, 'SELECT id,display_name FROM employees WHERE team_id=? AND is_active=1 ORDER BY COALESCE(gatekeeper_order,999999),display_name,id', team.id);
    const settings = await row(db, 'SELECT anchor_monday,anchor_employee_id FROM gatekeeper_settings WHERE team_id=?', team.id);
    if (!members.length || !settings?.anchor_monday) continue;
    const weeks = Math.floor((new Date(`${mondayFor(today)}T12:00:00Z`) - new Date(`${settings.anchor_monday}T12:00:00Z`)) / 604800000);
    const anchor = Math.max(0, members.findIndex((x) => Number(x.id) === Number(settings.anchor_employee_id)));
    const member = members[((anchor + weeks) % members.length + members.length) % members.length];
    result.push({ employee_id: member.id, display_name: member.display_name, team_id: team.id, team_name: team.name });
  }
  return result;
}

function attachDuties(positions, onCall, gatekeepers) {
  const map = new Map(positions.map((x) => [Number(x.id), x]));
  if (onCall && map.has(Number(onCall.employee_id))) map.get(Number(onCall.employee_id)).duties.push('On Call');
  for (const duty of gatekeepers) if (map.has(Number(duty.employee_id))) map.get(Number(duty.employee_id)).duties.push('Gatekeeper');
}

async function upcomingItems(db, employeeIds, today, days = 14) {
  if (!employeeIds.length) return [];
  const end = addDays(today, days);
  const inScope = placeholders(employeeIds), params = [today, end, ...employeeIds];
  const [leave, wfh, absence, sickness] = await Promise.all([
    rows(db, `SELECT lr.employee_id,e.display_name,t.name team_name,'Annual Leave' kind,lr.start_date,lr.end_date FROM leave_requests lr
      JOIN employees e ON e.id=lr.employee_id JOIN teams t ON t.id=e.team_id WHERE lr.status='approved' AND lr.end_date>=? AND lr.start_date<=?
      AND lr.employee_id IN (${inScope})`, ...params),
    rows(db, `SELECT w.employee_id,e.display_name,t.name team_name,'WFH' kind,w.request_date start_date,w.request_date end_date FROM wfh_requests w
      JOIN employees e ON e.id=w.employee_id JOIN teams t ON t.id=e.team_id WHERE w.status='approved' AND w.request_date>=? AND w.request_date<=?
      AND w.employee_id IN (${inScope})`, ...params),
    rows(db, `SELECT a.employee_id,e.display_name,t.name team_name,at.name kind,a.start_date,a.end_date FROM absences a
      JOIN absence_types at ON at.id=a.absence_type_id JOIN employees e ON e.id=a.employee_id JOIN teams t ON t.id=e.team_id
      WHERE a.is_active=1 AND a.end_date>=? AND a.start_date<=? AND a.employee_id IN (${inScope})`, ...params),
    rows(db, `SELECT s.employee_id,e.display_name,t.name team_name,'Sickness' kind,s.start_date,s.end_date FROM sickness s
      JOIN employees e ON e.id=s.employee_id JOIN teams t ON t.id=e.team_id WHERE s.is_active=1 AND s.end_date>=? AND s.start_date<=?
      AND s.employee_id IN (${inScope})`, ...params)
  ]);
  return [...leave, ...wfh, ...absence, ...sickness]
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)) || String(a.display_name).localeCompare(String(b.display_name))).slice(0, 10);
}

function attentionCard(label, count, detail, href, tone = '') {
  return `<a class="attention-card ${tone ? `attention-${tone}` : ''}" href="${href}"><span class="attention-label">${h(label)}</span><strong>${Number(count || 0)}</strong><span class="attention-detail">${h(detail)}</span></a>`;
}

function statusPill(label, tone) {
  return `<span class="dashboard-status dashboard-status-${tone}">${h(label)}</span>`;
}

function dutyPills(duties) {
  return duties.length ? duties.map((x) => `<span class="duty-pill">${h(x)}</span>`).join(' ') : '<span class="muted">—</span>';
}

function personalDutyBadges(duties) {
  const badges = {
    'On Call': { icon: '📱', label: 'On Call', href: '/on-call', className: 'personal-duty-oncall' },
    Gatekeeper: { icon: '🏰', label: 'Gatekeeper', href: '/gatekeepers', className: 'personal-duty-gatekeeper' }
  };
  return `<div class="personal-duty-badges" aria-label="Today’s operational duties">${duties.map((duty) => {
    const badge = badges[duty];
    if (!badge) return '';
    return `<a class="personal-duty-badge ${badge.className}" href="${badge.href}" title="You are ${h(badge.label)} today"><span class="personal-duty-icon" aria-hidden="true">${badge.icon}</span><span><small>Today’s duty</small><strong>${h(badge.label)}</strong></span></a>`;
  }).join('')}</div>`;
}

function shiftLabel(position) {
  if (!position.shift) return 'Not configured';
  if (!position.shift.is_working_day) return position.shift.name || 'Not working';
  const time = position.shift.start_time ? ` · ${position.shift.start_time.slice(0, 5)}–${String(position.shift.end_time || '').slice(0, 5)}` : '';
  return `${position.shift.name || position.shift.code || 'Working'}${time}${position.shiftOverride ? ' · override' : ''}`;
}

function todayTeamPanel(positions) {
  const body = positions.length ? `<div class="dashboard-table"><table><thead><tr><th>Employee</th><th>Team</th><th>Today</th><th>Shift</th><th>Duty</th></tr></thead><tbody>${positions.map((x) => `<tr><td><a href="/day?employee=${encodeURIComponent(x.display_name)}&date=${encodeURIComponent(x.today || '')}"><strong>${h(x.display_name)}</strong></a></td><td>${h(x.team_name)}</td><td>${statusPill(x.state, x.tone)}</td><td>${h(shiftLabel(x))}</td><td>${dutyPills(x.duties)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No active employees are in your current team scope.</div>';
  return `<section class="dashboard-panel dashboard-today"><div class="panel-heading"><div><h2>Today’s Team</h2><p>Live operational position from the rota and attendance records.</p></div><a href="/rota">Open rota</a></div>${body}</section>`;
}

function upcomingPanel(items, personal = false) {
  const content = items.length ? `<div class="upcoming-list">${items.map((x) => `<a class="upcoming-item" href="/rota?week=${encodeURIComponent(x.start_date)}"><span class="upcoming-date">${h(x.start_date.slice(5).split('-').reverse().join('/'))}</span><span><strong>${h(personal ? x.kind : x.display_name)}</strong><small>${h(personal ? (x.start_date === x.end_date ? x.start_date : `${x.start_date} → ${x.end_date}`) : `${x.kind} · ${x.team_name}`)}</small></span></a>`).join('')}</div>` : '<div class="empty">Nothing recorded for the next 14 days.</div>';
  return `<section class="dashboard-panel"><div class="panel-heading"><div><h2>Upcoming</h2><p>Approved leave, WFH and attendance changes over the next 14 days.</p></div></div>${content}</section>`;
}

async function managerCounts(db, teamIds, today) {
  if (!teamIds.length) return { leave: 0, wfh: 0, pdp: 0, certs: 0 };
  const qs = placeholders(teamIds), end = addDays(today, 60);
  const [leave, wfh, pdp, certs] = await Promise.all([
    row(db, `SELECT COUNT(*) c FROM leave_requests lr JOIN employees e ON e.id=lr.employee_id WHERE lr.status='pending' AND e.is_active=1 AND e.team_id IN (${qs})`, ...teamIds),
    row(db, `SELECT COUNT(*) c FROM wfh_requests w JOIN employees e ON e.id=w.employee_id WHERE w.status='pending' AND e.is_active=1 AND e.team_id IN (${qs})`, ...teamIds),
    row(db, `SELECT COUNT(DISTINCT p.cycle_id || ':' || p.employee_id) c FROM pdp_cycle_participants p JOIN pdp_cycles pc ON pc.id=p.cycle_id
      JOIN employees e ON e.id=p.employee_id WHERE pc.status='published' AND p.status='submitted' AND e.is_active=1 AND e.team_id IN (${qs})
      AND EXISTS(SELECT 1 FROM pdp_skill_assessments a WHERE a.cycle_id=p.cycle_id AND a.employee_id=p.employee_id AND (a.management_ability IS NULL OR a.management_interest IS NULL))`, ...teamIds),
    row(db, `SELECT COUNT(*) c FROM employee_certifications ec JOIN employees e ON e.id=ec.employee_id
      WHERE ec.expiry_date BETWEEN ? AND ? AND e.is_active=1 AND e.team_id IN (${qs})`, today, end, ...teamIds)
  ]);
  return { leave: Number(leave?.c || 0), wfh: Number(wfh?.c || 0), pdp: Number(pdp?.c || 0), certs: Number(certs?.c || 0) };
}

async function developmentPanel(db, teamIds, today) {
  if (!teamIds.length) return '<section class="dashboard-panel"><div class="panel-heading"><div><h2>Development</h2></div></div><div class="empty">No managed teams are assigned.</div></section>';
  const qs = placeholders(teamIds), end = addDays(today, 60);
  const cycles = await rows(db, `SELECT pc.id,pc.name,pc.due_date,COUNT(p.employee_id) participants,
    SUM(CASE WHEN p.status='submitted' THEN 1 ELSE 0 END) submitted FROM pdp_cycles pc JOIN pdp_cycle_participants p ON p.cycle_id=pc.id
    JOIN employees e ON e.id=p.employee_id WHERE pc.status='published' AND e.is_active=1 AND e.team_id IN (${qs})
    GROUP BY pc.id ORDER BY pc.due_date IS NULL,pc.due_date,pc.name`, ...teamIds);
  const certs = await rows(db, `SELECT ec.id,ec.expiry_date,e.display_name,ct.name FROM employee_certifications ec JOIN employees e ON e.id=ec.employee_id
    JOIN certification_types ct ON ct.id=ec.certification_type_id WHERE ec.expiry_date BETWEEN ? AND ?
    AND e.is_active=1 AND e.team_id IN (${qs}) ORDER BY ec.expiry_date,e.display_name LIMIT 5`, today, end, ...teamIds);
  const cycleHtml = cycles.length ? cycles.map((x) => { const percent = Number(x.participants) ? Math.round(Number(x.submitted) * 100 / Number(x.participants)) : 0; return `<a class="development-row" href="/pdp/team-assessments?cycle=${x.id}"><span><strong>${h(x.name)}</strong><small>${x.submitted}/${x.participants} submitted${x.due_date ? ` · due ${h(x.due_date)}` : ''}</small></span><span class="progress-track"><span style="width:${percent}%"></span></span><b>${percent}%</b></a>`; }).join('') : '<p class="muted">No active PDP cycle.</p>';
  const certHtml = certs.length ? `<h3>Renewals due</h3>${certs.map((x) => `<a class="development-row" href="/certifications/admin/${x.id}/edit"><span><strong>${h(x.display_name)}</strong><small>${h(x.name)} · ${h(x.expiry_date)}</small></span><b>Review</b></a>`).join('')}` : '<p class="muted section-gap">No certifications expire in the next 60 days.</p>';
  return `<section class="dashboard-panel"><div class="panel-heading"><div><h2>Development</h2><p>PDP progress and imminent certification renewals.</p></div></div>${cycleHtml}${certHtml}</section>`;
}

async function adminHealthPanel(db) {
  const [employees, teams, noRoles, noManagers, noRota] = await Promise.all([
    row(db, 'SELECT COUNT(*) c FROM employees WHERE is_active=1'), row(db, 'SELECT COUNT(*) c FROM teams WHERE is_active=1'),
    row(db, `SELECT COUNT(*) c FROM employees e WHERE e.is_active=1 AND NOT EXISTS(SELECT 1 FROM employee_roles er WHERE er.employee_id=e.id)`),
    row(db, `SELECT COUNT(*) c FROM teams t WHERE t.is_active=1 AND NOT EXISTS(SELECT 1 FROM team_managers tm WHERE tm.team_id=t.id)`),
    row(db, 'SELECT COUNT(*) c FROM teams WHERE is_active=1 AND default_rota_pattern_id IS NULL')
  ]);
  return `<section class="dashboard-panel admin-health"><div class="panel-heading"><div><h2>Administration</h2><p>Configuration health across SupportApp.</p></div><a href="/administration">System settings</a></div><div class="snapshot-grid"><div><strong>${employees?.c || 0}</strong><span>Active employees</span></div><div><strong>${teams?.c || 0}</strong><span>Active teams</span></div><a href="/employees"><strong>${noRoles?.c || 0}</strong><span>Without a role</span></a><a href="/teams"><strong>${noManagers?.c || 0}</strong><span>Teams without a manager</span></a><a href="/teams"><strong>${noRota?.c || 0}</strong><span>Teams without a rota</span></a></div></section>`;
}

async function employeeDashboard(db, user, appPage, date, positions, onCall, gatekeepers) {
  const position = positions[0];
  const upcoming = await upcomingItems(db, [Number(user.id)], date.iso);
  const [pdp, certs, pendingLeave, pendingWfh] = await Promise.all([
    row(db, `SELECT COUNT(*) c FROM pdp_cycle_participants p JOIN pdp_cycles pc ON pc.id=p.cycle_id WHERE p.employee_id=? AND pc.status='published' AND p.status<>'submitted'`, user.id),
    row(db, `SELECT COUNT(*) c FROM employee_certifications WHERE employee_id=? AND expiry_date BETWEEN ? AND ?`, user.id, date.iso, addDays(date.iso, 60)),
    row(db, `SELECT COUNT(*) c FROM leave_requests WHERE employee_id=? AND status='pending'`, user.id),
    row(db, `SELECT COUNT(*) c FROM wfh_requests WHERE employee_id=? AND status='pending'`, user.id)
  ]);
  const todayCard = `<section class="dashboard-panel personal-today"><div class="panel-heading"><div><h2>My Day</h2><p>Your current rota and attendance position.</p></div><a href="/rota">Open rota</a></div>${position ? `<div class="personal-status"><div>${statusPill(position.state, position.tone)}<h3>${h(shiftLabel(position))}</h3>${position.duties.length ? personalDutyBadges(position.duties) : '<p>No On-Call or Gatekeeper duty today.</p>'}</div><a class="button secondary" href="/day?employee=${encodeURIComponent(user.display_name)}&date=${date.iso}">Day actions</a></div>` : '<div class="empty">No active rota record was found.</div>'}</section>`;
  const actions = `<section><h2 class="dashboard-section-title">My Actions</h2><div class="attention-grid">${attentionCard('PDP outstanding', pdp?.c, 'Complete my assessment', '/pdp/my-skills', Number(pdp?.c) ? 'warning' : '')}${attentionCard('Certifications due', certs?.c, 'Within 60 days', '/certifications', Number(certs?.c) ? 'warning' : '')}${attentionCard('Leave requests', pendingLeave?.c, 'Awaiting a decision', '/leave')}${attentionCard('WFH requests', pendingWfh?.c, 'Awaiting a decision', '/rota')}</div></section>`;
  const quick = `<section class="dashboard-panel dashboard-quick"><div class="panel-heading"><div><h2>Quick Actions</h2></div></div><div class="quick-links"><a class="button" href="/leave">Request leave</a><a class="button secondary" href="/rota">View rota</a><a class="button secondary" href="/pdp/my-skills">My PDP</a><a class="button secondary" href="/certifications">My certifications</a></div></section>`;
  return appPage(`Good ${date.hour < 12 ? 'morning' : date.hour < 18 ? 'afternoon' : 'evening'}, ${user.display_name.split(' ')[0]}`, `${date.label} · Your SupportApp overview`, `${actions}<div class="dashboard-layout section-gap">${todayCard}${upcomingPanel(upcoming, true)}</div>${quick}`, user, 'Dashboard', db);
}

export async function dashboardPage(db, user, { appPage }, now = new Date()) {
  const date = londonDateParts(now), teamIds = await scopeTeamIds(db, user), employees = await scopedEmployees(db, user, teamIds);
  const positions = await todayPositions(db, employees, date.iso), onCall = await onCallFor(db, date.iso), gatekeepers = await gatekeepersFor(db, teamIds, date.iso);
  for (const position of positions) position.today = date.iso;
  attachDuties(positions, onCall, gatekeepers);
  if (!(user.isManager || user.isTeamLeader || user.isSystemAdmin)) return employeeDashboard(db, user, appPage, date, positions, onCall, gatekeepers);

  const counts = await managerCounts(db, teamIds, date.iso), upcoming = await upcomingItems(db, employees.map((x) => Number(x.id)), date.iso);
  const working = positions.filter((x) => x.state === 'Working' || x.state === 'WFH').length;
  const away = positions.filter((x) => ['Annual leave', 'Sickness'].includes(x.state)).length;
  const actionCards = `<section><h2 class="dashboard-section-title">Action Required</h2><div class="attention-grid">${attentionCard('Leave approvals', counts.leave, 'Pending requests', '/leave-requests?status=pending&past=show', counts.leave ? 'warning' : '')}${attentionCard('WFH requests', counts.wfh, 'Pending requests', '/wfh-requests', counts.wfh ? 'warning' : '')}${attentionCard('PDP assessments', counts.pdp, 'Ready for Manager/TL input', '/pdp/team-assessments', counts.pdp ? 'warning' : '')}${attentionCard('Certifications due', counts.certs, 'Within 60 days', '/certifications/admin?status=due', counts.certs ? 'warning' : '')}</div></section>`;
  const snapshot = `<section class="dashboard-panel team-snapshot"><div class="snapshot-grid"><div><strong>${employees.length}</strong><span>Active employees</span></div><div><strong>${working}</strong><span>Working / WFH</span></div><div><strong>${away}</strong><span>On leave / sick</span></div><div><strong>${gatekeepers.length}</strong><span>Gatekeepers today</span></div><div><strong>${onCall ? 1 : 0}</strong><span>On Call</span></div></div></section>`;
  const duties = `<section class="dashboard-panel duty-summary"><div class="panel-heading"><div><h2>Operational Duty</h2></div></div><div class="duty-summary-grid"><div><span>On Call</span><strong>${h(onCall?.display_name || 'Not configured')}</strong></div><div><span>Gatekeeper${gatekeepers.length === 1 ? '' : 's'}</span><strong>${gatekeepers.length ? gatekeepers.map((x) => `${x.display_name} (${x.team_name})`).map(h).join('<br>') : 'Not configured'}</strong></div></div></section>`;
  const quick = `<section class="dashboard-panel dashboard-quick"><div class="panel-heading"><div><h2>Quick Actions</h2></div></div><div class="quick-links"><a class="button" href="/rota">Open rota / record attendance</a><a class="button secondary" href="/leave-requests">Review leave</a><a class="button secondary" href="/wfh-requests">Review WFH</a><a class="button secondary" href="/certifications/admin">Team certifications</a><a class="button secondary" href="/pdp/team-assessments">Team PDP</a></div></section>`;
  const admin = user.isSystemAdmin ? await adminHealthPanel(db) : '';
  const noScope = !teamIds.length ? '<div class="notice section-gap"><strong>No managed teams assigned.</strong><br>Ask a System Administrator to add this account as a manager or team leader for at least one team.</div>' : '';
  const content = `${actionCards}${noScope}${snapshot}<div class="dashboard-layout section-gap">${todayTeamPanel(positions)}${duties}</div><div class="dashboard-layout section-gap">${upcomingPanel(upcoming)}${await developmentPanel(db, teamIds, date.iso)}</div>${quick}${admin ? `<div class="section-gap">${admin}</div>` : ''}`;
  return appPage(`Good ${date.hour < 12 ? 'morning' : date.hour < 18 ? 'afternoon' : 'evening'}, ${user.display_name.split(' ')[0]}`, `${date.label} · Support overview`, content, user, 'Dashboard', db);
}
