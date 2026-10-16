import { checkIdentities, type ProcessProbe, sameProcess } from '../proc/identity.js';
import { nowIso, tx } from '../store/db.js';
import {
  getSession,
  listSessions,
  markOfflineIfCurrent,
  type SessionRow,
  setParentState,
  setState,
} from '../store/sessions.js';
import type { Broker } from './server.js';

export type ParentVerdict = 'live' | 'gone' | 'unknown';

/**
 * W8, at MCP disconnect. Claude: the recorded agent process with the same start identity (a pid alone never counts);
 * no recorded identity is no evidence of a parent, so it is today's behavior (gone). Codex: the daemon pid says nothing
 * about one thread, so with a reachable app-server the verdict is unknown until the probe loop reads
 * thread/loaded/list (Task 11); without one there is no evidence (gone).
 */
export function parentOnDisconnect(s: SessionRow, probe: ProcessProbe, codexAvailable: boolean): ParentVerdict {
  if (s.agent === 'claude') {
    if (s.agent_pid === null || !s.agent_start) return 'gone';
    const same = sameProcess({ pid: s.agent_pid, start: s.agent_start }, probe);
    return same === null ? 'unknown' : same ? 'live' : 'gone';
  }
  return codexAvailable && s.agent_session_id ? 'unknown' : 'gone';
}

/**
 * W8, replaces markAllOffline at broker start. No connection exists yet, so every live row becomes link-disconnected.
 * Claude rows with an identity are verified with ONE probe call; gone ones go offline. Rows that cannot be verified
 * now (legacy rows without identity, a failed probe, every Codex row) keep parent_state unknown for the probe loop
 * and its grace period.
 */
export function verifyAtStart(broker: Pick<Broker, 'db' | 'processProbe' | 'log'>): {
  live: number;
  gone: number;
  unknown: number;
} {
  const db = broker.db;
  const rows = listSessions(db).filter((s) => s.state !== 'offline' && !s.retired_at);
  const claude = rows.filter((s) => s.agent === 'claude' && s.agent_pid !== null && s.agent_start);
  const checks = checkIdentities(
    claude.map((s) => ({ pid: s.agent_pid as number, start: s.agent_start as string })),
    broker.processProbe,
  );
  const counts = { live: 0, gone: 0, unknown: 0 };
  tx(db, () => {
    const at = nowIso();
    const keep = db.prepare(
      "UPDATE sessions SET link = 'disconnected', parent_state = ?, parent_checked_at = ? WHERE id = ?",
    );
    for (const s of rows) {
      const i = claude.indexOf(s);
      const v: ParentVerdict = i < 0 || checks === null ? 'unknown' : checks[i] ? 'live' : 'gone';
      counts[v]++;
      if (v === 'gone') setState(db, s.id, 'offline');
      else keep.run(v, at, s.id);
    }
  });
  broker.log(
    `startup liveness: ${counts.live} parent(s) open, ${counts.gone} gone, ${counts.unknown} unverified (grace, then offline)`,
  );
  return counts;
}

/** Fixed internal bounds (W8), in the style of the other fixed constants; tests override them via startBroker. */
export const PARENT_PROBE_MS = 10000;
export const PARENT_UNKNOWN_GRACE_MS = 60000;
export const PARENT_UNKNOWN_GRACE_PROBES = 3;

export interface LivenessOptions {
  intervalMs?: number;
  graceMs?: number;
  graceProbes?: number;
  now?: () => number;
}
export interface Liveness {
  probeNow(): Promise<void>;
  kick(): void;
  stop(): void;
}

/**
 * W8: re-checks link-disconnected live sessions every intervalMs (and on kick). Claude: one process probe for all
 * parents. Codex: one thread/loaded/list on the metadata-only connection. Gone → offline (announced, session.offline);
 * live → parent_state live; unknown → kept until both graceProbes consecutive unknown probes and graceMs have passed,
 * then today's behavior (offline). Each row is revalidated after the await (still disconnected, same generation).
 */
