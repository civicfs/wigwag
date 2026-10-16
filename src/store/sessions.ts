import { basename } from 'node:path';
import { newId } from '../ids.js';
import { resolveWorkspace } from '../workspace.js';
import { type Db, nowIso, tx } from './db.js';
import { scopeOf } from './links.js';

export type Agent = 'claude' | 'codex';
export type SessionState = 'online-busy' | 'online-idle' | 'offline';
export type NameSource = 'provisional' | 'native' | 'custom';
/** W8: the MCP link; meaningful only while state <> 'offline'. */
export type Link = 'connected' | 'disconnected';
/** W8: the agent process (Claude) or loaded thread (Codex) behind the session. */
export type ParentState = 'live' | 'gone' | 'unknown';

export interface SessionRow {
  id: string;
  name: string | null;
  agent: Agent;
  agent_session_id: string | null;
  cwd: string;
  /** Workspace id (spec §17), computed from `cwd` by the broker. */
  workspace: string;
  pid_chain: number[];
  mcp_ppid: number | null;
  state: SessionState;
  transport: 'claude-channel' | 'codex-queue';
  spawned_by: string | null;
  launch_json: string | null;
  created_at: string;
  last_seen_at: string;
  /** Where `name` came from: a custom name (register, WIGWAG_NAME, launch intent) is never replaced by a native one. */
  name_source: NameSource;
  /** The agent's own display name as last read (raw, trimmed, at most 200 characters). */
  native_name: string | null;
  /** Claude: the transcript path the trusted hook reported (title sidecar and transcript fallback live next to it). */
  native_ref: string | null;
  conn_generation: number;
  retired_at: string | null;
  /** The canonical slot this one was handed over to by a resume recovery. */
  retired_into: string | null;
  link: Link;
  parent_state: ParentState;
  /** Claude: the agent process the hook ran under (agentAncestor); Codex: null (the shared daemon is not one thread). */
  agent_pid: number | null;
  /** Process start identity of agent_pid at bind (src/proc/identity.ts); null when it could not be captured. */
  agent_start: string | null;
  parent_checked_at: string | null;
}

type Raw = Omit<SessionRow, 'pid_chain'> & { pid_chain: string };
const row = (r: unknown): SessionRow | undefined => {
  if (!r) return undefined;
  const raw = r as Raw;
  return { ...raw, pid_chain: JSON.parse(raw.pid_chain) as number[] };
};

export function createSession(
  db: Db,
  input: { agent: Agent; cwd: string; workspace?: string; pid_chain: number[]; mcp_ppid: number | null },
): SessionRow {
  const id = newId('ses');
  const at = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, name, agent, agent_session_id, cwd, workspace, pid_chain, mcp_ppid, state, transport,
       spawned_by, launch_json, created_at, last_seen_at)
     VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, 'online-idle', ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.agent,
    input.cwd,
    input.workspace ?? resolveWorkspace(input.cwd),
    JSON.stringify(input.pid_chain),
    input.mcp_ppid,
    input.agent === 'claude' ? 'claude-channel' : 'codex-queue',
    at,
    at,
  );
  return getSession(db, id) as SessionRow;
}

export const getSession = (db: Db, id: string) => row(db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));

export const liveHolder = (db: Db, name: string) =>
  row(db.prepare(`SELECT * FROM sessions WHERE name = ? AND state <> 'offline'`).get(name));

/** The session that holds `name` now or held it last (claimName clears the name on every other session). */
export const holderOf = (db: Db, name: string) =>
  row(db.prepare('SELECT * FROM sessions WHERE name = ? ORDER BY last_seen_at DESC LIMIT 1').get(name));

export const findByAgentSessionId = (db: Db, agentSessionId: string) =>
  row(
    db
      .prepare('SELECT * FROM sessions WHERE agent_session_id = ? ORDER BY last_seen_at DESC LIMIT 1')
      .get(agentSessionId),
  );

export const listSessions = (db: Db): SessionRow[] =>
  db
    .prepare('SELECT * FROM sessions ORDER BY last_seen_at DESC')
    .all()
    .map((r) => row(r) as SessionRow);

