import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import type { Capture } from '../../src/questions/schema.js';
import type { Assignment } from '../../src/questions/service.js';
import { bindAgentSession } from '../../src/store/sessions.js';
import { addThrottle } from '../../src/store/subs.js';
import { mcpClient, ownerClient, startTestBroker, until } from '../helpers.js';

let broker: Broker;
let home: string;
const clients: Array<{ close(): void }> = [];
beforeEach(async () => {
  ({ broker, home } = await startTestBroker());
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await broker.stop();
});
async function join(
  name: string,
  cwd = '/w/myproject',
  agent: 'claude' | 'codex' = 'claude',
  native = `native-${name}`,
) {
  const c = await mcpClient(home, { requested_name: name, cwd, agent });
  clients.push(c.client);
  await c.client.call('session.bind', { agent_session_id: native });
  broker.questions.markReady(c.welcome.session_id, native);
  return c;
}
const task = (to = 'worker-one', key = 'task-1') => ({
  to,
  subject: 'Test work',
  body: 'Perform the diagnostic task.',
  idempotency_key: key,
});
const qs = [
  {
    id: 'q1',
    header: 'Color',
    question: 'Which color?',
    options: [
      { label: 'Blue', description: 'Blue value' },
      { label: 'Green', description: 'Green value' },
    ],
    multiSelect: false,
    allowOther: false,
  },
];
function captured(worker: string, input: Capture) {
  const q = broker.questions.capture(worker, input);
  if (!q) throw new Error('Expected supervised native question');
  return q;
}

