import { WigwagError } from '../../errors.js';
import { addBlobScope, type BlobRow, blobInScope, getBlobMeta, putBlob } from '../../store/blobs.js';
import { inScope, scopeFor } from '../../store/links.js';
import {
  type DeliveryState,
  deliveriesFor,
  getMessage,
  insertMessage,
  type MessageKind,
  type MessageRow,
  type Priority,
  transition,
} from '../../store/messages.js';
import { assignedNamesWithWorkspace, getSession, holderOf } from '../../store/sessions.js';
import { addMute, removeMute } from '../../store/subs.js';
import type { Connection } from '../connection.js';
import { connCanSee, scopeViolation, senderWorkspace, visibleUnreadCount } from '../scope.js';
import type { Broker } from '../server.js';

export type InboxItem = { message: MessageRow; delivery_state: DeliveryState; attachments: BlobRow[] };

export function myName(broker: Broker, conn: Connection): string {
  const s = conn.sessionId ? getSession(broker.db, conn.sessionId) : undefined;
  if (!s?.name) throw new WigwagError('not_registered', 'This session has no name yet; call register');
  return s.name;
}

export function prepareBody(
  broker: Broker,
  from: string,
  body: string,
  attachments: string[],
): { body: string; attachments: string[] } {
  // Spec §17: a scoped sender may attach only blobs stored or received in its scope.
  const ws = senderWorkspace(broker.db, from);
  const scope = scopeFor(broker.db, ws);
  for (const ref of attachments) {
    if (!blobInScope(broker.db, ref, scope)) throw new WigwagError('not_found', `Attachment not found: ${ref}`);
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes <= broker.config.limits.inline_body_bytes) return { body, attachments };
  const blob = putBlob(
    broker.db,
    broker.home,
    Buffer.from(body, 'utf8'),
    { media_type: 'text/plain; charset=utf-8', name: 'body.txt', created_by: from },
    broker.config.limits.max_blob_bytes,
  );
  if (ws !== null) addBlobScope(broker.db, blob.ref, ws);
  return {
    body: `[body stored as blob ${blob.ref} (${bytes} bytes, text/plain; charset=utf-8) — fetch with blob_get]`,
    attachments: [blob.ref, ...attachments],
  };
}

export async function sendMessage(
  broker: Broker,
  input: {
    from: string;
    to: string;
    kind: MessageKind;
    priority: Priority;
    subject: string;
    body: string;
    attachments: string[];
    reply_to?: string | null;
    request_id?: string | null;
    expires_at?: string | null;
    /** Called synchronously once the message is persisted, before dispatch. */
    onInserted?: (m: MessageRow) => void;
  },
): Promise<MessageRow> {
  // Spec §17: recipients must share the sender's scope; owner and wigwag reach every workspace.
  const fromWorkspace = senderWorkspace(broker.db, input.from);
  let recipients: string[];
  if (input.to === 'all') {
    const scope = scopeFor(broker.db, fromWorkspace);
    recipients = assignedNamesWithWorkspace(broker.db)
      .filter((r) => r.name !== input.from && inScope(scope, r.workspace))
      .map((r) => r.name);
  } else {
    const violation = scopeViolation(broker.db, fromWorkspace, input.to);
    if (violation) throw new WigwagError('forbidden', violation);
    recipients = [input.to];
  }
  const prepared = prepareBody(broker, input.from, input.body, input.attachments);
  const m = insertMessage(
    broker.db,
    {
      from_name: input.from,
      from_workspace: fromWorkspace,
      to_target: input.to,
      kind: input.kind,
      priority: input.priority,
      subject: input.subject,
      body: prepared.body,
      attachments: prepared.attachments,
      reply_to: input.reply_to ?? null,
      request_id: input.request_id ?? null,
      expires_at: input.expires_at ?? null,
      stream: null,
    },
    recipients,
  );
  broker.broadcastOwner('message', m);
  input.onInserted?.(m);
  // Final review I-7 (spec §6 "accepted once committed"): the caller gets its answer now; pushes (a codex queue call
  // can take up to codex.queue_timeout_ms) run detached and their failures go through the delivery engine.
  broker.engine?.dispatchMessage(m.id).catch((e) => broker.log(`dispatch of ${m.id} failed: ${(e as Error).message}`));
  return m;
}

