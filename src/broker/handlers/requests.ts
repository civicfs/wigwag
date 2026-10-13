import { WigwagError } from '../../errors.js';
import { newId } from '../../ids.js';
import { findRequest, findResponse, type MessageRow } from '../../store/messages.js';
import type { Connection } from '../connection.js';
import { connCanSee } from '../scope.js';
import type { Broker } from '../server.js';
import { deliveryReceipt, markRead, myName, sendMessage, stillMine } from './messages.js';

export type RequestSummary = {
  request_id: string;
  message_id: string;
  from: string;
  to: string;
  subject: string;
  status: 'open' | 'answered' | 'expired';
  created_at: string;
  expires_at: string | null;
  response_id: string | null;
};

const MAX_TIMER_MS = 2_147_483_647;
let requestWaiters: Map<string, unknown> | null = null;

/** Test hook: number of request ids with pending awaits. */
export const pendingAwaitCount = (): number => requestWaiters?.size ?? 0;

/**
 * setTimeout that survives delays above the 32-bit limit: waits in bounded chunks and, after each
 * chunk, re-reads the remaining time via `remaining` before firing. Returns a cancel function.
 */
export function scheduleChunked(
  delayMs: number,
  fire: () => void,
  remaining: () => number,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
): () => void {
  let t: NodeJS.Timeout;
  const arm = (ms: number) => {
    t = timers.set(
      () => {
        const left = remaining();
        if (left > 0) arm(left);
        else fire();
      },
      Math.max(0, Math.min(ms, MAX_TIMER_MS)),
    );
  };
  arm(delayMs);
  return () => timers.clear(t);
}

