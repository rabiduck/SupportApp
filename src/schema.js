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

const V5_SCHEMA_STATEMENTS = [
  "INSERT OR IGNORE INTO roles (name, description, is_system) VALUES ('Employee','Standard SupportApp employee with rota access',1)",
  "UPDATE employee_roles SET role_id=(SELECT id FROM roles WHERE name='Employee') WHERE role_id=(SELECT id FROM roles WHERE name='Engineer')",
  "DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE name='Manager')",
  "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name='Manager' AND p.code IN ('MANAGE_USERS','MANAGE_TEAMS','MANAGE_EMPLOYEES','MANAGE_ROTA')",
  "UPDATE roles SET description='Manager or team leader with access to operational configuration' WHERE name='Manager'",
  "UPDATE app_meta SET value='5' WHERE key='schema_version'"
];

const V6_SCHEMA_STATEMENTS = [
  "DELETE FROM role_permissions WHERE role_id=(SELECT id FROM roles WHERE name='Engineer')",
  "DELETE FROM roles WHERE name='Engineer' AND NOT EXISTS (SELECT 1 FROM employee_roles er WHERE er.role_id=roles.id)",
  "UPDATE app_meta SET value='6' WHERE key='schema_version'"
];

const V7_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS employee_credentials (employee_id INTEGER PRIMARY KEY, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL DEFAULT 150000, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, employee_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS idx_auth_sessions_employee ON auth_sessions(employee_id)",
  "CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at)",
  "UPDATE app_meta SET value='7' WHERE key='schema_version'"
];

const V8_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS leave_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')), employee_notes TEXT, requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_by INTEGER, reviewed_at TEXT, manager_notes TEXT, FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE, FOREIGN KEY (reviewed_by) REFERENCES employees(id))",
  "CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id)",
  "CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status)",
  "CREATE INDEX IF NOT EXISTS idx_leave_requests_dates ON leave_requests(start_date,end_date)",
  "UPDATE app_meta SET value='8' WHERE key='schema_version'"
];

const V9_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_employee_id INTEGER NOT NULL, notification_type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, target_url TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT, FOREIGN KEY (recipient_employee_id) REFERENCES employees(id) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_employee_id,created_at)",
  "CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(recipient_employee_id,read_at)",
  "UPDATE app_meta SET value='9' WHERE key='schema_version'"
];

const V10_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS leave_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, description TEXT, entitlement_based INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS leave_years (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, start_date TEXT NOT NULL, end_date TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK (end_date >= start_date))",
  "CREATE TABLE IF NOT EXISTS employee_leave_entitlements (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, leave_year_id INTEGER NOT NULL, leave_type_id INTEGER NOT NULL, entitlement_hours REAL NOT NULL DEFAULT 0, adjustment_hours REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (employee_id,leave_year_id,leave_type_id), FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE, FOREIGN KEY (leave_year_id) REFERENCES leave_years(id) ON DELETE CASCADE, FOREIGN KEY (leave_type_id) REFERENCES leave_types(id))",
  "ALTER TABLE leave_requests ADD COLUMN leave_type_id INTEGER REFERENCES leave_types(id)",
  "INSERT OR IGNORE INTO leave_types (name,code,description,entitlement_based) VALUES ('Annual Leave','ANNUAL','Paid annual leave',1),('TOIL','TOIL','Time off in lieu',0)",
  "UPDATE leave_requests SET leave_type_id=(SELECT id FROM leave_types WHERE code='ANNUAL') WHERE leave_type_id IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_entitlements_employee_year ON employee_leave_entitlements(employee_id,leave_year_id)",
  "CREATE INDEX IF NOT EXISTS idx_leave_requests_type ON leave_requests(leave_type_id)",
  "UPDATE app_meta SET value='10' WHERE key='schema_version'"
];

const V11_SCHEMA_STATEMENTS = [
  "ALTER TABLE employee_leave_entitlements RENAME COLUMN entitlement_hours TO entitlement_days",
  "ALTER TABLE employee_leave_entitlements RENAME COLUMN adjustment_hours TO adjustment_days",
  "ALTER TABLE leave_requests ADD COLUMN start_portion TEXT NOT NULL DEFAULT 'FULL' CHECK (start_portion IN ('FULL','AM','PM'))",
  "ALTER TABLE leave_requests ADD COLUMN end_portion TEXT NOT NULL DEFAULT 'FULL' CHECK (end_portion IN ('FULL','AM','PM'))",
  "UPDATE app_meta SET value='11' WHERE key='schema_version'"
];

