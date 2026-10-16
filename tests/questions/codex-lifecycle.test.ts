import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import type { AppConnection } from '../../src/questions/codex.js';
import type { Relay } from '../../src/questions/service.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function boot() {
  const home = tmpHome();
  const state = {
    frontend: true,
    unavailable: false,
    subscribers: 0,
    resumes: 0,
    unsubscribes: 0,
    apps: [] as Questions[],
    onResume: null as ((app: Questions) => void) | null,
    onQueue: null as (() => Promise<void> | void) | null,
    queueCalls: 0,
    resumeError: false,
  };
  class Metadata extends EventEmitter {
    async connect() {}
    async call(method: string, p: { threadId?: string }) {
      if (state.unavailable) throw new Error('fixture metadata unavailable');
      return method === 'thread/loaded/list'
        ? { data: state.frontend || state.subscribers ? ['worker'] : [] }
        : { thread: { id: p.threadId, sessionId: p.threadId, source: 'cli', parentThreadId: null } };
    }
    send() {}
    close() {
      this.emit('disconnected');
    }
  }
  class Questions extends EventEmitter implements AppConnection {
    subscribed = false;
    sent: unknown[] = [];
    async connect() {}
    async call(method: string) {
      if (method === 'thread/resume') {
        if (state.resumeError) throw new Error('fixture native relay unavailable');
        this.subscribed = true;
        state.subscribers++;
        state.resumes++;
        state.onResume?.(this);
      }
      if (method === 'thread/unsubscribe') {
        state.unsubscribes++;
        if (this.subscribed) state.subscribers--;
        this.subscribed = false;
        return { status: 'unsubscribed' };
      }
      return { thread: { turns: [] } };
    }
    send(frame: unknown) {
      this.sent.push(frame);
    }
    close() {
      if (this.subscribed) state.subscribers--;
      this.subscribed = false;
      this.emit('disconnected');
    }
  }
  const codexNames = new CodexNames({ factory: () => new Metadata(), indexPath: join(home, 'missing-index') });
  const broker = await startBroker(home, {
    codexNames,
    codexQuestionFactory: () => {
      const app = new Questions();
      state.apps.push(app);
      return app;
    },
    codexQuestionIdleGraceMs: 20,
    transports: {
      claude: { kind: 'claude-channel', async push() {} },
      codex: {
        kind: 'codex-queue',
        async push() {
          state.queueCalls++;
          await state.onQueue?.();
        },
      },
    },
  });
  cleanup.push(() => broker.stop());
  const lead = await mcpClient(home, { requested_name: 'lead-one' }),
    worker = await mcpClient(home, { agent: 'codex', requested_name: 'worker-one' });
  cleanup.push(
    () => lead.client.close(),
    () => worker.client.close(),
  );
  await lead.client.call('session.bind', { agent_session_id: 'leader' });
  await worker.client.call('session.bind', { agent_session_id: 'worker', question_relay_version: 1 });
  await lead.client.call('assignment.delegate', {
    to: 'worker-one',
    subject: 'work',
    body: 'b',
    idempotency_key: 'lifecycle',
  });
  const capture = () =>
    broker.questions.capture(worker.welcome.session_id, {
      native_session_id: 'worker',
      turn_id: 'turn',
      tool_use_id: 'call',
      kind: 'codex',
      questions: [
        {
          id: 'q1',
          header: '',
          question: 'Choose?',
          options: [{ label: 'A', description: '' }],
          allowOther: true,
          multiSelect: false,
        },
      ],
    });
  const request = (app: Questions) =>
    app.emit('message', {
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'worker',
        turnId: 'turn',
        itemId: 'call',
        questions: [
          { id: 'q1', header: '', question: 'Choose?', options: [{ label: 'A', description: '' }], isOther: true },
        ],
      },
    });
  return { home, state, broker, lead, worker, capture, request };
}
describe('demand-driven Codex question subscriptions', () => {
  it('reattaches at a queued turn’s trusted prompt hook after the prior busy turn and idle grace, relaying exactly once', async () => {
    const { state, broker, lead, worker, capture, request } = await boot();
    await worker.client.call('session.turn', { phase: 'started' });
    const m = await lead.client.call<{ id: string }>('msg.send', {
      to: 'worker-one',
      subject: 'queue',
      body: 'b',
      priority: 'urgent',
      attachments: [],
    });
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'read');
    await worker.client.call('session.turn', { phase: 'ended' });
    await until(() => state.subscribers === 0, 1000);
    let q: Relay | null = null;
    state.onResume = (app) => {
      q = capture();
      request(app);
    };
    await worker.client.call('session.turn', { phase: 'started' }); // UserPromptSubmit's turn_started hook, before model work.
    if (!q) throw new Error('queued turn question was lost');
    const relay = q as Relay;
    await lead.client.call('question.answer', { relay_id: relay.id, answers: { q1: ['A'] } });
    const app = state.apps.at(-1);
    await until(() => app?.sent.length === 1);
    const resolved = { method: 'serverRequest/resolved', params: { threadId: 'worker', requestId: 42 } };
    app?.emit('message', resolved);
    app?.emit('message', resolved);
    request(app as Parameters<typeof request>[0]);
    expect(app?.sent).toHaveLength(1);
    expect(broker.questions.get(relay.id)?.state).toBe('applied');
    expect(broker.questions.list(null).questions.filter((x) => x.tool_use_id === 'call')).toHaveLength(1);
  });
  it('keeps a captured native question visible when UserPromptSubmit cannot reattach', async () => {
    const { state, broker, lead, worker, capture } = await boot();
    await until(() => state.subscribers === 0, 1000);
    state.resumeError = true;
    await worker.client.call('session.turn', { phase: 'started' });
    const q = capture();
    if (!q) throw new Error('native question was silently lost');
    expect(JSON.stringify(await lead.client.call('question.list'))).toContain(q.id);
    expect(broker.questions.get(q.id)?.state).toBe('pending');
  });
  it('broker stop releases a queue reservation and late completion never accesses its closed database', async () => {
    const { state, broker, lead } = await boot();
    await until(() => state.subscribers === 0, 1000);
    let release = () => {},
      entered = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    state.onQueue = async () => {
      entered();
      await gate;
    };
    await lead.client.call('msg.send', {
      to: 'worker-one',
      subject: 'queue',
      body: 'b',
      priority: 'urgent',
      attachments: [],
    });
    try {
      await waiting;
      expect(state.subscribers).toBe(1);
      broker.config.codex.queue_timeout_ms = 20;
      const prepare = vi.spyOn(broker.db, 'prepare');
      await broker.stop();
      expect(state.subscribers).toBe(0);
      prepare.mockClear();
      release();
      await new Promise<void>((r) => setImmediate(r));
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    } finally {
      release();
    }
  });
  it('attaches before an assigned queue push and holds the reservation through slow queue execution', async () => {
    const { state, broker, lead } = await boot();
    await until(() => state.subscribers === 0, 1000);
    let release = () => {},
      entered = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    state.onQueue = async () => {
      entered();
      await gate;
    };
    const m = await lead.client.call<{ id: string }>('msg.send', {
      to: 'worker-one',
      subject: 'queue',
      body: 'b',
      priority: 'urgent',
      attachments: [],
    });
    try {
      await waiting;
      await new Promise((r) => setTimeout(r, 50));
      expect(state.subscribers).toBe(1);
    } finally {
      release();
    }
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'read');
    await until(() => state.subscribers === 0, 1000);
  });
  it('releases the reservation after a failed queue without leaking an idle subscription', async () => {
    const { state, broker, lead } = await boot();
    await until(() => state.subscribers === 0, 1000);
    broker.config.retry.max_attempts = 1;
    state.onQueue = () => {
      throw new Error('fixture queue failed');
    };
    const m = await lead.client.call<{ id: string }>('msg.send', {
      to: 'worker-one',
      subject: 'queue',
      body: 'b',
      priority: 'urgent',
      attachments: [],
    });
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'stuck');
    await until(() => state.subscribers === 0, 1000);
    expect(state.resumes).toBeGreaterThan(1);
  });
  it.each(['attach', 'trust', 'link'])(
    'holds without queuing when the post-demand %s check fails; inbox remains available',
    async (failure) => {
      const { state, broker, lead, worker } = await boot();
      await until(() => state.subscribers === 0, 1000);
      const before = state.queueCalls;
      if (failure === 'attach') state.resumeError = true;
      else if (failure === 'trust')
        state.onResume = () => {
          state.unavailable = true;
        };
      else
        state.onResume = () => {
          broker.db.prepare("UPDATE sessions SET link='disconnected' WHERE id=?").run(worker.welcome.session_id);
        };
      const m = await lead.client.call<{ id: string }>('msg.send', {
        to: 'worker-one',
        subject: 'queue',
        body: 'b',
        priority: 'urgent',
        attachments: [],
      });
      await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, m.id)[0]?.state ?? ''));
      expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({
        state: 'held',
        last_error: expect.stringContaining(
          failure === 'attach' ? 'relay' : failure === 'trust' ? 'app-server-unavailable' : 'MCP disconnected',
        ),
      });
      expect(state.queueCalls).toBe(before);
      if (failure === 'link') expect(deliveriesOfMessage(broker.db, m.id)[0]?.hold_reason).toBe('disconnected');
      expect(JSON.stringify(await worker.client.call('msg.inbox'))).toContain(m.id);
      await until(() => state.subscribers === 0, 1000);
    },
  );
  it('an idle assignment unsubscribes and no longer keeps loaded-list liveness alive', async () => {
    const { state, broker, worker } = await boot();
    await until(() => state.subscribers === 0, 1000);
    expect(state.unsubscribes).toBe(1);
    const resumes = state.resumes;
    state.frontend = false;
    worker.client.close();
    await until(() => getSession(broker.db, worker.welcome.session_id)?.link === 'disconnected');
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, worker.welcome.session_id)?.state).toBe('offline');
    broker.questions.emit('assignments');
    await new Promise<void>((r) => setImmediate(r));
    expect(state.resumes).toBe(resumes);
  });
  it('awaits turn-start attachment and captures a question emitted immediately during resume', async () => {
    const { state, broker, worker, lead, capture, request } = await boot();
    await until(() => state.subscribers === 0, 1000);
    let q: Relay | null = null;
    state.onResume = (app) => {
      q = capture();
      request(app);
    };
    await worker.client.call('session.turn', { phase: 'started' });
    expect(q).not.toBeNull();
    const relay = q as unknown as Relay;
    await lead.client.call('question.answer', { relay_id: relay.id, answers: { q1: ['A'] } });
    await until(() => state.apps.at(-1)?.sent.length === 1);
    state.apps
      .at(-1)
      ?.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'worker', requestId: 42 } });
    expect(broker.questions.get(relay.id)?.state).toBe('applied');
  });
  it('keeps an answered relay after idle until native application, then honors the grace', async () => {
    const { state, broker, worker, lead, capture, request } = await boot();
    await worker.client.call('session.turn', { phase: 'started' });
    const q = capture();
    if (!q) throw new Error('capture failed');
    const app = state.apps.at(-1);
    if (!app) throw new Error('no app');
    request(app);
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    await until(() => app.sent.length === 1);
    vi.useFakeTimers();
    await worker.client.call('session.turn', { phase: 'ended' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(state.subscribers).toBe(1);
    expect(broker.questions.get(q.id)?.state).toBe('answered');
    app.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'worker', requestId: 42 } });
    await vi.advanceTimersByTimeAsync(10);
    expect(state.subscribers).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(state.subscribers).toBe(0);
    expect(broker.questions.get(q.id)?.state).toBe('applied');
    vi.useRealTimers();
  });
  it.each([false, true])(
    'never resumes an unloaded/unknown thread (unavailable=%s), and flags waiting demand',
    async (unavailable) => {
      const { state, worker } = await boot();
      await until(() => state.subscribers === 0, 1000);
      const resumes = state.resumes;
      state.frontend = false;
      state.unavailable = unavailable;
      await worker.client.call('session.turn', { phase: 'started' });
      expect(state.resumes).toBe(resumes);
      const who = await worker.client.call<{ codex_question_wait: string }>('session.whoami');
      expect(who.codex_question_wait).toBe(unavailable ? 'app-server-unavailable' : 'thread-not-loaded');
    },
  );
  it('broker stop unsubscribes the active relay and fully stops its timers', async () => {
    const { state, broker, worker } = await boot();
    await worker.client.call('session.turn', { phase: 'started' });
    expect(state.subscribers).toBe(1);
    await broker.stop();
    expect(state.subscribers).toBe(0);
    expect(state.unsubscribes).toBeGreaterThan(0);
  });
});