export function installRequests(broker: Broker): void {
  const db = broker.db;
  type Waiter = { settle: (m: MessageRow | null) => void };
  const waiters = new Map<string, Set<Waiter>>();
  const cancels = new Set<() => void>();
  requestWaiters = waiters;

  const settleAll = (requestId: string, m: MessageRow | null) => {
    const set = waiters.get(requestId);
    waiters.delete(requestId);
    for (const w of set ?? []) w.settle(m);
  };

  const statusOf = (req: MessageRow): RequestSummary['status'] => {
    if (req.request_id && findResponse(db, req.request_id)) return 'answered';
    if (req.expires_at && Date.parse(req.expires_at) <= Date.now()) return 'expired';
    return 'open';
  };
  /** R42-B: a request (or response) outside the caller's scope is reported exactly like a missing one. */
  const visibleRequest = (conn: Connection, requestId: string): MessageRow => {
    const req = findRequest(db, requestId);
    if (!req || !connCanSee(db, conn, req)) throw new WigwagError('not_found', `Request not found: ${requestId}`);
    return req;
  };

  /** R46-6: the response id is listed only when the caller can see that response. */
  const visibleResponseId = (conn: Connection, req: MessageRow): string | null => {
    const resp = req.request_id ? findResponse(db, req.request_id) : undefined;
    return resp && connCanSee(db, conn, resp) ? resp.id : null;
  };

  const summary = (req: MessageRow, conn: Connection): RequestSummary => ({
    request_id: req.request_id as string,
    message_id: req.id,
    from: req.from_name,
    to: req.to_target,
    subject: req.subject,
    status: statusOf(req),
    created_at: req.created_at,
    expires_at: req.expires_at,
    response_id: visibleResponseId(conn, req),
  });

  const expiryNotice = (req: MessageRow) => {
    const subject = `request expired: ${req.request_id}`;
    const exists = db
      .prepare(
        `SELECT 1 FROM messages WHERE kind = 'notice' AND from_name = 'wigwag' AND to_target = ? AND subject = ?`,
      )
      .get(req.from_name, subject);
    if (exists) return;
    broker.engine
      ?.notice(
        req.from_name,
        subject,
        `Your request "${req.subject}" to ${req.to_target} expired without a response.`,
        { from_workspace: req.from_workspace }, // R46-N3: keeps the request's provenance
      )
      .catch((e) => broker.log(`expiry notice failed: ${(e as Error).message}`));
  };

  const scheduleExpiry = (req: MessageRow) => {
    if (!req.expires_at) return;
    const cancel = scheduleChunked(
      Date.parse(req.expires_at) - Date.now(),
      () => {
        cancels.delete(cancel);
        if (statusOf(req) !== 'expired') return;
        settleAll(req.request_id as string, null);
        expiryNotice(req);
      },
      () => Date.parse(req.expires_at as string) - Date.now(),
    );
    cancels.add(cancel);
  };

  broker.onStart.push(() => {
    const rows = db
      .prepare(`SELECT request_id FROM messages WHERE kind = 'request' AND expires_at IS NOT NULL`)
      .all() as Array<{ request_id: string }>;
    for (const { request_id } of rows) {
      const row = findRequest(db, request_id);
      if (!row) continue;
      const st = statusOf(row);
      if (st === 'open') scheduleExpiry(row);
      else if (st === 'expired') expiryNotice(row);
    }
  });
  broker.onStop.push(() => {
    for (const c of cancels) c();
    cancels.clear();
    for (const id of [...waiters.keys()]) settleAll(id, null);
  });

  broker.handle('req.request', async ({ conn }, p) => {
    const request_id = newId('req');
    const m = await sendMessage(broker, {
      from: myName(broker, conn),
      to: p.to,
      kind: 'request',
      priority: 'normal',
      subject: p.subject,
      body: p.body,
      attachments: p.attachments,
      request_id,
      expires_at: p.expires_in_s ? new Date(Date.now() + p.expires_in_s * 1000).toISOString() : null,
      onInserted: scheduleExpiry,
    });
    return { request_id, message_id: m.id, deliveries: deliveryReceipt(broker, m.id) };
  });

  broker.handle('req.respond', async ({ conn }, p) => {
    const me = myName(broker, conn);
    const req = visibleRequest(conn, p.request_id);
    if (req.to_target !== me)
      throw new WigwagError('bad_request', `Request ${p.request_id} is addressed to ${req.to_target}, not ${me}`);
    const status = statusOf(req);
    if (status !== 'open') throw new WigwagError('conflict', `Request ${p.request_id} is already ${status}`);
    const m = await sendMessage(broker, {
      from: me,
      to: req.from_name,
      kind: 'response',
      priority: 'normal',
      subject: `${p.status === 'ok' ? 'Response' : 'Error response'}: ${req.subject}`.slice(0, 200),
      body: p.body,
      attachments: p.attachments,
      reply_to: req.id,
      request_id: p.request_id,
    });
    if (stillMine(broker, conn, me, req)) markRead(broker, req.id, me); // R46-N2: re-check after the awaited push
    settleAll(p.request_id, m);
    return { message_id: m.id, deliveries: deliveryReceipt(broker, m.id) };
  });

  broker.handle('req.await', async ({ conn }, p) => {
    const me = myName(broker, conn);
    const req = visibleRequest(conn, p.request_id);
    if (req.from_name !== me) throw new WigwagError('bad_request', `Request ${p.request_id} was not sent by ${me}`);
    const finish = (got: MessageRow | null) => {
      // R42-B / R46-6: re-check the request and the response right before returning (links may have changed while
      // waiting); a request that is no longer visible is reported like a missing one.
      if (!connCanSee(db, conn, req)) throw new WigwagError('not_found', `Request not found: ${p.request_id}`);
      // Final review I-4 (R48): a caller that no longer holds `me` (renamed while waiting, name taken by another
      // session) must not read or receive the response, which is now addressed to the new holder.
      const resp = got && stillMine(broker, conn, me, got) ? got : null;
      if (resp) markRead(broker, resp.id, me);
      return { status: statusOf(req), response: resp };
    };
    const existing = findResponse(db, p.request_id);
    if (existing || statusOf(req) === 'expired' || p.wait_s === 0) return finish(existing ?? null);
    const waitMs = Math.min(p.wait_s, broker.config.limits.max_await_s) * 1000;
    const resp = await new Promise<MessageRow | null>((resolve) => {
      const set = waiters.get(p.request_id) ?? new Set<Waiter>();
      const w: Waiter = {
        settle: (m) => {
          clearTimeout(t);
          set.delete(w);
          if (set.size === 0 && waiters.get(p.request_id) === set) waiters.delete(p.request_id);
          resolve(m);
        },
      };
      const t = setTimeout(() => w.settle(null), waitMs);
      set.add(w);
      waiters.set(p.request_id, set);
    });
    return finish(resp);
  });

  broker.handle('req.list', ({ conn }, p) => {
    const rows = (
      db.prepare(`SELECT request_id FROM messages WHERE kind = 'request' ORDER BY id`).all() as Array<{
        request_id: string;
      }>
    )
      .map((r) => findRequest(db, r.request_id) as MessageRow)
      .filter((r) => conn.role === 'owner' || [r.from_name, r.to_target].includes(myName(broker, conn)))
      .filter((r) => connCanSee(db, conn, r))
      .map((r) => summary(r, conn))
      .filter((s) => p.status === 'all' || s.status === p.status);
    return { requests: rows };
  });
}
