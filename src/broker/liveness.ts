import { checkIdentities, type ProcessProbe, sameProcess } from '../proc/identity.js';
import { nowIso, tx } from '../store/db.js';
import { listSessions, type SessionRow, setState } from '../store/sessions.js';
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
  const rows = listSessions(db).filter((s) => s.state !== 'offline');
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
