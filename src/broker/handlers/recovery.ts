import { WigwagError } from '../../errors.js';
import { duplicateNativeSlots, listLineage } from '../../store/recovery.js';
import { getSession, retireSlot, type SessionRow } from '../../store/sessions.js';
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
    flags: listLineage(db, { outcome: 'flagged', unresolved: true, limit }),
    duplicates: duplicateNativeSlots(db),
  }));
  broker.handle('owner.retire_slot', (_c, { session_id }) => {
    const s = getSession(db, session_id);
    if (!s) throw new WigwagError('not_found', `No session ${session_id}`);
    if (s.state !== 'offline')
      throw new WigwagError('conflict', `Session ${session_id} is live; only an offline slot can be retired`);
    if (!retireSlot(db, session_id)) throw new WigwagError('conflict', `Session ${session_id} is already retired`);
    broker.log(`owner retired slot ${session_id}`);
    broker.broadcastOwner('session', publicSession(db, getSession(db, session_id) as SessionRow));
    return { session_id };
  });
}