/** Assigned names with the workspace of their current or last holder. */
export const assignedNamesWithWorkspace = (db: Db): Array<{ name: string; workspace: string }> =>
  db.prepare('SELECT name, workspace FROM sessions WHERE name IS NOT NULL ORDER BY name').all() as Array<{
    name: string;
    workspace: string;
  }>;

export const assignedNames = (db: Db): string[] =>
  db
    .prepare('SELECT name FROM sessions WHERE name IS NOT NULL ORDER BY name')
    .all()
    .map((r) => (r as { name: string }).name);

/**
 * `reason: 'live'` — a live session holds the name. `reason: 'scope'` (spec §17, R42-A) — the offline holder is in a
 * workspace outside the claimant's scope, so taking the name would inherit another workspace's backlog.
 */
export type ClaimResult = { ok: true } | { ok: false; holder: SessionRow; reason: 'live' | 'scope' };

export function claimName(db: Db, sessionId: string, name: string, source?: NameSource): ClaimResult {
  return tx(db, (): ClaimResult => {
    const live = liveHolder(db, name);
    if (live && live.id !== sessionId) return { ok: false, holder: live, reason: 'live' };
    const prev = holderOf(db, name);
    const claimant = getSession(db, sessionId);
    if (prev && claimant && prev.id !== sessionId && !scopeOf(db, prev.workspace).has(claimant.workspace)) {
      return { ok: false, holder: prev, reason: 'scope' };
    }
    const at = nowIso();
    db.prepare('UPDATE name_claims SET released_at = ? WHERE released_at IS NULL AND (name = ? OR session_id = ?)').run(
      at,
      name,
      sessionId,
    );
    db.prepare('UPDATE sessions SET name = NULL WHERE name = ? AND id <> ?').run(name, sessionId);
    db.prepare(
      'UPDATE sessions SET name = ?, name_source = COALESCE(?, name_source), last_seen_at = ? WHERE id = ?',
    ).run(name, source ?? null, at, sessionId);
    db.prepare('INSERT INTO name_claims (name, session_id, claimed_at, released_at) VALUES (?, ?, ?, NULL)').run(
      name,
      sessionId,
      at,
    );
    return { ok: true as const };
  });
}

export function setState(db: Db, id: string, state: SessionState): void {
  db.prepare('UPDATE sessions SET state = ?, last_seen_at = ? WHERE id = ?').run(state, nowIso(), id);
}

export function setNameSource(db: Db, id: string, source: NameSource): void {
  db.prepare('UPDATE sessions SET name_source = ? WHERE id = ?').run(source, id);
}

export function setNativeName(db: Db, id: string, nativeName: string | null): void {
  db.prepare('UPDATE sessions SET native_name = ? WHERE id = ?').run(nativeName, id);
}

export function setNativeRef(db: Db, id: string, ref: string | null): void {
  db.prepare('UPDATE sessions SET native_ref = ? WHERE id = ?').run(ref, id);
}

/** A connection takes the slot: returns the new generation, which that connection keeps for its disconnect. */
export function attachConnection(db: Db, id: string): number {
  const r = db
    .prepare(
      "UPDATE sessions SET conn_generation = conn_generation + 1, link = 'connected' WHERE id = ? RETURNING conn_generation",
    )
    .get(id) as { conn_generation: number } | undefined;
  if (!r) throw new Error(`no session ${id}`);
  return r.conn_generation;
}

/** Marks the slot offline only if `generation` is still its current one (W7: a handed-over slot ignores stale closes). */
export function markOfflineIfCurrent(db: Db, id: string, generation: number): boolean {
  return (
    Number(
      db
        .prepare(`UPDATE sessions SET state = 'offline', last_seen_at = ? WHERE id = ? AND conn_generation = ?`)
        .run(nowIso(), id, generation).changes,
    ) === 1
  );
}

