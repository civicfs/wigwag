import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Separate from broker.mutex: released by SQLite/the kernel on process death. */
export function lockUpdate(home: string): () => void {
  return lock(
    home,
    'update.mutex',
    'Wigwag update already running for this home; wait for it to finish, then retry wigwag update --apply',
  );
}

/** Held by the detached worker, independently of the updater's lifetime. */
export function lockUpdateOperation(home: string): () => void {
  return lock(
    home,
    'update-operation.mutex',
    'Wigwag update operation still running; wait for it to finish, then retry wigwag update --apply',
  );
}

function lock(home: string, name: string, busy: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, name);
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const stat = lstatSync(file + suffix);
      if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()) throw new Error('Unsafe update mutex file');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  // O_EXCL never opens an existing mutex. Do not open/close an existing mutex
  // through fs: closing any descriptor could release this process's POSIX lock.
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const mutex = new DatabaseSync(file);
  try {
    mutex.exec('BEGIN EXCLUSIVE');
    chmodSync(file, 0o600);
  } catch (e) {
    mutex.close();
    if ((e as { errcode?: number }).errcode === 5) throw new Error(busy);
    throw e;
  }
  return () => mutex.close();
}