/** Mark a delivery read and tell the owner feed (unread counts). Returns false if it is not addressed to `me`. */
export function markRead(broker: Broker, messageId: string, me: string): boolean {
  try {
    // The caller holds `me` (checked by the caller in the same tick), so its workspace receives the attachments.
    const row = transition(broker.db, messageId, me, 'read', { grant_workspace: holderOf(broker.db, me)?.workspace });
    broker.broadcastOwner('delivery', { ...row, recipient_unread: visibleUnreadCount(broker.db, me) });
    return true;
  } catch (e) {
    if (e instanceof WigwagError && e.code === 'not_found') return false;
    throw e;
  }
}

/** R46-N2: after an await, the caller still holds `me` and can still see `m`. */
export function stillMine(broker: Broker, conn: Connection, me: string, m: MessageRow): boolean {
  const s = conn.sessionId ? getSession(broker.db, conn.sessionId) : undefined;
  return s?.name === me && connCanSee(broker.db, conn, m);
}

const UNREAD: DeliveryState[] = ['pending', 'held', 'pushed', 'failed', 'stuck'];

export function installMessages(broker: Broker): void {
  const db = broker.db;

  broker.handle('msg.send', async ({ conn }, p) => {
    const m = await sendMessage(broker, { from: myName(broker, conn), kind: 'message', ...p });
    return { id: m.id };
  });

  broker.handle('msg.reply', async ({ conn }, p) => {
    const me = myName(broker, conn);
    const orig = getMessage(db, p.msg_id);
    // R42-B: an original outside the caller's scope is reported exactly like a missing one.
    if (!orig || !connCanSee(db, conn, orig)) throw new WigwagError('not_found', `Message not found: ${p.msg_id}`);
    const m = await sendMessage(broker, {
      from: me,
      to: orig.from_name,
      kind: 'message',
      priority: p.priority,
      subject: `Re: ${orig.subject}`.slice(0, 200),
      body: p.body,
      attachments: p.attachments,
      reply_to: orig.id,
    });
    // R46-N2: the send awaited a push; links or the caller's name may have changed since. Re-check before marking.
    if (stillMine(broker, conn, me, orig)) markRead(broker, orig.id, me); // false when not addressed to me; allowed
    return { id: m.id };
  });

  broker.handle('msg.inbox', ({ conn }, p) => {
    const me = myName(broker, conn);
    const rows = deliveriesFor(db, me, p.include_read ? [...UNREAD, 'read'] : UNREAD)
      .filter((r) => connCanSee(db, conn, r.message)) // R42-B: never return or mark read what the caller cannot see
      .slice(-p.limit);
    const messages: InboxItem[] = rows.map((r) => ({
      message: r.message,
      delivery_state: r.state,
      attachments: r.message.attachments.flatMap((ref) => {
        const b = getBlobMeta(db, ref);
        return b ? [b] : [];
      }),
    }));
    for (const r of rows) if (r.state !== 'read') markRead(broker, r.message_id, me);
    return { messages };
  });

  broker.handle('msg.ack', ({ conn }, p) => {
    const me = myName(broker, conn);
    let acked = 0;
    for (const id of p.ids) {
      const m = getMessage(db, id);
      if (m && connCanSee(db, conn, m) && markRead(broker, id, me)) acked++;
    }
    return { acked };
  });

  broker.handle('mute.add', ({ conn }, p) => {
    addMute(db, myName(broker, conn), p.target);
    return {};
  });
  broker.handle('mute.remove', ({ conn }, p) => {
    removeMute(db, myName(broker, conn), p.target);
    return {};
  });
}
