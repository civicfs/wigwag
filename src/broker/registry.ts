import type { Db } from '../store/db.js';
import { scopeOf } from '../store/links.js';
import { type Agent, getSession, liveHolder, type SessionRow } from '../store/sessions.js';
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
  orchestration?: { assignment_id: string; orchestrator_session_id: string; orchestrator_name: string | null };
  role?: 'peer' | 'worker' | 'orchestrator' | 'orchestrator-worker';
  workers?: Array<{ assignment_id: string; session_id: string; name: string | null; state: SessionRow['state'] }>;
  terminal_title?: string;
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
  ...orchestration(db, s),
});

function orchestration(
  db: Db,
  s: SessionRow,
): Pick<PublicSession, 'orchestration' | 'role' | 'workers' | 'terminal_title'> {
  const rows = db
    .prepare('SELECT * FROM assignments WHERE ended_at IS NULL AND (worker_session_id=? OR orchestrator_session_id=?)')
    .all(s.id, s.id) as unknown as Array<{
    id: string;
    worker_session_id: string;
    worker_native_id: string;
    orchestrator_session_id: string;
    orchestrator_native_id: string;
  }>;
  const scope = scopeOf(db, s.workspace);
  const valid = rows.flatMap((a) => {
    const worker = getSession(db, a.worker_session_id),
      lead = getSession(db, a.orchestrator_session_id);
    return worker?.name &&
      lead?.name &&
      worker.agent_session_id === a.worker_native_id &&
      lead.agent_session_id === a.orchestrator_native_id &&
      scope.has(worker.workspace) &&
      scope.has(lead.workspace)
      ? [{ a, worker, lead }]
      : [];
  });
  const supervisor = valid.find((x) => x.a.worker_session_id === s.id);
  const workers = valid
    .filter((x) => x.a.orchestrator_session_id === s.id)
    .map((x) => ({ assignment_id: x.a.id, session_id: x.worker.id, name: x.worker.name, state: x.worker.state }));
  const role = supervisor
    ? workers.length
      ? 'orchestrator-worker'
      : 'worker'
    : workers.length
      ? 'orchestrator'
      : 'peer';
  const label = supervisor
    ? `${workers.length ? 'lead + worker' : 'worker'} ← ${supervisor.lead.name}`
    : workers.length
      ? 'lead'
      : 'peer';
  return {
    ...(supervisor
      ? {
          orchestration: {
            assignment_id: supervisor.a.id,
            orchestrator_session_id: supervisor.lead.id,
            orchestrator_name: supervisor.lead.name,
          },
        }
      : {}),
    role,
    workers,
    terminal_title: `[${label}] ${s.name ?? s.id}`,
  };
}

/** A named session that a push can reach: Claude needs only its connection; Codex needs a bound thread. */
export const isReachable = (s: SessionRow): boolean =>
  s.state !== 'offline' && s.name !== null && (s.agent === 'claude' || s.agent_session_id !== null);
