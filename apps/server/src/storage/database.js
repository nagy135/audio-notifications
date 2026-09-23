import { DatabaseSync } from 'node:sqlite';

const RETENTION_MS = 7 * 86_400_000;

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairing (
      code_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      idempotency_key TEXT UNIQUE,
      payload_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      updated_at INTEGER NOT NULL,
      error TEXT,
      PRIMARY KEY (message_id, device_id)
    );
  `);
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function pruneDatabase(db, now) {
  db.prepare('DELETE FROM pairing WHERE expires_at<=?').run(now());
  // Retain delivery receipts and idempotency keys for seven days after expiry.
  db.prepare('DELETE FROM messages WHERE expires_at<?').run(
    now() - RETENTION_MS,
  );
}
