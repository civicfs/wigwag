import type { Config } from '../config.js';
import type { FeedData } from '../protocol/rpc.js';
import { getBlobMeta } from '../store/blobs.js';
import type { Db } from '../store/db.js';
import {
  type DeliveryRow,
  type DeliveryState,
  deliveriesByState,
  deliveriesFor,
  deliveriesOfMessage,
  deliveryRecipient,
  getMessage,
  insertMessage,
  moveDeliveries,
  type Priority,
  settleForward,
  type TransitionPatch,
  transitionIf,
} from '../store/messages.js';
import { getSession, holderOf, type SessionRow } from '../store/sessions.js';
import { activeThrottles, addThrottle, isMuted, isThrottled, releaseThrottle } from '../store/subs.js';
import type { CodexPushProof, TransportRegistry } from '../transports/types.js';
import { codexPushHold, codexPushLabel } from './codex-push.js';
import { decide } from './policy.js';
import { WakeLimiter } from './ratelimit.js';
import { type RecipientState, recipientState } from './registry.js';
import { type RenderItem, renderDigest } from './render.js';
import { nativeRecipientMatches, scopeViolation, visibleUnreadCount } from './scope.js';

export interface EngineDeps {
  db: Db;
  config: Config;
  transports: TransportRegistry;
  emitFeed: (type: FeedData['type'], payload: unknown) => void;
  log: (line: string) => void;
  now?: () => number;
  codexPushTrust?: (session: SessionRow) => Promise<string | null>;
  codexQuestionPush?: (session: SessionRow) => Promise<() => void>;
}

type Key = { message_id: string; recipient: string };
const SYSTEM_SENDERS = new Set(['owner', 'wigwag']);
const OWNER = 'owner';
/** Delivery transport recorded for messages addressed to the owner (read in the owner feed, not pushed to a session). */
const OWNER_FEED = 'owner-feed';
// Held-item text for a live Claude session that cannot take a channel push (hold_reason `unbound` either way: the stored
// reasons are a fixed enum). Bound: its hooks work, so the turn boundary delivers and the fix is the launch flag. Not
// bound: the MCP server is connected but no hook has matched it, so no turn boundary can deliver either; the launch
// advice would be wrong (a session started with `wigwag claude` shows this too when its hooks fail to bind).
const NO_CHANNEL =
  'this Claude session did not load the wigwag channel (start it with: wigwag claude); delivered at its next turn boundary or by inbox';
const UNBOUND_NO_CHANNEL =
  'this Claude session is connected but no wigwag hook has bound to it yet (see "not bound" in broker.log) and its MCP server reported no usable channel, so it cannot be pushed to or reached at a turn boundary; delivered by inbox, or at a turn boundary once a hook binds it';

