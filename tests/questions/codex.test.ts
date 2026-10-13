import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { CodexQuestions } from '../../src/questions/codex.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, startTestBroker, until } from '../helpers.js';

class FakeApp extends EventEmitter {
  sent: any[] = [];
  calls: any[] = [];
  turns: unknown[] = [];
  onRead?: () => void;
  rejectTurns = false;
  async connect() {}
  async call(method: string, params: unknown) {
    this.calls.push({ method, params });
    if (this.rejectTurns && method.startsWith('turn/')) throw new Error('Native response lost after submission');
    if (method === 'thread/read') this.onRead?.();
    return { thread: { id: 'native-worker', turns: this.turns } };
  }
  send(f: unknown) {
    this.sent.push(f);
  }
  close() {}
}
let broker: Broker;
let home: string;
let adapter: CodexQuestions;
const closers: Array<() => void> = [];
beforeEach(async () => {
  ({ broker, home } = await startTestBroker());
});
afterEach(async () => {
  adapter?.stop();
  for (const c of closers.splice(0)) c();
  await broker.stop();
});
async function setup(kind: 'codex' | 'codex_async' = 'codex') {
  const app = new FakeApp();
  adapter = new CodexQuestions(broker.questions, () => app);
  const lead = await mcpClient(home, { requested_name: 'lead-one' });
  closers.push(() => lead.client.close());
  const worker = await mcpClient(home, { requested_name: 'worker-one', agent: 'codex' });
  closers.push(() => worker.client.close());
  await lead.client.call('session.bind', { agent_session_id: 'native-lead' });
  await worker.client.call('session.bind', { agent_session_id: 'native-worker' });
  broker.questions.markReady(worker.welcome.session_id, 'native-worker');
  broker.questions.prepareCodex = (s) => adapter.attach(s);
  await lead.client.call('assignment.delegate', { to: 'worker-one', subject: 's', body: 'b', idempotency_key: '1' });
  const q = broker.questions.capture(worker.welcome.session_id, {
    native_session_id: 'native-worker',
    tool_use_id: 'call1',
    turn_id: 'turn1',
    kind,
    questions: [
      {
        id: 'q1',
        header: '',
        question: 'Which?',
        options: [{ label: 'A', description: '' }],
        allowOther: true,
        multiSelect: false,
      },
    ],
  });
  if (!q) throw new Error('capture failed');
  return { app, lead, worker, q };
}
describe('Codex native question bridge', () => {
  it('does not retry an async input with an ambiguous native acknowledgement', async () => {
    const { app, lead, q } = await setup('codex_async');
    app.rejectTurns = true;
    app.emit('message', {
      method: 'item/completed',
      params: {
        threadId: 'native-worker',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'call1',
          delivery: 'async',
          questions: [{ title: 'Which?', options: ['A'] }],
        },
      },
    });
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    await until(() => broker.questions.get(q.id)?.state === 'failed', 1000);
    broker.questions.emit('changed');
    expect(app.calls.filter((c) => c.method.startsWith('turn/'))).toHaveLength(1);
  });
  it('answers only a captured native invocation and waits for native resolution before marking it applied', async () => {
    const { app, lead, q } = await setup();
    app.emit('message', {
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'native-worker',
        turnId: 'turn1',
        itemId: 'call1',
        questions: [
          { id: 'q1', header: '', question: 'Which?', options: [{ label: 'A', description: '' }], isOther: true },
        ],
      },
    });
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    await until(() => app.sent.length === 1);
    expect(app.sent[0]).toMatchObject({
      id: 42,
      result: { answers: { q1: { answers: ['A', expect.stringContaining('orchestrator lead-one')] } } },
    });
    expect(broker.questions.get(q.id)?.state).toBe('answered');
    app.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'native-worker', requestId: 42 } });
    await until(() => broker.questions.get(q.id)?.state === 'applied');
  });
  it('leaves approval prompts and unknown or mismatched native calls untouched', async () => {
    const { app, lead, q } = await setup();
    app.emit('message', {
      id: 9,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'native-worker' },
    });
    app.emit('message', {
      id: 10,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'native-worker', turnId: 'wrong-turn', itemId: 'call1', questions: [] },
    });
    app.emit('message', {
      id: 11,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'native-worker', turnId: 'turn1', itemId: 'other-call', questions: [] },
    });
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    expect(app.sent).toEqual([]);
  });
  it('cancels a relay when the human resolves its native request first', async () => {
    const { app, lead, q } = await setup();
    app.emit('message', {
      id: 42,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'native-worker',
        turnId: 'turn1',
        itemId: 'call1',
        questions: [
          { id: 'q1', header: '', question: 'Which?', options: [{ label: 'A', description: '' }], isOther: true },
        ],
      },
    });
    app.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'native-worker', requestId: 42 } });
    await expect(lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } })).rejects.toMatchObject(
      { code: 'conflict' },
    );
    expect(app.sent).toEqual([]);
  });
  it('returns asynchronous answers using the original question-call identifiers', async () => {
    const { app, lead, q } = await setup('codex_async');
    app.emit('message', {
      method: 'item/completed',
      params: {
        threadId: 'native-worker',
        turnId: 'turn1',
        item: {
          type: 'agentMessage',
          id: 'call1',
          delivery: 'async',
          questions: [{ title: 'Which?', options: ['A'] }],
        },
      },
    });
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    await until(() => app.calls.some((c) => c.method === 'turn/steer'));
    expect(app.calls.find((c) => c.method === 'turn/steer')).toMatchObject({
      params: {
        threadId: 'native-worker',
        expectedTurnId: 'turn1',
        input: [{ type: 'text', text: expect.stringContaining('send_user_message_question_reply') }],
      },
    });
    await until(() => broker.questions.get(q.id)?.state === 'applied');
  });
  it('starts a new turn for a recovered async question whose original turn completed', async () => {
    const { lead, worker, q } = await setup('codex_async');
    adapter.stop();
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    const app = new FakeApp();
    app.turns = [
      {
        id: 'turn1',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'call1',
            delivery: 'async',
            questions: [{ title: 'Which?', options: ['A'] }],
          },
        ],
      },
    ];
    adapter = new CodexQuestions(broker.questions, () => app);
    await adapter.attach(getSession(broker.db, worker.welcome.session_id)!);
    await until(() => app.calls.some((c) => c.method === 'turn/start'));
    expect(app.calls.some((c) => c.method === 'turn/steer')).toBe(false);
  });
  it('replays human answers before sending a recovered async answer', async () => {
    const { lead, worker, q } = await setup('codex_async');
    adapter.stop();
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    const app = new FakeApp();
    app.turns = [
      {
        id: 'turn1',
        status: 'completed',
        items: [
          {
            type: 'agentMessage',
            id: 'call1',
            delivery: 'async',
            questions: [{ title: 'Which?', options: ['A'] }],
          },
        ],
      },
      {
        id: 'turn2',
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            content: [
              {
                type: 'text',
                text:
                  '<send_user_message_question_reply>' +
                  JSON.stringify([
                    {
                      answer: 'Human answer',
                      questionItemId: JSON.stringify(['request_user_input_async', 'call1', 0]),
                    },
                  ]) +
                  '</send_user_message_question_reply>',
              },
            ],
          },
        ],
      },
    ];
    adapter = new CodexQuestions(broker.questions, () => app);
    await adapter.attach(getSession(broker.db, worker.welcome.session_id)!);
    expect(app.calls.filter((c) => c.method.startsWith('turn/'))).toEqual([]);
    expect(broker.questions.get(q.id)?.state).toBe('cancelled');
  });
  it('cancels a captured blocking call when its turn ends before the native request appears', async () => {
    const { app, q } = await setup();
    app.emit('message', {
      method: 'turn/completed',
      params: {
        threadId: 'native-worker',
        turn: { id: 'turn1', status: 'completed' },
      },
    });
    expect(broker.questions.get(q.id)?.state).toBe('cancelled');
  });
  it('keeps a live human reply received during recovery ahead of a stale snapshot', async () => {
    const { lead, worker, q } = await setup('codex_async');
    adapter.stop();
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    const app = new FakeApp();
    app.turns = [
      {
        id: 'turn1',
        status: 'completed',
        items: [
          { type: 'agentMessage', id: 'call1', delivery: 'async', questions: [{ title: 'Which?', options: ['A'] }] },
        ],
      },
    ];
    app.onRead = () =>
      app.emit('message', {
        method: 'item/completed',
        params: {
          threadId: 'native-worker',
          turnId: 'turn2',
          item: {
            type: 'userMessage',
            content: [
              {
                type: 'text',
                text:
                  '<send_user_message_question_reply>' +
                  JSON.stringify([
                    {
                      answer: 'Human answer',
                      questionItemId: JSON.stringify(['request_user_input_async', 'call1', 0]),
                    },
                  ]) +
                  '</send_user_message_question_reply>',
              },
            ],
          },
        },
      });
    adapter = new CodexQuestions(broker.questions, () => app);
    await adapter.attach(getSession(broker.db, worker.welcome.session_id)!);
    expect(app.calls.filter((c) => c.method.startsWith('turn/'))).toEqual([]);
    expect(broker.questions.get(q.id)?.state).toBe('cancelled');
  });
  it('cancels async questions from interrupted turns during recovery', async () => {
    const { lead, worker, q } = await setup('codex_async');
    adapter.stop();
    await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
    const app = new FakeApp();
    app.turns = [
      {
        id: 'turn1',
        status: 'interrupted',
        items: [
          { type: 'agentMessage', id: 'call1', delivery: 'async', questions: [{ title: 'Which?', options: ['A'] }] },
        ],
      },
    ];
    adapter = new CodexQuestions(broker.questions, () => app);
    await adapter.attach(getSession(broker.db, worker.welcome.session_id)!);
    expect(app.calls.filter((c) => c.method.startsWith('turn/'))).toEqual([]);
    expect(broker.questions.get(q.id)?.state).toBe('cancelled');
  });
});