/** W8: the MCP link of the current generation dropped but the parent is (or may be) alive: keep state and name. */
export function markDisconnectedIfCurrent(db: Db, id: string, generation: number, parent: ParentState): boolean {
  const at = nowIso();
  return (
    Number(
      db
        .prepare(
          `UPDATE sessions SET link = 'disconnected', parent_state = ?, parent_checked_at = ?, last_seen_at = ?
           WHERE id = ? AND conn_generation = ? AND state <> 'offline'`,
        )
        .run(parent, at, at, id, generation).changes,
    ) === 1
  );
}

export function setParentState(db: Db, id: string, state: ParentState): void {
  db.prepare('UPDATE sessions SET parent_state = ?, parent_checked_at = ? WHERE id = ?').run(state, nowIso(), id);
}

export function setAgentIdentity(db: Db, id: string, pid: number | null, start: string | null): void {
  db.prepare('UPDATE sessions SET agent_pid = ?, agent_start = ? WHERE id = ?').run(pid, start, id);
}

export function bindAgentSession(db: Db, id: string, agentSessionId: string): void {
  db.prepare('UPDATE sessions SET agent_session_id = ?, last_seen_at = ? WHERE id = ?').run(
    agentSessionId,
    nowIso(),
    id,
  );
}

export type ThreadBindResult = { ok: true } | { ok: false; holder: SessionRow };

/**
 * Binds `id` to the agent's own session id (spec §4). The check and the write are one transaction: another LIVE session
 * of the same agent already holding the id refuses the bind; an OFFLINE holder is taken over (its stale binding is
 * cleared, its name and history stay with it). Re-binding the same id on the same session is idempotent.
 */
export function bindAgentSessionExclusive(db: Db, id: string, agentSessionId: string): ThreadBindResult {
  return tx(db, (): ThreadBindResult => {
    const me = getSession(db, id);
    const holders = db
      .prepare('SELECT * FROM sessions WHERE agent = ? AND agent_session_id = ? AND id <> ?')
      .all(me?.agent ?? 'codex', agentSessionId, id)
      .map((r) => row(r) as SessionRow);
    const live = holders.find((h) => h.state !== 'offline');
    if (live) return { ok: false, holder: live };
    db.prepare('UPDATE sessions SET agent_session_id = NULL WHERE agent = ? AND agent_session_id = ? AND id <> ?').run(
      me?.agent ?? 'codex',
      agentSessionId,
      id,
    );
    bindAgentSession(db, id, agentSessionId);
    return { ok: true };
  });
}

/** A resumed MCP process may have a new cwd/pid chain; a changed mcp_ppid means a new agent process, so the binding is dropped. */
export function refreshProcess(
  db: Db,
  id: string,
  input: { cwd: string; workspace?: string; pid_chain: number[]; mcp_ppid: number | null },
): void {
  db.prepare(
    `UPDATE sessions SET cwd = ?, workspace = ?, pid_chain = ?,
       agent_session_id = CASE WHEN mcp_ppid IS ? THEN agent_session_id ELSE NULL END,
       mcp_ppid = ?, last_seen_at = ? WHERE id = ?`,
  ).run(
    input.cwd,
    input.workspace ?? resolveWorkspace(input.cwd),
    JSON.stringify(input.pid_chain),
    input.mcp_ppid,
    input.mcp_ppid,
    nowIso(),
    id,
  );
}

export function markAllOffline(db: Db): void {
  db.prepare(`UPDATE sessions SET state = 'offline' WHERE state <> 'offline'`).run();
}

/** `<agent>-<cwd-basename slug>-<4 base32>`; always matches NAME_RE. */
export function provisionalName(agent: Agent, cwd: string, rand4: string): string {
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40 - agent.length);
  return [agent, slug || 'session', rand4].join('-');
}

/** Owner resolution (W7): an offline slot is excluded from automatic resume recovery and duplicate diagnostics. */
export function retireSlot(db: Db, id: string): boolean {
  return (
    Number(
      db
        .prepare(`UPDATE sessions SET retired_at = ? WHERE id = ? AND state = 'offline' AND retired_at IS NULL`)
        .run(nowIso(), id).changes,
    ) === 1
  );
}
