export const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_system INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, description TEXT);
CREATE TABLE IF NOT EXISTS role_permissions (role_id INTEGER NOT NULL, permission_id INTEGER NOT NULL, PRIMARY KEY (role_id, permission_id), FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE, FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, email TEXT UNIQUE, external_identity TEXT UNIQUE, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS user_roles (user_id INTEGER NOT NULL, role_id INTEGER NOT NULL, PRIMARY KEY (user_id, role_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS departments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY AUTOINCREMENT, department_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (department_id, name), FOREIGN KEY (department_id) REFERENCES departments(id));
CREATE TABLE IF NOT EXISTS employees (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, team_id INTEGER NOT NULL, display_name TEXT NOT NULL, job_title TEXT, phone TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (team_id) REFERENCES teams(id));
CREATE TABLE IF NOT EXISTS shift_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, start_time TEXT, end_time TEXT, is_working_day INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS rota_patterns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, cycle_length_weeks INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS rota_pattern_days (id INTEGER PRIMARY KEY AUTOINCREMENT, rota_pattern_id INTEGER NOT NULL, shift_type_id INTEGER NOT NULL, week_number INTEGER NOT NULL, day_of_week INTEGER NOT NULL, UNIQUE (rota_pattern_id, week_number, day_of_week), FOREIGN KEY (rota_pattern_id) REFERENCES rota_patterns(id) ON DELETE CASCADE, FOREIGN KEY (shift_type_id) REFERENCES shift_types(id));
CREATE INDEX IF NOT EXISTS idx_teams_department ON teams(department_id);
CREATE INDEX IF NOT EXISTS idx_employees_team ON employees(team_id);
CREATE INDEX IF NOT EXISTS idx_pattern_days_pattern ON rota_pattern_days(rota_pattern_id);
INSERT OR IGNORE INTO permissions (code, description) VALUES ('MANAGE_USERS','Create and maintain portal users'),('MANAGE_TEAMS','Create and maintain departments and teams'),('MANAGE_EMPLOYEES','Create and maintain employees'),('MANAGE_ROTA','Create and maintain rota configuration');
INSERT OR IGNORE INTO roles (name, description, is_system) VALUES ('SystemAdmin','Full SupportApp administration',1),('Engineer','Standard SupportApp user',1);
INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name='SystemAdmin';
INSERT OR IGNORE INTO departments (name, description) VALUES ('Support','Support department');
INSERT OR IGNORE INTO shift_types (name, code, start_time, end_time, is_working_day) VALUES ('Off','OFF',NULL,NULL,0),('Early','EARLY','08:30','16:30',1),('Late','LATE','09:30','18:00',1),('Long Day','LONG','08:00','18:00',1);
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version','1');
`;

export async function ensureSchema(db) {
  try {
    const row = await db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").first();
    if (row?.value === '1') return;
  } catch (_) {
    // First request against a new D1 database: apply the initial schema below.
  }
  await db.exec(INITIAL_SCHEMA);
}
