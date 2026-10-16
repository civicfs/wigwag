import { WigwagError } from '../errors.js';
import { newId } from '../ids.js';
import { type Db, nowIso, tx } from './db.js';

export type Priority = 'urgent' | 'normal' | 'low';
export type MessageKind = 'message' | 'request' | 'response' | 'notice';
export type DeliveryState = 'pending' | 'held' | 'pushed' | 'failed' | 'stuck' | 'read';
export type HoldReason = 'offline' | 'unbound' | 'low' | 'muted' | 'throttled' | 'disconnected';

export interface MessageRow {
  id: string;
  from_name: string;
  /** Sender's workspace (spec §17); null for the unscoped senders `owner` and `wigwag`. */
  from_workspace: string | null;
  to_target: string;
  kind: MessageKind;
  priority: Priority;
  subject: string;
  body: string;
  attachments: string[];
  reply_to: string | null;
  request_id: string | null;
  expires_at: string | null;
  /** Set on notices generated from a stream subscription; used for stream mutes. */
  stream: string | null;
  created_at: string;
}
export type NewMessage = Omit<MessageRow, 'id' | 'created_at' | 'from_workspace'> & { from_workspace?: string | null };

export interface DeliveryRow {
  message_id: string;
  recipient: string;
  state: DeliveryState;
  hold_reason: HoldReason | null;
  attempts: number;
  last_error: string | null;
  transport: string | null;
  next_attempt_at: string | null;
  updated_at: string;
}
export type DeliveryWithMessage = DeliveryRow & { message: MessageRow };

export interface TransitionPatch {
  hold_reason?: HoldReason | null;
  attempts?: number;
  last_error?: string | null;
  transport?: string | null;
  next_attempt_at?: string | null;
  detail?: string;
  /**
   * Spec §17 / R46-N1: on `pushed`/`read`, the attachments become readable in this workspace — the workspace of the
   * session that actually received the message, captured by the caller (for a push: when the push started).
   */
  grant_workspace?: string;
}

const msg = (r: unknown): MessageRow | undefined => {
  if (!r) return undefined;
  const raw = r as Omit<MessageRow, 'attachments'> & { attachments: string };
  return { ...raw, attachments: JSON.parse(raw.attachments) as string[] };
};