const V12_SCHEMA_STATEMENTS = [
  "UPDATE leave_requests SET leave_type_id=(SELECT id FROM leave_types WHERE code='ANNUAL') WHERE leave_type_id IS NULL",
  "UPDATE app_meta SET value='12' WHERE key='schema_version'"
];

const V13_SCHEMA_STATEMENTS = [
  "ALTER TABLE leave_requests ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'REQUEST'",
  "UPDATE app_meta SET value='13' WHERE key='schema_version'"
];

const V14_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS leave_change_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, leave_request_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, start_portion TEXT NOT NULL DEFAULT 'FULL', end_portion TEXT NOT NULL DEFAULT 'FULL', employee_notes TEXT, status TEXT NOT NULL DEFAULT 'pending', requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_by INTEGER, reviewed_at TEXT, manager_notes TEXT, FOREIGN KEY(leave_request_id) REFERENCES leave_requests(id), FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(reviewed_by) REFERENCES employees(id))",
  "CREATE INDEX IF NOT EXISTS idx_leave_changes_leave ON leave_change_requests(leave_request_id,status)",
  "UPDATE app_meta SET value='14' WHERE key='schema_version'"
];

const V15_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS wfh_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, request_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', employee_notes TEXT, requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_by INTEGER, reviewed_at TEXT, manager_notes TEXT, entry_mode TEXT NOT NULL DEFAULT 'REQUEST', FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(reviewed_by) REFERENCES employees(id))",
  "CREATE INDEX IF NOT EXISTS idx_wfh_employee_date ON wfh_requests(employee_id,request_date,status)",
  "UPDATE app_meta SET value='15' WHERE key='schema_version'"
];

const V16_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS absence_types (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1)",
  "INSERT OR IGNORE INTO absence_types(name,code,is_active) VALUES ('DC','DC',1),('Appointment','APPOINTMENT',1),('Exam','EXAM',1),('Course','COURSE',1),('Client Site','CLIENT_SITE',1),('Other','OTHER',1)",
  "CREATE TABLE IF NOT EXISTS absences (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, absence_type_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, start_portion TEXT NOT NULL DEFAULT 'FULL', end_portion TEXT NOT NULL DEFAULT 'FULL', notes TEXT, recorded_by INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_active INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(absence_type_id) REFERENCES absence_types(id), FOREIGN KEY(recorded_by) REFERENCES employees(id))",
  "CREATE INDEX IF NOT EXISTS idx_absences_employee_dates ON absences(employee_id,start_date,end_date,is_active)",
  "CREATE TABLE IF NOT EXISTS sickness (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, start_portion TEXT NOT NULL DEFAULT 'FULL', end_portion TEXT NOT NULL DEFAULT 'FULL', notes TEXT, recorded_by INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_active INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(recorded_by) REFERENCES employees(id))",
  "CREATE INDEX IF NOT EXISTS idx_sickness_employee_dates ON sickness(employee_id,start_date,end_date,is_active)",
  "UPDATE app_meta SET value='16' WHERE key='schema_version'"
];

const V17_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS shift_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL, override_date TEXT NOT NULL, shift_type_id INTEGER NOT NULL, notes TEXT, recorded_by INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, is_active INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(shift_type_id) REFERENCES shift_types(id), FOREIGN KEY(recorded_by) REFERENCES employees(id))",
  "CREATE INDEX IF NOT EXISTS idx_shift_overrides_employee_date ON shift_overrides(employee_id,override_date,is_active)",
  "UPDATE app_meta SET value='17' WHERE key='schema_version'"
];

