-- SupportApp schema v3: unify employee and portal-user identity.
ALTER TABLE employees ADD COLUMN username TEXT;
ALTER TABLE employees ADD COLUMN email TEXT;
ALTER TABLE employees ADD COLUMN external_identity TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_username ON employees(username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email ON employees(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_external_identity ON employees(external_identity) WHERE external_identity IS NOT NULL;

CREATE TABLE IF NOT EXISTS employee_roles (
    employee_id INTEGER NOT NULL,
    role_id INTEGER NOT NULL,
    PRIMARY KEY (employee_id, role_id),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

UPDATE employees
SET username = (SELECT u.username FROM users u WHERE u.id = employees.user_id),
    email = (SELECT u.email FROM users u WHERE u.id = employees.user_id),
    external_identity = (SELECT u.external_identity FROM users u WHERE u.id = employees.user_id)
WHERE user_id IS NOT NULL;

INSERT OR IGNORE INTO employee_roles (employee_id, role_id)
SELECT e.id, ur.role_id
FROM employees e
JOIN user_roles ur ON ur.user_id = e.user_id
WHERE e.user_id IS NOT NULL;

UPDATE app_meta SET value = '3' WHERE key = 'schema_version';
