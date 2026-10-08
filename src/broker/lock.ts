import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WigwagError } from '../errors.js';

const SQLITE_BUSY = 5;

/**
 * The single-broker lock for one home.
 *
 * Mutual exclusion is a kernel lock, not a pid file: a dedicated SQLite file (`broker.mutex`) is held
 * in an open `BEGIN EXCLUSIVE` transaction for the broker's lifetime. SQLite takes a POSIX advisory
 * lock on the file and, inside one process, arbitrates between its own connections, so exactly one
 * holder exists across all processes and Broker instances. The kernel drops the lock when the holder
 * dies, so there is no stale lock to detect or break, and a reused pid can never block a start.
 *
 * `broker.lock` holds the holder's pid for humans and tools. Only the mutex holder writes or removes it.
 *
 * Never open, read or close `broker.mutex` through `fs` in a broker process: closing any descriptor of
 * that file releases every POSIX lock the process holds on it.
 */
export class BrokerLock {
  private constructor(
    private mutex: DatabaseSync | null,
    private readonly pidFile: string,
  ) {}

  static acquire(home: string): BrokerLock {
    const mutexPath = join(home, 'broker.mutex');
    const pidFile = join(home, 'broker.lock');
    const mutex = new DatabaseSync(mutexPath); // busy timeout 0: a held lock fails at once
    try {
      mutex.exec('BEGIN EXCLUSIVE');
    } catch (e) {
      mutex.close();
      if ((e as { errcode?: number }).errcode === SQLITE_BUSY) {
        throw new WigwagError('already_running', `Broker already running (pid ${readPid(pidFile) ?? 'unknown'})`);
      }
      throw e;
    }
    try {
      chmodSync(mutexPath, 0o600);
      const tmp = `${pidFile}.${process.pid}.tmp`;
      writeFileSync(tmp, String(process.pid), { mode: 0o600 });
      renameSync(tmp, pidFile); // replaces any pid file left by a dead broker
    } catch (e) {
      mutex.close(); // closing the connection ends the transaction and drops the lock
      throw e;
    }
    return new BrokerLock(mutex, pidFile);
  }

  get held(): boolean {
    return this.mutex !== null;
  }

  /** Idempotent. Removes the pid file while still holding the mutex, so it can only be ours. */
  release(): void {
    if (!this.mutex) return;
    try {
      unlinkSync(this.pidFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    } finally {
      this.mutex.close();
      this.mutex = null;
    }
  }
}

function readPid(pidFile: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