export function insertMessage(db: Db, input: NewMessage, recipients: string[]): MessageRow {
  const id = newId('msg');
  const at = nowIso();
  tx(db, () => {
    db.prepare(
      `INSERT INTO messages (id, from_name, from_workspace, to_target, kind, priority, subject, body, attachments,
         reply_to, request_id, expires_at, stream, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.from_name,
      input.from_workspace ?? null,
      input.to_target,
      input.kind,
      input.priority,
      input.subject,
      input.body,
      JSON.stringify(input.attachments),
      input.reply_to,
      input.request_id,
      input.expires_at,
      input.stream,
      at,
    );
    const ins = db.prepare(
      `INSERT INTO deliveries (message_id, recipient, state, attempts, updated_at) VALUES (?, ?, 'pending', 0, ?)`,
    );
    const ev = db.prepare(
      `INSERT INTO delivery_events (message_id, recipient, from_state, to_state, detail, at) VALUES (?, ?, NULL, 'pending', NULL, ?)`,
    );
    for (const r of [...new Set(recipients)]) {
      ins.run(id, r, at);
      ev.run(id, r, at);
    }
  });
  return getMessage(db, id) as MessageRow;
}

export const getMessage = (db: Db, id: string) => msg(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));

const getDelivery = (db: Db, messageId: string, recipient: string) =>
  db.prepare('SELECT * FROM deliveries WHERE message_id = ? AND recipient = ?').get(messageId, recipient) as
    | DeliveryRow
    | undefined;

export function transition(
  db: Db,
  messageId: string,
  recipient: string,
  to: DeliveryState,
  patch: TransitionPatch = {},
): DeliveryRow {
  return transitionIf(db, messageId, recipient, null, to, patch) as DeliveryRow;
}

/**
 * Like `transition`, but only when the delivery is still in one of `onlyFrom` (null = any state but `read`).
 * Returns null, changing nothing and granting nothing, when it is not (R46-N1: a completion must not override a
 * `stuck` or `read` that happened while the push was in flight).
 */
export function transitionIf(
  db: Db,
  messageId: string,
  recipient: string,
  onlyFrom: DeliveryState[] | null,
  to: DeliveryState,
  patch: TransitionPatch = {},
): DeliveryRow | null {
  return tx(db, () => {
    const cur = getDelivery(db, messageId, recipient);
    if (!cur) throw new WigwagError('not_found', `No delivery ${messageId} → ${recipient}`);
    if (onlyFrom !== null && !onlyFrom.includes(cur.state)) return null;
    if (cur.state === 'read') return cur;
    const at = nowIso();
    const next: DeliveryRow = {
      ...cur,
      state: to,
      hold_reason: to === 'held' ? (patch.hold_reason ?? cur.hold_reason) : null,
      attempts: patch.attempts ?? cur.attempts,
      last_error: patch.last_error === undefined ? cur.last_error : patch.last_error,
      transport: patch.transport === undefined ? cur.transport : patch.transport,
      next_attempt_at: patch.next_attempt_at === undefined ? cur.next_attempt_at : patch.next_attempt_at,
      updated_at: at,
    };
    db.prepare(
      `UPDATE deliveries SET state = ?, hold_reason = ?, attempts = ?, last_error = ?, transport = ?,
         next_attempt_at = ?, updated_at = ? WHERE message_id = ? AND recipient = ?`,
    ).run(
      next.state,
      next.hold_reason,
      next.attempts,
      next.last_error,
      next.transport,
      next.next_attempt_at,
      at,
      messageId,
      recipient,
    );
    const detail = patch.detail ?? (to === 'held' ? next.hold_reason : (patch.last_error ?? null));
    db.prepare(
      'INSERT INTO delivery_events (message_id, recipient, from_state, to_state, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(messageId, recipient, cur.state, to, detail, at);
    // Spec §17 / R42 / R46-N1: an attachment becomes readable only in the workspace of the session that actually
    // received it (supplied by the caller), never in whoever holds the name later.
    if ((to === 'pushed' || to === 'read') && patch.grant_workspace !== undefined) {
      db.prepare(
        `INSERT OR IGNORE INTO blob_scopes (ref, workspace, at)
         SELECT j.value, ?, ? FROM messages m, json_each(m.attachments) j WHERE m.id = ?`,
      ).run(patch.grant_workspace, at, messageId);
    }
    return next;
  });
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export function deliveriesFor(db: Db, recipient: string, states: DeliveryState[]): DeliveryWithMessage[] {
  const rows = db
    .prepare(
      `SELECT d.*, m.id AS m_id FROM deliveries d JOIN messages m ON m.id = d.message_id
       WHERE d.recipient = ? AND d.state IN (${placeholders(states.length)}) ORDER BY m.id`,
    )
    .all(recipient, ...states) as unknown as Array<DeliveryRow & { m_id: string }>;
  return rows.map(({ m_id, ...d }) => ({ ...d, message: getMessage(db, m_id) as MessageRow }));
}

/**
 * A session left the provisional name the broker gave it: its undelivered deliveries addressed to the old name move to
 * the new one, in one transaction. Messages stay as sent (`to_target` is not rewritten); each moved delivery gets an
 * event under the new recipient saying where it came from. A delivery whose message already has a row for the new
 * recipient (an `all` broadcast that reached both names) is left where it is (primary-key collision). `canMove` is the
 * caller's veto (scope, in-flight push).
 */
export function moveDeliveries(
  db: Db,
  from: string,
  to: string,
  canMove: (d: DeliveryWithMessage) => boolean,
): DeliveryRow[] {
  return tx(db, () => {
    const moved: DeliveryRow[] = [];
    const upd = db.prepare('UPDATE OR IGNORE deliveries SET recipient = ? WHERE message_id = ? AND recipient = ?');
    const ev = db.prepare(
      'INSERT INTO delivery_events (message_id, recipient, from_state, to_state, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const at = nowIso();
    for (const d of deliveriesFor(db, from, ['pending', 'held', 'stuck', 'failed'])) {
      if (!canMove(d)) continue;
      if (Number(upd.run(to, d.message_id, from).changes) !== 1) continue;
      ev.run(d.message_id, to, d.state, d.state, `forwarded from ${from}`, at);
      moved.push(getDelivery(db, d.message_id, to) as DeliveryRow);
    }
    return moved;
  });
}

export const deliveriesByState = (db: Db, states: DeliveryState[]): DeliveryRow[] =>
  db
    .prepare(`SELECT * FROM deliveries WHERE state IN (${placeholders(states.length)}) ORDER BY message_id`)
    .all(...states) as unknown as DeliveryRow[];

export const deliveriesOfMessage = (db: Db, messageId: string): DeliveryRow[] =>
  db
    .prepare('SELECT * FROM deliveries WHERE message_id = ? ORDER BY recipient')
    .all(messageId) as unknown as DeliveryRow[];

export function feed(db: Db, q: { before?: string; limit: number; name?: string }): MessageRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (q.before) {
    where.push('id < ?');
    args.push(q.before);
  }
  if (q.name) {
    where.push(`(from_name = ? OR to_target = ? OR to_target = 'all')`);
    args.push(q.name, q.name);
  }
  const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, q.limit)
    .map((r) => msg(r) as MessageRow);
}

export const findRequest = (db: Db, requestId: string) =>
  msg(db.prepare(`SELECT * FROM messages WHERE request_id = ? AND kind = 'request'`).get(requestId));

export const findResponse = (db: Db, requestId: string) =>
  msg(db.prepare(`SELECT * FROM messages WHERE request_id = ? AND kind = 'response'`).get(requestId));

export const unreadCount = (db: Db, name: string): number =>
  (
    db.prepare(`SELECT count(*) AS n FROM deliveries WHERE recipient = ? AND state <> 'read'`).get(name) as {
      n: number;
    }
  ).n;
