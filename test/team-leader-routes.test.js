import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import worker from '../src/worker-v8.js';
import { ensureSchema } from '../src/schema.js';
import { d1Database } from './helpers/d1.js';

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const db = d1Database();
  await ensureSchema(db);
  const departmentId = db.sqlite.prepare("SELECT id FROM departments WHERE name='Support'").get().id;
  const patternId = db.sqlite.prepare("SELECT id FROM rota_patterns WHERE name='No Scheduled Hours'").get().id;
  const insertTeam = db.sqlite.prepare('INSERT INTO teams(department_id,name,default_rota_pattern_id,is_active) VALUES(?,?,?,1)');
  const teamA = Number(insertTeam.run(departmentId, 'Alpha', patternId).lastInsertRowid);
  const teamB = Number(insertTeam.run(departmentId, 'Beta', patternId).lastInsertRowid);
  const insertEmployee = db.sqlite.prepare('INSERT INTO employees(team_id,display_name,username,email,is_active) VALUES(?,?,?,?,1)');
  const tl = Number(insertEmployee.run(teamA, 'Taylor TL', 'taylor', 'taylor@example.test').lastInsertRowid);
  const manager = Number(insertEmployee.run(teamA, 'Morgan Manager', 'morgan', 'morgan@example.test').lastInsertRowid);
  const employeeA = Number(insertEmployee.run(teamA, 'Alex Alpha', 'alex', 'alex@example.test').lastInsertRowid);
  const employeeB = Number(insertEmployee.run(teamB, 'Blake Beta', 'blake', 'blake@example.test').lastInsertRowid);
  const roleId = (name) => db.sqlite.prepare('SELECT id FROM roles WHERE name=?').get(name).id;
  const assignRole = db.sqlite.prepare('INSERT INTO employee_roles(employee_id,role_id) VALUES(?,?)');
  assignRole.run(tl, roleId('TeamLeader'));
  assignRole.run(manager, roleId('Manager'));
  assignRole.run(employeeA, roleId('Employee'));
  assignRole.run(employeeB, roleId('Employee'));
  db.sqlite.prepare('INSERT INTO team_managers(team_id,employee_id) VALUES(?,?)').run(teamA, tl);
  db.sqlite.prepare('INSERT INTO team_managers(team_id,employee_id) VALUES(?,?)').run(teamA, manager);
  const annualId = db.sqlite.prepare("SELECT id FROM leave_types WHERE code='ANNUAL'").get().id;
  const insertLeave = db.sqlite.prepare("INSERT INTO leave_requests(employee_id,start_date,end_date,status,leave_type_id) VALUES(?,?,?,'pending',?)");
  insertLeave.run(employeeA, '2099-01-10', '2099-01-10', annualId);
  insertLeave.run(employeeB, '2099-01-11', '2099-01-11', annualId);
  db.sqlite.prepare("INSERT INTO employee_credentials(employee_id,password_hash,password_salt,password_iterations) VALUES(?,'x','x',1)").run(tl);
  const sessions = new Map();
  for (const [name, employeeId] of [['tl',tl],['manager',manager],['employee',employeeA]]) {
    const token = `${name}-session`;
    db.sqlite.prepare("INSERT INTO auth_sessions(token_hash,employee_id,expires_at) VALUES(?,?,datetime('now','+12 hours'))").run(hash(token),employeeId);
    sessions.set(name, token);
  }
  return { db, env: { DB: db, AUTH_PROVIDER: 'local' }, sessions, ids: { tl, manager, employeeA, employeeB } };
}

function request(path, token) {
  return new Request(`https://supportapp.test${path}`, { headers: { Cookie: `supportapp_session=${token}` } });
}

test('Team Leader can review managed-team leave but cannot see another team', async () => {
  const { env, sessions } = await fixture();
  const response = await worker.fetch(request('/leave-requests?past=show', sessions.get('tl')), env, {});
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Alex Alpha/);
  assert.doesNotMatch(body, /Blake Beta/);
});

test('Team Leader and Manager have employee administration access in scope', async () => {
  const { env, sessions, ids } = await fixture();
  for (const actor of ['tl', 'manager']) {
    const response = await worker.fetch(request('/employees', sessions.get(actor)), env, {});
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /Alex Alpha/);
    assert.doesNotMatch(body, /Blake Beta/);
  }
  const outside = await worker.fetch(request(`/employees/${ids.employeeB}/edit`, sessions.get('tl')), env, {});
  assert.equal(outside.status, 403);
});

test('Team Leader cannot edit another elevated account and Employee cannot review leave', async () => {
  const { env, sessions, ids } = await fixture();
  const elevated = await worker.fetch(request(`/employees/${ids.manager}/edit`, sessions.get('tl')), env, {});
  const ordinary = await worker.fetch(request('/leave-requests', sessions.get('employee')), env, {});
  assert.equal(elevated.status, 403);
  assert.equal(ordinary.status, 403);
});