export function installLiveness(broker: Broker, opts: LivenessOptions = {}): Liveness {
  const db = broker.db;
  const intervalMs = opts.intervalMs ?? PARENT_PROBE_MS;
  const graceMs = opts.graceMs ?? PARENT_UNKNOWN_GRACE_MS;
  const graceProbes = opts.graceProbes ?? PARENT_UNKNOWN_GRACE_PROBES;
  const now = opts.now ?? Date.now;
  const unknownSince = new Map<string, { first: number; probes: number; generation: number }>();
  let running: Promise<void> | null = null;
  let stopped = false;
  let queuedKick: NodeJS.Immediate | null = null;

  const connected = (s: SessionRow) => {
    if (s.link === 'connected') unknownSince.delete(s.id);
  };
  broker.bus.on('session.available', connected);

  const offline = (s: SessionRow, why: string) => {
    if (!markOfflineIfCurrent(db, s.id, s.conn_generation)) return;
    unknownSince.delete(s.id);
    broker.log(`liveness: ${s.id} (${s.name ?? 'unnamed'}) offline: ${why}`);
    broker.announce(s.id);
    broker.bus.emit('session.offline', getSession(db, s.id));
  };
  const mark = (s: SessionRow, state: 'live' | 'unknown') => {
    const changed = s.parent_state !== state;
    setParentState(db, s.id, state);
    if (changed) broker.announce(s.id);
  };

  const probeOnce = async () => {
    const sessions = listSessions(db);
    const current = new Map(sessions.map((s) => [s.id, s]));
    for (const [id, grace] of unknownSince) {
      const s = current.get(id);
      if (
        !s ||
        s.state === 'offline' ||
        s.link === 'connected' ||
        s.retired_at ||
        s.conn_generation !== grace.generation
      )
        unknownSince.delete(id);
    }
    const rows = sessions.filter((s) => s.state !== 'offline' && s.link === 'disconnected' && !s.retired_at);
    if (!rows.length) return;
    const withId = rows.filter((s) => s.agent === 'claude' && s.agent_pid !== null && s.agent_start);
    const checks = checkIdentities(
      withId.map((s) => ({ pid: s.agent_pid as number, start: s.agent_start as string })),
      broker.processProbe,
    );
    const loaded = rows.some((s) => s.agent === 'codex') ? ((await broker.codexNames?.loadedThreads()) ?? null) : null;
    if (stopped) return;
    for (const s of rows) {
      const fresh = getSession(db, s.id);
      if (
        !fresh ||
        fresh.state === 'offline' ||
        fresh.link !== 'disconnected' ||
        fresh.conn_generation !== s.conn_generation
      )
        continue;
      let v: ParentVerdict;
      if (s.agent === 'claude') {
        const i = withId.indexOf(s);
        v = i < 0 || checks === null ? 'unknown' : checks[i] ? 'live' : 'gone';
      } else
        v = !s.agent_session_id
          ? 'gone'
          : loaded === null
            ? 'unknown'
            : loaded.has(s.agent_session_id)
              ? 'live'
              : 'gone';
      if (v === 'gone') {
        offline(fresh, s.agent === 'claude' ? 'parent process gone' : 'thread no longer loaded');
        continue;
      }
      if (v === 'live') {
        unknownSince.delete(s.id);
        mark(fresh, 'live');
        continue;
      }
      const u = unknownSince.get(s.id) ?? { first: now(), probes: 0, generation: s.conn_generation };
      u.probes++;
      unknownSince.set(s.id, u);
      if (u.probes >= graceProbes && now() - u.first >= graceMs) {
        offline(fresh, `parent unverifiable for ${u.probes} probes; falling back to offline`);
        continue;
      }
      mark(fresh, 'unknown');
    }
  };

  const probeNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    running ??= probeOnce()
      .catch((e) => broker.log(`liveness probe failed: ${(e as Error).message}`))
      .finally(() => {
        running = null;
      });
    return running;
  };
  const kick = () => {
    if (stopped || queuedKick) return;
    queuedKick = setImmediate(() => {
      queuedKick = null;
      void probeNow();
    });
    queuedKick.unref();
  };
  const timer = setInterval(() => void probeNow(), intervalMs);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (queuedKick) clearImmediate(queuedKick);
    queuedKick = null;
    unknownSince.clear();
    broker.bus.off('session.available', connected);
  };
  broker.onStart.push(kick);
  broker.onStop.push(stop);
  const liveness: Liveness = { probeNow, kick, stop };
  broker.liveness = liveness;
  return liveness;
}