export class DeliveryEngine {
  private readonly limiter: WakeLimiter;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly now: () => number;
  /** Deliveries whose transport call is running. Keyed `message_id\0recipient`. */
  private readonly inflight = new Set<string>();
  /** Running transport pushes; a graceful stop waits for them (final review I-10). */
  private readonly running = new Set<Promise<void>>();
  private readonly recipientQueues = new Map<string, Promise<void>>();
  private readonly abortPushes = new AbortController();
  private drained = false;
  private stopped = false;
  private readonly throttleSchedules = new Map<string, symbol>();

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.limiter = new WakeLimiter(d.config.rate.wake_pushes, d.config.rate.window_s * 1000, this.now);
  }

  private static id(k: Key): string {
    return `${k.message_id}\u0000${k.recipient}`;
  }

  /** Preserve commit order within a recipient without holding up another recipient or the accepting RPC. */
  private enqueue(recipient: string, run: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.recipientQueues.get(recipient);
    const p = previous
      ? previous
          .catch(() => {})
          .then(() => {
            if (!this.stopped) return run();
          })
      : run();
    this.recipientQueues.set(recipient, p);
    this.running.add(p);
    const done = () => {
      this.running.delete(p);
      if (this.recipientQueues.get(recipient) === p) this.recipientQueues.delete(recipient);
    };
    p.then(done, done);
    return p;
  }

  /** The recipient's state; a live Claude session without a usable channel reads `no-channel` (E-3). */
  private recipient(name: string): { state: RecipientState; session?: SessionRow } {
    return recipientState(this.d.db, name, (s) => this.d.transports.claude.hasChannel?.(s) ?? true);
  }

  private busy(k: Key): boolean {
    return this.inflight.has(DeliveryEngine.id(k));
  }

  /** Only broker-created native relays bypass the ordinary peer-message wake quota. */
  private nativeQuestion(messageId: string): boolean {
    return !!this.d.db
      .prepare(
        "SELECT 1 FROM question_relays q JOIN assignments a ON a.id=q.assignment_id WHERE q.message_id=? AND q.state='pending' AND a.ended_at IS NULL",
      )
      .get(messageId);
  }

  private move(k: Key, to: DeliveryState, patch: TransitionPatch = {}) {
    return this.moveIf(k, null, to, patch) as DeliveryRow;
  }

  /** Conditional move (R46-N1): null, with no feed event, when the delivery is no longer in `onlyFrom`. */
  private moveIf(k: Key, onlyFrom: DeliveryState[] | null, to: DeliveryState, patch: TransitionPatch = {}) {
    const row = transitionIf(this.d.db, k.message_id, k.recipient, onlyFrom, to, patch);
    if (row) {
      const recipient = deliveryRecipient(this.d.db, row) ?? row.forward_to ?? row.recipient;
      this.d.emitFeed('delivery', { ...row, recipient, recipient_unread: visibleUnreadCount(this.d.db, recipient) });
    }
    return row;
  }

  /**
   * Delivered into the model's context (a channel push, a codex queue call, a hook digest): `pushed`, then at once
   * `read`, both logged in delivery_events. The recipient's unread count and default inbox exclude it; history and
   * `show` keep the transport and both events. Spec §5: delivery into the context counts as reading.
   */
  private delivered(k: Key, onlyFrom: DeliveryState[] | null, patch: TransitionPatch): void {
    const row = this.moveIf(k, onlyFrom, 'pushed', patch);
    if (row) this.moveIf(k, ['pushed'], 'read', { detail: `delivered via ${patch.transport}` });
  }

  private stateOf(k: Key): DeliveryState | undefined {
    return deliveriesOfMessage(this.d.db, k.message_id).find((x) => x.recipient === k.recipient)?.state;
  }

  private items(keys: Key[]): RenderItem[] {
    return keys.map((k) => {
      const msg = getMessage(this.d.db, k.message_id);
      if (!msg) throw new Error(`message vanished: ${k.message_id}`);
      const attachments = msg.attachments.flatMap((ref) => {
        const b = getBlobMeta(this.d.db, ref);
        return b ? [b] : [];
      });
      return { msg, attachments, nativeQuestion: this.nativeQuestion(msg.id) };
    });
  }

  /**
   * Spec §17 scope check, run before anything is pushed or held for a recipient: a message from a scoped sender whose
   * recipient (current or last holder) is outside the sender's scope becomes `stuck` and the sender gets a low notice.
   */
  private allowed(k: Key): boolean {
    const msg = getMessage(this.d.db, k.message_id);
    const delivery = deliveriesOfMessage(this.d.db, k.message_id).find((d) => d.recipient === k.recipient);
    const recipient = delivery ? deliveryRecipient(this.d.db, delivery) : k.recipient;
    if (!recipient) return false;
    if (msg && !nativeRecipientMatches(this.d.db, recipient, msg)) {
      this.move(k, 'stuck', { last_error: 'Native assignment recipient binding changed', next_attempt_at: null });
      return false;
    }
    const reason = msg ? scopeViolation(this.d.db, msg.from_workspace, recipient) : null;
    if (!msg || reason === null) return true;
    this.move(k, 'stuck', { last_error: reason, next_attempt_at: null });
    if (SYSTEM_SENDERS.has(msg.from_name)) return false;
    this.notice(
      msg.from_name,
      `delivery stuck: ${k.message_id} → ${k.recipient}`,
      `wigwag did not deliver ${k.message_id} ("${msg.subject}") to ${k.recipient}.\n${reason}`,
      { from_workspace: msg.from_workspace }, // R46-N3: a notice about a message keeps that message's provenance
    ).catch((e) => this.d.log(`scope notice failed: ${(e as Error).message}`));
    return false;
  }

  /**
   * R42-D: a name was claimed, resumed or bound — sweep its held/pending backlog through the scope check. In-flight
   * keys are swept too: their push then completes only from the state it started in (R46-N1), so a sweep wins.
   */
  sweep(name: string): void {
    for (const x of deliveriesFor(this.d.db, name, ['held', 'pending'])) {
      this.allowed({ message_id: x.message_id, recipient: x.recipient });
    }
  }

  /**
   * A session moved from name `from` to `to` (any rename, W2a): its undelivered deliveries follow it (append-only
   * history is untouched). In-flight pushes follow once settled; a message the new name's scope cannot receive is not moved
   * (spec §17). Pending and failed deliveries are dispatched again under the new name (their timers and queued
   * dispatches were keyed by the old one); held ones are picked up by the `session.available` sweep that follows.
   */
  /** Name reuse cannot erase stable ownership. Complete any already-settled handoffs before publishing it. */
  nameClaimed(_sessionId: string, _name: string): void {
    this.settleForwards();
  }

  /** Recovery keeps exact row ownership even if it interrupted a previous rename. */
  transferForwards(provisionalId: string, canonicalId: string, _to: string): void {
    this.d.db.prepare('UPDATE deliveries SET forward_to=? WHERE forward_to=?').run(canonicalId, provisionalId);
  }

  private forwarded(rows: DeliveryRow[]): void {
    for (const row of rows) {
      this.d.emitFeed('delivery', { ...row, recipient_unread: visibleUnreadCount(this.d.db, row.recipient) });
      if (row.state === 'pending' || row.state === 'failed')
        this.dispatch(row.message_id, row.recipient).catch((e) =>
          this.d.log(`dispatch after forward failed: ${(e as Error).message}`),
        );
    }
  }

  /** In-flight keys remain physical until settled; their durable owner determines the current destination. */
  private settleForwards(sessionId?: string): number {
    const rows = this.d.db
      .prepare(`SELECT * FROM deliveries WHERE forward_to IS NOT NULL${sessionId ? ' AND forward_to=?' : ''}`)
      .all(...(sessionId ? [sessionId] : [])) as unknown as DeliveryRow[];
    const moved: DeliveryRow[] = [];
    for (const row of rows) {
      if (this.busy(row)) continue;
      const owner = row.forward_to ? getSession(this.d.db, row.forward_to) : undefined;
      const message = getMessage(this.d.db, row.message_id);
      if (!owner?.name || !message || scopeViolation(this.d.db, message.from_workspace, owner.name) !== null) continue;
      const next = settleForward(this.d.db, row, owner.name);
      if (next) moved.push(next);
    }
    this.forwarded(moved);
    return moved.length;
  }

  /** Pure data writes, safe inside the claim/adoption transaction. No events, dispatch or transport before commit. */
  prepareForward(from: string, to: string, sessionId: string, onlyMessageIds?: Set<string>): void {
    const holder = holderOf(this.d.db, from);
    if (from === to || (holder && holder.id !== sessionId)) return;
    const rows = deliveriesFor(this.d.db, from, ['pending', 'held', 'failed', 'stuck']);
    // Inspect only active chunks, not the name's potentially large delivered history.
    for (const key of this.inflight) {
      const separator = key.indexOf('\u0000');
      if (key.slice(separator + 1) !== from) continue;
      const id = key.slice(0, separator);
      const chunk = deliveriesOfMessage(this.d.db, id).find(
        (d) => d.recipient === from && (d.state === 'pushed' || d.state === 'read'),
      );
      const message = chunk ? getMessage(this.d.db, id) : undefined;
      if (chunk && message) rows.push({ ...chunk, message });
    }
    // Include already-pushed/read chunks whose transport is still running. Neither inbox history nor a new
    // source-name claimant may gain them while the physical key is needed by the old push callback.
    for (const row of rows) {
      if (onlyMessageIds && !onlyMessageIds.has(row.message_id)) continue;
      if (!['pending', 'held', 'failed', 'stuck'].includes(row.state) && !this.busy(row)) continue;
      // Ownership survives even when scope currently prevents completing the move. Never donate a skipped row
      // to a later source-name holder; settleForwards/allowed enforce the destination's current scope.
      this.d.db
        .prepare(`UPDATE deliveries SET forward_to=? WHERE message_id=? AND recipient=?
        AND (forward_to IS NULL OR forward_to=?)`)
        .run(sessionId, row.message_id, row.recipient, sessionId);
    }
  }

  forward(from: string, to: string, sessionId: string, onlyMessageIds?: Set<string>): number {
    const holder = holderOf(this.d.db, from);
    if (from === to || (holder && holder.id !== sessionId)) return 0;
    this.prepareForward(from, to, sessionId, onlyMessageIds);
    const settled = this.settleForwards(sessionId);
    const moved = moveDeliveries(
      this.d.db,
      from,
      to,
      (row) =>
        (!onlyMessageIds || onlyMessageIds.has(row.message_id)) &&
        !this.busy(row) &&
        scopeViolation(this.d.db, row.message.from_workspace, to) === null,
    );
    this.forwarded(moved);
    if (moved.length) this.d.log(`forwarded ${moved.length} undelivered message(s) from ${from} to ${to}`);
    return moved.length + settled;
  }

  /** Recipients are dispatched in parallel: one slow transport (a hung `codex queue`) does not delay the others. */
  async dispatchMessage(messageId: string): Promise<void> {
    const pending = deliveriesOfMessage(this.d.db, messageId).filter((del) => del.state === 'pending');
    const results = await Promise.allSettled(pending.map((del) => this.dispatch(messageId, del.recipient)));
    for (const [i, r] of results.entries()) {
      if (r.status === 'rejected') {
        this.d.log(`dispatch ${messageId} -> ${pending[i].recipient} failed: ${(r.reason as Error)?.message}`);
      }
    }
  }

  dispatch(messageId: string, recipient: string): Promise<void> {
    return this.enqueue(recipient, () => this.dispatchNow(messageId, recipient));
  }

  private async dispatchNow(messageId: string, recipient: string): Promise<void> {
    const msg = getMessage(this.d.db, messageId);
    if (!msg) return;
    const k = { message_id: messageId, recipient };
    if (this.busy(k)) return;
    const cur = deliveriesOfMessage(this.d.db, messageId).find((x) => x.recipient === recipient);
    if (!cur || (cur.state !== 'pending' && cur.state !== 'failed' && cur.state !== 'held')) return;
    if (cur.forward_to) {
      this.settleForwards();
      return; // never dispatch a durable handoff under its reclaimed physical source name
    }
    if (!this.allowed(k)) return;
    if (recipient === OWNER) {
      // The owner is not a session: there is nothing to wake and no live/offline state. The message is committed and
      // the owner reads it from the feed (TUI) or `wigwag tail`/`show`, so it counts as delivered, never held.
      this.move(k, 'pushed', { transport: OWNER_FEED, last_error: null, next_attempt_at: null });
      return;
    }
    const rs = this.recipient(recipient);
    const nativeQuestion = this.nativeQuestion(messageId);
    const dec = decide({
      priority: msg.priority,
      recipient: rs.state,
      muted: isMuted(this.d.db, recipient, msg.from_name, msg.stream ?? undefined),
      throttled: !nativeQuestion && isThrottled(this.d.db, msg.from_name, recipient),
    });
    if (dec.action === 'hold') {
      if (dec.reason === 'throttled') this.scheduleThrottle(msg.from_name, recipient);
      this.move(k, 'held', {
        hold_reason: dec.reason,
        ...(rs.state === 'no-channel'
          ? { last_error: rs.session?.agent_session_id ? NO_CHANNEL : UNBOUND_NO_CHANNEL }
          : {}),
      });
      return;
    }
    // A retry of a failed push was already counted when it first dispatched; counting it again would
    // throttle the pair mid-backoff and hide the failure instead of ending in `stuck`.
    const isRetry = cur.state === 'failed';
    if (
      !isRetry &&
      !nativeQuestion &&
      !SYSTEM_SENDERS.has(msg.from_name) &&
      !this.limiter.tryConsume(msg.from_name, recipient)
    ) {
      addThrottle(this.d.db, msg.from_name, recipient);
      this.d.emitFeed('throttle', { from: msg.from_name, to: recipient, active: true });
      this.d.log(`throttled ${msg.from_name} -> ${recipient}`);
      this.move(k, 'held', { hold_reason: 'throttled' });
      this.scheduleThrottle(msg.from_name, recipient);
      return;
    }
    await this.push(rs.session as SessionRow, [k]);
  }

  private async push(session: SessionRow, wake: Key[]): Promise<void> {
    if (this.stopped) return;
    let release: (() => void) | undefined;
    try {
      try {
        if (session.agent === 'codex') release = await this.d.codexQuestionPush?.(session);
      } catch (e) {
        if (this.stopped || this.drained) return;
        const detail = `Codex push held: question relay preflight failed: ${e instanceof Error ? e.message : String(e)}; inbox delivery works`;
        const reason = (e as { data?: { hold_reason?: string } }).data?.hold_reason;
        const hold = reason === 'offline' || reason === 'disconnected' ? reason : 'codex-untrusted';
        this.d.log(detail);
        for (const k of wake)
          this.moveIf(k, ['pending', 'held', 'failed'], 'held', { hold_reason: hold, last_error: detail });
        return;
      }
      // This fresh trust check runs after native attachment I/O; its proof belongs only to the ensuing push.
      await this.pushPrepared(session, wake);
    } finally {
      release?.();
    }
  }

  private async pushPrepared(session: SessionRow, wake: Key[]): Promise<void> {
    if (this.stopped) return;
    let codexPushProof: CodexPushProof | undefined;
    if (session.agent === 'codex' && this.d.codexPushTrust) {
      const reason = await this.d.codexPushTrust(session);
      if (this.stopped) return;
      if (reason) {
        for (const k of wake)
          this.moveIf(k, ['pending', 'held', 'failed'], 'held', {
            hold_reason: codexPushHold(reason),
            last_error: codexPushLabel(reason),
          });
        return;
      }
      codexPushProof = {
        sessionId: session.id,
        nativeId: session.agent_session_id,
        generation: session.conn_generation,
        checkedAt: this.now(),
      };
    }
    const transport = session.agent === 'claude' ? this.d.transports.claude : this.d.transports.codex;
    // Codex cannot be shown hook context reliably (spike S4), so a wake push to Codex also carries its held
    // low/muted items. This never wakes Codex on its own: it only rides along with a push that already wakes.
    const ride =
      session.agent === 'codex' && session.name
        ? deliveriesFor(this.d.db, session.name, ['held'])
            .filter((x) => x.hold_reason === 'low' || x.hold_reason === 'muted')
            .map((x) => ({ message_id: x.message_id, recipient: x.recipient }))
            .filter((k) => !wake.some((w) => w.message_id === k.message_id) && !this.busy(k))
        : [];
    // Spec §17: out-of-scope keys (including Codex ride-along items) become stuck here and are not pushed.
    const allowedKeys = [...wake, ...ride].filter(
      (k) => ['pending', 'held', 'failed'].includes(this.stateOf(k) ?? '') && this.allowed(k),
    );
    // Final review I-11: an item this transport can never carry (over the codex argv budget) is stuck at once, with a
    // notice, instead of being retried max_attempts times; it also never blocks the wake push it would ride along.
    const pairs = allowedKeys.flatMap((k) => {
      const item = this.items([k])[0];
      const why = transport.tooLarge?.(item) ?? null;
      if (why === null) return [{ k, item }];
      this.unpushable(k, why);
      return [];
    });
    const keys = pairs.map((x) => x.k);
    if (!keys.length) return;
    // R46-N1: each key's state when the push starts, and the receiving session (its workspace is the only one granted
    // the attachments). A completion that finds another state (swept to stuck, read) is dropped.
    const started = keys.map((k) => ({ k, from: this.stateOf(k) as DeliveryState }));
    const due = new Set(wake.map((k) => DeliveryEngine.id(k)));
    // Claimed synchronously (no await since the ride list was read), so a concurrent push cannot also take them.
    for (const k of keys) this.inflight.add(DeliveryEngine.id(k));
    const markPushed = (ids: Set<string>) => {
      if (this.drained) return; // the bounded shutdown may already have released the db
      for (const { k, from } of started) {
        if (!ids.has(k.message_id)) continue;
        try {
          this.delivered(k, [from], {
            transport: transport.kind,
            last_error: null,
            next_attempt_at: null,
            grant_workspace: session.workspace,
          });
        } catch (e) {
          this.d.log(`marking ${k.message_id} -> ${k.recipient} pushed failed: ${(e as Error).message}`);
        }
      }
    };
    try {
      let err: Error | null = null;
      try {
        await transport.push(
          session,
          pairs.map((x) => x.item),
          {
            signal: this.abortPushes.signal,
            onPushed: (items) => markPushed(new Set(items.map((it) => it.msg.id))),
            codexPushProof,
          },
        );
      } catch (e) {
        err = e as Error;
      }
      if (this.drained) return;
      if (err) {
        // Ride-along items were never due: they stay held and ride again on the next wake push.
        for (const { k, from } of started) {
          if (!due.has(DeliveryEngine.id(k))) continue;
          try {
            if (this.stateOf(k) !== from) continue; // changed during the push (swept, read): not ours to fail
            const blocked = (err as { data?: { hold_reason?: string } }).data?.hold_reason;
            if (blocked === 'codex-untrusted' || blocked === 'disconnected' || blocked === 'offline') {
              this.moveIf(k, [from], 'held', { hold_reason: blocked, last_error: err.message });
            } else if (session.agent === 'claude') {
              // No live channel is an offline hold, not a retryable failure.
              this.moveIf(k, [from], 'held', { hold_reason: 'offline', last_error: (err as Error).message });
            } else {
              await this.fail(k, err);
            }
          } catch (e) {
            this.d.log(`failure handling for ${k.message_id} -> ${k.recipient} failed: ${(e as Error).message}`);
          }
        }
        return;
      }
      markPushed(new Set(keys.map((k) => k.message_id)));
    } finally {
      for (const k of keys) this.inflight.delete(DeliveryEngine.id(k));
      if (!this.drained) {
        this.settleForwards();
      }
    }
  }

  private unpushable(k: Key, why: string): void {
    const cur = deliveriesOfMessage(this.d.db, k.message_id).find((x) => x.recipient === k.recipient);
    const attempts = (cur?.attempts ?? 0) + 1;
    this.move(k, 'stuck', { attempts, last_error: why, next_attempt_at: null });
    const msg = getMessage(this.d.db, k.message_id);
    if (!msg || SYSTEM_SENDERS.has(msg.from_name)) return;
    // Deferred: push() is still selecting and claiming its keys synchronously; the notice dispatches after that.
    queueMicrotask(() => {
      this.notice(
        msg.from_name,
        `delivery stuck: ${k.message_id} → ${k.recipient}`,
        `wigwag cannot deliver ${k.message_id} ("${msg.subject}") to ${k.recipient}: ${why}. Send a smaller message or put the content in a blob.`,
        { from_workspace: msg.from_workspace }, // R46-N3
      ).catch((e) => this.d.log(`unpushable notice failed: ${(e as Error).message}`));
    });
  }

  private async fail(k: Key, err: Error): Promise<void> {
    const cur = deliveriesOfMessage(this.d.db, k.message_id).find((x) => x.recipient === k.recipient);
    const attempts = (cur?.attempts ?? 0) + 1;
    if (attempts >= this.d.config.retry.max_attempts) {
      this.move(k, 'stuck', { attempts, last_error: err.message });
      const msg = getMessage(this.d.db, k.message_id);
      if (msg && !SYSTEM_SENDERS.has(msg.from_name)) {
        await this.notice(
          msg.from_name,
          `delivery stuck: ${k.message_id} → ${k.recipient}`,
          `wigwag could not deliver ${k.message_id} ("${msg.subject}") to ${k.recipient} after ${attempts} attempts.\nLast error: ${err.message}`,
          { from_workspace: msg.from_workspace }, // R46-N3
        );
      }
      return;
    }
    const delay = this.d.config.retry.base_ms * 2 ** (attempts - 1);
    this.move(k, 'failed', {
      attempts,
      last_error: err.message,
      next_attempt_at: new Date(this.now() + delay).toISOString(),
    });
    this.schedule(delay, () => this.retry(k));
  }

  /** Timer-driven retry: only a delivery that is still `failed` is pushed again. */
  private async retry(k: Key): Promise<void> {
    const cur = deliveriesOfMessage(this.d.db, k.message_id).find((x) => x.recipient === k.recipient);
    if (cur?.state !== 'failed') return;
    await this.dispatch(k.message_id, k.recipient);
  }

  private schedule(ms: number, f: () => Promise<void>): void {
    if (this.stopped) return;
    const t = setTimeout(
      () => {
        this.timers.delete(t);
        f().catch((e) => this.d.log(`scheduled dispatch failed: ${(e as Error).message}`));
      },
      Math.max(0, ms),
    );
    this.timers.add(t);
  }

  private scheduleThrottle(from: string, to: string): void {
    const key = `${from}\u0000${to}`;
    if (this.throttleSchedules.has(key) || this.stopped) return;
    const current = activeThrottles(this.d.db).find((t) => t.from_name === from && t.to_name === to);
    if (!current) return;
    const token = Symbol();
    this.throttleSchedules.set(key, token);
    const deadline = Date.parse(current.created_at) + this.d.config.rate.window_s * 1000;
    const arm = () =>
      this.schedule(Math.min(2147483647, Math.max(0, deadline - this.now())), async () => {
        if (this.throttleSchedules.get(key) !== token) return;
        if (deadline > this.now()) {
          arm();
          return;
        }
        this.throttleSchedules.delete(key);
        if (isThrottled(this.d.db, from, to)) await this.release(from, to);
      });
    arm();
  }

  /** System notice from "wigwag" to a session name. */
  async notice(
    to: string,
    subject: string,
    body: string,
    opts: { priority?: Priority; stream?: string; attachments?: string[]; from_workspace?: string | null } = {},
  ): Promise<void> {
    const m = insertMessage(
      this.d.db,
      {
        from_name: 'wigwag',
        // R42-C: data notices (KV watch, stream subscription) keep the data item's workspace as provenance.
        from_workspace: opts.from_workspace ?? null,
        to_target: to,
        kind: 'notice',
        priority: opts.priority ?? 'low',
        subject,
        body,
        attachments: opts.attachments ?? [],
        reply_to: null,
        request_id: null,
        expires_at: null,
        stream: opts.stream ?? null,
      },
      [to],
    );
    this.d.emitFeed('message', m);
    this.dispatchMessage(m.id).catch((e) => this.d.log(`notice dispatch failed: ${(e as Error).message}`));
  }

  /** A named session became reachable: push its offline/unbound backlog that would wake it, as one push. */
  onAvailable(session: SessionRow): Promise<void> {
    if (!session.name) return Promise.resolve();
    return this.enqueue(session.name, () => this.availableNow(session));
  }

  private async availableNow(session: SessionRow): Promise<void> {
    if (!session.name) return;
    const rs = this.recipient(session.name);
    if (rs.state === 'offline' || rs.state === 'unbound' || rs.state === 'no-channel' || rs.state === 'disconnected')
      return;
    const wake: Key[] = [];
    const backlog = deliveriesFor(this.d.db, session.name, ['held']).filter(
      (x) =>
        (x.hold_reason === 'offline' ||
          x.hold_reason === 'unbound' ||
          x.hold_reason === 'disconnected' ||
          x.hold_reason === 'codex-untrusted') &&
        !this.busy(x) &&
        this.allowed({ message_id: x.message_id, recipient: x.recipient }),
    );
    for (const x of backlog) {
      const k = { message_id: x.message_id, recipient: x.recipient };
      const dec = decide({
        priority: x.message.priority,
        recipient: rs.state,
        muted: isMuted(this.d.db, x.recipient, x.message.from_name, x.message.stream ?? undefined),
        throttled: !this.nativeQuestion(x.message_id) && isThrottled(this.d.db, x.message.from_name, x.recipient),
      });
      if (dec.action === 'push') wake.push(k);
      else this.move(k, 'held', { hold_reason: dec.reason });
    }
    if (wake.length) await this.push(rs.session as SessionRow, wake);
  }

  /** Turn boundary: everything held for `name` except throttled, as text; marks it pushed via the hook. */
  takeDigest(name: string): string | null {
    const held = deliveriesFor(this.d.db, name, ['held']).filter(
      (x) =>
        x.hold_reason !== 'throttled' &&
        !this.busy(x) &&
        this.allowed({ message_id: x.message_id, recipient: x.recipient }),
    );
    if (!held.length) return null;
    const keys = held.map((x) => ({ message_id: x.message_id, recipient: x.recipient }));
    const text = renderDigest(this.items(keys));
    const receiver = holderOf(this.d.db, name)?.workspace;
    for (const k of keys) this.delivered(k, null, { transport: 'hook', last_error: null, grant_workspace: receiver });
    return text;
  }

  /** Clears the pair's throttle, then pushes its throttled backlog as ONE push using one limiter slot. */
  release(from: string, to: string): Promise<void> {
    return this.enqueue(to, () => this.releaseNow(from, to));
  }

  private async releaseNow(from: string, to: string): Promise<void> {
    this.throttleSchedules.delete(`${from}\u0000${to}`);
    releaseThrottle(this.d.db, from, to);
    this.limiter.reset(from, to);
    this.d.emitFeed('throttle', { from, to, active: false });
    const held = deliveriesFor(this.d.db, to, ['held']).filter(
      (x) =>
        x.hold_reason === 'throttled' &&
        x.message.from_name === from &&
        !this.busy(x) &&
        this.allowed({ message_id: x.message_id, recipient: x.recipient }),
    );
    if (!held.length) return;
    const rs = this.recipient(to);
    const wake: Key[] = [];
    for (const x of held) {
      const k = { message_id: x.message_id, recipient: x.recipient };
      const dec = decide({
        priority: x.message.priority,
        recipient: rs.state,
        muted: isMuted(this.d.db, to, from, x.message.stream ?? undefined),
        throttled: false,
      });
      if (dec.action === 'push') wake.push(k);
      else this.move(k, 'held', { hold_reason: dec.reason });
    }
    if (!wake.length) return;
    if (!SYSTEM_SENDERS.has(from)) this.limiter.tryConsume(from, to);
    await this.push(rs.session as SessionRow, wake);
  }

  /** Broker start: every session is offline, so pending become held(offline); failed are rescheduled. */
  async resumeAll(): Promise<void> {
    this.settleForwards();
    for (const t of activeThrottles(this.d.db)) this.scheduleThrottle(t.from_name, t.to_name);
    for (const x of deliveriesByState(this.d.db, ['pending'])) await this.dispatch(x.message_id, x.recipient);
    for (const x of deliveriesByState(this.d.db, ['failed'])) {
      const at = x.next_attempt_at ? Date.parse(x.next_attempt_at) : this.now();
      this.schedule(at - this.now(), () => this.retry(x));
    }
  }

  stop(): void {
    this.throttleSchedules.clear();
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * Final review I-10: after stop(), waits for running pushes to record their outcome (the db is still open), at
   * most `timeoutMs`. A push that succeeds during a graceful shutdown is then not pushed again after a restart.
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.drained || !this.running.size) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((res) => {
      timer = setTimeout(res, timeoutMs);
    });
    await Promise.race([Promise.allSettled([...this.running]), timeout]);
    clearTimeout(timer);
    if (this.running.size) {
      this.d.log(`stop: ${this.running.size} dispatch(es) still running after ${timeoutMs} ms; cancelling pushes`);
      this.drained = true;
      this.abortPushes.abort();
    }
  }
}
