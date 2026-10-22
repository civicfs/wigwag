import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import type { Agent } from '../../src/store/sessions.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, readCodexCalls, startTestBroker, WAIT_MS } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  delete process.env.FAKE_CODEX_LOG;
});
const states = ['idle', 'busy'] as const;
const priorities = ['urgent', 'normal', 'low'] as const;
const agents: Agent[] = ['claude', 'codex'];
const cases = agents.flatMap((from) =>
  agents.flatMap((to) =>
    states.flatMap((sender) =>
      states.flatMap((receiver) => priorities.map((priority) => ({ from, to, sender, receiver, priority }))),
    ),
  ),
);

async function session(home: string, agent: Agent, name: string, pid: number) {
  const peer = await mcpClient(home, {
    agent,
    requested_name: name,
    mcp_ppid: pid,
    pid_chain: [pid + 1, pid],
    channel: true,
    ...(agent === 'claude' ? { channel_receipts: true as const } : {}),
  });
  cleanup.push(() => peer.client.close());
  const native = `native-${name}`;
  let hook: Client | undefined;
  const event = (name: string) =>
    hook?.call<{ additional_context: string | null }>('hook.event', {
      agent: 'claude',
      event: name,
      agent_session_id: native,
      cwd: '/w/myproject',
      agent_pid: pid,
      pid_chain: [pid + 9, pid],
    });
  if (agent === 'codex') await peer.client.call('session.bind', { agent_session_id: native });
  else {
    hook = (await Client.connect(sockPath(home), { protocol: 1, role: 'hook' }, frameLimit(loadConfig(home)))).client;
    cleanup.push(() => hook?.close());
    await event('SessionStart');
  }
  return {
    ...peer,
    set: (state: 'busy' | 'idle') =>
      agent === 'codex'
        ? peer.client.call('session.turn', { phase: state === 'busy' ? 'started' : 'ended' })
        : event(state === 'busy' ? 'UserPromptSubmit' : 'Stop'),
    digest: async () =>
      agent === 'codex'
        ? (await peer.client.call<{ text: string | null }>('session.digest')).text
        : (await event('PostToolUse'))?.additional_context,
  };
}

function delivery(broker: Broker, id: string) {
  return deliveriesOfMessage(broker.db, id)[0];
}

describe('provider and active/idle delivery combinations', () => {
  it.each(cases)('$from/$sender → $to/$receiver ($priority)', async ({ from, to, sender, receiver, priority }) => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const log = join(home, 'codex.jsonl');
    process.env.FAKE_CODEX_LOG = log;
    const source = await session(home, from, 'matrix-sender', 101);
    const target = await session(home, to, 'matrix-target', 201);
    await source.set(sender);
    await target.set(receiver);
    expect(getSession(broker.db, source.welcome.session_id)?.state).toBe(`online-${sender}`);
    expect(getSession(broker.db, target.welcome.session_id)?.state).toBe(`online-${receiver}`);
    const { id } = await source.client.call<{ id: string }>('msg.send', {
      to: 'matrix-target',
      subject: 'matrix',
      body: 'MATRIX-DELIVERY-TOKEN',
      priority,
      attachments: [],
    });
    if (priority === 'low') {
      await vi.waitFor(() => expect(delivery(broker, id)).toMatchObject({ state: 'held', hold_reason: 'low' }), {
        timeout: WAIT_MS,
      });
      expect(target.pushes).toHaveLength(0);
      expect(readCodexCalls(log)).toHaveLength(0);
      expect(await target.digest()).toContain('MATRIX-DELIVERY-TOKEN');
      expect(delivery(broker, id)).toMatchObject({
        state: 'read',
        transport: 'hook',
        recipient_session_id: target.welcome.session_id,
      });
    } else if (to === 'claude') {
      await vi.waitFor(() => expect(target.pushes).toHaveLength(1), { timeout: WAIT_MS });
      expect(target.pushes[0].content).toContain('MATRIX-DELIVERY-TOKEN');
      expect(delivery(broker, id).state).toBe('pending');
      await target.client.call('channel.receipt', { receipt_id: target.pushes[0].receipt_id, ok: true });
      await vi.waitFor(
        () =>
          expect(delivery(broker, id)).toMatchObject({
            state: 'read',
            transport: 'claude-channel',
            recipient_session_id: target.welcome.session_id,
          }),
        { timeout: WAIT_MS },
      );
    } else {
      await vi.waitFor(
        () =>
          expect(delivery(broker, id)).toMatchObject({
            state: 'read',
            transport: 'codex-queue',
            recipient_session_id: target.welcome.session_id,
          }),
        { timeout: WAIT_MS },
      );
      expect(readCodexCalls(log)).toHaveLength(1);
      expect(readCodexCalls(log)[0].argv).toEqual([
        'queue',
        '--thread',
        'native-matrix-target',
        '--message',
        expect.stringContaining('MATRIX-DELIVERY-TOKEN'),
      ]);
    }
    await target.set('busy');
    await target.set('idle');
    expect(getSession(broker.db, target.welcome.session_id)?.state).toBe('online-idle');
    expect(target.pushes.length + readCodexCalls(log).length).toBe(priority === 'low' ? 0 : 1);
  });
});
