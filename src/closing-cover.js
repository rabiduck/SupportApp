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

function placeholders(values) {
  return values.map(() => '?').join(',') || 'NULL';
}

function addDays(dateText, amount) {
  const date = new Date(`${dateText}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(dateText) {
  return (new Date(`${dateText}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function cycleWeek(dateText, patternStart, length) {
  if (!patternStart || Number(length) <= 0) return 1;
  const weeks = Math.floor((new Date(`${dateText}T12:00:00Z`) - new Date(`${patternStart}T12:00:00Z`)) / 604800000);
  return ((weeks % Number(length)) + Number(length)) % Number(length) + 1;
}

function dateList(startDate, endDate, limit = 370) {
  const result = [];
  for (let date = startDate; date <= endDate && result.length < limit; date = addDays(date, 1)) result.push(date);
  return result;
}

function absencePortion(item, date) {
  if (item.start_date === item.end_date) return item.start_portion || item.end_portion || 'FULL';
  if (date === item.start_date) return item.start_portion || 'FULL';
  if (date === item.end_date) return item.end_portion || 'FULL';
  return 'FULL';
}

function removesClosingPresence(item, date) {
  return ['FULL', 'PM'].includes(absencePortion(item, date));
}

function labelDate(dateText) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
  }).format(new Date(`${dateText}T12:00:00Z`));
}

async function keyholderCoverage(db, dates) {
  const weekdays = dates.filter((date) => dayOfWeek(date) < 5);
  if (!weekdays.length) return { configuredCount: 0, dates: [] };
  const startDate = weekdays[0], endDate = weekdays[weekdays.length - 1];
  const keyholders = await rows(db, `SELECT e.id,e.display_name,e.team_id,t.name team_name,
    COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) pattern_id,
    COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) pattern_start_date,
    COALESCE(op.cycle_length_weeks,tp.cycle_length_weeks,1) cycle_length_weeks
    FROM closing_keyholders ck JOIN employees e ON e.id=ck.employee_id JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns op ON op.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns tp ON tp.id=t.default_rota_pattern_id
    WHERE ck.is_active=1 AND e.is_active=1 AND t.is_active=1 ORDER BY e.display_name`);
  if (!keyholders.length) return {
    configuredCount: 0,
    dates: weekdays.map((date) => ({ date, label: labelDate(date), keyholders: [], covered: false }))
  };

  const employeeIds = keyholders.map((x) => Number(x.id));
  const patternIds = [...new Set(keyholders.map((x) => Number(x.pattern_id)).filter(Boolean))];
  const inEmployees = placeholders(employeeIds);
  const [assignments, overrides, leave, wfh, absences, sickness] = await Promise.all([
    patternIds.length ? rows(db, `SELECT rpw.rota_pattern_id,rpw.week_number,wpd.day_of_week,st.start_time,st.end_time,st.is_working_day
      FROM rota_pattern_weeks rpw JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id
      JOIN shift_types st ON st.id=wpd.shift_type_id WHERE rpw.rota_pattern_id IN (${placeholders(patternIds)})`, ...patternIds) : [],
    rows(db, `SELECT o.employee_id,o.override_date,st.start_time,st.end_time,st.is_working_day FROM shift_overrides o
      JOIN shift_types st ON st.id=o.shift_type_id WHERE o.is_active=1 AND o.override_date BETWEEN ? AND ?
      AND o.employee_id IN (${inEmployees}) ORDER BY o.id`, startDate, endDate, ...employeeIds),
    rows(db, `SELECT employee_id,start_date,end_date,start_portion,end_portion FROM leave_requests
      WHERE status='approved' AND start_date<=? AND end_date>=? AND employee_id IN (${inEmployees})`, endDate, startDate, ...employeeIds),
    rows(db, `SELECT employee_id,request_date FROM wfh_requests WHERE status='approved' AND request_date BETWEEN ? AND ?
      AND employee_id IN (${inEmployees})`, startDate, endDate, ...employeeIds),
    rows(db, `SELECT employee_id,start_date,end_date,start_portion,end_portion FROM absences
      WHERE is_active=1 AND start_date<=? AND end_date>=? AND employee_id IN (${inEmployees})`, endDate, startDate, ...employeeIds),
    rows(db, `SELECT employee_id,start_date,end_date,start_portion,end_portion FROM sickness
      WHERE is_active=1 AND start_date<=? AND end_date>=? AND employee_id IN (${inEmployees})`, endDate, startDate, ...employeeIds)
  ]);

  const assignmentMap = new Map(assignments.map((x) => [`${x.rota_pattern_id}:${x.week_number}:${x.day_of_week}`, x]));
  const overrideMap = new Map(overrides.map((x) => [`${x.employee_id}:${x.override_date}`, x]));
  const wfhSet = new Set(wfh.map((x) => `${x.employee_id}:${x.request_date}`));
  const overlaps = (items, employeeId, date) => items.some((x) => Number(x.employee_id) === Number(employeeId) && x.start_date <= date && x.end_date >= date && removesClosingPresence(x, date));

  const coverage = weekdays.map((date) => {
    const available = keyholders.filter((employee) => {
      const shift = overrideMap.get(`${employee.id}:${date}`)
        || assignmentMap.get(`${employee.pattern_id}:${cycleWeek(date, employee.pattern_start_date, employee.cycle_length_weeks)}:${dayOfWeek(date)}`);
      if (!shift?.is_working_day || !shift.end_time || String(shift.end_time).slice(0, 5) < '18:00') return false;
      if (wfhSet.has(`${employee.id}:${date}`)) return false;
      if (overlaps(leave, employee.id, date) || overlaps(absences, employee.id, date) || overlaps(sickness, employee.id, date)) return false;
      return true;
    });
    return {
      date,
      label: labelDate(date),
      covered: available.length > 0,
      keyholders: available.map((x) => ({ id: Number(x.id), name: x.display_name, team: x.team_name }))
    };
  });
  return { configuredCount: keyholders.length, dates: coverage };
}

