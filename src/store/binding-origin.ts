import { type Db, nowIso } from './db.js';
import type { SessionRow } from './sessions.js';

export type BindingOrigin = 'raw-bind' | 'legacy-unverified' | 'hook-verified' | 'hook-unverified';

/** Positive proof is the latest binding-origin lineage evidence.origin for this exact slot/native pair.
 * The V4 sessions.bind_origin='unverified' DEFAULT is NOT proof: historical unstamped holders stay protected.
 */
export function bindingOrigin(db: Db, s: SessionRow): BindingOrigin | null {
  if (!s.agent_session_id) return null;
  const row = db
    .prepare(`SELECT json_extract(evidence_json,'$.origin') AS origin FROM session_lineage
    WHERE session_id=? AND native_id=? AND outcome='observed' AND reason='binding-origin' ORDER BY id DESC LIMIT 1`)
    .get(s.id, s.agent_session_id) as { origin: BindingOrigin } | undefined;
  return row?.origin ?? null;
}

export function recordBindingOrigin(db: Db, s: SessionRow, origin: BindingOrigin): void {
  if (!s.agent_session_id) return;
  if (bindingOrigin(db, s) !== origin)
    db.prepare(`INSERT INTO session_lineage
      (agent,native_id,workspace,session_id,cause,outcome,reason,evidence_json,generation,created_at)
      VALUES(?,?,?,?,'continuation','observed','binding-origin',?,?,?)`).run(
      s.agent,
      s.agent_session_id,
      s.workspace,
      s.id,
      JSON.stringify({ origin }),
      s.conn_generation,
      nowIso(),
    );
  db.prepare('UPDATE sessions SET bind_origin=? WHERE id=?').run(
    origin === 'hook-verified' ? 'hook-verified' : 'unverified',
    s.id,
  );
}

export const provenUntrustedBinding = (db: Db, s: SessionRow): boolean => {
  const origin = bindingOrigin(db, s);
  return origin === 'raw-bind' || origin === 'legacy-unverified';
};
