export const INITIAL_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_system INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, description TEXT)",
  "CREATE TABLE IF NOT EXISTS role_permissions (role_id INTEGER NOT NULL, permission_id INTEGER NOT NULL, PRIMARY KEY (role_id, permission_id), FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE, FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, email TEXT UNIQUE, external_identity TEXT UNIQUE, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS user_roles (user_id INTEGER NOT NULL, role_id INTEGER NOT NULL, PRIMARY KEY (user_id, role_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS shift_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, start_time TEXT, end_time TEXT, is_working_day INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS rota_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, cycle_length_weeks INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, department_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, default_rota_pattern_id INTEGER, default_pattern_start_date TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (department_id, name), FOREIGN KEY (department_id) REFERENCES departments(id), FOREIGN KEY (default_rota_pattern_id) REFERENCES rota_patterns(id))",
  "CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, team_id INTEGER NOT NULL, display_name TEXT NOT NULL, job_title TEXT, phone TEXT, override_rota_pattern_id INTEGER, override_pattern_start_date TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (team_id) REFERENCES teams(id), FOREIGN KEY (override_rota_pattern_id) REFERENCES rota_patterns(id))",
  "CREATE TABLE IF NOT EXISTS rota_pattern_days (id INTEGER PRIMARY KEY AUTOINCREMENT, rota_pattern_id INTEGER NOT NULL, shift_type_id INTEGER NOT NULL, week_number INTEGER NOT NULL, day_of_week INTEGER NOT NULL, UNIQUE (rota_pattern_id, week_number, day_of_week), FOREIGN KEY (rota_pattern_id) REFERENCES rota_patterns(id) ON DELETE CASCADE, FOREIGN KEY (shift_type_id) REFERENCES shift_types(id))",
  "CREATE INDEX IF NOT EXISTS idx_teams_department ON teams(department_id)",
  "CREATE INDEX IF NOT EXISTS idx_employees_team ON employees(team_id)",
  "CREATE INDEX IF NOT EXISTS idx_pattern_days_pattern ON rota_pattern_days(rota_pattern_id)",
  "INSERT OR IGNORE INTO permissions (code, description) VALUES ('MANAGE_USERS','Create and maintain portal users'),('MANAGE_TEAMS','Create and maintain departments and teams'),('MANAGE_EMPLOYEES','Create and maintain employees'),('MANAGE_ROTA','Create and maintain rota configuration')",
  "INSERT OR IGNORE INTO roles (name, description, is_system) VALUES ('SystemAdmin','Full SupportApp administration',1),('Engineer','Standard SupportApp user',1)",
  "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name='SystemAdmin'",
  "INSERT OR IGNORE INTO departments (name, description) VALUES ('Support','Support department')",
  "INSERT OR IGNORE INTO shift_types (name, code, start_time, end_time, is_working_day) VALUES ('Off','OFF',NULL,NULL,0),('Early','EARLY','08:30','16:30',1),('Late','LATE','09:30','18:00',1),('Long Day','LONG','08:00','18:00',1)",
  "INSERT OR IGNORE INTO rota_patterns (name, description, cycle_length_weeks) VALUES ('No Scheduled Hours','Default all-off rota pattern',1)",
  "INSERT OR IGNORE INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) SELECT rp.id, st.id, 1, 0 FROM rota_patterns rp JOIN shift_types st ON st.code='OFF' WHERE rp.name='No Scheduled Hours'",
  "INSERT OR IGNORE INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) SELECT rp.id, st.id, 1, 1 FROM rota_patterns rp JOIN shift_types st ON st.code='OFF' WHERE rp.name='No Scheduled Hours'",
  "INSERT OR IGNORE INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) SELECT rp.id, st.id, 1, 2 FROM rota_patterns rp JOIN shift_types st ON st.code='OFF' WHERE rp.name='No Scheduled Hours'",
  "INSERT OR IGNORE INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) SELECT rp.id, st.id, 1, 3 FROM rota_patterns rp JOIN shift_types st ON st.code='OFF' WHERE rp.name='No Scheduled Hours'",
  "INSERT OR IGNORE INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) SELECT rp.id, st.id, 1, 4 FROM rota_patterns rp JOIN shift_types st ON st.code='OFF' WHERE rp.name='No Scheduled Hours'",
  "INSERT OR IGNORE INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) SELECT rp.id, st.id, 1, 5 FROM rota_patterns rp JOIN shift_types st ON st.code='OFF' WHERE rp.name='No Scheduled Hours'",
  "INSERT OR IGNORE INTO rota_pattern_days (rota_pattern_id, shift_type_id, week_number, day_of_week) SELECT rp.id, st.id, 1, 6 FROM rota_patterns rp JOIN shift_types st ON st.code='OFF' WHERE rp.name='No Scheduled Hours'",
  "UPDATE teams SET default_rota_pattern_id=(SELECT id FROM rota_patterns WHERE name='No Scheduled Hours') WHERE default_rota_pattern_id IS NULL",
  "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version','1')"
];