export async function closingCoverageWindow(db, today) {
  const current = new Date(`${today}T12:00:00Z`);
  const mondayOffset = (current.getUTCDay() + 6) % 7;
  const currentMonday = addDays(today, -mondayOffset);
  const endOfNextWeek = addDays(currentMonday, 13);
  const result = await keyholderCoverage(db, dateList(today, endOfNextWeek));
  return { ...result, gaps: result.dates.filter((x) => !x.covered) };
}

export async function closingCoverImpact(db, candidate) {
  const dates = dateList(candidate.startDate, candidate.endDate).filter((date) => dayOfWeek(date) < 5);
  const baseline = await keyholderCoverage(db, dates);
  const candidateId = Number(candidate.employeeId);
  const removesCandidate = (date) => {
    if (candidate.type === 'wfh') return date === candidate.startDate;
    return removesClosingPresence({
      start_date: candidate.startDate,
      end_date: candidate.endDate,
      start_portion: candidate.startPortion || 'FULL',
      end_portion: candidate.endPortion || 'FULL'
    }, date);
  };
  const after = baseline.dates.map((entry) => {
    const keyholders = removesCandidate(entry.date) ? entry.keyholders.filter((x) => x.id !== candidateId) : entry.keyholders;
    return { ...entry, keyholders, covered: keyholders.length > 0 };
  });
  const caused = after.filter((entry, index) => baseline.dates[index]?.covered && !entry.covered);
  const existing = after.filter((entry, index) => !baseline.dates[index]?.covered && !entry.covered);
  return { configuredCount: baseline.configuredCount, caused, existing, after };
}

export function closingCoverWarningHtml(impact, { overrideError = false } = {}) {
  if (!impact || (!impact.caused.length && !impact.existing.length)) return '';
  const caused = impact.caused.length ? `<div class="closing-cover-warning closing-cover-danger"><strong>🔑 Approving this request would remove closing cover</strong><p>No registered keyholder would remain in the office until 18:00 on:</p><ul>${impact.caused.map((x) => `<li>${h(x.label)}</li>`).join('')}</ul>${overrideError ? '<p><strong>Tick the closing-cover override confirmation before approving.</strong></p>' : ''}</div>` : '';
  const existing = impact.existing.length ? `<div class="closing-cover-warning closing-cover-existing"><strong>⚠ Closing cover is already unconfirmed</strong><p>No registered 18:00 keyholder is currently available on:</p><ul>${impact.existing.map((x) => `<li>${h(x.label)}</li>`).join('')}</ul><p>This gap exists independently of the request being reviewed.</p></div>` : '';
  return caused + existing;
}

export function closingCoverOverrideControl(impact) {
  if (!impact?.caused?.length) return '';
  return '<label class="checkbox-label closing-cover-override"><input type="checkbox" name="closing_cover_override" value="1"> I confirm an alternative lock-up arrangement will be made.</label>';
}

function keyholderStatus(active) {
  return active
    ? '<span class="status-badge status-active">Keyholder</span>'
    : '<span class="status-badge status-inactive">Not a keyholder</span>';
}

async function managedTeamIds(db, user) {
  if (user.isSystemAdmin) return (await rows(db, 'SELECT id FROM teams WHERE is_active=1')).map((x) => Number(x.id));
  return [...new Set((user.managedTeamIds || []).map(Number))];
}