const V18_SCHEMA_STATEMENTS = [
 "CREATE TABLE IF NOT EXISTS oncall_members (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL UNIQUE, display_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, removed_at TEXT, FOREIGN KEY(employee_id) REFERENCES employees(id))",
 "CREATE TABLE IF NOT EXISTS oncall_settings (id INTEGER PRIMARY KEY CHECK(id=1), anchor_friday TEXT, anchor_member_id INTEGER, FOREIGN KEY(anchor_member_id) REFERENCES oncall_members(id))",
 "INSERT OR IGNORE INTO oncall_settings(id) VALUES(1)",
 "CREATE TABLE IF NOT EXISTS oncall_cover_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_id INTEGER NOT NULL, scope TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, mode TEXT NOT NULL, named_employee_id INTEGER, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', accepted_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT, FOREIGN KEY(requester_id) REFERENCES employees(id), FOREIGN KEY(named_employee_id) REFERENCES employees(id), FOREIGN KEY(accepted_by) REFERENCES employees(id))",
 "CREATE TABLE IF NOT EXISTS oncall_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, start_date TEXT NOT NULL, end_date TEXT NOT NULL, employee_id INTEGER NOT NULL, source TEXT NOT NULL, source_id INTEGER, notes TEXT, recorded_by INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_active INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(recorded_by) REFERENCES employees(id))",
 "CREATE INDEX IF NOT EXISTS idx_oncall_overrides_dates ON oncall_overrides(start_date,end_date,is_active)",
 "UPDATE app_meta SET value='18' WHERE key='schema_version'"
];

const V19_SCHEMA_STATEMENTS = [
 "ALTER TABLE teams ADD COLUMN gatekeeper_enabled INTEGER NOT NULL DEFAULT 1",
 "ALTER TABLE employees ADD COLUMN gatekeeper_order INTEGER",
 "CREATE TABLE IF NOT EXISTS gatekeeper_settings (team_id INTEGER PRIMARY KEY, anchor_monday TEXT, anchor_employee_id INTEGER, FOREIGN KEY(team_id) REFERENCES teams(id), FOREIGN KEY(anchor_employee_id) REFERENCES employees(id))",
 "CREATE TABLE IF NOT EXISTS gatekeeper_cover_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER NOT NULL, requester_id INTEGER NOT NULL, scope TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, mode TEXT NOT NULL, named_employee_id INTEGER, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', accepted_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT, FOREIGN KEY(team_id) REFERENCES teams(id), FOREIGN KEY(requester_id) REFERENCES employees(id))",
 "CREATE TABLE IF NOT EXISTS gatekeeper_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, employee_id INTEGER NOT NULL, source TEXT NOT NULL, source_id INTEGER, notes TEXT, recorded_by INTEGER NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, is_active INTEGER NOT NULL DEFAULT 1)",
 "CREATE INDEX IF NOT EXISTS idx_gatekeeper_overrides_dates ON gatekeeper_overrides(team_id,start_date,end_date,is_active)",
 "UPDATE app_meta SET value='19' WHERE key='schema_version'"
];