const V2_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS week_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS week_pattern_days (id INTEGER PRIMARY KEY AUTOINCREMENT, week_pattern_id INTEGER NOT NULL, shift_type_id INTEGER NOT NULL, day_of_week INTEGER NOT NULL, UNIQUE (week_pattern_id, day_of_week), FOREIGN KEY (week_pattern_id) REFERENCES week_patterns(id) ON DELETE CASCADE, FOREIGN KEY (shift_type_id) REFERENCES shift_types(id))",
  "CREATE TABLE IF NOT EXISTS rota_pattern_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, rota_pattern_id INTEGER NOT NULL, week_number INTEGER NOT NULL, week_pattern_id INTEGER NOT NULL, UNIQUE (rota_pattern_id, week_number), FOREIGN KEY (rota_pattern_id) REFERENCES rota_patterns(id) ON DELETE CASCADE, FOREIGN KEY (week_pattern_id) REFERENCES week_patterns(id))",
  "CREATE INDEX IF NOT EXISTS idx_week_pattern_days_pattern ON week_pattern_days(week_pattern_id)",
  "CREATE INDEX IF NOT EXISTS idx_rota_pattern_weeks_pattern ON rota_pattern_weeks(rota_pattern_id)",
  "INSERT OR IGNORE INTO week_patterns (name, description, is_active, created_at) SELECT name, description, is_active, created_at FROM rota_patterns",
  "INSERT OR IGNORE INTO week_pattern_days (week_pattern_id, shift_type_id, day_of_week) SELECT wp.id, rpd.shift_type_id, rpd.day_of_week FROM rota_pattern_days rpd JOIN rota_patterns rp ON rp.id=rpd.rota_pattern_id JOIN week_patterns wp ON wp.name=rp.name WHERE rpd.week_number=1",
  "INSERT OR IGNORE INTO rota_pattern_weeks (rota_pattern_id, week_number, week_pattern_id) SELECT rp.id, 1, wp.id FROM rota_patterns rp JOIN week_patterns wp ON wp.name=rp.name",
  "UPDATE app_meta SET value='2' WHERE key='schema_version'"
];

const V3_SCHEMA_STATEMENTS = [
  "ALTER TABLE employees ADD COLUMN username TEXT",
  "ALTER TABLE employees ADD COLUMN email TEXT",
  "ALTER TABLE employees ADD COLUMN external_identity TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_username ON employees(username) WHERE username IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email ON employees(email) WHERE email IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_external_identity ON employees(external_identity) WHERE external_identity IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS employee_roles (employee_id INTEGER NOT NULL, role_id INTEGER NOT NULL, PRIMARY KEY (employee_id, role_id), FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE, FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE)",
  "UPDATE employees SET username=(SELECT u.username FROM users u WHERE u.id=employees.user_id), email=(SELECT u.email FROM users u WHERE u.id=employees.user_id), external_identity=(SELECT u.external_identity FROM users u WHERE u.id=employees.user_id) WHERE user_id IS NOT NULL",
  "INSERT OR IGNORE INTO employee_roles (employee_id, role_id) SELECT e.id, ur.role_id FROM employees e JOIN user_roles ur ON ur.user_id=e.user_id WHERE e.user_id IS NOT NULL",
  "UPDATE app_meta SET value='3' WHERE key='schema_version'"
];

const V4_SCHEMA_STATEMENTS = [
  "INSERT OR IGNORE INTO roles (name, description, is_system) VALUES ('Manager','Manager or team leader with scoped responsibility for assigned teams',1)",
  "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('MANAGE_EMPLOYEES','MANAGE_ROTA') WHERE r.name='Manager'",
  "CREATE TABLE IF NOT EXISTS team_managers (team_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, PRIMARY KEY (team_id, employee_id), FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE, FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS idx_team_managers_employee ON team_managers(employee_id)",
  "UPDATE app_meta SET value='4' WHERE key='schema_version'"
];

async function applyStatements(db, statements, ignoreDuplicateColumns = false) {
  for (const statement of statements) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      if (ignoreDuplicateColumns && String(error?.message || error).includes('duplicate column name')) continue;
      throw error;
    }
  }
}

export async function ensureSchema(db) {
  let version = 0;
  try {
    const current = await db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").first();
    version = Number(current?.value || 0);
  } catch (_) {
    version = 0;
  }

  if (version < 1) {
    await applyStatements(db, INITIAL_SCHEMA_STATEMENTS);
    version = 1;
  }

  if (version < 2) {
    await applyStatements(db, V2_SCHEMA_STATEMENTS);
    version = 2;
  }

  if (version < 3) {
    await applyStatements(db, V3_SCHEMA_STATEMENTS, true);
    version = 3;
  }

  if (version < 4) {
    await applyStatements(db, V4_SCHEMA_STATEMENTS);
  }
}
