import type { SessionRow } from '../store/sessions.js';
import { getSession } from '../store/sessions.js';
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
};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Native requests are answered only after a matching allowlisted PreToolUse capture. */
export class CodexQuestions {
  private readonly attached = new Map<string, Attached>();
  private stopped = false;
  private readonly retry: NodeJS.Timeout;
  private readonly changed = () => this.flush();
  private readonly assignments = () => {
    this.reconcile().catch((e) => this.log(e));
  };
  constructor(
    readonly service: QuestionService,
    private readonly factory: () => AppConnection = () =>
      new AppServer(
        service.broker.config.questions.app_server_socket,
        service.broker.config.questions.app_server_timeout_ms,
      ),
  ) {
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
    this.service.broker.log(`native Codex question adapter: ${e instanceof Error ? e.message : String(e)}`);
  }
  async attach(session: SessionRow): Promise<void> {
    if (this.stopped || !session.agent_session_id)
      throw new Error('Codex question adapter cannot attach an unbound session');
    const existing = this.attached.get(session.id);
    if (existing?.native === session.agent_session_id) return existing.starting;
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
        this.attached.delete(entry.session);
      }
    });
    entry.starting = (async () => {
      try {
        await app.connect();
        if (entry.closed || this.stopped) throw new Error('Codex question attach cancelled');
        await app.call('thread/resume', { threadId: entry.native, excludeTurns: true });
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
        if (outstanding.length) {
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
            if (['interrupted', 'failed'].includes(turn.status))
              this.receive(entry, { method: 'turn/completed', params: { threadId: entry.native, turn } });
          }
        }
        if (entry.closed || this.stopped) throw new Error('Codex question recovery cancelled');
        for (const frame of entry.buffered.splice(0)) this.receive(entry, frame);
        entry.recovering = false;
        this.flush();
      } catch (e) {
        this.detach(entry);
        throw e;
      }
    })();
    return entry.starting;
  }
  private detach(e: Attached): void {
    e.closed = true;
    e.app.close();
    if (this.attached.get(e.session) === e) this.attached.delete(e.session);
  }
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    const active = this.service.list(null).assignments.filter((a) => !a.ended_at);
    for (const e of this.attached.values()) {
      if (e.recovering) continue; // Delegation preflight attaches before the assignment commits.
      const a = active.find((a) => a.worker_session_id === e.session);
      if (!a || !this.service.participants(a)) this.detach(e);
    }
    for (const a of active) {
      const s = getSession(this.service.broker.db, a.worker_session_id);
      if (s?.agent === 'codex' && s.state !== 'offline' && this.service.participants(a)) await this.attach(s);
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
      if (e.activeTurn === p.turn.id) e.activeTurn = undefined;
      for (const q of this.service.list(null).questions) {
        if (q.native_session_id !== e.native || q.turn_id !== p.turn.id) continue;
        if (q.kind === 'codex' || ['interrupted', 'failed'].includes(String(p.turn.status))) {
          this.service.cancel(q.id, 'Native turn ended');
          e.pending.delete(q.id);
        }
      }
    }
    if (f.method === 'serverRequest/resolved') {
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
      e.activeTurn = q.turn_id;
      e.pending.set(q.id, { relay: q, requestId: f.id, sent: false });
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
    this.flush();
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
          this.log(err);
        }
      }
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.retry);
    this.service.off('changed', this.changed);
    this.service.off('assignments', this.assignments);
    this.service.broker.bus.off('session.available', this.assignments);
    for (const e of this.attached.values()) this.detach(e);
  }
}