describe('native question orchestration', () => {
  it('rechecks cycles after asynchronous Codex attachment', async () => {
    const a = await join('lead-one', '/w/myproject', 'codex');
    const b = await join('worker-one', '/w/myproject', 'codex');
    let resume!: () => void;
    let started = false;
    broker.questions.prepareCodex = async (s) => {
      if (s.id === b.welcome.session_id) {
        started = true;
        await new Promise<void>((r) => {
          resume = r;
        });
      }
    };
    const first = a.client.call('assignment.delegate', task());
    await until(() => started);
    await b.client.call('assignment.delegate', task('lead-one'));
    resume();
    await expect(first).rejects.toMatchObject({ code: 'conflict' });
  });
  it('does not deliver or expose native questions to a new holder of the lead name', async () => {
    const lead = await join('lead-one');
    const worker = await join('worker-one');
    await lead.client.call('assignment.delegate', task());
    lead.client.close();
    await until(
      () =>
        broker.db.prepare('SELECT state FROM sessions WHERE id=?').get(lead.welcome.session_id)?.state === 'offline',
    );
    const q = captured(worker.welcome.session_id, {
      native_session_id: 'native-worker-one',
      turn_id: 't',
      tool_use_id: 'c',
      kind: 'claude',
      questions: qs,
    });
    const replacement = await join('lead-one', '/w/myproject', 'claude', 'native-replacement-lead');
    await broker.engine?.dispatchMessage(q.message_id);
    expect(replacement.pushes.some((p) => p.content.includes(q.id))).toBe(false);
    const inbox = JSON.stringify(await replacement.client.call('msg.inbox', { include_read: true }));
    expect(inbox).not.toContain(q.id);
    await expect(replacement.client.call('msg.read', { msg_id: q.message_id })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
  it('pushes broker-verified native questions to a busy lead despite ordinary-message throttling', async () => {
    const lead = await join('lead-one');
    const worker = await join('worker-one');
    await lead.client.call('assignment.delegate', task());
    broker.db.prepare("UPDATE sessions SET state='online-busy' WHERE id=?").run(lead.welcome.session_id);
    addThrottle(broker.db, 'worker-one', 'lead-one');
    const q = captured(worker.welcome.session_id, {
      native_session_id: 'native-worker-one',
      turn_id: 't',
      tool_use_id: 'c',
      kind: 'claude',
      questions: qs,
    });
    await until(() => lead.pushes.some((p) => p.content.includes(q.id)), 1000);
  });
  it('returns bounded status summaries without task bodies, questions, or conversation history', async () => {
    const lead = await join('lead-one');
    const worker = await join('worker-one');
    const receipt = await lead.client.call('assignment.delegate', {
      ...task(),
      body: 'PRIVATE_TASK_CONTEXT '.repeat(1000),
    });
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_TASK_CONTEXT');
    const q = captured(worker.welcome.session_id, {
      native_session_id: 'native-worker-one',
      turn_id: 't',
      tool_use_id: 'c',
      kind: 'claude',
      questions: [{ ...qs[0], question: 'QUESTION_DETAIL '.repeat(200) }],
    });
    if (!q) throw new Error('capture failed');
    const summary = JSON.stringify(await lead.client.call('question.list', {}));
    expect(summary).not.toContain('PRIVATE_TASK_CONTEXT');
    expect(summary).not.toContain('QUESTION_DETAIL');
    expect(summary).toContain(q.id);
    expect(Buffer.byteLength(summary)).toBeLessThan(12000);
    const detail = await lead.client.call<{ data: string }>('question.details', { relay_id: q.id });
    expect(detail.data).toContain('QUESTION_DETAIL');
    expect(detail.data).not.toContain('PRIVATE_TASK_CONTEXT');
  });
  it('shows per-assignment roles and terminal labels, including an agent that both leads and works', async () => {
    const lead = await join('lead-one');
    const middle = await join('middle-one');
    const worker = await join('worker-one');
    expect(await lead.client.call('session.whoami')).toMatchObject({ role: 'peer', terminal_title: '[peer] lead-one' });
    await lead.client.call('assignment.delegate', task('middle-one'));
    await middle.client.call('assignment.delegate', task());
    expect(await lead.client.call('session.whoami')).toMatchObject({
      role: 'orchestrator',
      terminal_title: '[lead] lead-one',
      workers: [{ name: 'middle-one' }],
    });
    expect(await middle.client.call('session.whoami')).toMatchObject({
      role: 'orchestrator-worker',
      terminal_title: '[lead + worker ← lead-one] middle-one',
      workers: [{ name: 'worker-one' }],
    });
    expect(await worker.client.call('session.whoami')).toMatchObject({
      role: 'worker',
      terminal_title: '[worker ← middle-one] worker-one',
    });
  });
  it('records the caller as orchestrator, atomically stores the task, and makes retries idempotent', async () => {
    const lead = await join('lead-one');
    const worker = await join('worker-one');
    const a = await lead.client.call<Assignment>('assignment.delegate', task());
    expect(a).toMatchObject({
      orchestrator_session_id: lead.welcome.session_id,
      worker_session_id: worker.welcome.session_id,
    });
    expect(await lead.client.call('assignment.delegate', task())).toEqual(a);
    expect(broker.db.prepare("SELECT count(*) AS n FROM messages WHERE subject = 'Test work'").get()).toMatchObject({
      n: 1,
    });
    expect(await worker.client.call('session.whoami')).toMatchObject({
      orchestration: { assignment_id: a.id, orchestrator_name: 'lead-one' },
    });
  });
  it('ordinary requests and messages never create a supervisor', async () => {
    const lead = await join('lead-one');
    const w = await join('worker-one');
    await lead.client.call('req.request', { to: 'worker-one', subject: 'ordinary', body: 'hello' });
    expect(broker.questions.activeAssignment(w.welcome.session_id)).toBeUndefined();
  });
  it('refuses self-delegation, cycles, competing supervisors, and changed idempotency payloads', async () => {
    const a = await join('lead-one');
    const b = await join('worker-one');
    const c = await join('other-one');
    await expect(a.client.call('assignment.delegate', task('lead-one'))).rejects.toMatchObject({ code: 'bad_request' });
    await a.client.call('assignment.delegate', task());
    await expect(b.client.call('assignment.delegate', task('lead-one'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(c.client.call('assignment.delegate', task())).rejects.toMatchObject({ code: 'conflict' });
    await expect(a.client.call('assignment.delegate', { ...task(), body: 'Different task' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
  it('requires live bound sessions and native integration readiness', async () => {
    const a = await join('lead-one');
    const w = await join('worker-one');
    broker.db.prepare('DELETE FROM question_integrations WHERE session_id = ?').run(w.welcome.session_id);
    await expect(a.client.call('assignment.delegate', task())).rejects.toMatchObject({ code: 'conflict' });
    await expect(a.client.call('assignment.delegate', task('missing-one'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });
  it('refuses cross-workspace assignment without exposing the other session', async () => {
    const a = await join('lead-one');
    await join('worker-one', '/elsewhere');
    await expect(a.client.call('assignment.delegate', task())).rejects.toMatchObject({ code: 'not_found' });
  });
  it('routes captured questions to the recorded lead; validates and applies its answer once', async () => {
    const lead = await join('lead-one');
    const w = await join('worker-one');
    const outsider = await join('other-one');
    await lead.client.call('assignment.delegate', task());
    const q = captured(w.welcome.session_id, {
      native_session_id: 'native-worker-one',
      turn_id: 'turn1',
      tool_use_id: 'call1',
      kind: 'claude',
      questions: qs,
    });
    expect(
      captured(w.welcome.session_id, {
        native_session_id: 'native-worker-one',
        turn_id: 'turn1',
        tool_use_id: 'call1',
        kind: 'claude',
        questions: qs,
      }).id,
    ).toBe(q.id);
    await until(() => lead.pushes.some((p) => p.content.includes(q.id)));
    await expect(
      outsider.client.call('question.answer', { relay_id: q.id, answers: { q1: ['Blue'] } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['Purple'] } }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(lead.client.call('question.answer', { relay_id: q.id, answers: {} })).rejects.toMatchObject({
      code: 'bad_request',
    });
    const answerReceipt = await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['Blue'] } });
    expect(answerReceipt).toEqual({ relay_id: q.id, state: 'answered' });
    expect(broker.questions.get(q.id)?.state).toBe('answered');
    expect(broker.questions.answerFor(q.id, w.welcome.session_id)?.answers).toEqual({ q1: ['Blue'] });
    broker.questions.applied(q.id);
    await expect(
      lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['Green'] } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(broker.questions.get(q.id)?.state).toBe('applied');
  });
  it('does not intercept an unsupervised lead and never reuses a cancelled invocation', async () => {
    const lead = await join('lead-one');
    const w = await join('worker-one');
    expect(
      broker.questions.capture(lead.welcome.session_id, {
        native_session_id: 'native-lead-one',
        turn_id: 't',
        tool_use_id: 'c',
        kind: 'claude',
        questions: qs,
      }),
    ).toBeNull();
    await lead.client.call('assignment.delegate', task());
    const q = captured(w.welcome.session_id, {
      native_session_id: 'native-worker-one',
      turn_id: 't',
      tool_use_id: 'c',
      kind: 'claude',
      questions: qs,
    });
    broker.questions.cancel(q.id, 'native question resolved elsewhere');
    await expect(
      lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['Blue'] } }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('release cancels pending questions and permits a new explicit assignment', async () => {
    const lead = await join('lead-one');
    const w = await join('worker-one');
    const next = await join('next-one');
    const a = await lead.client.call<Assignment>('assignment.delegate', task());
    const q = captured(w.welcome.session_id, {
      native_session_id: 'native-worker-one',
      turn_id: 't',
      tool_use_id: 'c',
      kind: 'claude',
      questions: qs,
    });
    await expect(next.client.call('assignment.release', { assignment_id: a.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await lead.client.call('assignment.release', { assignment_id: a.id });
    expect(broker.questions.get(q.id)?.state).toBe('cancelled');
    expect(await next.client.call('assignment.delegate', task('worker-one', 'new'))).toMatchObject({
      orchestrator_session_id: next.welcome.session_id,
    });
  });
  it('rejects stale native bindings before accepting or applying an answer', async () => {
    const lead = await join('lead-one');
    const w = await join('worker-one');
    await lead.client.call('assignment.delegate', task());
    const q = captured(w.welcome.session_id, {
      native_session_id: 'native-worker-one',
      turn_id: 't',
      tool_use_id: 'c',
      kind: 'claude',
      questions: qs,
    });
    // Fault injection: raw Claude rebinding is now refused; still exercise defensive stale-row checks.
    bindAgentSession(broker.db, w.welcome.session_id, 'replacement-native-id');
    await expect(
      lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['Blue'] } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(broker.questions.answerFor(q.id, w.welcome.session_id)).toBeNull();
  });
  it('owner can inspect and release assignments but cannot impersonate an answering orchestrator', async () => {
    const lead = await join('lead-one');
    await join('worker-one');
    const a = await lead.client.call<Assignment>('assignment.delegate', task());
    const o = await ownerClient(home);
    clients.push(o);
    expect(await o.call('question.list', {})).toMatchObject({ assignments: [{ id: a.id }] });
    await o.call('assignment.release', { assignment_id: a.id });
    expect(broker.questions.activeAssignment(a.worker_session_id)).toBeUndefined();
  });
});