export async function handleKeyholderRoute(request, db, user, path) {
  const canMaintain = Boolean(user.isSystemAdmin || user.isManager);
  const canView = Boolean(canMaintain || user.isTeamLeader);
  if (!canView) return { kind: 'denied', status: 403, message: 'Manager or Team Leader access is required.' };

  const match = path.match(/^\/keyholders\/(\d+)\/toggle$/);
  if (match && request.method.toUpperCase() === 'POST') {
    if (!canMaintain) return { kind: 'denied', status: 403, message: 'Only Managers and System Administrators can maintain the keyholder register.' };
    const employeeId = Number(match[1]);
    const teamIds = await managedTeamIds(db, user);
    const employee = await row(db, `SELECT id FROM employees WHERE id=? AND is_active=1 AND team_id IN (${placeholders(teamIds)})`, employeeId, ...teamIds);
    if (!employee) return { kind: 'denied', status: 403, message: 'That employee is outside your management scope.' };
    const current = await row(db, 'SELECT is_active FROM closing_keyholders WHERE employee_id=?', employeeId);
    if (current) {
      await db.prepare('UPDATE closing_keyholders SET is_active=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE employee_id=?')
        .bind(current.is_active ? 0 : 1, user.id, employeeId).run();
    } else {
      await db.prepare('INSERT INTO closing_keyholders(employee_id,is_active,updated_by) VALUES(?,1,?)').bind(employeeId, user.id).run();
    }
    return { kind: 'redirect', path: '/keyholders' };
  }

  if (path !== '/keyholders' || request.method.toUpperCase() !== 'GET') return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const coverage = await closingCoverageWindow(db, today);
  const teamIds = await managedTeamIds(db, user);
  const employees = canMaintain ? await rows(db, `SELECT e.id,e.display_name,t.name team_name,COALESCE(ck.is_active,0) is_keyholder
    FROM employees e JOIN teams t ON t.id=e.team_id LEFT JOIN closing_keyholders ck ON ck.employee_id=e.id
    WHERE e.is_active=1 AND t.is_active=1 AND e.team_id IN (${placeholders(teamIds)}) ORDER BY t.name,e.display_name`, ...teamIds)
    : await rows(db, `SELECT e.id,e.display_name,t.name team_name,1 is_keyholder FROM closing_keyholders ck
      JOIN employees e ON e.id=ck.employee_id JOIN teams t ON t.id=e.team_id
      WHERE ck.is_active=1 AND e.is_active=1 AND t.is_active=1 ORDER BY t.name,e.display_name`);
  const coverageRows = coverage.dates.map((x) => `<tr><td><strong>${h(x.label)}</strong></td><td>${x.covered ? '<span class="status-badge status-active">Covered</span>' : '<span class="status-badge status-danger">No 18:00 keyholder</span>'}</td><td>${x.keyholders.length ? h(x.keyholders.map((k) => k.name).join(', ')) : '—'}</td></tr>`).join('');
  const registerRows = employees.length ? employees.map((employee) => `<tr><td><strong>${h(employee.display_name)}</strong></td><td>${h(employee.team_name)}</td><td>${keyholderStatus(employee.is_keyholder)}</td>${canMaintain ? `<td class="text-right"><form method="post" action="/keyholders/${employee.id}/toggle"><button class="${employee.is_keyholder ? 'secondary' : ''}" type="submit">${employee.is_keyholder ? 'Remove' : 'Add keyholder'}</button></form></td>` : ''}</tr>`).join('') : `<tr><td colspan="${canMaintain ? 4 : 3}" class="empty">${canMaintain ? 'No active employees are in your management scope.' : 'No keyholders have been registered.'}</td></tr>`;
  return {
    kind: 'page',
    title: 'Closing Cover',
    description: 'Maintain keyholders and confirm that an 18:00 lock-up capability remains in the building.',
    content: `<div class="table-card"><h2 class="keyholder-heading">Closing Cover · This Week and Next</h2><table><thead><tr><th>Date</th><th>Position</th><th>Available Keyholder</th></tr></thead><tbody>${coverageRows}</tbody></table></div><div class="table-card section-gap"><h2 class="keyholder-heading">Keyholder Register</h2>${canMaintain ? '<p class="keyholder-help">Managers can maintain employees in their managed teams. Closing-cover calculations use all active registered keyholders.</p>' : '<p class="keyholder-help">This register is maintained by Managers and System Administrators.</p>'}<table><thead><tr><th>Employee</th><th>Team</th><th>Status</th>${canMaintain ? '<th></th>' : ''}</tr></thead><tbody>${registerRows}</tbody></table></div>`
  };
}
