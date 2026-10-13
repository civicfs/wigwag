import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { mcpClient, startTestBroker } from '../helpers.js';

let broker: Broker;
let home: string;
const clients: Client[] = [];
beforeEach(async () => {
  ({ broker, home } = await startTestBroker());
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await broker.stop();
});
async function setup() {
  const lead = await mcpClient(home, { requested_name: 'lead-one', mcp_ppid: 42 });
  clients.push(lead.client);
  const worker = await mcpClient(home, { requested_name: 'worker-one', mcp_ppid: 43 });
  clients.push(worker.client);
  await lead.client.call('session.bind', { agent_session_id: 'native-lead' });
  await worker.client.call('session.bind', { agent_session_id: 'native-worker' });
  const { client: hook } = await Client.connect(
    sockPath(home),
    { protocol: 1, role: 'hook' },
    frameLimit(loadConfig(home)),
  );
  clients.push(hook);
  const identity = {
    agent: 'claude',
    native_session_id: 'native-worker',
    cwd: '/w/myproject',
    agent_pid: 43,
    pid_chain: [50, 43],
  };
  await hook.call('hook.question_ready', identity);
  return { lead, worker, hook, identity };
}
describe('native question hook endpoints', () => {
  it('does not intercept unsupervised workers, then returns answers only to the bound worker hook', async () => {
    const { lead, hook, identity } = await setup();
    const capture = {
      ...identity,
      tool_name: 'AskUserQuestion',
      tool_use_id: 'call1',
      turn_id: 'turn1',
      tool_input: {
        questions: [
          {
            question: 'Which?',
            header: 'Pick',
            options: [
              { label: 'A', description: 'A' },
              { label: 'B', description: 'B' },
            ],
          },
        ],
      },
    };
    expect(await hook.call('hook.question_capture', capture)).toEqual({ supervised: false });
    await lead.client.call('assignment.delegate', {
      to: 'worker-one',
      subject: 's',
      body: 'b',
      idempotency_key: 'key',
    });
    const q = await hook.call<any>('hook.question_capture', capture);
    expect(q).toMatchObject({ supervised: true, state: 'pending', orchestrator_name: 'lead-one' });
    await lead.client.call('question.answer', { relay_id: q.relay_id, answers: { q1: ['B'] } });
    expect(await hook.call('hook.question_poll', { ...identity, relay_id: q.relay_id })).toMatchObject({
      state: 'answered',
      answers: { q1: ['B'] },
    });
    await expect(
      hook.call('hook.question_poll', { ...identity, agent_pid: 42, relay_id: q.relay_id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await hook.call('hook.question_applied', { ...identity, relay_id: q.relay_id });
    expect(broker.questions.get(q.relay_id)?.state).toBe('applied');
  });
  it('refuses a hook from a different workspace or a nested agent process', async () => {
    const { hook, identity } = await setup();
    await expect(hook.call('hook.question_ready', { ...identity, cwd: '/elsewhere' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      hook.call('hook.question_ready', { ...identity, agent_pid: 77, pid_chain: [77, 43] }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('ignores native permission and plan-approval calls even for a supervised worker', async () => {
    const { lead, hook, identity } = await setup();
    await lead.client.call('assignment.delegate', {
      to: 'worker-one',
      subject: 's',
      body: 'b',
      idempotency_key: 'key',
    });
    expect(
      await hook.call('hook.question_capture', {
        ...identity,
        tool_name: 'ExitPlanMode',
        tool_use_id: 'c',
        turn_id: 't',
        tool_input: {},
      }),
    ).toEqual({ supervised: false });
  });
});
