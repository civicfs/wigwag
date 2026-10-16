import { isLegacySession } from './compatibility.js';
import { type Db, nowIso, tx } from './db.js';
import { type Agent, getSession, type NameSource, type SessionRow, type SessionState } from './sessions.js';

export type LineageCause = 'resume' | 'fork' | 'switch' | 'continuation';
export type LineageOutcome = 'adopted' | 'flagged' | 'observed';

export interface LineageInput {
  agent: Agent;
  native_id: string;
  previous_native_id?: string | null;
  workspace: string;
  session_id: string;
  canonical_session_id?: string | null;
  cause: LineageCause;
  outcome: LineageOutcome;
  reason?: string | null;
  evidence: Record<string, unknown>;
  generation?: number | null;
}

export interface LineageRow {
  id: number;
  agent: Agent;
  native_id: string;
  previous_native_id: string | null;
  workspace: string;
  session_id: string;
  canonical_session_id: string | null;
  cause: LineageCause;
  outcome: LineageOutcome;
  reason: string | null;
  evidence: Record<string, unknown>;
  generation: number | null;
  handoff_state: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function recordLineage(db: Db, x: LineageInput): number {
  const r = db
    .prepare(
      `INSERT INTO session_lineage (agent, native_id, previous_native_id, workspace, session_id, canonical_session_id,
         cause, outcome, reason, evidence_json, generation, handoff_state, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(
      x.agent,
      x.native_id,
      x.previous_native_id ?? null,
      x.workspace,
      x.session_id,
      x.canonical_session_id ?? null,
      x.cause,
      x.outcome,
      x.reason ?? null,
      JSON.stringify(x.evidence),
      x.generation ?? null,
      nowIso(),
    );
  return Number(r.lastInsertRowid);
}

export function listLineage(
  db: Db,
  q: { outcome?: LineageOutcome; unresolved?: boolean; limit: number },
): LineageRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (q.outcome) {
    where.push('outcome = ?');
    args.push(q.outcome);
  }
  if (q.unresolved) where.push('resolved_at IS NULL');
  const rows = db
    .prepare(
      `SELECT * FROM session_lineage ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    )
    .all(...args, q.limit) as Array<Omit<LineageRow, 'evidence'> & { evidence_json: string }>;
  return rows.map(({ evidence_json, ...r }) => ({ ...r, evidence: JSON.parse(evidence_json) }));
}

const sessionsByIds = (db: Db, rows: unknown[]): SessionRow[] =>
  rows.map((r) => getSession(db, (r as { id: string }).id) as SessionRow);

export const liveNativeHolders = (db: Db, agent: Agent, native: string, exceptId: string): SessionRow[] =>
  sessionsByIds(
    db,
    db
      .prepare(
        `SELECT id FROM sessions WHERE agent = ? AND agent_session_id = ? AND id <> ? AND state <> 'offline'
           AND link = 'connected' AND retired_at IS NULL`,
      )
      .all(agent, native, exceptId),
  );

/**
 * W7: offline slots a resumed native session may reclaim, plus (W8) live slots whose MCP link dropped: a new MCP
 * process for the same native session re-attaches to them. Empty provisional/unnamed slots and historically refused-resume shells are excluded unless they retain
 * assignments, undelivered mail, subscriptions or mutes. A refused slot keeps its explicit name without creating loops.
 */
export const recoveryCandidates = (
  db: Db,
  q: { agent: Agent; native: string; workspace: string; exceptId: string },
): SessionRow[] =>
  sessionsByIds(
    db,
    db
      .prepare(
        `SELECT s.id FROM sessions s
         WHERE s.agent = ? AND s.agent_session_id = ? AND s.workspace = ? AND s.id <> ?
           AND (s.state = 'offline' OR s.link = 'disconnected') AND s.retired_at IS NULL
           AND (
             (s.name IS NOT NULL AND s.name_source <> 'provisional' AND NOT EXISTS (
               SELECT 1 FROM session_lineage l WHERE l.session_id = s.id AND l.native_id = s.agent_session_id
                 AND l.cause = 'resume' AND l.outcome = 'flagged'))
             OR EXISTS (SELECT 1 FROM assignments a WHERE a.ended_at IS NULL
                AND (a.worker_session_id = s.id OR a.orchestrator_session_id = s.id))
             OR EXISTS (SELECT 1 FROM deliveries d WHERE d.recipient = s.name AND d.state IN ('pending','held','failed','stuck'))
             OR EXISTS (SELECT 1 FROM subscriptions sub WHERE sub.session_name = s.name AND sub.removed_at IS NULL)
             OR EXISTS (SELECT 1 FROM mutes m WHERE m.session_name = s.name AND m.removed_at IS NULL)
           )
         ORDER BY s.last_seen_at DESC`,
      )
      .all(q.agent, q.native, q.workspace, q.exceptId),
  ).filter((s) => !isLegacySession(db, s.id));

export type AdoptResult =
  | {
      ok: true;
      canonical: SessionRow;
      generation: number;
      fromName: string | null;
      fromSource: NameSource;
      cancelledRelays: string[];
      lineageId: number;
    }
  | { ok: false; reason: 'canonical-changed' | 'provisional-changed' | 'live-holder' };

/**
 * W7 (S-E recommendation 2): in one transaction, revalidate, then move the provisional slot's live connection state
 * (process fields, state, native binding) onto the canonical slot and retire the provisional slot into it. The
 * canonical slot keeps its name, or takes the provisional name if it lost its own. Readiness is cleared for both (a new
 * process must prove QuestionReady again). Pending or answered synchronous relays of the canonical slot's active worker
 * assignment for this native id are cancelled unless the same verified live Claude parent still owns them; async Codex relays stay for
 * the adapter's history reconciliation. Lineage is recorded inside the same transaction.
 */
export function adoptCanonical(
  db: Db,
  x: {
    provisionalId: string;
    canonicalId: string;
    native: string;
    state: SessionState;
    evidence: Record<string, unknown>;
  },
): AdoptResult {
  return tx(db, (): AdoptResult => {
    const p = getSession(db, x.provisionalId);
    const c = getSession(db, x.canonicalId);
    if (
      !c ||
      isLegacySession(db, c.id) ||
      (c.state !== 'offline' && c.link !== 'disconnected') ||
      c.retired_at ||
      c.agent_session_id !== x.native ||
      (p && (c.agent !== p.agent || c.workspace !== p.workspace))
    )
      return { ok: false, reason: 'canonical-changed' };
    if (
      !p ||
      isLegacySession(db, p.id) ||
      p.state === 'offline' ||
      p.link !== 'connected' ||
      p.retired_at ||
      (p.agent_session_id !== null && p.agent_session_id !== x.native)
    )
      return { ok: false, reason: 'provisional-changed' };
    if (liveNativeHolders(db, p.agent, x.native, p.id).length) return { ok: false, reason: 'live-holder' };
    const at = nowIso();
    db.prepare('UPDATE name_claims SET released_at = ? WHERE released_at IS NULL AND session_id = ?').run(at, p.id);
    db.prepare(
      `UPDATE sessions SET name = NULL, agent_session_id = NULL, state = 'offline', retired_at = ?, retired_into = ?,
         last_seen_at = ? WHERE id = ?`,
    ).run(at, c.id, at, p.id);
    const takeName = !c.name && p.name;
    const generation = (
      db
        .prepare(
          `UPDATE sessions SET name = ?, name_source = ?, state = ?, cwd = ?, workspace = ?, pid_chain = ?, mcp_ppid = ?,
             agent_session_id = ?, conn_generation = conn_generation + 1, link = 'connected', last_seen_at = ?,
             agent_pid = ?, agent_start = ?, parent_state = ?, parent_checked_at = ?
           WHERE id = ? RETURNING conn_generation`,
        )
        .get(
          takeName ? p.name : c.name,
          takeName ? p.name_source : c.name_source,
          x.state,
          p.cwd,
          p.workspace,
          JSON.stringify(p.pid_chain),
          p.mcp_ppid,
          x.native,
          at,
          p.agent_pid,
          p.agent_start,
          p.agent_start ? p.parent_state : 'unknown',
          p.agent_start ? p.parent_checked_at : null,
          c.id,
        ) as { conn_generation: number }
    ).conn_generation;
    if (takeName)
      db.prepare('INSERT INTO name_claims (name, session_id, claimed_at, released_at) VALUES (?, ?, ?, NULL)').run(
        p.name,
        c.id,
        at,
      );
    db.prepare('DELETE FROM question_integrations WHERE session_id IN (?, ?)').run(p.id, c.id);
    const sameLiveClaudeParent =
      c.agent === 'claude' &&
      p.agent === 'claude' &&
      c.agent_pid !== null &&
      c.agent_pid === p.agent_pid &&
      !!c.agent_start &&
      c.agent_start === p.agent_start &&
      c.parent_state === 'live' &&
      p.parent_state === 'live';
    const stale = sameLiveClaudeParent
      ? []
      : (
          db
            .prepare(
              `SELECT q.id FROM question_relays q JOIN assignments a ON a.id = q.assignment_id
           WHERE a.ended_at IS NULL AND a.worker_session_id = ? AND q.native_session_id = ?
             AND q.kind IN ('claude', 'codex') AND q.state IN ('pending', 'answered') ORDER BY q.id`,
            )
            .all(c.id, x.native) as Array<{ id: string }>
        ).map((r) => r.id);
    const cancel = db.prepare(
      "UPDATE question_relays SET state = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND state IN ('pending', 'answered')",
    );
    for (const id of stale) cancel.run('Native session resumed; this question is no longer waiting', at, id);
    resolveLineage(db, [p.id, c.id]);
    const lineageId = recordLineage(db, {
      agent: c.agent,
      native_id: x.native,
      workspace: c.workspace,
      session_id: p.id,
      canonical_session_id: c.id,
      cause: 'resume',
      outcome: 'adopted',
      evidence: x.evidence,
      generation,
    });
    return {
      ok: true,
      canonical: getSession(db, c.id) as SessionRow,
      generation,
      fromName: p.name,
      fromSource: p.name_source,
      cancelledRelays: stale,
      lineageId,
    };
  });
}

export interface RecoverySlot {
  session_id: string;
  name: string | null;
  name_source: NameSource;
  last_seen_at: string;
  state: SessionState;
  link: SessionRow['link'];
  assignments: Array<{ id: string; role: 'worker' | 'orchestrator' }>;
  held_pending: number;
  undelivered: number;
}

export function recoverySlot(db: Db, id: string): RecoverySlot | null {
  const s = getSession(db, id);
  if (!s) return null;
  const assignments = db
    .prepare(`SELECT id, 'worker' AS role FROM assignments WHERE worker_session_id=? AND ended_at IS NULL
    UNION ALL SELECT id, 'orchestrator' AS role FROM assignments WHERE orchestrator_session_id=? AND ended_at IS NULL
    ORDER BY id, role`)
    .all(id, id) as RecoverySlot['assignments'];
  const mail = db
    .prepare(`SELECT count(*) AS undelivered,
    coalesce(sum(CASE WHEN state IN ('pending','held') THEN 1 ELSE 0 END),0) AS held_pending
    FROM deliveries WHERE recipient=? AND state IN ('pending','held','failed','stuck')`)
    .get(s.name) as { undelivered: number; held_pending: number };
  return {
    session_id: s.id,
    name: s.name,
    name_source: s.name_source,
    last_seen_at: s.last_seen_at,
    state: s.state,
    link: s.link,
    assignments,
    ...mail,
  };
}

/** Resolve the display event without erasing the refused-shell history used by candidate selection. */
export function resolveLineage(db: Db, sessionIds: string[]): void {
  const ids = JSON.stringify(sessionIds);
  db.prepare(`UPDATE session_lineage SET resolved_at=? WHERE outcome='flagged' AND resolved_at IS NULL AND (
    session_id IN (SELECT value FROM json_each(?)) OR canonical_session_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM json_each(session_lineage.evidence_json, '$.candidates') c WHERE c.value IN (SELECT value FROM json_each(?)))
  )`).run(nowIso(), ids, ids, ids);
}

export interface DuplicateGroup {
  agent: Agent;
  native_id: string;
  workspace: string;
  session_ids: string[];
  slots: RecoverySlot[];
}

/** Migration diagnostics (S-E: nine slots for one conversation): unretired slots sharing agent, native id and workspace. */
export function duplicateNativeSlots(db: Db): DuplicateGroup[] {
  return (
    db
      .prepare(
        `SELECT agent, agent_session_id AS native_id, workspace, group_concat(id, ',') AS ids FROM sessions
         WHERE agent_session_id IS NOT NULL AND retired_at IS NULL
         GROUP BY agent, agent_session_id, workspace HAVING count(*) > 1 ORDER BY max(last_seen_at) DESC`,
      )
      .all() as Array<{ agent: Agent; native_id: string; workspace: string; ids: string }>
  ).map((r) => ({
    agent: r.agent,
    native_id: r.native_id,
    workspace: r.workspace,
    session_ids: r.ids.split(','),
    slots: r.ids.split(',').map((id) => recoverySlot(db, id) as RecoverySlot),
  }));
}
