import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema } from '../src/schema.js';
import { d1Database } from './helpers/d1.js';

test('fresh schema creates TeamLeader and reaches version 27', async () => {
  const db = d1Database();
  await ensureSchema(db);

  const version = db.sqlite.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get();
  const role = db.sqlite.prepare("SELECT description,is_system FROM roles WHERE name='TeamLeader'").get();
  const permissions = db.sqlite.prepare(`SELECT p.code FROM role_permissions rp
    JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id
    WHERE r.name='TeamLeader' ORDER BY p.code`).all().map((item) => item.code);

  assert.equal(version.value, '27');
  assert.equal(role.is_system, 1);
  assert.match(role.description, /Deputy manager/);
  assert.deepEqual(permissions, ['MANAGE_EMPLOYEES', 'MANAGE_ROTA', 'MANAGE_TEAMS', 'MANAGE_USERS']);
});

test('version 26 database receives TeamLeader migration idempotently', async () => {
  const db = d1Database();
  await ensureSchema(db);
  db.sqlite.exec("DELETE FROM roles WHERE name='TeamLeader'; UPDATE app_meta SET value='26' WHERE key='schema_version'");

  await ensureSchema(db);
  await ensureSchema(db);

  const count = db.sqlite.prepare("SELECT COUNT(*) count FROM roles WHERE name='TeamLeader'").get();
  const version = db.sqlite.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get();
  assert.equal(count.count, 1);
  assert.equal(version.value, '27');
});
