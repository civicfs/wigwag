import { chmodSync, linkSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from './schema.js';

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

/** The clear-text copy of a database taken just before the schema v3 migration; kept after success. */
export const preV3BackupPath = (file: string): string => `${file}.pre-v3.bak`;

const removeQuietly = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // e.g. a directory in the way; the caller already reports the failure
  }
};

/**
 * A consistent snapshot (VACUUM INTO reads committed WAL content, no checkpoint needed) at a per-process temporary
 * path, mode 0600. VACUUM cannot run inside a transaction, so the snapshot precedes the write lock; openDb publishes it
 * under the lock only if the migration is still needed.
 */
function snapshotBeforeV3(db: Db, file: string): string {
  const tmp = `${file}.pre-v3.${process.pid}.tmp`;
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    chmodSync(tmp, 0o600);
    return tmp;
  } catch (e) {
    removeQuietly(tmp);
    throw new Error(
      `wigwag: could not back up ${file} before the schema v3 migration (${(e as Error).message}); not migrating. Free space or fix permissions in that directory, then start wigwag again.`,
    );
  }
}

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  // Set first: several processes may open a fresh file at once (concurrent autospawn).
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  retryBusy(db, () => db.exec('PRAGMA journal_mode = WAL;'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  // A database that already held data (v1/v2) is backed up before v3; a fresh file has nothing to lose.
  const initialVersion = schemaVersion(db);
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
  if (schemaVersion(db) < 3) {
    const snapshot = initialVersion >= 1 ? snapshotBeforeV3(db, file) : null;
    try {
      tx(db, () => {
        // Re-read under the write lock: another process may have migrated (and backed up) meanwhile.
        if (schemaVersion(db) >= 3) return;
        if (snapshot) {
          const bak = preV3BackupPath(file);
          try {
            linkSync(snapshot, bak); // never overwrites: an existing backup refuses the migration
          } catch (e) {
            throw new Error(
              (e as NodeJS.ErrnoException).code === 'EEXIST'
                ? `wigwag: ${bak} already exists (left by an earlier migration attempt); not migrating. Check it, move or delete it, then start wigwag again.`
                : `wigwag: could not back up ${file} before the schema v3 migration (${(e as Error).message}); not migrating.`,
            );
          }
        }
        db.exec(SCHEMA_V3);
        db.prepare('INSERT INTO schema_version (version) VALUES (3)').run();
      });
    } finally {
      if (snapshot) removeQuietly(snapshot);
    }
  }
  return db;
}