const V20_SCHEMA_STATEMENTS = [
 "CREATE TABLE IF NOT EXISTS pdp_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT)",
 "CREATE TABLE IF NOT EXISTS pdp_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT)",
 "CREATE TABLE IF NOT EXISTS pdp_ability_scale (score INTEGER PRIMARY KEY CHECK(score BETWEEN 1 AND 5), level TEXT NOT NULL, explanation TEXT NOT NULL, updated_at TEXT)",
 "INSERT OR IGNORE INTO pdp_ability_scale(score,level,explanation) VALUES(1,'Low','Unable to perform and little to no experience')",
 "INSERT OR IGNORE INTO pdp_ability_scale(score,level,explanation) VALUES(2,'Basic','Limited in knowledge and ability. Would require help and assistance from others.')",
 "INSERT OR IGNORE INTO pdp_ability_scale(score,level,explanation) VALUES(3,'Demonstrating','Has decent experience but needs help from time to time.')",
 "INSERT OR IGNORE INTO pdp_ability_scale(score,level,explanation) VALUES(4,'Proficient','Capable and demonstrates proficiency. Can work with little help or assistance.')",
 "INSERT OR IGNORE INTO pdp_ability_scale(score,level,explanation) VALUES(5,'Experienced','Fully capable, experienced and needs no assistance. Sought for by others to help and able to lead / train.')",
 "CREATE TABLE IF NOT EXISTS pdp_matrices (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT)",
 "CREATE TABLE IF NOT EXISTS pdp_matrix_teams (matrix_id INTEGER NOT NULL, team_id INTEGER NOT NULL, PRIMARY KEY(matrix_id,team_id), FOREIGN KEY(matrix_id) REFERENCES pdp_matrices(id) ON DELETE CASCADE, FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE)",
 "CREATE TABLE IF NOT EXISTS pdp_matrix_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, matrix_id INTEGER NOT NULL, category_id INTEGER NOT NULL, display_order INTEGER NOT NULL DEFAULT 0, UNIQUE(matrix_id,category_id), FOREIGN KEY(matrix_id) REFERENCES pdp_matrices(id) ON DELETE CASCADE, FOREIGN KEY(category_id) REFERENCES pdp_categories(id))",
 "CREATE TABLE IF NOT EXISTS pdp_matrix_skills (id INTEGER PRIMARY KEY AUTOINCREMENT, matrix_id INTEGER NOT NULL, category_id INTEGER, skill_id INTEGER NOT NULL, display_order INTEGER NOT NULL DEFAULT 0, UNIQUE(matrix_id,skill_id), FOREIGN KEY(matrix_id) REFERENCES pdp_matrices(id) ON DELETE CASCADE, FOREIGN KEY(category_id) REFERENCES pdp_categories(id), FOREIGN KEY(skill_id) REFERENCES pdp_skills(id))",
 "CREATE TABLE IF NOT EXISTS pdp_cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', start_date TEXT, due_date TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, published_at TEXT, closed_at TEXT, source_cycle_id INTEGER, FOREIGN KEY(created_by) REFERENCES employees(id), FOREIGN KEY(source_cycle_id) REFERENCES pdp_cycles(id))",
 "CREATE TABLE IF NOT EXISTS pdp_cycle_matrices (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL, source_matrix_id INTEGER, team_id INTEGER NOT NULL, matrix_name TEXT NOT NULL, matrix_snapshot TEXT NOT NULL, UNIQUE(cycle_id,team_id), FOREIGN KEY(cycle_id) REFERENCES pdp_cycles(id) ON DELETE CASCADE, FOREIGN KEY(team_id) REFERENCES teams(id))",
 "CREATE TABLE IF NOT EXISTS pdp_skill_assessments (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, skill_id INTEGER NOT NULL, self_ability INTEGER, self_interest INTEGER, management_ability INTEGER, management_interest INTEGER, management_assessor_id INTEGER, self_updated_at TEXT, management_updated_at TEXT, UNIQUE(cycle_id,employee_id,skill_id), FOREIGN KEY(cycle_id) REFERENCES pdp_cycles(id), FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(skill_id) REFERENCES pdp_skills(id), FOREIGN KEY(management_assessor_id) REFERENCES employees(id))",
 "CREATE TABLE IF NOT EXISTS pdp_skill_assessment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, assessment_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, rating_type TEXT NOT NULL, ability INTEGER, interest INTEGER, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(assessment_id) REFERENCES pdp_skill_assessments(id), FOREIGN KEY(actor_id) REFERENCES employees(id))",
 "UPDATE app_meta SET value='20' WHERE key='schema_version'"
];


const V21_SCHEMA_STATEMENTS = [
 "ALTER TABLE pdp_cycles ADD COLUMN source_matrix_id INTEGER",
 "ALTER TABLE pdp_cycles ADD COLUMN ability_scale_snapshot TEXT",
 "CREATE TABLE IF NOT EXISTS pdp_cycle_participants (cycle_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'not_started', included_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, submitted_at TEXT, PRIMARY KEY(cycle_id,employee_id), FOREIGN KEY(cycle_id) REFERENCES pdp_cycles(id) ON DELETE CASCADE, FOREIGN KEY(employee_id) REFERENCES employees(id))",
 "UPDATE app_meta SET value='21' WHERE key='schema_version'"
];

const V23_SCHEMA_STATEMENTS = [
 "CREATE TABLE IF NOT EXISTS pdp_cycle_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL, question_text TEXT NOT NULL, display_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(cycle_id) REFERENCES pdp_cycles(id) ON DELETE CASCADE)",
 "CREATE TABLE IF NOT EXISTS pdp_question_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, cycle_id INTEGER NOT NULL, employee_id INTEGER NOT NULL, question_id INTEGER NOT NULL, response_text TEXT, updated_at TEXT, UNIQUE(cycle_id,employee_id,question_id), FOREIGN KEY(cycle_id) REFERENCES pdp_cycles(id) ON DELETE CASCADE, FOREIGN KEY(employee_id) REFERENCES employees(id), FOREIGN KEY(question_id) REFERENCES pdp_cycle_questions(id) ON DELETE CASCADE)",
 "UPDATE app_meta SET value='23' WHERE key='schema_version'"
];

