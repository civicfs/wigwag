import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startBroker } from '../../broker/assemble.js';
import { canConnect, ensureBroker, sockPath } from '../../client/autospawn.js';
import { readBrokerStatus } from '../../client/broker-status.js';
import type { Client } from '../../client/client.js';
import { connectOwner } from '../../client/owner.js';
import { loadConfig, resolveHome } from '../../config.js';
import { WigwagError } from '../../errors.js';
import { frameLimit } from '../../protocol/frame.js';
import { assertRehearsalClientPaths } from '../../rehearsal.js';
import { usageError } from '../help.js';
import { cliEntry, out, ownerConnect, parseCli } from '../util.js';

/** The pid reported by a broker answering on this home's socket, or null when none answers (never autospawns). */
export async function liveStatus(home: string): Promise<{ pid: number; version?: string } | null> {
  const config = loadConfig(home);
  const mode = assertRehearsalClientPaths(home, config);
  if (!(await canConnect(sockPath(home)))) return null;
  const signal = AbortSignal.timeout(config.broker.start_timeout_ms);
  let client: Client | undefined;
  try {
    ({ client } = await connectOwner(home, config, undefined, signal));
    const ping = client.call<{ pid: number; version?: string }>('sys.ping');
    const timedOut = new Promise<never>((_, rej) =>
      signal.addEventListener('abort', () => rej(new Error('sys.ping timed out')), { once: true }),
    );
    return await Promise.race([ping, timedOut]);
  } catch (e) {
    if (mode.enabled) throw e; // No legacy/status fallback may bypass rehearsal verification.
    if (e instanceof WigwagError && (e.data as { kind?: string })?.kind === 'version-skew') {
      try {
        return await readBrokerStatus(
          sockPath(home),
          frameLimit(config),
          signal,
          (e.data as { peer?: string })?.peer === 'client' ? (e.data as { expected?: unknown }).expected : undefined,
        );
      } catch {}
    }
    return null;
  } finally {
    client?.close();
  }
}

const livePid = async (home: string) => (await liveStatus(home))?.pid ?? null;

/** SIGTERM a verified broker pid. ESRCH (it exited meanwhile) is fine; any other error (EPERM) is a failure. */
export function signalBroker(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = (p, s) => process.kill(p, s),
): { out?: string; err?: string; code: number } {
  try {
    kill(pid, 'SIGTERM');
    return {
      out: `sent SIGTERM to broker pid ${pid}\nnote: live MCP servers start it again on their next reconnect, so with live sessions this is a restart`,
      code: 0,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      return { out: `broker pid ${pid} not running (stale lock; the next start clears it)`, code: 0 };
    }
    return { err: `cannot signal broker pid ${pid}: ${(e as Error).message}`, code: 1 };
  }
}

export async function cmdBroker(sub: string | undefined, args: string[] = []): Promise<void> {
  const home = resolveHome();
  if (sub === 'run') {
    try {
      const broker = await startBroker(home);
      const stop = () =>
        void broker.stop().then(
          () => process.exit(0),
          (e: unknown) => {
            process.stderr.write(`wigwag: broker stop failed: ${e instanceof Error ? e.message : String(e)}\n`);
            process.exit(1);
          },
        );
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    } catch (e) {
      if (e instanceof WigwagError && e.code === 'already_running') {
        // Exit 0: ensureBroker reads this as "lost a concurrent start" and keeps waiting for the winner.
        // Autospawn points stderr at broker.log, where one line per losing probe only fills the log; the message is
        // for a person who ran `wigwag broker run` in a terminal.
        if (process.stderr.isTTY) process.stderr.write(`${e.message}\n`);
        return;
      }
      throw e;
    }
    return;
  }
  if (sub === 'restart') {
    const { values } = parseCli({ args, options: { 'expect-version': { type: 'string' } } });
    const old = await liveStatus(home);
    if (old) {
      const signalled = signalBroker(old.pid);
      if (signalled.code) throw new Error(signalled.err);
      const until = Date.now() + loadConfig(home).broker.start_timeout_ms;
      while ((await liveStatus(home))?.pid === old.pid) {
        if (Date.now() >= until) throw new Error('Broker shutdown timed out; restart was not confirmed');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await ensureBroker(home, loadConfig(home), cliEntry());
    const current = await liveStatus(home);
    if (
      !current ||
      current.pid === old?.pid ||
      (values['expect-version'] && current.version !== values['expect-version'])
    )
      throw new Error('Replacement broker version or identity was not confirmed');
    out(`broker running pid ${current.pid} version ${current.version ?? 'unknown'}`);
    return;
  }
  if (sub === 'start') {
    await ensureBroker(home, loadConfig(home), cliEntry());
    out('broker running');
    return;
  }
  if (sub === 'status') {
    if (!(await canConnect(sockPath(home)))) {
      out('broker not running');
      process.exitCode = 1;
      return;
    }
    const { client } = await ownerConnect();
    try {
      const r = await client.call<{ pid: number; version?: string }>('sys.ping');
      out(`broker running pid ${r.pid}`);
    } finally {
      client.close();
    }
    return;
  }
  if (sub === 'stop') {
    const lock = join(home, 'broker.lock');
    if (!existsSync(lock)) {
      out('broker not running');
      return;
    }
    const raw = readFileSync(lock, 'utf8').trim();
    const pid = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(pid) || pid <= 1) {
      process.stderr.write('lock file malformed; not signalling\n');
      process.exitCode = 1;
      return;
    }
    // Final review I-2: broker.lock outlives a crashed broker and its pid may now belong to an unrelated process.
    // Signal only a broker that answers on the socket with the same pid.
    const live = await livePid(home);
    if (live === null) {
      out(`broker not running (stale lock pid ${pid}; not signalling, the next start clears it)`);
      return;
    }
    if (live !== pid) {
      process.stderr.write(
        `broker answering on the socket is pid ${live} but broker.lock says ${pid}; not signalling\n`,
      );
      process.exitCode = 1;
      return;
    }
    const r = signalBroker(pid);
    if (r.out) out(r.out);
    if (r.err) process.stderr.write(`${r.err}\n`);
    if (r.code) process.exitCode = r.code;
    return;
  }
  throw usageError('broker');
}
