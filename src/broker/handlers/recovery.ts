import { WigwagError } from '../../errors.js';
import { tx } from '../../store/db.js';
import { duplicateNativeSlots, listLineage, recoverySlot, resolveLineage } from '../../store/recovery.js';
import { getSession, listSessions, retireSlot, type SessionRow } from '../../store/sessions.js';
import { publicSession } from '../registry.js';
import type { Broker } from '../server.js';

export function installRecovery(broker: Broker): void {
  const db = broker.db;
  broker.onStart.push(() => {
    const dups = duplicateNativeSlots(db);
    if (dups.length)
      broker.log(
        `recovery diagnostics: ${dups.length} native session id(s) have more than one wigwag slot; automatic resume recovery is refused for them until the owner retires the extra slots (wigwag recovery)`,
      );
  });
  broker.handle('owner.recovery', (_c, { limit }) => ({
    codex_question_waiting: [...broker.questions.codexWaiting].map(([session_id, reason]) => ({ session_id, reason })),
    flags: listLineage(db, { outcome: 'flagged', unresolved: true, limit }),
    duplicates: duplicateNativeSlots(db),
    codex_push_untrusted: listSessions(db)
      .filter((s) => s.agent === 'codex' && !s.retired_at && s.codex_push_reason)
      .map((s) => ({ ...publicSession(db, s), session_id: s.id, reason: s.codex_push_reason })),
  }));
  broker.handle('owner.retire_slot', (_c, { session_id, force }) => {
    tx(db, () => {
      const s = getSession(db, session_id);
      if (!s) throw new WigwagError('not_found', `No session ${session_id}`);
      if (s.state !== 'offline')
        throw new WigwagError('conflict', `Session ${session_id} is live; only an offline slot can be retired`);
      const details = recoverySlot(db, session_id);
      if (!force && details && (details.assignments.length || details.undelivered))
        throw new WigwagError(
          'conflict',
          `Session ${session_id} has ${details.assignments.length} active assignment(s) (${details.assignments.map((a) => a.id).join(', ')}) and ${details.undelivered} undelivered message(s); use --force to retire it anyway`,
        );
      if (!retireSlot(db, session_id)) throw new WigwagError('conflict', `Session ${session_id} is already retired`);
      resolveLineage(db, [session_id]);
    });
    broker.log(`owner retired slot ${session_id}`);
    broker.broadcastOwner('session', publicSession(db, getSession(db, session_id) as SessionRow));
    return { session_id };
  });
}
