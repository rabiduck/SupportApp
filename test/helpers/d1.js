import { DatabaseSync } from 'node:sqlite';

export function d1Database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = {
    sqlite,
    prepare(sql) {
      let params = [];
      const statement = () => sqlite.prepare(sql);
      const prepared = {
        bind(...values) { params = values; return prepared; },
        async run() {
          const result = statement().run(...params);
          return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
        },
        async first() { return statement().get(...params) ?? null; },
        async all() { return { success: true, results: statement().all(...params) }; }
      };
      return prepared;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  };
  return db;
}
