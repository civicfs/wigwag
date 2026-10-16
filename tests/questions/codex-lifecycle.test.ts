import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import type { AppConnection } from '../../src/questions/codex.js';
import type { Relay } from '../../src/questions/service.js';
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
      codex: { kind: 'codex-queue', async push() {} },
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
