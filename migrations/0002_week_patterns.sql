CREATE TABLE IF NOT EXISTS week_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS week_pattern_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_pattern_id INTEGER NOT NULL,
    shift_type_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL,
    UNIQUE (week_pattern_id, day_of_week),
    FOREIGN KEY (week_pattern_id) REFERENCES week_patterns(id) ON DELETE CASCADE,
    FOREIGN KEY (shift_type_id) REFERENCES shift_types(id)
);

CREATE TABLE IF NOT EXISTS rota_pattern_weeks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rota_pattern_id INTEGER NOT NULL,
    week_number INTEGER NOT NULL,
    week_pattern_id INTEGER NOT NULL,
    UNIQUE (rota_pattern_id, week_number),
    FOREIGN KEY (rota_pattern_id) REFERENCES rota_patterns(id) ON DELETE CASCADE,
    FOREIGN KEY (week_pattern_id) REFERENCES week_patterns(id)
);

CREATE INDEX IF NOT EXISTS idx_week_pattern_days_pattern ON week_pattern_days(week_pattern_id);
CREATE INDEX IF NOT EXISTS idx_rota_pattern_weeks_pattern ON rota_pattern_weeks(rota_pattern_id);

-- Migrate existing one-week rota patterns into reusable week patterns.
INSERT OR IGNORE INTO week_patterns (name, description, is_active, created_at)
SELECT name, description, is_active, created_at FROM rota_patterns;

INSERT OR IGNORE INTO week_pattern_days (week_pattern_id, shift_type_id, day_of_week)
SELECT wp.id, rpd.shift_type_id, rpd.day_of_week
FROM rota_pattern_days rpd
JOIN rota_patterns rp ON rp.id = rpd.rota_pattern_id
JOIN week_patterns wp ON wp.name = rp.name
WHERE rpd.week_number = 1;

INSERT OR IGNORE INTO rota_pattern_weeks (rota_pattern_id, week_number, week_pattern_id)
SELECT rp.id, 1, wp.id
FROM rota_patterns rp
JOIN week_patterns wp ON wp.name = rp.name;

UPDATE app_meta SET value = '2' WHERE key = 'schema_version';
