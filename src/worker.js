import legacyWorker from './index.js';
import { ensureSchema } from './schema.js';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const h = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

async function rows(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return d; }
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d;
}
function formatDay(date) { return `${DAY_NAMES[(date.getUTCDay() + 6) % 7].slice(0,3)} ${date.getUTCDate()}`; }
function formatRange(start) {
  const end = addDays(start, 6);
  const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}
function cycleWeekForDate(startDate, cycleLength, targetDate) {
  if (!startDate || !cycleLength) return 1;
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return 1;
  const diffWeeks = Math.floor((targetDate.getTime() - start.getTime()) / (7 * 86400000));
  const mod = ((diffWeeks % cycleLength) + cycleLength) % cycleLength;
  return mod + 1;
}

const shell = (content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rota · Support Portal</title><link rel="stylesheet" href="/assets/site.css"></head><body>
<header class="top-bar"><div class="brand">Support Portal</div><div class="user-area">Cloudflare UAT</div></header>
<div class="app-shell"><nav class="side-nav"><a href="/">Dashboard</a><a class="active" href="/rota">Rota</a><a href="/users">Users</a><a href="/teams">Teams</a><a href="/employees">Employees</a><a href="/shift-patterns">Shift Patterns</a><a href="/administration">Administration</a></nav><main class="page">${content}</main></div>
<footer class="footer">SupportApp · Cloudflare-native UAT</footer></body></html>`;

async function calendarRota(request, db) {
  await ensureSchema(db);
  const url = new URL(request.url);
  const teams = await rows(db, 'SELECT id,name FROM teams WHERE is_active=1 ORDER BY name');
  const selectedTeam = Number(url.searchParams.get('team')) || null;
  const requestedMonth = url.searchParams.get('month');
  const requested = requestedMonth && /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth + '-01' : url.searchParams.get('week');
  const base = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? new Date(`${requested}T00:00:00Z`) : new Date();
  const weekStart = mondayOf(base);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const previous = isoDate(addDays(weekStart, -7));
  const next = isoDate(addDays(weekStart, 7));
  const todayWeek = isoDate(mondayOf(new Date()));
  const teamParam = selectedTeam ? `&team=${selectedTeam}` : '';

  const employees = await rows(db, `SELECT e.id,e.display_name,t.id AS team_id,t.name AS team_name,
    COALESCE(e.override_rota_pattern_id,t.default_rota_pattern_id) AS pattern_id,
    COALESCE(e.override_pattern_start_date,t.default_pattern_start_date) AS pattern_start_date,
    COALESCE(orp.name,trp.name,'No Scheduled Hours') AS pattern_name,
    COALESCE(orp.cycle_length_weeks,trp.cycle_length_weeks,1) AS cycle_length_weeks
    FROM employees e JOIN teams t ON t.id=e.team_id
    LEFT JOIN rota_patterns orp ON orp.id=e.override_rota_pattern_id
    LEFT JOIN rota_patterns trp ON trp.id=t.default_rota_pattern_id
    WHERE e.is_active=1 AND t.is_active=1 ${selectedTeam ? 'AND t.id=?' : ''}
    ORDER BY t.name,e.display_name`, ...(selectedTeam ? [selectedTeam] : []));

  const assignments = await rows(db, `SELECT rpw.rota_pattern_id,rpw.week_number,wpd.day_of_week,st.code,st.name,st.start_time,st.end_time,st.is_working_day
    FROM rota_pattern_weeks rpw
    JOIN week_pattern_days wpd ON wpd.week_pattern_id=rpw.week_pattern_id
    JOIN shift_types st ON st.id=wpd.shift_type_id
    ORDER BY rpw.rota_pattern_id,rpw.week_number,wpd.day_of_week`);
  const shiftMap = new Map();
  for (const a of assignments) shiftMap.set(`${a.rota_pattern_id}:${a.week_number}:${a.day_of_week}`, a);

  // Approved leave and WFH are overlays: the underlying generated shift remains unchanged.
  const weekEnd = isoDate(dates[6]);
  const leaveRows = await rows(db, `SELECT employee_id,start_date,end_date,start_portion,end_portion FROM leave_requests
    WHERE status='approved' AND start_date<=? AND end_date>=?`, weekEnd, isoDate(weekStart));
  const leaveByEmployee = new Map();
  for (const leave of leaveRows) {
    if (!leaveByEmployee.has(Number(leave.employee_id))) leaveByEmployee.set(Number(leave.employee_id), []);
    leaveByEmployee.get(Number(leave.employee_id)).push(leave);
  }

  const overrideRows = await rows(db, `SELECT o.employee_id,o.override_date,s.id shift_type_id,s.code,s.name,s.start_time,s.end_time,s.is_working_day FROM shift_overrides o JOIN shift_types s ON s.id=o.shift_type_id WHERE o.is_active=1 AND o.override_date>=? AND o.override_date<=?`, isoDate(weekStart), weekEnd);
  const overrideMap = new Map(overrideRows.map(o=>[`${o.employee_id}:${o.override_date}`,o]));
  const absenceRows = await rows(db, `SELECT a.*,t.name type_name,t.code type_code FROM absences a JOIN absence_types t ON t.id=a.absence_type_id WHERE a.is_active=1 AND a.start_date<=? AND a.end_date>=?`, weekEnd, isoDate(weekStart));
  const sicknessRows = await rows(db, `SELECT * FROM sickness WHERE is_active=1 AND start_date<=? AND end_date>=?`, weekEnd, isoDate(weekStart));
  const absenceMap = new Map(), sicknessMap = new Map();
  for (const a of absenceRows) for (const d of dates) { const day=isoDate(d); if(day>=a.start_date&&day<=a.end_date) absenceMap.set(`${a.employee_id}:${day}`,a); }
  for (const s of sicknessRows) for (const d of dates) { const day=isoDate(d); if(day>=s.start_date&&day<=s.end_date) sicknessMap.set(`${s.employee_id}:${day}`,s); }
  const wfhRows = await rows(db, `SELECT employee_id,request_date,status FROM wfh_requests WHERE request_date>=? AND request_date<=? AND status IN ('pending','approved')`, isoDate(weekStart), weekEnd);
  const wfhMap = new Map(wfhRows.map(x => [`${x.employee_id}:${x.request_date}`, x.status]));
  const today = isoDate(new Date());
  let lastTeam = null;
  const body = employees.map((e) => {
    const group = !selectedTeam && e.team_name !== lastTeam ? `<tr class="team-group"><td colspan="9"><strong>${h(e.team_name)}</strong></td></tr>` : '';
    lastTeam = e.team_name;
    const cycleWeek = cycleWeekForDate(e.pattern_start_date, Number(e.cycle_length_weeks) || 1, weekStart);
    const cells = dates.map((date, i) => {
      const day = isoDate(date);
      const scheduledShift = shiftMap.get(`${e.pattern_id}:${cycleWeek}:${i}`);
      const overrideShift = overrideMap.get(`${e.id}:${day}`);
      const shift = overrideShift || scheduledShift;
      const code = shift?.code || 'OFF';
      const title = shift ? `${shift.name}${shift.start_time ? ` ${shift.start_time}–${shift.end_time}` : ''}${overrideShift ? ` · override (scheduled ${scheduledShift?.code || 'OFF'})` : ''}` : 'Off';
      const approvedLeave = (leaveByEmployee.get(Number(e.id)) || []).find((leave) => leave.start_date <= day && leave.end_date >= day);
      // Leave only replaces a scheduled working shift; OFF remains OFF.
      const absence = absenceMap.get(`${e.id}:${day}`), sick = sicknessMap.get(`${e.id}:${day}`);
      if (sick && shift?.is_working_day) {
        let p='FULL'; if(day===sick.start_date)p=sick.start_portion||'FULL'; if(day===sick.end_date)p=sick.end_portion||'FULL';
        const shiftLine=`<span class="rota-underlying-shift">${h(code)}</span>`, line=`<strong>SICK${p==='FULL'?'':` ${h(p)}`}</strong>`;
        return `<td class="rota-cell shift-leave ${day===today?'today':''}" title="${h(`Sickness · scheduled ${code}`)}">${p==='PM'?`${shiftLine}<br>${line}`:`${line}<br>${shiftLine}`}</td>`;
      }
      if (absence && shift?.is_working_day) {
        let p='FULL'; if(day===absence.start_date)p=absence.start_portion||'FULL'; if(day===absence.end_date)p=absence.end_portion||'FULL';
        const shiftLine=`<span class="rota-underlying-shift">${h(code)}</span>`, line=`<strong>${h(absence.type_name.toUpperCase())}${p==='FULL'?'':` ${h(p)}`}</strong>`;
        return `<td class="rota-cell shift-leave ${day===today?'today':''}" title="${h(`${absence.type_name} · scheduled ${code}`)}">${p==='PM'?`${shiftLine}<br>${line}`:`${line}<br>${shiftLine}`}</td>`;
      }
      const wfh = wfhMap.get(`${e.id}:${day}`);
      if (approvedLeave && shift?.is_working_day) {
        let portion = 'FULL';
        if (day === approvedLeave.start_date) portion = approvedLeave.start_portion || 'FULL';
        if (day === approvedLeave.end_date) portion = approvedLeave.end_portion || 'FULL';
        const detail = portion === 'FULL' ? 'Annual Leave' : `Annual Leave · ${portion} half day`;
        const shiftLine = `<span class="rota-underlying-shift">${h(code)}</span>`;
        const leaveLine = `<strong>LEAVE${portion === 'FULL' ? '' : ` ${h(portion)}`}</strong>`;
        const wfhLine = wfh && portion !== 'FULL' ? `<br><strong>WFH${wfh==='pending'?' REQUESTED':''}</strong>` : '';
        const display = portion === 'PM'
          ? `${shiftLine}<br>${leaveLine}${wfhLine}`
          : `${leaveLine}<br>${shiftLine}${wfhLine}`;
        return `<td class="rota-cell shift-leave ${day === today ? 'today' : ''}" title="${h(`${detail} · scheduled ${code}${wfh && portion!=='FULL' ? ` · WFH ${wfh}` : ''}`)}">${display}</td>`;
      }
      if (wfh && shift?.is_working_day) return `<td class="rota-cell shift-${h(code).toLowerCase()} ${day === today ? 'today' : ''}" title="${h(title)} · WFH ${wfh}"><strong>${h(code)}</strong><br><strong>WFH${wfh==='pending'?' REQUESTED':''}</strong></td>`;
      return `<td class="rota-cell shift-${h(code).toLowerCase()} ${day === today ? 'today' : ''}" title="${h(title)}"><strong>${h(code)}</strong></td>`;
    }).join('');
    return `${group}<tr><td class="employee-cell"><strong>${h(e.display_name)}</strong><br><span class="muted">${h(e.pattern_name)} · ${cycleWeek}/${e.cycle_length_weeks}</span></td><td class="team-cell">${h(e.team_name)}</td>${cells}</tr>`;
  }).join('');

  const teamOptions = `<option value="">All Teams</option>${teams.map(t => `<option value="${t.id}" ${selectedTeam === t.id ? 'selected' : ''}>${h(t.name)}</option>`).join('')}`;
  const headers = dates.map(d => `<th class="${isoDate(d) === today ? 'today' : ''}">${formatDay(d)}</th>`).join('');
  const table = employees.length ? `<div class="table-card rota-calendar"><table><thead><tr><th>Employee</th><th>Team</th>${headers}</tr></thead><tbody>${body}</tbody></table></div>` : '<div class="empty">No active employees match this team.</div>';

  const content = `<div class="page-header"><div><div class="page-title">Rota</div><div class="page-description">Calendar week view by employee.</div></div></div>
  <div class="rota-toolbar">
    <form method="get" action="/rota" class="rota-filter"><label>Team<select name="team" onchange="this.form.submit()">${teamOptions}</select></label><input type="hidden" name="week" value="${isoDate(weekStart)}"></form>
    <div class="week-nav"><a class="button secondary" href="/rota?week=${previous}${teamParam}">‹ Previous</a><a class="button" href="/rota?week=${todayWeek}${teamParam}">Today</a><a class="button secondary" href="/rota?week=${next}${teamParam}">Next ›</a><form method="get" action="/rota" style="display:inline-flex;gap:6px;align-items:end;margin-left:12px"><label>Jump to month<input type="month" name="month" value="${isoDate(weekStart).slice(0,7)}"></label>${selectedTeam?`<input type="hidden" name="team" value="${selectedTeam}">`:''}<button type="submit" class="secondary">Go</button></form></div>
    <div class="week-range"><strong>${h(formatRange(weekStart))}</strong></div>
  </div>
  ${table}
  <div class="notice section-gap">Shifts are calculated from each employee's rota pattern. Approved annual leave overlays scheduled working days without changing the underlying pattern.</div>`;
  return new Response(shell(content+`<script>
  document.querySelectorAll('.rota-cell').forEach(td=>td.addEventListener('click',()=>{
    const tr=td.closest('tr'), idx=[...tr.children].indexOf(td)-2;
    if(idx<0)return;
    const name=tr.querySelector('.employee-cell strong')?.textContent, date=${JSON.stringify(dates.map(isoDate))}[idx];
    if(!name||!date)return;
    // The Day Actions endpoint owns authorization. Ignore access-denied responses here
    // so clicking another employee's row remains a harmless no-op rather than surfacing
    // a Worker exception/error page.
    fetch('/day?employee='+encodeURIComponent(name)+'&date='+date,{redirect:'manual'}).then(r=>{
      if(r.ok) location.href='/day?employee='+encodeURIComponent(name)+'&date='+date;
    }).catch(()=>{});

  }));
  </script>`), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.replace(/\/$/, '') === '/rota') {
      try { return await calendarRota(request, env.DB); }
      catch (error) { console.error(error); }
    }
    return legacyWorker.fetch(request, env);
  },
};
