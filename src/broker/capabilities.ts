import { codexHostWarning } from '../protocol/codex-hook.js';
import { isLegacySession } from '../store/compatibility.js';
import type { SessionRow } from '../store/sessions.js';
import { type CodexPushBlockReason, codexPushBlock } from './codex-push.js';
import type { Broker } from './server.js';

/** Owner ruling 2026-10-15: no parity; say plainly what this session gets. */
export interface SessionCapabilities {
  native_names: 'claude-hook-sidecar' | 'codex-app-server' | 'codex-session-index';
  resume_recovery: 'native-id' | 'verified-root-only' | 'unavailable';
  resume_recovery_reason?: string;
  delivery: 'push' | 'hook-boundary' | 'codex-queue';
  codex_push?: 'trusted' | 'held';
  codex_push_reason?: CodexPushBlockReason | null;
  codex_host_warning?: string | null;
  /** W8: how an MCP disconnect is told apart from the parent closing. */
  parent_liveness: 'process-identity' | 'thread-loaded' | 'unavailable';
}

export function capabilitiesFor(broker: Broker, s: SessionRow): SessionCapabilities {
  if (isLegacySession(broker.db, s.id))
    return {
      native_names: s.agent === 'claude' ? 'claude-hook-sidecar' : 'codex-session-index',
      resume_recovery: 'unavailable',
      resume_recovery_reason: 'legacy-client',
      delivery:
        s.agent === 'codex' || s.link === 'disconnected' || broker.connectionFor(s.id)?.channel === false
          ? 'hook-boundary'
          : 'push',
      ...(s.agent === 'codex'
        ? {
            codex_push: 'held' as const,
            codex_push_reason: 'unverified-bind' as const,
            codex_host_warning: codexHostWarning(s),
          }
        : {}),
      parent_liveness: 'unavailable',
    };
  if (s.agent === 'claude')
    return {
      native_names: 'claude-hook-sidecar',
      resume_recovery: 'native-id',
      delivery: s.link === 'disconnected' || broker.connectionFor(s.id)?.channel === false ? 'hook-boundary' : 'push',
      parent_liveness: s.agent_start ? 'process-identity' : 'unavailable',
    };
  const app = broker.codexNames?.available === true;
  return {
    native_names: app ? 'codex-app-server' : 'codex-session-index',
    resume_recovery:
      app && broker.trustedThreadId(s) === s.agent_session_id && s.agent_session_id !== null
        ? 'verified-root-only'
        : 'unavailable',
    ...(broker.trustedThreadId(s) === null ? { resume_recovery_reason: 'codex-thread-id-untrusted' } : {}),
    delivery: codexPushBlock(s) ? 'hook-boundary' : 'codex-queue',
    codex_push: codexPushBlock(s) ? 'held' : 'trusted',
    codex_push_reason: codexPushBlock(s),
    codex_host_warning: codexHostWarning(s),
    parent_liveness: app && s.agent_session_id ? 'thread-loaded' : 'unavailable',
  };
}
