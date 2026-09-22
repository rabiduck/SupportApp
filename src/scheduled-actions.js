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

function londonParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return { date, time: `${parts.hour}:${parts.minute}`, weekday, day: Number(parts.day) };
}

function dateAtNoon(dateText) {
  return new Date(`${dateText}T12:00:00Z`);
}

function mondayFor(dateText) {
  const date = dateAtNoon(dateText);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function fridayFor(dateText) {
  const date = dateAtNoon(dateText);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - 5 + 7) % 7));
  return date.toISOString().slice(0, 10);
}

function daysInMonth(dateText) {
  const [year, month] = dateText.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function scheduleMatchesDate(schedule, date, weekday, day) {
  if (date < schedule.start_date || (schedule.end_date && date > schedule.end_date)) return false;
  if (schedule.recurrence_type === 'once') return date === schedule.start_date;
  if (schedule.recurrence_type === 'daily') return true;
  if (schedule.recurrence_type === 'weekly') return Number(schedule.day_of_week) === weekday;
  if (schedule.recurrence_type === 'monthly') return day === Math.min(Number(schedule.day_of_month), daysInMonth(date));
  return false;
}

function scheduledKeyIfDue(schedule, now = new Date()) {
  const local = londonParts(now);
  if (!scheduleMatchesDate(schedule, local.date, local.weekday, local.day)) return null;
  if (String(schedule.local_time) > local.time) return null;
  return `${local.date}T${schedule.local_time}`;
}

async function onCallEmployee(db, dateText) {
  const override = await row(db, `SELECT o.employee_id,e.team_id FROM oncall_overrides o JOIN employees e ON e.id=o.employee_id
    WHERE o.is_active=1 AND e.is_active=1 AND o.start_date<=? AND o.end_date>=? ORDER BY o.id DESC LIMIT 1`, dateText, dateText);
  if (override) return { employeeId: Number(override.employee_id), teamId: Number(override.team_id) };
  const members = await rows(db, `SELECT m.id,m.employee_id,e.team_id FROM oncall_members m JOIN employees e ON e.id=m.employee_id
    WHERE m.is_active=1 AND e.is_active=1 ORDER BY m.display_order,m.id`);
  const settings = await row(db, 'SELECT anchor_friday,anchor_member_id FROM oncall_settings WHERE id=1');
  if (!members.length || !settings?.anchor_friday) return { employeeId: null, teamId: null };
  const weeks = Math.floor((dateAtNoon(fridayFor(dateText)) - dateAtNoon(settings.anchor_friday)) / 604800000);
  const anchor = Math.max(0, members.findIndex((item) => Number(item.id) === Number(settings.anchor_member_id)));
  const member = members[((anchor + weeks) % members.length + members.length) % members.length];
  return { employeeId: Number(member.employee_id), teamId: Number(member.team_id) };
}

async function gatekeeperEmployee(db, teamId, dateText) {
  const weekend = [0, 6].includes(dateAtNoon(dateText).getUTCDay());
  if (weekend) return { employeeId: null, teamId: Number(teamId) };
  const override = await row(db, `SELECT o.employee_id FROM gatekeeper_overrides o JOIN employees e ON e.id=o.employee_id
    WHERE o.team_id=? AND o.is_active=1 AND e.is_active=1 AND o.start_date<=? AND o.end_date>=? ORDER BY o.id DESC LIMIT 1`, teamId, dateText, dateText);
  if (override) return { employeeId: Number(override.employee_id), teamId: Number(teamId) };
  const members = await rows(db, `SELECT id FROM employees WHERE team_id=? AND is_active=1 ORDER BY COALESCE(gatekeeper_order,999999),display_name,id`, teamId);
  const settings = await row(db, 'SELECT anchor_monday,anchor_employee_id FROM gatekeeper_settings WHERE team_id=?', teamId);
  if (!members.length || !settings?.anchor_monday) return { employeeId: null, teamId: Number(teamId) };
  const weeks = Math.floor((dateAtNoon(mondayFor(dateText)) - dateAtNoon(settings.anchor_monday)) / 604800000);
  const anchor = Math.max(0, members.findIndex((item) => Number(item.id) === Number(settings.anchor_employee_id)));
  const member = members[((anchor + weeks) % members.length + members.length) % members.length];
  return { employeeId: Number(member.id), teamId: Number(teamId) };
}

async function resolveAssignment(db, schedule, dateText) {
  if (schedule.assignment_type === 'employee') {
    const employee = await row(db, 'SELECT id,team_id FROM employees WHERE id=? AND is_active=1', schedule.target_employee_id);
    return employee ? { employeeId: Number(employee.id), teamId: Number(employee.team_id) } : { employeeId: null, teamId: null };
  }
  if (schedule.assignment_type === 'team') return { employeeId: null, teamId: Number(schedule.target_team_id) || null };
  if (schedule.assignment_type === 'on_call') return onCallEmployee(db, dateText);
  if (schedule.assignment_type === 'gatekeeper') return gatekeeperEmployee(db, schedule.target_team_id, dateText);
  return { employeeId: null, teamId: null };
}

async function notifyAssignment(db, instanceId, title, dueAt, assignment) {
  const recipients = assignment.employeeId
    ? [assignment.employeeId]
    : assignment.teamId
      ? (await rows(db, 'SELECT id FROM employees WHERE team_id=? AND is_active=1 ORDER BY id', assignment.teamId)).map((item) => Number(item.id))
      : [];
  for (const recipient of [...new Set(recipients)]) {
    await db.prepare(`INSERT INTO notifications(recipient_employee_id,notification_type,title,message,target_url)
      VALUES(?,?,?,?,?)`).bind(recipient, 'scheduled_action', `Action ready · ${title}`, `Due ${formatDateTime(dueAt)}.`, `/actions/${instanceId}`).run();
  }
}

async function generateInstance(db, schedule, scheduledFor, now = new Date()) {
  const dateText = scheduledFor.slice(0, 10);
  const assignment = await resolveAssignment(db, schedule, dateText);
  const dueAt = new Date(now.getTime() + Number(schedule.due_after_minutes || 480) * 60000).toISOString();
  const created = await db.prepare(`INSERT OR IGNORE INTO scheduled_action_instances
    (schedule_id,scheduled_for,title_snapshot,instructions_snapshot,priority,assigned_employee_id,assigned_team_id,due_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(schedule.id, scheduledFor, schedule.name, schedule.instructions || null, schedule.priority, assignment.employeeId, assignment.teamId, dueAt).run();
  if (Number(created.meta?.changes || 0) !== 1) return null;
  const instanceId = Number(created.meta?.last_row_id);
  await db.prepare(`INSERT INTO scheduled_action_history(instance_id,event_type,to_status,notes)
    VALUES(?,'generated','open',?)`).bind(instanceId, `Generated from schedule: ${schedule.name}`).run();
  await notifyAssignment(db, instanceId, schedule.name, dueAt, assignment);
  return instanceId;
}

export async function runScheduledActionSweep(db, now = new Date()) {
  const schedules = await rows(db, `SELECT * FROM scheduled_action_schedules WHERE is_active=1 AND removed_at IS NULL ORDER BY id`);
  let generated = 0;
  for (const schedule of schedules) {
    const scheduledFor = scheduledKeyIfDue(schedule, now);
    if (!scheduledFor) continue;
    const instanceId = await generateInstance(db, schedule, scheduledFor, now);
    if (!instanceId) continue;
    generated += 1;
    if (schedule.recurrence_type === 'once') {
      await db.prepare('UPDATE scheduled_action_schedules SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(schedule.id).run();
    }
  }
  return { examined: schedules.length, generated };
}

function formatDateTime(value) {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && !value.endsWith('Z') && !value.includes('+')) {
    const [date, time] = value.split('T');
    return `${date.split('-').reverse().join('/')} ${time.slice(0, 5)}`;
  }
  const normalized = String(value).includes('T') ? String(value) : `${String(value).replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function effectiveStatus(instance, now = new Date()) {
  if (instance.removed_at) return 'removed';
  if (['completed', 'skipped'].includes(instance.status)) return instance.status;
  return new Date(instance.due_at).getTime() < now.getTime() ? 'overdue' : instance.status;
}

function statusBadge(instance) {
  const status = effectiveStatus(instance);
  const label = { open: 'Open', in_progress: 'In Progress', completed: 'Closed', skipped: 'Skipped', removed: 'Removed', overdue: 'Overdue' }[status] || status;
  const cls = status === 'completed' ? 'status-active' : status === 'overdue' ? 'status-danger' : status === 'in_progress' ? 'status-warning' : status === 'removed' ? 'status-inactive' : '';
  return `<span class="status-badge ${cls}">${h(label)}</span>`;
}

function priorityBadge(priority) {
  const cls = priority === 'critical' ? 'status-danger' : priority === 'high' ? 'status-warning' : priority === 'low' ? 'status-inactive' : '';
  return `<span class="status-badge ${cls}">${h(String(priority || 'normal').replace(/^./, (x) => x.toUpperCase()))}</span>`;
}

function recurrenceLabel(schedule) {
  const days = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  if (schedule.recurrence_type === 'once') return `Once · ${schedule.start_date} at ${schedule.local_time}`;
  if (schedule.recurrence_type === 'daily') return `Daily · ${schedule.local_time}`;
  if (schedule.recurrence_type === 'weekly') return `${days[Number(schedule.day_of_week)] || 'Weekly'} · ${schedule.local_time}`;
  return `Monthly · day ${schedule.day_of_month} at ${schedule.local_time}`;
}

function assignmentLabel(item) {
  if (item.assigned_employee_name) return item.assigned_employee_name;
  if (item.assigned_team_name) return `${item.assigned_team_name} team queue`;
  if (item.assignment_type === 'on_call') return 'On Call · unresolved';
  if (item.assignment_type === 'gatekeeper') return 'Gatekeeper · unresolved';
  return 'Unassigned';
}

const INSTANCE_SELECT = `SELECT i.*,s.assignment_type,s.name schedule_name,s.created_by,
  ae.display_name assigned_employee_name,ae.team_id assigned_employee_team_id,at.name assigned_team_name,
  ce.display_name creator_name,ce.team_id creator_team_id
  FROM scheduled_action_instances i JOIN scheduled_action_schedules s ON s.id=i.schedule_id
  LEFT JOIN employees ae ON ae.id=i.assigned_employee_id LEFT JOIN teams at ON at.id=i.assigned_team_id
  LEFT JOIN employees ce ON ce.id=s.created_by`;

function instanceTable(items) {
  if (!items.length) return '<div class="empty">No actions match this view.</div>';
  return `<div class="table-card"><table><thead><tr><th>Action</th><th>Owner</th><th>Assigned To</th><th>Scheduled</th><th>Due</th><th>Priority</th><th>Status</th></tr></thead><tbody>${items.map((item) => `<tr><td><a href="/actions/${item.id}"><strong>${h(item.title_snapshot)}</strong></a></td><td>${h(item.creator_name || 'Unknown')}</td><td>${h(assignmentLabel(item))}</td><td>${h(formatDateTime(item.scheduled_for))}</td><td>${h(formatDateTime(item.due_at))}</td><td>${priorityBadge(item.priority)}</td><td>${statusBadge(item)}</td></tr>`).join('')}</tbody></table></div>`;
}

function instanceFilters(request) {
  const params = new URL(request.url).searchParams;
  const status = ['open', 'completed', 'all'].includes(params.get('status')) ? params.get('status') : 'open';
  const priority = ['low', 'normal', 'high', 'critical'].includes(params.get('priority')) ? params.get('priority') : '';
  return { status, priority, q: String(params.get('q') || '').trim() };
}

function listFilters(filters, basePath) {
  const statusOptions = [['open','Open'],['completed','Closed'],['all','All']].map(([value, label]) => `<option value="${value}" ${selected(filters.status, value)}>${label}</option>`).join('');
  const priorityOptions = [['','Any priority'],['low','Low'],['normal','Normal'],['high','High'],['critical','Critical']].map(([value, label]) => `<option value="${value}" ${selected(filters.priority, value)}>${label}</option>`).join('');
  return `<form class="action-bar action-filters" method="get" action="${basePath}"><label>Status<select name="status">${statusOptions}</select></label><label>Priority<select name="priority">${priorityOptions}</select></label><label>Search<input name="q" value="${h(filters.q)}" placeholder="Title, owner or assignee"></label><button type="submit">Apply Filters</button><a class="button secondary" href="${basePath}">Reset</a></form>`;
}

function filterInstances(items, filters) {
  let filtered = filters.status === 'completed'
    ? items.filter((item) => ['completed', 'skipped'].includes(item.status))
    : filters.status === 'all' ? items : items.filter((item) => !['completed', 'skipped'].includes(item.status));
  if (filters.priority) filtered = filtered.filter((item) => item.priority === filters.priority);
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    filtered = filtered.filter((item) => [item.title_snapshot,item.instructions_snapshot,item.creator_name,assignmentLabel(item)].some((value) => String(value || '').toLowerCase().includes(needle)));
  }
  return filtered;
}

async function myActionsPage(request, db, user) {
  const filters = instanceFilters(request);
  const items = await rows(db, `${INSTANCE_SELECT} WHERE i.removed_at IS NULL AND (i.assigned_team_id=? OR ae.team_id=?) ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,i.due_at DESC`, user.team_id, user.team_id);
  const emptyIntro = !items.length ? '<div class="notice"><strong>No actions are currently assigned to you.</strong><br>Create a one-time handover action or a repeating operational action whenever one is needed.</div>' : '';
  const controls = '<div class="action-bar"><a class="button" href="/actions/new">Create Action</a><a class="button secondary" href="/actions/all">All Actions</a><a class="button secondary" href="/actions/schedules">Created Actions</a></div>';
  return page('My Actions', 'Internal work assigned directly to you or available in your team queue.', `${controls}${emptyIntro}${listFilters(filters, '/actions')}${instanceTable(filterInstances(items, filters))}`);
}

async function allActionsPage(request, db) {
  const filters = instanceFilters(request);
  const items = await rows(db, `${INSTANCE_SELECT} WHERE i.removed_at IS NULL ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,i.due_at DESC`);
  const controls = '<div class="action-bar"><a class="button" href="/actions/new">Create Action</a><a class="button secondary" href="/actions">My Actions</a><a class="button secondary" href="/actions/schedules">Created Actions</a></div>';
  return page('All Actions', 'Shared internal action queue. Any colleague can step in to progress or complete an action when needed.', `${controls}${listFilters(filters, '/actions/all')}${instanceTable(filterInstances(items, filters))}`);
}

async function teamActionsPage(request, db, user) {
  if (!(user.isSystemAdmin || user.isManager || user.isTeamLeader)) return page('Access Denied', '', '<div class="notice"><strong>Manager, Team Leader or System Administrator access is required.</strong></div>', 403);
  const filters = instanceFilters(request);
  let items = [];
  if (user.isSystemAdmin) items = await rows(db, `${INSTANCE_SELECT} WHERE i.removed_at IS NULL ORDER BY i.due_at DESC`);
  else {
    const teamIds = [...new Set((user.managedTeamIds || []).map(Number))];
    if (teamIds.length) {
      const marks = teamIds.map(() => '?').join(',');
      items = await rows(db, `${INSTANCE_SELECT} WHERE i.removed_at IS NULL AND (i.assigned_team_id IN (${marks}) OR ae.team_id IN (${marks})) ORDER BY i.due_at DESC`, ...teamIds, ...teamIds);
    }
  }
  return page('Team Actions', 'Internal work across your managed teams.', `<div class="action-bar"><a class="button" href="/actions/new">Create Action</a><a class="button secondary" href="/actions/all">All Actions</a><a class="button secondary" href="/actions/schedules">Created Actions</a></div>${listFilters(filters, '/actions/team')}${instanceTable(filterInstances(items, filters))}`);
}

async function scheduleOptions(db) {
  const [employees, teams] = await Promise.all([
    rows(db, 'SELECT id,display_name FROM employees WHERE is_active=1 ORDER BY display_name'),
    rows(db, 'SELECT id,name FROM teams WHERE is_active=1 ORDER BY name')
  ]);
  return { employees, teams };
}

function selected(value, expected) { return String(value ?? '') === String(expected) ? 'selected' : ''; }
function checked(value) { return Number(value) ? 'checked' : ''; }

function scheduleForm(item, options, message = '') {
  const employeeOptions = options.employees.map((employee) => `<option value="${employee.id}" ${selected(item.target_employee_id, employee.id)}>${h(employee.display_name)}</option>`).join('');
  const teamOptions = options.teams.map((team) => `<option value="${team.id}" ${selected(item.target_team_id, team.id)}>${h(team.name)}</option>`).join('');
  const weekdayOptions = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].slice(1).map((day, index) => `<option value="${index + 1}" ${selected(item.day_of_week, index + 1)}>${day}</option>`).join('');
  const hours = Math.max(.25, Number(item.due_after_minutes || 480) / 60);
  return `${message ? `<div class="notice"><strong>${h(message)}</strong></div>` : ''}<div class="form-card schedule-form"><form method="post">
    <label>Action Title<input name="name" value="${h(item.name || '')}" maxlength="140" required autofocus></label>
    <label>Instructions<textarea name="instructions" rows="5" placeholder="Explain what must be checked, recorded or completed.">${h(item.instructions || '')}</textarea></label>
    <div class="form-grid"><label>Action Type<select name="recurrence_type"><option value="once" ${selected(item.recurrence_type, 'once')}>One time</option><option value="daily" ${selected(item.recurrence_type, 'daily')}>Repeating · Daily</option><option value="weekly" ${selected(item.recurrence_type, 'weekly')}>Repeating · Weekly</option><option value="monthly" ${selected(item.recurrence_type, 'monthly')}>Repeating · Monthly</option></select></label><label>Create Time <span class="muted">(Europe/London)</span><input name="local_time" type="time" value="${h(item.local_time || '09:00')}" required></label></div>
    <div class="form-grid"><label>Weekly Day<select name="day_of_week"><option value="">Not applicable</option>${weekdayOptions}</select></label><label>Monthly Day<input name="day_of_month" type="number" min="1" max="31" value="${h(item.day_of_month || '')}" placeholder="1–31"></label></div>
    <div class="form-grid"><label>Start / Create Date<input name="start_date" type="date" value="${h(item.start_date || londonParts().date)}" required></label><label>End Date <span class="muted">(repeating actions only)</span><input name="end_date" type="date" value="${h(item.end_date || '')}"></label></div>
    <div class="form-grid"><label>Due After (hours)<input name="due_after_hours" type="number" min="0.25" max="720" step="0.25" value="${hours}" required></label><label>Priority<select name="priority"><option value="low" ${selected(item.priority, 'low')}>Low</option><option value="normal" ${selected(item.priority || 'normal', 'normal')}>Normal</option><option value="high" ${selected(item.priority, 'high')}>High</option><option value="critical" ${selected(item.priority, 'critical')}>Critical</option></select></label></div>
    <label>Assignment<select name="assignment_type"><option value="employee" ${selected(item.assignment_type, 'employee')}>Named Employee</option><option value="team" ${selected(item.assignment_type, 'team')}>Team Queue</option><option value="on_call" ${selected(item.assignment_type, 'on_call')}>Current On Call Engineer</option><option value="gatekeeper" ${selected(item.assignment_type, 'gatekeeper')}>Current Gatekeeper</option></select></label>
    <div class="form-grid"><label>Employee<select name="target_employee_id"><option value="">Not applicable</option>${employeeOptions}</select></label><label>Team<select name="target_team_id"><option value="">Not applicable</option>${teamOptions}</select></label></div>
    <p class="muted">Choose an employee for Named Employee. Choose a team for Team Queue or Current Gatekeeper. On Call is resolved globally when the task is generated. Assignment identifies primary responsibility; every SupportApp user can still step in and complete the action.</p>
    <label class="checkbox-label"><input type="checkbox" name="is_active" value="1" ${checked(item.is_active ?? 1)}> Action active</label>
    <div class="action-bar"><button type="submit">Save Action</button><a class="button secondary" href="/actions/schedules">Cancel</a></div>
  </form></div>`;
}

function scheduleValues(form, existing = {}) {
  const dueHours = Number(form.get('due_after_hours'));
  return {
    ...existing,
    name: String(form.get('name') || '').trim(),
    instructions: String(form.get('instructions') || '').trim(),
    recurrence_type: String(form.get('recurrence_type') || ''),
    local_time: String(form.get('local_time') || ''),
    day_of_week: Number(form.get('day_of_week')) || null,
    day_of_month: Number(form.get('day_of_month')) || null,
    start_date: String(form.get('start_date') || ''),
    end_date: String(form.get('end_date') || '').trim() || null,
    due_after_minutes: Number.isFinite(dueHours) ? Math.round(dueHours * 60) : 0,
    priority: String(form.get('priority') || 'normal'),
    assignment_type: String(form.get('assignment_type') || ''),
    target_employee_id: Number(form.get('target_employee_id')) || null,
    target_team_id: Number(form.get('target_team_id')) || null,
    is_active: form.get('is_active') ? 1 : 0
  };
}

async function validateSchedule(db, item) {
  if (!item.name) return 'Action name is required.';
  if (!['once', 'daily', 'weekly', 'monthly'].includes(item.recurrence_type)) return 'Choose a valid recurrence.';
  if (!/^\d{2}:\d{2}$/.test(item.local_time)) return 'Choose a valid action time.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.start_date)) return 'Choose a valid start date.';
  if (item.end_date && item.end_date < item.start_date) return 'End date cannot be before the start date.';
  if (item.recurrence_type === 'weekly' && !(item.day_of_week >= 1 && item.day_of_week <= 7)) return 'Choose a weekday for a weekly schedule.';
  if (item.recurrence_type === 'monthly' && !(item.day_of_month >= 1 && item.day_of_month <= 31)) return 'Choose a day of the month.';
  if (item.due_after_minutes < 15 || item.due_after_minutes > 43200) return 'Due time must be between 15 minutes and 30 days.';
  if (!['low', 'normal', 'high', 'critical'].includes(item.priority)) return 'Choose a valid priority.';
  if (!['employee', 'team', 'on_call', 'gatekeeper'].includes(item.assignment_type)) return 'Choose a valid assignment type.';
  if (item.assignment_type === 'employee' && !(await row(db, 'SELECT id FROM employees WHERE id=? AND is_active=1', item.target_employee_id))) return 'Choose an active employee.';
  if (['team', 'gatekeeper'].includes(item.assignment_type) && !(await row(db, 'SELECT id FROM teams WHERE id=? AND is_active=1', item.target_team_id))) return 'Choose an active team.';
  return '';
}

const SCHEDULE_SELECT = `SELECT s.*,ce.display_name creator_name,ce.team_id creator_team_id,
  te.team_id target_employee_team_id,e.display_name target_employee_name,t.name target_team_name,
  (SELECT COUNT(*) FROM scheduled_action_instances i WHERE i.schedule_id=s.id AND i.removed_at IS NULL) run_count,
  (SELECT MAX(i.generated_at) FROM scheduled_action_instances i WHERE i.schedule_id=s.id AND i.removed_at IS NULL) last_run
  FROM scheduled_action_schedules s
  LEFT JOIN employees ce ON ce.id=s.created_by
  LEFT JOIN employees te ON te.id=s.target_employee_id
  LEFT JOIN employees e ON e.id=s.target_employee_id
  LEFT JOIN teams t ON t.id=s.target_team_id`;

function scheduleInManagedScope(user, schedule) {
  if (!(user.isManager || user.isTeamLeader)) return false;
  const managed = new Set((user.managedTeamIds || []).map(Number));
  const relevantTeamId = Number(schedule.target_team_id || schedule.target_employee_team_id || schedule.creator_team_id);
  return Boolean(relevantTeamId && managed.has(relevantTeamId));
}

function userOwnsSchedule(user, schedule) {
  return Number(schedule.created_by) === Number(user.id);
}

function userCanEditSchedule(user, schedule) {
  return Boolean(user.isSystemAdmin || userOwnsSchedule(user, schedule));
}

function userCanRemoveSchedule(user, schedule) {
  return Boolean(user.isSystemAdmin || userOwnsSchedule(user, schedule) || scheduleInManagedScope(user, schedule));
}

async function scheduleFormPage(request, db, user, id = null) {
  const local = londonParts();
  let item = id ? await row(db, `${SCHEDULE_SELECT} WHERE s.id=? AND s.removed_at IS NULL`, id) : { recurrence_type: 'once', local_time: local.time, priority: 'normal', assignment_type: 'employee', target_employee_id: user.id, due_after_minutes: 480, is_active: 1, start_date: local.date };
  if (!item) return page('Action Not Found', '', '<div class="notice"><strong>That action does not exist.</strong></div>', 404);
  if (id && !userCanEditSchedule(user, item)) return page('Access Denied', '', '<div class="notice"><strong>Only the action owner can edit this action.</strong></div>', 403);
  const options = await scheduleOptions(db);
  let message = '';
  if (request.method.toUpperCase() === 'POST') {
    item = scheduleValues(await request.formData(), item);
    message = await validateSchedule(db, item);
    if (!message) {
      const employeeId = item.assignment_type === 'employee' ? item.target_employee_id : null;
      const teamId = ['team', 'gatekeeper'].includes(item.assignment_type) ? item.target_team_id : null;
      if (id) {
        await db.prepare(`UPDATE scheduled_action_schedules SET name=?,instructions=?,recurrence_type=?,local_time=?,day_of_week=?,day_of_month=?,start_date=?,end_date=?,due_after_minutes=?,priority=?,assignment_type=?,target_employee_id=?,target_team_id=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(item.name,item.instructions||null,item.recurrence_type,item.local_time,item.day_of_week,item.day_of_month,item.start_date,item.end_date,item.due_after_minutes,item.priority,item.assignment_type,employeeId,teamId,item.is_active,id).run();
      } else {
        const created = await db.prepare(`INSERT INTO scheduled_action_schedules(name,instructions,recurrence_type,local_time,day_of_week,day_of_month,start_date,end_date,due_after_minutes,priority,assignment_type,target_employee_id,target_team_id,is_active,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(item.name,item.instructions||null,item.recurrence_type,item.local_time,item.day_of_week,item.day_of_month,item.start_date,item.end_date,item.due_after_minutes,item.priority,item.assignment_type,employeeId,teamId,item.is_active,user.id).run();
        const scheduleId = Number(created.meta?.last_row_id);
        if (scheduleId && item.is_active && item.recurrence_type === 'once') {
          const schedule = { ...item, id: scheduleId, target_employee_id: employeeId, target_team_id: teamId };
          const scheduledFor = scheduledKeyIfDue(schedule, new Date());
          if (scheduledFor) {
            const instanceId = await generateInstance(db, schedule, scheduledFor);
            await db.prepare('UPDATE scheduled_action_schedules SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(scheduleId).run();
            if (instanceId) return redirect(`/actions/${instanceId}`);
          }
        }
      }
      return redirect('/actions/schedules');
    }
  }
  return page(id ? 'Edit Action' : 'Create Action', 'Create a one-time handover or repeating internal action and choose who should receive it.', scheduleForm(item, options, message));
}

function scheduleIsExpired(schedule, today = londonParts().date) {
  if (schedule.recurrence_type === 'once') return schedule.start_date < today || Number(schedule.run_count || 0) > 0;
  return Boolean(schedule.end_date && schedule.end_date < today);
}

function scheduleFilters(request) {
  const params = new URL(request.url).searchParams;
  const state = ['current', 'expired', 'all'].includes(params.get('state')) ? params.get('state') : 'current';
  return { state, q: String(params.get('q') || '').trim() };
}

function scheduleFilterForm(filters) {
  const stateOptions = [['current','Current'],['expired','Expired'],['all','All']].map(([value, label]) => `<option value="${value}" ${selected(filters.state, value)}>${label}</option>`).join('');
  return `<form class="action-bar action-filters" method="get" action="/actions/schedules"><label>State<select name="state">${stateOptions}</select></label><label>Search<input name="q" value="${h(filters.q)}" placeholder="Title, owner or assignee"></label><button type="submit">Apply Filters</button><a class="button secondary" href="/actions/schedules">Reset</a></form>`;
}

async function schedulesPage(request, db, user) {
  const filters = scheduleFilters(request);
  const allSchedules = await rows(db, `${SCHEDULE_SELECT} WHERE s.removed_at IS NULL ORDER BY s.is_active DESC,s.name`);
  let schedules = user.isSystemAdmin ? allSchedules : allSchedules.filter((schedule) => userOwnsSchedule(user, schedule) || scheduleInManagedScope(user, schedule));
  if (filters.state === 'current') schedules = schedules.filter((schedule) => !scheduleIsExpired(schedule));
  if (filters.state === 'expired') schedules = schedules.filter((schedule) => scheduleIsExpired(schedule));
  if (filters.q) {
    const needle = filters.q.toLowerCase();
    schedules = schedules.filter((schedule) => [schedule.name,schedule.instructions,schedule.creator_name,schedule.target_employee_name,schedule.target_team_name].some((value) => String(value || '').toLowerCase().includes(needle)));
  }
  const content = schedules.length ? `<div class="table-card"><table><thead><tr><th>Action</th><th>Owner</th><th>Timing</th><th>Assignment</th><th>Last Generated</th><th>Status</th><th></th></tr></thead><tbody>${schedules.map((schedule) => {
    const canEdit = userCanEditSchedule(user, schedule);
    const canRemove = userCanRemoveSchedule(user, schedule);
    const controls = `${canEdit ? `<a class="button secondary" href="/actions/schedules/${schedule.id}/edit">Edit</a><form method="post" action="/actions/schedules/${schedule.id}/run"><button type="submit" class="secondary">Run Now</button></form><form method="post" action="/actions/schedules/${schedule.id}/toggle"><button type="submit" class="secondary">${schedule.is_active ? 'Pause' : 'Enable'}</button></form>` : ''}${canRemove ? `<form method="post" action="/actions/schedules/${schedule.id}/remove"><button type="submit" class="secondary">Remove</button></form>` : ''}`;
    const state = scheduleIsExpired(schedule) ? '<span class="status-badge status-inactive">Expired</span>' : schedule.is_active ? '<span class="status-badge status-active">Active</span>' : '<span class="status-badge status-inactive">Paused</span>';
    return `<tr><td><strong>${h(schedule.name)}</strong><br><span class="muted">${h(schedule.priority)} priority · ${schedule.run_count} generated</span></td><td>${h(schedule.creator_name || 'Unknown')}</td><td>${h(recurrenceLabel(schedule))}</td><td>${h(schedule.target_employee_name || schedule.target_team_name || (schedule.assignment_type === 'on_call' ? 'Current On Call' : 'Current Gatekeeper'))}</td><td>${h(formatDateTime(schedule.last_run))}</td><td>${state}</td><td><div class="schedule-actions">${controls}</div></td></tr>`;
  }).join('')}</tbody></table></div>` : '<div class="notice"><strong>No actions have been created in your scope.</strong><br>Create a one-time action for a handover or a repeating action for recurring work.</div>';
  return page('Created Actions', 'Review actions you own and, for Managers and Team Leaders, actions within your managed teams. Expired definitions are hidden by default.', `<div class="action-bar"><a class="button" href="/actions/new">Create Action</a><a class="button secondary" href="/actions">My Actions</a><a class="button secondary" href="/actions/all">All Actions</a>${user.isSystemAdmin || user.isManager || user.isTeamLeader ? '<a class="button secondary" href="/actions/team">Team Actions</a>' : ''}</div>${scheduleFilterForm(filters)}${content}`);
}

function userCanManageInstance(user, instance) {
  if (user.isSystemAdmin) return true;
  if (!(user.isManager || user.isTeamLeader)) return false;
  const managed = new Set((user.managedTeamIds || []).map(Number));
  return managed.has(Number(instance.assigned_team_id)) || managed.has(Number(instance.assigned_employee_team_id));
}

function userCanRemoveInstance(user, instance) {
  if (user.isSystemAdmin || Number(instance.created_by) === Number(user.id)) return true;
  if (!(user.isManager || user.isTeamLeader)) return false;
  const managed = new Set((user.managedTeamIds || []).map(Number));
  const relevantTeamId = Number(instance.assigned_team_id || instance.assigned_employee_team_id || instance.creator_team_id);
  return Boolean(relevantTeamId && managed.has(relevantTeamId));
}

async function addHistory(db, instanceId, actorId, eventType, fromStatus, toStatus, notes = null) {
  await db.prepare(`INSERT INTO scheduled_action_history(instance_id,actor_id,event_type,from_status,to_status,notes) VALUES(?,?,?,?,?,?)`)
    .bind(instanceId, actorId || null, eventType, fromStatus || null, toStatus || null, notes || null).run();
}

async function instancePage(request, db, user, id) {
  let instance = await row(db, `${INSTANCE_SELECT} WHERE i.id=?`, id);
  if (!instance) return page('Action Not Found', '', '<div class="notice"><strong>That scheduled action does not exist.</strong></div>', 404);
  const canManage = userCanManageInstance(user, instance);
  const teamQueue = !instance.assigned_employee_id;
  if (request.method.toUpperCase() === 'POST') {
    const form = await request.formData();
    const action = String(form.get('action') || '');
    const notes = String(form.get('notes') || '').trim() || null;
    const from = instance.status;
    if (action === 'claim' && teamQueue && from === 'open') {
      const result = await db.prepare(`UPDATE scheduled_action_instances SET assigned_employee_id=?,claimed_by=?,claimed_at=CURRENT_TIMESTAMP,status='in_progress',updated_at=CURRENT_TIMESTAMP WHERE id=? AND assigned_employee_id IS NULL AND status='open'`).bind(user.id,user.id,id).run();
      if (Number(result.meta?.changes || 0) === 1) await addHistory(db,id,user.id,'claimed',from,'in_progress',notes);
    } else if (action === 'start' && from === 'open') {
      const result = await db.prepare(`UPDATE scheduled_action_instances SET status='in_progress',updated_at=CURRENT_TIMESTAMP WHERE id=? AND removed_at IS NULL AND status='open'`).bind(id).run();
      if (Number(result.meta?.changes || 0) === 1) await addHistory(db,id,user.id,'started',from,'in_progress',notes);
    } else if (action === 'complete' && ['open','in_progress'].includes(from)) {
      const result = await db.prepare(`UPDATE scheduled_action_instances SET assigned_employee_id=COALESCE(assigned_employee_id,?),status='completed',completed_by=?,completed_at=CURRENT_TIMESTAMP,completion_notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND removed_at IS NULL AND status IN ('open','in_progress')`).bind(user.id,user.id,notes,id).run();
      if (Number(result.meta?.changes || 0) === 1) await addHistory(db,id,user.id,'completed',from,'completed',notes);
    } else if (action === 'skip' && canManage && ['open','in_progress'].includes(from)) {
      if (!notes) return page('Reason Required', '', '<div class="notice"><strong>Provide a reason when skipping a scheduled action.</strong></div>', 400);
      const result = await db.prepare(`UPDATE scheduled_action_instances SET status='skipped',skipped_by=?,skipped_at=CURRENT_TIMESTAMP,skip_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND removed_at IS NULL AND status IN ('open','in_progress')`).bind(user.id,notes,id).run();
      if (Number(result.meta?.changes || 0) === 1) await addHistory(db,id,user.id,'skipped',from,'skipped',notes);
    } else if (action === 'remove' && userCanRemoveInstance(user, instance) && ['open','in_progress'].includes(from)) {
      const result = await db.prepare(`UPDATE scheduled_action_instances SET removed_at=CURRENT_TIMESTAMP,removed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND removed_at IS NULL AND status IN ('open','in_progress')`).bind(user.id,id).run();
      if (Number(result.meta?.changes || 0) === 1) await addHistory(db,id,user.id,'removed',from,null,notes || 'Action removed.');
      return redirect('/actions');
    }
    return redirect(`/actions/${id}`);
  }
  const history = await rows(db, `SELECT h.*,e.display_name actor_name FROM scheduled_action_history h LEFT JOIN employees e ON e.id=h.actor_id WHERE h.instance_id=? ORDER BY h.id DESC`, id);
  const canRemove = userCanRemoveInstance(user, instance);
  const actions = !instance.removed_at && ['open','in_progress'].includes(instance.status) ? `<div class="form-card action-update"><form method="post"><label>Completion / Action Notes<textarea name="notes" rows="4" placeholder="Record the outcome, evidence or reason for the change."></textarea></label><div class="action-bar">${teamQueue && instance.status === 'open' ? '<button name="action" value="claim">Claim Action</button>' : ''}${instance.status === 'open' ? '<button name="action" value="start" class="secondary">Start</button>' : ''}<button name="action" value="complete">Complete & Close</button>${canManage ? '<button name="action" value="skip" class="secondary">Skip</button>' : ''}${canRemove ? '<button name="action" value="remove" class="secondary">Remove Action</button>' : ''}</div></form></div>` : '';
  const historyHtml = history.length ? `<div class="action-history">${history.map((event) => `<div><strong>${h(String(event.event_type).replace(/^./, (x) => x.toUpperCase()))}</strong><span>${h(event.actor_name || 'Scheduler')} · ${h(formatDateTime(event.created_at))}</span>${event.notes ? `<p>${h(event.notes)}</p>` : ''}</div>`).join('')}</div>` : '<div class="empty">No history recorded.</div>';
  const details = `<div class="scheduled-action-detail"><section class="dashboard-panel"><div class="action-detail-heading">${priorityBadge(instance.priority)}${statusBadge(instance)}</div><h2>${h(instance.title_snapshot)}</h2><p class="action-instructions">${h(instance.instructions_snapshot || 'No additional instructions were supplied.')}</p><dl><dt>Assigned To</dt><dd>${h(assignmentLabel(instance))}</dd><dt>Owner</dt><dd>${h(instance.creator_name || 'Unknown')}</dd><dt>Created For</dt><dd>${h(formatDateTime(instance.scheduled_for))}</dd><dt>Due</dt><dd>${h(formatDateTime(instance.due_at))}</dd><dt>Source Action</dt><dd>${h(instance.schedule_name)}</dd></dl></section><section class="dashboard-panel"><h2>History</h2>${historyHtml}</section></div>`;
  return page(instance.title_snapshot, 'Internal action and retained completion record.', `${details}<div class="section-gap">${actions}</div>`);
}

async function scheduleAction(request, db, user, id, operation, now = new Date()) {
  const schedule = await row(db, `${SCHEDULE_SELECT} WHERE s.id=? AND s.removed_at IS NULL`, id);
  if (!schedule) return redirect('/actions/schedules');
  if (operation === 'remove') {
    if (!userCanRemoveSchedule(user, schedule)) return page('Access Denied', '', '<div class="notice"><strong>Only the action owner or an authorised Manager/Team Leader can remove this action.</strong></div>', 403);
    const openInstances = await rows(db, `SELECT id,status FROM scheduled_action_instances WHERE schedule_id=? AND removed_at IS NULL AND status IN ('open','in_progress')`, id);
    for (const instance of openInstances) {
      const result = await db.prepare(`UPDATE scheduled_action_instances SET removed_at=CURRENT_TIMESTAMP,removed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND removed_at IS NULL AND status IN ('open','in_progress')`).bind(user.id,instance.id).run();
      if (Number(result.meta?.changes || 0) === 1) await addHistory(db,instance.id,user.id,'removed',instance.status,null,'Source action removed.');
    }
    await db.prepare(`UPDATE scheduled_action_schedules SET is_active=0,removed_at=CURRENT_TIMESTAMP,removed_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(user.id,id).run();
    return redirect('/actions/schedules');
  }
  if (!userCanEditSchedule(user, schedule)) return page('Access Denied', '', '<div class="notice"><strong>Only the action owner can change or run this action.</strong></div>', 403);
  if (operation === 'toggle') await db.prepare('UPDATE scheduled_action_schedules SET is_active=CASE is_active WHEN 1 THEN 0 ELSE 1 END,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(id).run();
  if (operation === 'run') {
    const local = londonParts(now);
    await generateInstance(db, schedule, `${local.date}T${local.time}:manual:${now.getTime()}`, now);
  }
  return redirect('/actions/schedules');
}

export async function scheduledActionAttention(db, user, now = new Date()) {
  const result = await row(db, `SELECT COUNT(*) c,SUM(CASE WHEN i.due_at<? THEN 1 ELSE 0 END) overdue FROM scheduled_action_instances i LEFT JOIN employees e ON e.id=i.assigned_employee_id WHERE i.removed_at IS NULL AND i.status IN ('open','in_progress') AND (i.assigned_team_id=? OR e.team_id=?)`, now.toISOString(), user.team_id, user.team_id);
  return { open: Number(result?.c || 0), overdue: Number(result?.overdue || 0) };
}

export async function teamScheduledActionAttention(db, teamIds, now = new Date()) {
  if (!teamIds.length) return { open: 0, overdue: 0 };
  const marks = teamIds.map(() => '?').join(',');
  const result = await row(db, `SELECT COUNT(*) c,SUM(CASE WHEN i.due_at<? THEN 1 ELSE 0 END) overdue FROM scheduled_action_instances i LEFT JOIN employees e ON e.id=i.assigned_employee_id WHERE i.removed_at IS NULL AND i.status IN ('open','in_progress') AND (i.assigned_team_id IN (${marks}) OR e.team_id IN (${marks}))`, now.toISOString(), ...teamIds, ...teamIds);
  return { open: Number(result?.c || 0), overdue: Number(result?.overdue || 0) };
}

export async function handleScheduledActionRoute(request, db, user, path) {
  if (path === '/actions' && request.method.toUpperCase() === 'GET') return myActionsPage(request, db, user);
  if (path === '/actions/all' && request.method.toUpperCase() === 'GET') return allActionsPage(request, db, user);
  if (path === '/actions/team' && request.method.toUpperCase() === 'GET') return teamActionsPage(request, db, user);
  if (path === '/actions/schedules' && request.method.toUpperCase() === 'GET') return schedulesPage(request, db, user);
  if (path === '/actions/new' && ['GET','POST'].includes(request.method.toUpperCase())) return scheduleFormPage(request, db, user);
  if (path === '/actions/schedules/new' && ['GET','POST'].includes(request.method.toUpperCase())) return scheduleFormPage(request, db, user);
  if (/^\/actions\/schedules\/\d+\/edit$/.test(path) && ['GET','POST'].includes(request.method.toUpperCase())) return scheduleFormPage(request, db, user, Number(path.split('/')[3]));
  if (/^\/actions\/schedules\/\d+\/(run|toggle|remove)$/.test(path) && request.method.toUpperCase() === 'POST') { const parts = path.split('/'); return scheduleAction(request, db, user, Number(parts[3]), parts[4]); }
  if (/^\/actions\/\d+$/.test(path) && ['GET','POST'].includes(request.method.toUpperCase())) return instancePage(request, db, user, Number(path.split('/')[2]));
  return null;
}
