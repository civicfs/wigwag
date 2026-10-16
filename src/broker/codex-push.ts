import { trustedCodexHost } from '../protocol/codex-hook.js';
import { isLegacySession } from '../store/compatibility.js';
import type { HoldReason } from '../store/messages.js';
import type { CodexPushReason, SessionRow } from '../store/sessions.js';
import { getSession } from '../store/sessions.js';
import type { Broker } from './server.js';

export type CodexPushBlockReason = CodexPushReason | 'mcp-disconnected' | 'offline';
export const codexPushBlock = (
  s: Pick<SessionRow, 'state' | 'link' | 'codex_push_reason'> & Partial<Pick<SessionRow, 'bind_origin'>>,
): CodexPushBlockReason | null =>
  s.state === 'offline'
    ? 'offline'
    : s.link === 'disconnected'
      ? 'mcp-disconnected'
      : s.bind_origin === 'unverified'
        ? 'unverified-bind'
        : s.codex_push_reason;
export const codexPushHold = (reason: string): HoldReason =>
  reason === 'mcp-disconnected' ? 'disconnected' : reason === 'offline' ? 'offline' : 'codex-untrusted';
export const codexPushLabel = (reason: string): string =>
  reason === 'mcp-disconnected'
    ? 'Codex push held: MCP disconnected'
    : reason === 'offline'
      ? 'Codex push held: session offline'
      : reason === 'unverified-bind'
        ? 'Codex push held: reload the Wigwag plugin / restart this Codex session to enable push; inbox delivery works (unverified-bind)'
        : `Codex push held: thread identity unverified (${reason})`;

/** Revalidate slot ownership after metadata I/O; never apply evidence to a different binding or a closed DB. */
export function installCodexPushTrust(broker: Broker, now: () => number = Date.now): void {
  let stopped = false;
  broker.onStop.push(() => {
    stopped = true;
  });
  broker.checkCodexPush = async (s, fresh = false, announce = true, proof) => {
    if (stopped) return 'app-server-unavailable';
    const matches = (current: SessionRow | undefined): current is SessionRow =>
      !!current &&
      !current.retired_at &&
      current.agent_session_id === s.agent_session_id &&
      current.conn_generation === s.conn_generation;
    const before = getSession(broker.db, s.id);
    if (!matches(before)) return 'app-server-unavailable';
    const isVerified = (slot: SessionRow) =>
      !isLegacySession(broker.db, slot.id) &&
      slot.bind_origin === 'hook-verified' &&
      trustedCodexHost(
        slot.host_client_name && slot.host_client_version
          ? { name: slot.host_client_name, version: slot.host_client_version }
          : null,
        broker.config.codex.trusted_host_versions,
      );
    const verified = isVerified(before);
    const duplicated = () =>
      !!(
        s.agent_session_id &&
        broker.db
          .prepare(`SELECT 1 FROM sessions
      WHERE agent='codex' AND agent_session_id=? AND id<>? AND retired_at IS NULL AND state<>'offline' LIMIT 1`)
          .get(s.agent_session_id, s.id)
      );
    const age = proof ? now() - proof.checkedAt : Infinity;
    const reuse =
      !!proof &&
      age >= 0 &&
      age < 1000 &&
      proof.sessionId === s.id &&
      proof.nativeId === s.agent_session_id &&
      proof.generation === s.conn_generation &&
      before.codex_push_reason === null &&
      verified;
    const trust = !verified
      ? { trusted: false, reason: 'unverified-bind' as const }
      : duplicated()
        ? { trusted: false, reason: 'shared-root' as const }
        : reuse
          ? { trusted: true, reason: null }
          : s.agent_session_id
            ? await broker.codexNames?.pushTrust(s.agent_session_id, fresh)
            : undefined;
    if (stopped) return 'app-server-unavailable';
    const current = getSession(broker.db, s.id);
    if (!matches(current)) return 'app-server-unavailable';
    const stillVerified = isVerified(current);
    const reason = !stillVerified
      ? 'unverified-bind'
      : duplicated()
        ? 'shared-root'
        : (trust?.reason ?? (trust?.trusted ? null : 'app-server-unavailable'));
    broker.db
      .prepare(
        "UPDATE sessions SET codex_push_reason=?,bind_origin=CASE WHEN ? THEN bind_origin ELSE 'unverified' END WHERE id=?",
      )
      .run(reason, stillVerified ? 1 : 0, s.id);
    if (announce && current.codex_push_reason !== reason) {
      // Announce through the usual path so restored trust can release held deliveries.
      broker.announce(s.id);
    }
    return codexPushBlock({ ...current, codex_push_reason: reason });
  };
}
