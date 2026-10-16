import type { Hello } from '../protocol/rpc.js';
import { type Db, nowIso } from './db.js';
import type { SessionRow } from './sessions.js';

/** Historical compatibility observations survive resolved recovery flags and broker restarts. */
export function isLegacySession(db: Db, id: string): boolean {
  const r = db
    .prepare(`SELECT reason FROM session_lineage WHERE session_id=? AND outcome='observed'
    AND reason IN ('legacy-client','stamped-client') ORDER BY id DESC LIMIT 1`)
    .get(id) as { reason: string } | undefined;
  return r?.reason === 'legacy-client';
}

/** Only hello calls this; a stamped client can clear the marker only after a validated explicit reattach. */
export function recordClientCompatibility(db: Db, s: SessionRow, hello: Hello, legacy: boolean): void {
  const previous = isLegacySession(db, s.id);
  if (previous !== legacy)
    db.prepare(`INSERT INTO session_lineage
    (agent,native_id,workspace,session_id,cause,outcome,reason,evidence_json,generation,created_at)
    VALUES(?,?,?,?,'continuation','observed',?,?,?,?)`).run(
      s.agent,
      s.agent_session_id ?? '',
      s.workspace,
      s.id,
      legacy ? 'legacy-client' : 'stamped-client',
      JSON.stringify({
        protocol: hello.protocol,
        schema_version: hello.schema_version ?? null,
        version: hello.version ?? null,
      }),
      s.conn_generation,
      nowIso(),
    );
  if (legacy)
    db.prepare(`UPDATE sessions SET agent_pid=NULL,agent_start=NULL,parent_state='unknown',parent_checked_at=NULL,
    codex_push_reason='app-server-unavailable' WHERE id=?`).run(s.id);
}
