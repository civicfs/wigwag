import type { Db } from './db.js';
import { inScope, scopeFor } from './links.js';
import type { DeliveryRow, MessageRow } from './messages.js';
import { getSession, type SessionRow } from './sessions.js';

/** Only trusted recovery writes retired_into. A display name never establishes a session's successor. */
export function canonicalSession(db: Db, id: string): SessionRow | undefined {
  const seen = new Set<string>();
  let s = getSession(db, id);
  while (s?.retired_into) {
    if (seen.has(s.id)) return undefined;
    seen.add(s.id);
    s = getSession(db, s.retired_into);
  }
  return s;
}

export function sameSession(db: Db, a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const first = canonicalSession(db, a);
  return first !== undefined && first.id === canonicalSession(db, b)?.id;
}

export const messageSender = (db: Db, messageId: string): SessionRow | undefined => {
  const row = db.prepare('SELECT sender_session_id FROM message_ownership WHERE message_id=?').get(messageId) as
    | { sender_session_id: string | null }
    | undefined;
  return row?.sender_session_id ? canonicalSession(db, row.sender_session_id) : undefined;
};

export const messageSentBy = (db: Db, m: MessageRow, sessionId: string | null | undefined): boolean =>
  sameSession(db, messageSender(db, m.id)?.id, sessionId);

export const deliveryOwner = (db: Db, d: DeliveryRow): SessionRow | undefined => {
  const id = d.recipient_session_id ?? d.forward_to;
  return id ? canonicalSession(db, id) : undefined;
};

export const deliveryOwnedBy = (db: Db, d: DeliveryRow, sessionId: string | null | undefined): boolean =>
  sameSession(db, deliveryOwner(db, d)?.id, sessionId);

export function messageAddressedTo(db: Db, messageId: string, sessionId: string | null | undefined): boolean {
  const rows = db.prepare('SELECT * FROM deliveries WHERE message_id=?').all(messageId) as unknown as DeliveryRow[];
  return rows.some((d) => deliveryOwnedBy(db, d, sessionId));
}

/** An unknown destination is acquired by its first registered, in-scope holder; historical gaps stay untrusted. */
export function claimMessageRecipient(db: Db, messageId: string, sessionId: string): boolean {
  const s = canonicalSession(db, sessionId);
  if (!s?.name) return false;
  const row = db
    .prepare(`SELECT m.from_name,m.from_workspace FROM messages m
    JOIN message_ownership o ON o.message_id=m.id WHERE m.id=? AND o.mode='captured'`)
    .get(messageId) as { from_name: string; from_workspace: string | null } | undefined;
  if (!row || (row.from_workspace === null && !['owner', 'wigwag'].includes(row.from_name))) return false;
  if (!inScope(scopeFor(db, row.from_workspace), s.workspace)) return false;
  return (
    Number(
      db
        .prepare(`UPDATE deliveries SET recipient_session_id=? WHERE message_id=?
    AND recipient_session_id IS NULL AND forward_to IS NULL AND recipient=?`)
        .run(s.id, messageId, s.name).changes,
    ) > 0
  );
}

export function claimUnownedRecipients(db: Db, sessionId: string): void {
  const s = canonicalSession(db, sessionId);
  if (!s?.name) return;
  const rows = db
    .prepare('SELECT message_id FROM deliveries WHERE recipient=? AND recipient_session_id IS NULL')
    .all(s.name) as Array<{ message_id: string }>;
  for (const { message_id } of rows) claimMessageRecipient(db, message_id, s.id);
}
