import type { CodexPushReason } from '../store/sessions.js';
import { getSession } from '../store/sessions.js';
import type { Broker } from './server.js';

export const codexPushLabel = (reason: CodexPushReason): string =>
  `Codex push held: thread identity unverified (${reason})`;

/** Revalidate slot ownership after metadata I/O; never apply evidence to a different binding or a closed DB. */
export function installCodexPushTrust(broker: Broker): void {
  let stopped = false;
  broker.onStop.push(() => {
    stopped = true;
  });
  broker.checkCodexPush = async (s, fresh = false, announce = true) => {
    const trust = s.agent_session_id ? await broker.codexNames?.pushTrust(s.agent_session_id, fresh) : undefined;
    if (stopped) return 'app-server-unavailable';
    const current = getSession(broker.db, s.id);
    if (
      !current ||
      current.retired_at ||
      current.agent_session_id !== s.agent_session_id ||
      current.conn_generation !== s.conn_generation
    )
      return 'app-server-unavailable';
    const reason = trust?.reason ?? (trust?.trusted ? null : 'app-server-unavailable');
    broker.db.prepare('UPDATE sessions SET codex_push_reason=? WHERE id=?').run(reason, s.id);
    if (announce && current.codex_push_reason !== reason) {
      // Announce through the usual path so restored trust can release held deliveries.
      broker.announce(s.id);
    }
    return reason;
  };
}
