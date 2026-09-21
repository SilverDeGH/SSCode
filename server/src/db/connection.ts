import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, MIGRATIONS } from './schema.ts';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function migrate(db: DatabaseSync): void {
  const hasMeta =
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv_meta'")
      .get() !== undefined;
  let current = 0;
  if (hasMeta) {
    const row = db
      .prepare("SELECT value FROM kv_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    current = row ? Number(row.value) : 0;
  }
  for (let version = current + 1; version <= SCHEMA_VERSION; version++) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) {
      throw new Error(`missing migration for schema version ${version}`);
    }
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare(
        "INSERT INTO kv_meta (key, value) VALUES ('schema_version', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