const V22_SCHEMA_STATEMENTS = [
 "CREATE TABLE IF NOT EXISTS pdp_cycle_matrix_links (cycle_id INTEGER NOT NULL, matrix_id INTEGER NOT NULL, PRIMARY KEY(cycle_id,matrix_id), FOREIGN KEY(cycle_id) REFERENCES pdp_cycles(id) ON DELETE CASCADE, FOREIGN KEY(matrix_id) REFERENCES pdp_matrices(id))",
 "UPDATE app_meta SET value='22' WHERE key='schema_version'"
];

const V24_SCHEMA_STATEMENTS = [
 "CREATE TABLE IF NOT EXISTS scheduled_action_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, instructions TEXT, recurrence_type TEXT NOT NULL CHECK(recurrence_type IN ('once','daily','weekly','monthly')), local_time TEXT NOT NULL, day_of_week INTEGER, day_of_month INTEGER, start_date TEXT NOT NULL, end_date TEXT, timezone TEXT NOT NULL DEFAULT 'Europe/London', due_after_minutes INTEGER NOT NULL DEFAULT 480, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')), assignment_type TEXT NOT NULL CHECK(assignment_type IN ('employee','team','on_call','gatekeeper')), target_employee_id INTEGER, target_team_id INTEGER, is_active INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, FOREIGN KEY(target_employee_id) REFERENCES employees(id), FOREIGN KEY(target_team_id) REFERENCES teams(id), FOREIGN KEY(created_by) REFERENCES employees(id))",
 "CREATE INDEX IF NOT EXISTS idx_scheduled_action_schedules_active ON scheduled_action_schedules(is_active,start_date,end_date)",
 "CREATE TABLE IF NOT EXISTS scheduled_action_instances (id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id INTEGER NOT NULL, scheduled_for TEXT NOT NULL, title_snapshot TEXT NOT NULL, instructions_snapshot TEXT, priority TEXT NOT NULL, assigned_employee_id INTEGER, assigned_team_id INTEGER, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed','skipped')), due_at TEXT NOT NULL, generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, claimed_by INTEGER, claimed_at TEXT, completed_by INTEGER, completed_at TEXT, completion_notes TEXT, skipped_by INTEGER, skipped_at TEXT, skip_reason TEXT, updated_at TEXT, UNIQUE(schedule_id,scheduled_for), FOREIGN KEY(schedule_id) REFERENCES scheduled_action_schedules(id) ON DELETE CASCADE, FOREIGN KEY(assigned_employee_id) REFERENCES employees(id), FOREIGN KEY(assigned_team_id) REFERENCES teams(id), FOREIGN KEY(claimed_by) REFERENCES employees(id), FOREIGN KEY(completed_by) REFERENCES employees(id), FOREIGN KEY(skipped_by) REFERENCES employees(id))",
 "CREATE INDEX IF NOT EXISTS idx_scheduled_action_instances_employee ON scheduled_action_instances(assigned_employee_id,status,due_at)",
 "CREATE INDEX IF NOT EXISTS idx_scheduled_action_instances_team ON scheduled_action_instances(assigned_team_id,status,due_at)",
 "CREATE INDEX IF NOT EXISTS idx_scheduled_action_instances_schedule ON scheduled_action_instances(schedule_id,scheduled_for)",
 "CREATE TABLE IF NOT EXISTS scheduled_action_history (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id INTEGER NOT NULL, actor_id INTEGER, event_type TEXT NOT NULL, from_status TEXT, to_status TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(instance_id) REFERENCES scheduled_action_instances(id) ON DELETE CASCADE, FOREIGN KEY(actor_id) REFERENCES employees(id))",
 "CREATE INDEX IF NOT EXISTS idx_scheduled_action_history_instance ON scheduled_action_history(instance_id,created_at)",
 "UPDATE app_meta SET value='24' WHERE key='schema_version'"
];

const V25_SCHEMA_STATEMENTS = [
 "CREATE TABLE IF NOT EXISTS closing_keyholders (employee_id INTEGER PRIMARY KEY, is_active INTEGER NOT NULL DEFAULT 1, updated_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT, FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE, FOREIGN KEY(updated_by) REFERENCES employees(id))",
 "CREATE INDEX IF NOT EXISTS idx_closing_keyholders_active ON closing_keyholders(is_active,employee_id)",
 "UPDATE app_meta SET value='25' WHERE key='schema_version'"
];

