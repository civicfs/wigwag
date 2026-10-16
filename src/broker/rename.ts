import { type Db, nowIso, tx } from '../store/db.js';
import { scopeOf } from '../store/links.js';
import { getSession, listSessions, type NameSource } from '../store/sessions.js';
import { publicSession } from './registry.js';
import type { Broker } from './server.js';

export type RenameCause = 'register' | 'native' | 'launch' | 'recovery';

const hasHistory = (db: Db, name: string): boolean =>
  !!db
    .prepare(
      'SELECT 1 FROM messages WHERE from_name = ? OR to_target = ? UNION ALL SELECT 1 FROM deliveries WHERE recipient = ? LIMIT 1',
    )
    .get(name, name, name);

/** The renamed slot's active rows replace identical active rows the new name already had, then move. */
function moveActive(db: Db, table: 'subscriptions' | 'mutes', from: string, to: string, at: string): number {
  db.prepare(
    `UPDATE ${table} SET removed_at = ? WHERE session_name = ? AND removed_at IS NULL
       AND target IN (SELECT target FROM ${table} WHERE session_name = ? AND removed_at IS NULL)`,
  ).run(at, to, from);
  return Number(
    db.prepare(`UPDATE ${table} SET session_name = ? WHERE session_name = ? AND removed_at IS NULL`).run(to, from)
      .changes,
  );
}

/**
 * W2a: runs after a successful claimName moved slot `sessionId` off `from`. Undelivered mail, active subscriptions and
 * active mutes follow the slot to its new name; the move is audited in session_renames; live sessions in the slot's
 * scope get a low-priority notice (skipped when `from` was an unused provisional name nobody could have addressed);
 * owners get the session. The caller announces the session afterwards so the moved held backlog is swept.
 */
export function afterRename(
  broker: Broker,
  sessionId: string,
  from: string | null,
  fromSource: NameSource,
  cause: RenameCause,
): void {
  const db = broker.db;
  const s = getSession(db, sessionId);
  if (!s?.name || s.name === from) return;
  const to = s.name;
  const mail = from ? (broker.engine?.forward(from, to, s.id) ?? 0) : 0;
  const at = nowIso();
  const moved = tx(db, () => {
    const subs = from ? moveActive(db, 'subscriptions', from, to, at) : 0;
    const mutes = from ? moveActive(db, 'mutes', from, to, at) : 0;
    db.prepare(
      `INSERT INTO session_renames (session_id, from_name, to_name, cause, name_source, mail_moved,
         subscriptions_moved, mutes_moved, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, from, to, cause, s.name_source, mail, subs, mutes, at);
    return { subs, mutes };
  });
  broker.log(
    `rename ${s.id}: ${from ?? '(none)'} -> ${to} (${cause}); moved ${mail} message(s), ${moved.subs} subscription(s), ${moved.mutes} mute(s)`,
  );
  broker.broadcastOwner('session', publicSession(db, s));
  if (!from || (fromSource === 'provisional' && !hasHistory(db, from))) return;
  const scope = scopeOf(db, s.workspace);
  for (const peer of listSessions(db)) {
    if (peer.id === s.id || peer.state === 'offline' || !peer.name || !scope.has(peer.workspace)) continue;
    broker.engine
      ?.notice(
        peer.name,
        `session renamed: ${from} → ${to}`,
        `Session ${s.id} (${s.agent}) is now "${to}" (was "${from}"; ${cause}). Undelivered messages to "${from}" now go to "${to}". Address new messages to "${to}".`,
        { from_workspace: s.workspace },
      )
      .catch((e) => broker.log(`rename notice failed: ${(e as Error).message}`));
  }
}
