import { WigwagError } from '../errors.js';
import type { SessionRow } from '../store/sessions.js';
import { getSession, setState } from '../store/sessions.js';
import { type AppFrame, AppServer } from './app-server.js';
import { asyncReply, codexAnswer, normalizeNative } from './native.js';
import type { QuestionService, Relay } from './service.js';

export interface AppConnection {
  connect(): Promise<void>;
  call(method: string, params: unknown): Promise<unknown>;
  send(frame: unknown): void;
  close(): void;
  on(event: string, listener: (f: AppFrame) => void): unknown;
}
type Pending = { relay: Relay; requestId?: string | number; sent: boolean };
type Revalidation = Map<string, { requestId?: string | number; sent: boolean }>;
type Attached = {
  app: AppConnection;
  native: string;
  session: string;
  pending: Map<string, Pending>;
  starting: Promise<void>;
  closed: boolean;
  recovering: boolean;
  buffered: AppFrame[];
  activeTurn?: string;
  subscribed?: boolean;
  idleTimer?: NodeJS.Timeout;
  revalidation?: Revalidation;
};
export const CODEX_QUESTION_IDLE_GRACE_MS = 2000;
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Native requests are answered only after a matching allowlisted PreToolUse capture. */
export class CodexQuestions {
  private readonly attached = new Map<string, Attached>();
  private readonly pushing = new Map<string, number>();
  private readonly revalidations = new Map<string, Revalidation>();
  private stopped = false;
  private readonly retry: NodeJS.Timeout;
  private readonly closing = new Set<Promise<void>>();
  private stopPromise: Promise<void> | null = null;
  private readonly idleGraceMs: number;
  private readonly changed = () => {
    this.flush();
    this.assignments();
  };
  private readonly turnHook = async (s: SessionRow, phase: 'started' | 'ended') => {
    const a = this.service.activeAssignment(s.id);
    if (!a || !this.service.participants(a)) return;
    if (phase === 'started') await this.attach(s);
    else {
      const e = this.attached.get(s.id);
      if (e) e.activeTurn = undefined;
      await this.reconcile();
    }
  };
  private readonly assignments = () => {
    this.reconcile().catch((e) => this.log(e));
  };
  private readonly revalidateMcp = (session: SessionRow): void => {
    const existing = this.attached.get(session.id);
    const checks: Revalidation = new Map();
    for (const q of this.service.list(null).questions) {
      const assignment = this.service.assignment(q.assignment_id);
      if (
        q.kind !== 'codex' ||
        !['pending', 'answered'].includes(q.state) ||
        q.native_session_id !== session.agent_session_id ||
        assignment?.worker_session_id !== session.id ||
        assignment.ended_at
      )
        continue;
      const pending = existing?.pending.get(q.id);
      checks.set(q.id, { requestId: pending?.requestId, sent: pending?.sent ?? false });
    }
    if (checks.size) {
      this.revalidations.set(session.id, checks);
      this.service.codexWaiting.set(session.id, 'native-request-unverified');
    }
    if (existing) this.detach(existing); // old pending evidence must never authorize an answer after handover
  };
  /**
   * Pin only this queue attempt; turn notifications/hooks and the existing idle grace take over afterwards.
   * Pinned Codex rust-v0.162.1: queued UserInput starts a user turn, runs UserPromptSubmit, then model work:
   * https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/ext/queue/src/service.rs#L438
   * https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/session/turn.rs#L366
   * https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/hook_runtime.rs#L677
   * thread/resume also replays pending thread requests (excluding owner-only verification requests):
   * https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L830
   */
  private readonly reservePush = async (s: SessionRow): Promise<() => void> => {
    if (this.stopped) throw new Error('Codex question adapter stopped');
    const assignment = this.service.activeAssignment(s.id);
    if (!assignment) return () => {};
    if (!this.service.participants(assignment)) throw new Error('Codex question assignment is stale');
    this.pushing.set(s.id, (this.pushing.get(s.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (this.pushing.get(s.id) ?? 1) - 1;
      if (remaining) this.pushing.set(s.id, remaining);
      else this.pushing.delete(s.id);
      if (!this.stopped) this.assignments();
    };
    try {
      await this.attach(s);
      if (this.stopped) throw new Error('Codex question adapter stopped');
      const current = getSession(this.service.broker.db, s.id);
      if (current?.state === 'offline' || current?.link === 'disconnected')
        throw new WigwagError(
          'unbound',
          current.state === 'offline'
            ? 'Codex session offline during question attachment'
            : 'Codex MCP disconnected during question attachment',
          { hold_reason: current.state === 'offline' ? 'offline' : 'disconnected' },
        );
      if (
        !current ||
        current.retired_at ||
        current.agent_session_id !== s.agent_session_id ||
        current.conn_generation !== s.conn_generation ||
        this.service.activeAssignment(s.id)?.id !== assignment.id ||
        !this.service.participants(assignment)
      )
        throw new Error('Codex question binding or assignment changed during queue attachment');
      return release;
    } catch (e) {
      release();
      throw e;
    }
  };
  constructor(
    readonly service: QuestionService,
    private readonly factory: () => AppConnection = () =>
      new AppServer(
        service.broker.config.questions.app_server_socket,
        service.broker.config.questions.app_server_timeout_ms,
      ),
    opts: { idleGraceMs?: number } = {},
  ) {
    this.idleGraceMs =
      opts.idleGraceMs ?? service.broker.config.questions.codex_idle_grace_ms ?? CODEX_QUESTION_IDLE_GRACE_MS;
    service.turnCodex = this.turnHook;
    service.reserveCodexPush = this.reservePush;
    service.revalidateCodexMcp = this.revalidateMcp;
    service.on('changed', this.changed);
    service.on('assignments', this.assignments);
    service.broker.bus.on('session.available', this.assignments);
    this.retry = setInterval(() => {
      this.assignments();
      this.flush();
    }, 1500);
    this.retry.unref();
  }
  private log(e: unknown): void {
    if (e instanceof WigwagError && (e.data as { kind?: string })?.kind === 'question-wait') return;
    this.service.broker.log(`native Codex question adapter: ${e instanceof Error ? e.message : String(e)}`);
  }
  async attach(session: SessionRow): Promise<void> {
    if (this.stopped || !session.agent_session_id)
      throw new Error('Codex question adapter cannot attach an unbound session');
    const existing = this.attached.get(session.id);
    if (existing?.native === session.agent_session_id) {
      this.clearIdle(existing);
      return existing.starting;
    }
    if (existing) this.detach(existing);
    const app = this.factory();
    const entry: Attached = {
      app,
      native: session.agent_session_id,
      session: session.id,
      pending: new Map(),
      starting: Promise.resolve(),
      closed: false,
      recovering: true,
      buffered: [],
      revalidation: this.revalidations.get(session.id),
    };
    this.attached.set(session.id, entry);
    app.on('message', (f) => {
      if (entry.closed || this.stopped) return;
      try {
        if (entry.recovering) {
          if (entry.buffered.length >= 1000) {
            this.detach(entry);
            throw new Error('Native recovery event buffer exceeded its limit');
          }
          entry.buffered.push(f);
          return;
        }
        this.receive(entry, f);
      } catch (e) {
        this.log(e);
      }
    });
    app.on('disconnected', () => {
      if (!entry.closed) {
        entry.closed = true;
        this.clearIdle(entry);
        if (this.attached.get(entry.session) === entry) this.attached.delete(entry.session);
      }
    });
    entry.starting = (async () => {
      try {
        await this.requireLoaded(entry);
        await app.connect();
        if (entry.closed || this.stopped) throw new Error('Codex question attach cancelled');
        await this.requireLoaded(entry);
        await app.call('thread/resume', { threadId: entry.native, excludeTurns: true });
        entry.subscribed = true;
        if (entry.closed || this.stopped) throw new Error('Codex question attach cancelled');
        if (!entry.revalidation && this.service.codexWaiting.delete(entry.session))
          this.service.broker.announce(entry.session);
        // Recover async questions after a broker reconnect. Read only this assigned thread;
        // large responses are bounded by the transport and fail visibly rather than truncate.
        const outstanding = this.service
          .list(null)
          .questions.filter(
            (q) =>
              q.native_session_id === entry.native &&
              q.kind === 'codex_async' &&
              ['pending', 'answered'].includes(q.state),
          );
        if (outstanding.length || entry.revalidation?.size) {
          const history = (await app.call('thread/read', { threadId: entry.native, includeTurns: true })) as {
            thread?: { turns?: Array<{ id: string; status: string; items: unknown[] }> };
          };
          for (const turn of history.thread?.turns ?? []) {
            if (turn.status === 'inProgress') entry.activeTurn = turn.id;
            for (const item of turn.items)
              this.receive(entry, {
                method: 'item/completed',
                params: { threadId: entry.native, turnId: turn.id, item },
              });
            if (
              ['interrupted', 'failed'].includes(turn.status) ||
              (entry.revalidation?.size && turn.status === 'completed')
            )
              this.receive(entry, { method: 'turn/completed', params: { threadId: entry.native, turn } });
          }
        }
        if (entry.closed || this.stopped) throw new Error('Codex question recovery cancelled');
        for (const frame of entry.buffered.splice(0)) this.receive(entry, frame);
        entry.recovering = false;
        this.revalidationStatus(entry);
        this.flush();
      } catch (e) {
        this.detach(entry);
        if (!this.stopped && entry.revalidation?.size) {
          this.waiting(entry.session, 'question-revalidation-unavailable');
        }
        throw e;
      }
    })();
    return entry.starting;
  }
  private waiting(session: string, reason: 'native-request-unverified' | 'question-revalidation-unavailable'): void {
    if (this.service.codexWaiting.get(session) === reason) return;
    this.service.codexWaiting.set(session, reason);
    this.service.broker.log(`Codex question relay waiting: ${session}: ${reason}; relay retained, no answer submitted`);
    this.service.broker.announce(session);
  }
  private revalidationStatus(e: Attached): void {
    if (!e.revalidation) return;
    for (const id of e.revalidation.keys()) {
      const q = this.service.get(id);
      if (!q || !['pending', 'answered'].includes(q.state)) e.revalidation.delete(id);
    }
    if (!e.revalidation.size) this.revalidations.delete(e.session);
    if ([...e.revalidation.keys()].some((id) => !e.pending.has(id)))
      this.waiting(e.session, 'native-request-unverified');
    else if (this.service.codexWaiting.delete(e.session)) this.service.broker.announce(e.session);
  }
  private clearIdle(e: Attached): void {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    e.idleTimer = undefined;
  }
  private async requireLoaded(e: Attached): Promise<void> {
    const loaded = await this.service.broker.codexNames?.loadedThreads();
    if (e.closed || this.stopped) throw new Error('Codex question attach cancelled');
    const fresh = getSession(this.service.broker.db, e.session);
    if (!fresh || fresh.retired_at || fresh.state === 'offline' || fresh.agent_session_id !== e.native)
      throw new Error('Codex question binding changed during attach');
    const reason = loaded == null ? 'app-server-unavailable' : !loaded.has(e.native) ? 'thread-not-loaded' : null;
    if (!reason) return;
    if (this.service.codexWaiting.get(e.session) !== reason) {
      this.service.codexWaiting.set(e.session, reason);
      this.service.broker.log(`Codex question relay waiting: ${e.session}: ${reason}`);
      this.service.broker.announce(e.session);
    }
    throw new WigwagError('unbound', `Codex question relay waiting: ${reason}; no thread/resume was sent`, {
      kind: 'question-wait',
    });
  }
  private detach(e: Attached): void {
    if (e.closed) return;
    e.closed = true;
    this.clearIdle(e);
    if (this.attached.get(e.session) === e) this.attached.delete(e.session);
    if (!e.subscribed) {
      e.app.close();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Codex question unsubscribe timed out')),
        this.service.broker.config.questions.app_server_timeout_ms,
      );
      timer.unref();
    });
    const closing = Promise.race([
      Promise.resolve().then(() => e.app.call('thread/unsubscribe', { threadId: e.native })),
      timeout,
    ])
      .then(
        () => {},
        (err) => this.log(err),
      )
      .finally(() => {
        clearTimeout(timer);
        e.app.close();
        this.closing.delete(closing);
      });
    this.closing.add(closing);
  }
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    const all = this.service.list(null),
      active = all.assignments.filter((a) => !a.ended_at);
    const need = (s: SessionRow, e?: Attached) =>
      (this.pushing.get(s.id) ?? 0) > 0 ||
      s.state === 'online-busy' ||
      !!e?.activeTurn ||
      all.questions.some(
        (q) =>
          q.native_session_id === s.agent_session_id &&
          ['pending', 'answered'].includes(q.state) &&
          active.some((a) => a.id === q.assignment_id && a.worker_session_id === s.id),
      );
    for (const e of this.attached.values()) {
      if (e.recovering) continue;
      const a = active.find((a) => a.worker_session_id === e.session),
        s = getSession(this.service.broker.db, e.session);
      if (!a || !s || !this.service.participants(a) || s.agent_session_id !== e.native) {
        this.service.codexWaiting.delete(e.session);
        this.detach(e);
        continue;
      }
      if (need(s, e)) this.clearIdle(e);
      else if (!e.idleTimer) {
        e.idleTimer = setTimeout(() => {
          e.idleTimer = undefined;
          this.detach(e);
        }, this.idleGraceMs);
        e.idleTimer.unref();
      }
    }
    for (const id of this.service.codexWaiting.keys()) {
      const s = getSession(this.service.broker.db, id);
      if (!s || !active.some((a) => a.worker_session_id === id && this.service.participants(a)) || !need(s))
        this.service.codexWaiting.delete(id);
    }
    for (const a of active) {
      const s = getSession(this.service.broker.db, a.worker_session_id);
      if (
        s?.agent === 'codex' &&
        s.state !== 'offline' &&
        this.service.participants(a) &&
        need(s, this.attached.get(s.id))
      )
        await this.attach(s).catch((e) => this.log(e));
    }
  }
  private nativeRelay(e: Attached, itemId: unknown, turn: unknown, kind: Relay['kind']): Relay | undefined {
    const a = this.service.activeAssignment(e.session);
    if (!a || !this.service.participants(a)) return;
    return this.service
      .list(null)
      .questions.find(
        (q) =>
          q.assignment_id === a.id &&
          q.native_session_id === e.native &&
          q.tool_use_id === itemId &&
          q.turn_id === turn &&
          q.kind === kind &&
          ['pending', 'answered'].includes(q.state),
      );
  }
  private receive(e: Attached, f: AppFrame): void {
    const p = f.params;
    if (!p || p.threadId !== e.native) return;
    if (f.method === 'turn/started' && object(p.turn) && typeof p.turn.id === 'string') e.activeTurn = p.turn.id;
    if (f.method === 'turn/completed' && object(p.turn)) {
      if (e.activeTurn === p.turn.id) {
        e.activeTurn = undefined;
        const s = getSession(this.service.broker.db, e.session);
        if (s?.agent_session_id === e.native && s.state !== 'offline')
          setState(this.service.broker.db, s.id, 'online-idle');
      }
      for (const q of this.service.list(null).questions) {
        if (q.native_session_id !== e.native || q.turn_id !== p.turn.id) continue;
        if (q.kind === 'codex' || ['interrupted', 'failed'].includes(String(p.turn.status))) {
          this.service.cancel(q.id, 'Native turn ended');
          e.pending.delete(q.id);
        }
      }
    }
    if (f.method === 'serverRequest/resolved') {
      for (const [id, check] of e.revalidation ?? [])
        if (!e.pending.has(id) && check.requestId !== undefined && check.requestId === p.requestId) {
          if (check.sent) this.service.applied(id);
          else this.service.cancel(id, 'Native question resolved outside Wigwag');
        }
      for (const [id, pending] of e.pending)
        if (pending.requestId === p.requestId && pending.relay.kind === 'codex') {
          e.pending.delete(id);
          if (pending.sent) this.service.applied(id);
          else this.service.cancel(id, 'Native question resolved outside Wigwag');
        }
    }
    if (f.method === 'item/tool/requestUserInput' && (typeof f.id === 'number' || typeof f.id === 'string')) {
      const q = this.nativeRelay(e, p.itemId, p.turnId, 'codex');
      if (!q) return; // Connector prompts use this method too; never infer a native tool from it alone.
      const native = normalizeNative('codex', 'request_user_input', { questions: p.questions });
      if (JSON.stringify(native?.questions) !== JSON.stringify(q.questions)) return;
      const expected = e.revalidation?.get(q.id);
      if (expected?.requestId !== undefined && expected.requestId !== f.id) {
        this.waiting(e.session, 'native-request-unverified');
        return;
      }
      e.activeTurn = q.turn_id;
      // Pending replay preserves the exact server request ID (0.162.1 outgoing_message.rs:446,582).
      // https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/outgoing_message.rs#L446
      e.pending.set(q.id, { relay: q, requestId: f.id, sent: expected?.sent ?? false });
    }
    if (f.method === 'item/completed' && object(p.item)) {
      const item = p.item;
      if (item.type === 'agentMessage' && item.delivery === 'async' && Array.isArray(item.questions)) {
        const q = this.nativeRelay(e, item.id, p.turnId, 'codex_async');
        if (
          q &&
          JSON.stringify(
            normalizeNative('codex', 'request_user_input_async', { questions: item.questions })?.questions,
          ) === JSON.stringify(q.questions)
        ) {
          if (!e.pending.has(q.id)) e.pending.set(q.id, { relay: q, sent: false });
          if (!e.recovering) e.activeTurn = q.turn_id;
        }
      }
      if (item.type === 'userMessage' && Array.isArray(item.content)) {
        for (const part of item.content)
          if (
            object(part) &&
            typeof part.text === 'string' &&
            part.text.includes('<send_user_message_question_reply>')
          ) {
            const match = part.text.match(
              /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/,
            );
            if (!match) continue;
            let replies: unknown;
            try {
              replies = JSON.parse(match[1]);
            } catch {
              continue;
            }
            if (!Array.isArray(replies)) continue;
            for (const [id, pending] of e.pending)
              if (
                pending.relay.kind === 'codex_async' &&
                replies.some(
                  (r) =>
                    object(r) &&
                    typeof r.questionItemId === 'string' &&
                    pending.relay.questions.some(
                      (_q, i) =>
                        r.questionItemId === JSON.stringify(['request_user_input_async', pending.relay.tool_use_id, i]),
                    ),
                )
              ) {
                const current = this.service.get(id);
                const assignment = current && this.service.assignment(current.assignment_id);
                const pair = assignment && this.service.participants(assignment);
                const ownReply =
                  current?.answers &&
                  pair &&
                  part.text ===
                    asyncReply(current.tool_use_id, current.questions, current.answers, pair.leader.name as string);
                if (ownReply) this.service.applied(id);
                else this.service.cancel(id, 'Native async question answered outside Wigwag');
                e.pending.delete(id);
              }
          }
      }
    }
    this.revalidationStatus(e);
    this.flush();
    this.assignments();
  }
  private flush(): void {
    if (this.stopped) return;
    for (const e of this.attached.values())
      for (const [id, pending] of e.pending) {
        if (pending.sent || e.closed || e.recovering) continue;
        const q = this.service.answerFor(id, e.session);
        const a = q && this.service.assignment(q.assignment_id);
        const pair = a && this.service.participants(a);
        if (!q?.answers || !pair) continue;
        pending.sent = true;
        const revalidation = e.revalidation?.get(id);
        if (revalidation) revalidation.sent = true;
        try {
          if (q.kind === 'codex')
            e.app.send({ id: pending.requestId, result: codexAnswer(q.answers, pair.leader.name as string) });
          else {
            const input = [
              { type: 'text', text: asyncReply(q.tool_use_id, q.questions, q.answers, pair.leader.name as string) },
            ];
            const sending = e.activeTurn
              ? e.app.call('turn/steer', { threadId: e.native, expectedTurnId: e.activeTurn, input })
              : e.app.call('turn/start', { threadId: e.native, input });
            sending
              .then(() => {
                e.pending.delete(id);
                this.service.applied(id);
              })
              .catch((err) => {
                e.pending.delete(id);
                this.service.fail(
                  id,
                  'Native async acknowledgement unavailable; input may already be accepted. Inspect the native thread before explicitly retrying.',
                );
                this.log(err);
              });
          }
        } catch (err) {
          pending.sent = false;
          if (revalidation) revalidation.sent = false;
          this.log(err);
        }
      }
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    clearInterval(this.retry);
    this.service.off('changed', this.changed);
    this.service.off('assignments', this.assignments);
    this.service.broker.bus.off('session.available', this.assignments);
    if (this.service.turnCodex === this.turnHook) this.service.turnCodex = null;
    if (this.service.reserveCodexPush === this.reservePush) this.service.reserveCodexPush = null;
    if (this.service.revalidateCodexMcp === this.revalidateMcp) this.service.revalidateCodexMcp = null;
    this.pushing.clear();
    this.revalidations.clear();
    this.service.codexWaiting.clear();
    for (const e of this.attached.values()) this.detach(e);
    this.stopPromise = Promise.all([...this.closing]).then(() => {});
    return this.stopPromise;
  }
}