const V26_SCHEMA_STATEMENTS = [
 "ALTER TABLE scheduled_action_schedules ADD COLUMN removed_at TEXT",
 "ALTER TABLE scheduled_action_schedules ADD COLUMN removed_by INTEGER REFERENCES employees(id)",
 "ALTER TABLE scheduled_action_instances ADD COLUMN removed_at TEXT",
 "ALTER TABLE scheduled_action_instances ADD COLUMN removed_by INTEGER REFERENCES employees(id)",
 "CREATE INDEX IF NOT EXISTS idx_scheduled_action_schedules_owner ON scheduled_action_schedules(created_by,removed_at)",
 "CREATE INDEX IF NOT EXISTS idx_scheduled_action_instances_removed ON scheduled_action_instances(removed_at,status)",
 "UPDATE app_meta SET value='26' WHERE key='schema_version'"
];

const V27_SCHEMA_STATEMENTS = [
 "INSERT OR IGNORE INTO roles (name, description, is_system) VALUES ('TeamLeader','Deputy manager with operational responsibility for assigned teams',1)",
 "INSERT OR IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name='TeamLeader' AND p.code IN ('MANAGE_USERS','MANAGE_TEAMS','MANAGE_EMPLOYEES','MANAGE_ROTA')",
 "UPDATE roles SET description='Manager with operational responsibility for assigned teams' WHERE name='Manager'",
 "UPDATE app_meta SET value='27' WHERE key='schema_version'"
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

  if (version < 1) { await applyStatements(db, INITIAL_SCHEMA_STATEMENTS); version = 1; }
  if (version < 2) { await applyStatements(db, V2_SCHEMA_STATEMENTS); version = 2; }
  if (version < 3) { await applyStatements(db, V3_SCHEMA_STATEMENTS, true); version = 3; }
  if (version < 4) { await applyStatements(db, V4_SCHEMA_STATEMENTS); version = 4; }
  if (version < 5) { await applyStatements(db, V5_SCHEMA_STATEMENTS); version = 5; }
  if (version < 6) { await applyStatements(db, V6_SCHEMA_STATEMENTS); version = 6; }
  if (version < 7) { await applyStatements(db, V7_SCHEMA_STATEMENTS); version = 7; }
  if (version < 8) { await applyStatements(db, V8_SCHEMA_STATEMENTS); version = 8; }
  if (version < 9) { await applyStatements(db, V9_SCHEMA_STATEMENTS); version = 9; }
  if (version < 10) { await applyStatements(db, V10_SCHEMA_STATEMENTS, true); version = 10; }
  if (version < 11) { await applyStatements(db, V11_SCHEMA_STATEMENTS, true); version = 11; }
  if (version < 12) { await applyStatements(db, V12_SCHEMA_STATEMENTS); version = 12; }
  if (version < 13) { await applyStatements(db, V13_SCHEMA_STATEMENTS, true); version = 13; }
  if (version < 14) { await applyStatements(db, V14_SCHEMA_STATEMENTS); version = 14; }
  if (version < 15) { await applyStatements(db, V15_SCHEMA_STATEMENTS); version = 15; }
  if (version < 16) { await applyStatements(db, V16_SCHEMA_STATEMENTS); version = 16; }
  if (version < 17) { await applyStatements(db, V17_SCHEMA_STATEMENTS); version = 17; }
  if (version < 18) { await applyStatements(db, V18_SCHEMA_STATEMENTS); version = 18; }
  if (version < 19) { await applyStatements(db, V19_SCHEMA_STATEMENTS, true); version = 19; }
  if (version < 20) { await applyStatements(db, V20_SCHEMA_STATEMENTS); version = 20; }
  if (version < 21) { await applyStatements(db, V21_SCHEMA_STATEMENTS, true); version = 21; }
  if (version < 22) { await applyStatements(db, V22_SCHEMA_STATEMENTS); version = 22; }
  if (version < 23) { await applyStatements(db, V23_SCHEMA_STATEMENTS); version = 23; }
  if (version < 24) { await applyStatements(db, V24_SCHEMA_STATEMENTS); version = 24; }
  if (version < 25) { await applyStatements(db, V25_SCHEMA_STATEMENTS); version = 25; }
  if (version < 26) { await applyStatements(db, V26_SCHEMA_STATEMENTS, true); version = 26; }
  if (version < 27) { await applyStatements(db, V27_SCHEMA_STATEMENTS); version = 27; }
}
