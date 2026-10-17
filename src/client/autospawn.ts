import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from '../config.js';
import { WigwagError } from '../errors.js';
import { assertRehearsalClientPaths, assertRehearsalStoragePaths } from '../rehearsal.js';
import { connectOwner } from './owner.js';

/** Poll granularity while waiting for a freshly spawned broker; not a tunable. */
const POLL_MS = 50;

export const sockPath = (home: string): string => join(home, 'broker.sock');

const cancelled = () => new WigwagError('transport', 'Waiting for the wigwag broker was cancelled');

/**
 * Probes the socket. A pre-aborted `signal` rejects with `transport` without opening a socket; an abort
 * mid-probe destroys the probe socket and rejects with `transport`. Listeners are removed once settled.
 */
export function canConnect(path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((res, rej) => {
    const s = createConnection(path);
    const settle = (fn: () => void) => {
      signal?.removeEventListener('abort', onAbort);
      s.removeAllListeners('connect');
      s.removeAllListeners('error');
      s.on('error', () => {}); // a late error on the discarded probe must not go unhandled
      s.destroy();
      fn();
    };
    const onAbort = () => settle(() => rej(cancelled()));
    signal?.addEventListener('abort', onAbort, { once: true });
    s.once('connect', () => settle(() => res(true)));
    s.once('error', () => settle(() => res(false)));
  });
}

/**
 * Starts a broker for `home` unless one is reachable, and waits until it accepts connections.
 * `entry` is the wigwag CLI script (process.argv[1] in production, dist/main.js in tests).
 *
 * Concurrent callers may each spawn a process; the broker lock lets exactly one run, and the others exit
 * 0 ("already running") while every caller waits for the winner's socket. A spawn error or a child that
 * exits non-zero before the socket is reachable rejects at once with `transport`. Aborting `signal`
 * rejects with `transport`: a pre-aborted signal or an abort during the initial probe spawns nothing;
 * an abort after the spawn stops the wait (the spawned process is left to finish starting).
 */
export async function ensureBroker(home: string, config: Config, entry: string, signal?: AbortSignal): Promise<void> {
  const mode = assertRehearsalClientPaths(home, config);
  const reachable = async () => {
    if (!(await canConnect(sockPath(home), signal))) return false;
    if (mode.enabled) {
      const { client } = await connectOwner(home, config, undefined, signal);
      client.destroy();
    }
    return true;
  };
  if (await reachable()) return;
  if (signal?.aborted) throw cancelled();
  const logPath = join(home, 'logs', 'broker.log');
  assertRehearsalStoragePaths(home, [join(home, 'logs'), logPath]);
  mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
  let failure: WigwagError | null = null;
  let child: ChildProcess;
  const log = openSync(logPath, 'a');
  try {
    child = spawn(process.execPath, [entry, 'broker', 'run'], {
      detached: true,
      // final m-7: not the spawner's cwd, which may be a worktree that is later removed or a mount that goes away
      // (absolute, so a relative WIGWAG_HOME still names the same home from inside it)
      cwd: resolve(home),
      stdio: ['ignore', log, log],
      env: { ...process.env, WIGWAG_HOME: resolve(home) },
    });
  } catch (e) {
    throw new WigwagError('transport', `Could not start the wigwag broker: ${(e as Error).message}; see ${logPath}`);
  } finally {
    closeSync(log); // the child holds its own copy of the descriptor
  }
  child.on('error', (e) => {
    failure ??= new WigwagError('transport', `Could not start the wigwag broker: ${e.message}; see ${logPath}`);
  });
  child.on('exit', (code, sig) => {
    if (code === 0) return; // lost the lock to a concurrent start; keep waiting for that broker
    failure ??= new WigwagError(
      'transport',
      `Broker process exited with ${sig ? `signal ${sig}` : `code ${code}`} before accepting connections; see ${logPath}`,
    );
  });
  child.unref();
  if (child.pid !== undefined) {
    assertRehearsalStoragePaths(home, [logPath]);
    appendFileSync(logPath, `${new Date().toISOString()} spawned broker pid=${child.pid}\n`);
  }

  const deadline = Date.now() + config.broker.start_timeout_ms;
  try {
    while (Date.now() < deadline) {
      if (await reachable()) return;
      if (failure) throw failure;
      await sleep(POLL_MS, undefined, { signal });
    }
  } catch (e) {
    if (signal?.aborted) throw cancelled();
    throw e;
  }
  throw new WigwagError(
    'transport',
    `Broker did not start within ${config.broker.start_timeout_ms} ms; see ${logPath}`,
  );
}
