import type { Db } from '../store/db.js';
import { type Agent, liveHolder, type SessionRow } from '../store/sessions.js';
import { workspaceLabel } from '../workspace.js';
import { visibleUnreadCount } from './scope.js';

/** `no-channel`: a live Claude session whose MCP client cannot take channel pushes (E-3). */
export type RecipientState = 'offline' | 'unbound' | 'no-channel' | 'idle' | 'busy';

export function recipientState(
  db: Db,
  name: string,
  hasChannel: (s: SessionRow) => boolean = () => true,
): { state: RecipientState; session?: SessionRow } {
  const s = liveHolder(db, name);
  if (!s) return { state: 'offline' };
  if (s.agent === 'codex' && !s.agent_session_id) return { state: 'unbound', session: s };
  if (s.agent === 'claude' && !hasChannel(s)) return { state: 'no-channel', session: s };
  return { state: s.state === 'online-busy' ? 'busy' : 'idle', session: s };
}

export interface PublicSession {
  id: string;
  name: string | null;
  agent: Agent;
  state: SessionRow['state'];
  cwd: string;
  workspace: string;
  workspace_label: string;
  bound: boolean;
  unread: number;
  last_seen_at: string;
}

export const publicSession = (db: Db, s: SessionRow): PublicSession => ({
  id: s.id,
  name: s.name,
  agent: s.agent,
  state: s.state,
  cwd: s.cwd,
  workspace: s.workspace,
  workspace_label: workspaceLabel(s.workspace),
  bound: s.agent_session_id !== null,
  unread: s.name ? visibleUnreadCount(db, s.name) : 0,
  last_seen_at: s.last_seen_at,
});

/** A named session that a push can reach: Claude needs only its connection; Codex needs a bound thread. */
export const isReachable = (s: SessionRow): boolean =>
  s.state !== 'offline' && s.name !== null && (s.agent === 'claude' || s.agent_session_id !== null);
