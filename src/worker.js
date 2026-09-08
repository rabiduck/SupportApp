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
  const requested = url.searchParams.get('week');
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

  const today = isoDate(new Date());
  let lastTeam = null;
  const body = employees.map((e) => {
    const group = !selectedTeam && e.team_name !== lastTeam ? `<tr class="team-group"><td colspan="9"><strong>${h(e.team_name)}</strong></td></tr>` : '';
    lastTeam = e.team_name;
    const cycleWeek = cycleWeekForDate(e.pattern_start_date, Number(e.cycle_length_weeks) || 1, weekStart);
    const cells = dates.map((date, i) => {
      const shift = shiftMap.get(`${e.pattern_id}:${cycleWeek}:${i}`);
      const code = shift?.code || 'OFF';
      const title = shift ? `${shift.name}${shift.start_time ? ` ${shift.start_time}–${shift.end_time}` : ''}` : 'Off';
      return `<td class="rota-cell shift-${h(code).toLowerCase()} ${isoDate(date) === today ? 'today' : ''}" title="${h(title)}"><strong>${h(code)}</strong></td>`;
    }).join('');
    return `${group}<tr><td class="employee-cell"><strong>${h(e.display_name)}</strong><br><span class="muted">${h(e.pattern_name)} · ${cycleWeek}/${e.cycle_length_weeks}</span></td><td class="team-cell">${h(e.team_name)}</td>${cells}</tr>`;
  }).join('');

  const teamOptions = `<option value="">All Teams</option>${teams.map(t => `<option value="${t.id}" ${selectedTeam === t.id ? 'selected' : ''}>${h(t.name)}</option>`).join('')}`;
  const headers = dates.map(d => `<th class="${isoDate(d) === today ? 'today' : ''}">${formatDay(d)}</th>`).join('');
  const table = employees.length ? `<div class="table-card rota-calendar"><table><thead><tr><th>Employee</th><th>Team</th>${headers}</tr></thead><tbody>${body}</tbody></table></div>` : '<div class="empty">No active employees match this team.</div>';

  const content = `<div class="page-header"><div><div class="page-title">Rota</div><div class="page-description">Calendar week view by employee.</div></div></div>
  <div class="rota-toolbar">
    <form method="get" action="/rota" class="rota-filter"><label>Team<select name="team" onchange="this.form.submit()">${teamOptions}</select></label><input type="hidden" name="week" value="${isoDate(weekStart)}"></form>
    <div class="week-nav"><a class="button secondary" href="/rota?week=${previous}${teamParam}">‹ Previous</a><a class="button" href="/rota?week=${todayWeek}${teamParam}">Today</a><a class="button secondary" href="/rota?week=${next}${teamParam}">Next ›</a></div>
    <div class="week-range"><strong>${h(formatRange(weekStart))}</strong></div>
  </div>
  ${table}
  <div class="notice section-gap">Shifts are calculated for the selected calendar week from each employee's team default or individual rota override and its pattern start date.</div>`;
  return new Response(shell(content), { headers: { 'content-type': 'text/html; charset=UTF-8' } });
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
