import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1, SCHEMA_V2 } from './schema.js';

export type Db = DatabaseSync;

export const nowIso = () => new Date().toISOString();

export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Fixed internal lock waits (single-writer broker); not deployment tunables.
const BUSY_TIMEOUT_MS = 5000;
const BUSY_RETRY_MAX_SLEEP_MS = 50;
const SQLITE_BUSY = 5;

const isBusy = (e: unknown): boolean => ((e as { errcode?: number }).errcode ?? 0) % 256 === SQLITE_BUSY;

/**
 * Retries `fn` while SQLite reports SQLITE_BUSY, for statements where SQLite returns BUSY without
 * consulting the busy handler (switching a fresh file to WAL while other processes do the same).
 * The whole retry loop stays inside one BUSY_TIMEOUT_MS window: each attempt's busy_timeout is the
 * time remaining in that window, and the deadline is checked before every retry. The connection's
 * busy_timeout is restored to BUSY_TIMEOUT_MS afterwards.
 */
function retryBusy<T>(db: Db, fn: () => T): T {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  try {
    for (let sleepMs = 1; ; sleepMs = Math.min(sleepMs * 2, BUSY_RETRY_MAX_SLEEP_MS)) {
      const remaining = deadline - Date.now();
      db.exec(`PRAGMA busy_timeout = ${Math.max(0, remaining)};`);
      try {
        return fn();
      } catch (e) {
        if (!isBusy(e)) throw e;
        const left = deadline - Date.now();
        if (left <= 0) throw e;
        Atomics.wait(pause, 0, 0, Math.min(sleepMs, left));
        if (Date.now() >= deadline) throw e;
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  }
}

const schemaVersion = (db: Db): number =>
  (db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  // Set first: several processes may open a fresh file at once (concurrent autospawn).
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  retryBusy(db, () => db.exec('PRAGMA journal_mode = WAL;'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  if (schemaVersion(db) < 1) {
    tx(db, () => {
      // Re-read under the write lock: another process may have migrated since the check above.
      if (schemaVersion(db) >= 1) return;
      db.exec(SCHEMA_V1);
      db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    });
  }
  if (schemaVersion(db) < 2) {
    tx(db, () => {
      if (schemaVersion(db) >= 2) return;
      db.exec(SCHEMA_V2);
      db.prepare('INSERT INTO schema_version (version) VALUES (2)').run();
    });
  }
  return db;
}
