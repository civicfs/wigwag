import type { SessionRow } from '../store/sessions.js';
import type { Broker } from './server.js';

/** Owner ruling 2026-10-15: no parity; say plainly what this session gets. */
export interface SessionCapabilities {
  native_names: 'claude-hook-sidecar' | 'codex-app-server' | 'codex-session-index';
  resume_recovery: 'native-id' | 'verified-root-only' | 'unavailable';
  delivery: 'push' | 'hook-boundary' | 'codex-queue';
  /** W8: how an MCP disconnect is told apart from the parent closing. */
  parent_liveness: 'process-identity' | 'thread-loaded' | 'unavailable';
}

export function capabilitiesFor(broker: Broker, s: SessionRow): SessionCapabilities {
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
    resume_recovery: app ? 'verified-root-only' : 'unavailable',
    delivery: 'codex-queue',
    parent_liveness: app && s.agent_session_id ? 'thread-loaded' : 'unavailable',
  };
}
