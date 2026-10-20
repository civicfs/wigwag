import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import type { Client } from '../../src/client/client.js';
import { Client as BrokerClient } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { mcpClient, startTestBroker, until } from '../helpers.js';

let home: string;
let broker: Broker;
const clients: Client[] = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await broker.stop().catch(() => {});
});
const state = (id: string) => deliveriesOfMessage(broker.db, id)[0];

async function recipient(resumeId?: string) {
  const connected = await mcpClient(home, {
    requested_name: 'claude-recipient',
    agent: 'claude',
    mcp_ppid: 4001,
    channel: true,
    channel_receipts: true,
    resume_session_id: resumeId,
  });
  clients.push(connected.client);
  return connected;
}
async function codexSender() {
  const connected = await mcpClient(home, { requested_name: 'codex-sender', agent: 'codex', mcp_ppid: 4002 });
  clients.push(connected.client);
  await connected.client.call('session.bind', { agent_session_id: 'codex-thread' });
  return connected.client;
}
async function send(sender: Client, body = 'CODEX-TO-CLAUDE') {
  return sender.call<{ id: string }>('msg.send', {
    to: 'claude-recipient',
    subject: 'notification receipt',
    body,
    priority: 'normal',
    attachments: [],
  });
}

describe('durable Codex to Claude notification receipts', () => {
  it('keeps a notification unread until its bridge confirms the local write, then records channel delivery', async () => {
    const target = await recipient();
    const sender = await codexSender();
    const message = await send(sender);
    await until(() => target.pushes.length === 1);
    expect(state(message.id).state).toBe('pending');
    const receiptId = target.pushes[0].receipt_id;
    expect(receiptId).toBeDefined();
    expect(await sender.call('channel.receipt', { receipt_id: receiptId, ok: true }).catch((error) => error.code)).toBe(
      'bad_request',
    );
    expect(state(message.id).state).toBe('pending');
    expect(await target.client.call('channel.receipt', { receipt_id: receiptId, ok: true })).toEqual({
      accepted: true,
    });
    await until(() => state(message.id).state === 'read');
    expect(state(message.id)).toMatchObject({ state: 'read', transport: 'claude-channel' });
    expect(await target.client.call('channel.receipt', { receipt_id: receiptId, ok: true })).toEqual({
      accepted: false,
    });
  });

  it('preserves inbox recovery after the MCP host rejects a notification write', async () => {
    const target = await recipient();
    const sender = await codexSender();
    const message = await send(sender);
    await until(() => target.pushes.length === 1);
    await target.client.call('channel.receipt', { receipt_id: target.pushes[0].receipt_id, ok: false });
    await until(() => state(message.id).state === 'held');
    expect(state(message.id)).toMatchObject({ state: 'held', hold_reason: 'offline', transport: null });
    expect(state(message.id).last_error).toContain('notification write failed');
    const inbox = await target.client.call<{ messages: Array<{ id: string; body: string }> }>('msg.inbox', {});
    expect(JSON.stringify(inbox)).toContain('CODEX-TO-CLAUDE');
    expect(state(message.id).state).toBe('read');
  });

  it('rejects stale receipts on a replacement and delivers the retained backlog through its new receipt', async () => {
    const first = await recipient();
    const sender = await codexSender();
    const message = await send(sender);
    await until(() => first.pushes.length === 1);
    const oldReceipt = first.pushes[0].receipt_id;
    first.client.destroy();
    await until(() => state(message.id).state === 'held');
    const replacement = await recipient(first.welcome.session_id);
    await until(() => replacement.pushes.length === 1);
    expect(replacement.pushes[0].content).toContain('CODEX-TO-CLAUDE');
    expect(replacement.pushes[0].receipt_id).not.toBe(oldReceipt);
    expect(await replacement.client.call('channel.receipt', { receipt_id: oldReceipt, ok: true })).toEqual({
      accepted: false,
    });
    expect(state(message.id).state).toBe('held');
    await replacement.client.call('channel.receipt', { receipt_id: replacement.pushes[0].receipt_id, ok: true });
    await until(() => state(message.id).state === 'read');
  });

  it('delivers a rejected notification through the next trusted Claude hook turn boundary', async () => {
    const target = await recipient();
    const sender = await codexSender();
    const { client: hook } = await BrokerClient.connect(
      sockPath(home),
      { protocol: 1, role: 'hook' },
      frameLimit(loadConfig(home)),
    );
    clients.push(hook);
    const event = (phase: string) =>
      hook.call<{ bound: boolean; additional_context: string | null }>('hook.event', {
        agent: 'claude',
        event: phase,
        agent_session_id: 'claude-native',
        cwd: '/w/myproject',
        pid_chain: [9001, 4001, 1],
        agent_pid: 4001,
      });
    expect((await event('SessionStart')).bound).toBe(true);
    const message = await send(sender);
    await until(() => target.pushes.length === 1);
    await target.client.call('channel.receipt', { receipt_id: target.pushes[0].receipt_id, ok: false });
    await until(() => state(message.id).state === 'held');
    const turn = await event('UserPromptSubmit');
    expect(turn.additional_context).toContain('CODEX-TO-CLAUDE');
    expect(state(message.id)).toMatchObject({ state: 'read', transport: 'hook' });
  });
});
