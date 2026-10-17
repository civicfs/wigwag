import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { deliveriesOfMessage, insertMessage } from '../../src/store/messages.js';
import { EMPTY, reduce } from '../../src/tui/state.js';
import { mcpClient, readCodexCalls, startBroker, startTestBroker, until } from '../helpers.js';

// Owner decision (Pass 2): a message counts as read once it is delivered into the model's context, by a channel push,
// a codex queue call or a hook digest. Held, pending, stuck and failed items stay unread.
let home: string;
let broker: Broker;
const closers: Array<() => unknown> = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
  process.env.FAKE_CODEX_LOG = join(home, 'codex.jsonl');
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await broker.stop().catch(() => {});
  delete process.env.FAKE_CODEX_LOG;
});

const send = async (to: string, priority: 'urgent' | 'normal' | 'low', body: string) => {
  const m = insertMessage(
    broker.db,
    {
      from_name: 'owner',
      to_target: to,
      kind: 'message',
      priority,
      subject: 's',
      body,
      attachments: [],
      reply_to: null,
      request_id: null,
      expires_at: null,
      stream: null,
    },
    [to],
  );
  await broker.engine?.dispatchMessage(m.id);
  return m;
};
const state = (id: string, to: string) => deliveriesOfMessage(broker.db, id).find((d) => d.recipient === to);
const events = (id: string, to: string) =>
  (
    broker.db
      .prepare('SELECT to_state FROM delivery_events WHERE message_id = ? AND recipient = ? ORDER BY rowid')
      .all(id, to) as Array<{ to_state: string }>
  ).map((e) => e.to_state);

async function owner() {
  const feed: Array<{ type: string; payload: unknown }> = [];
  const { client } = await Client.connect(
    sockPath(home),
    { protocol: 1, role: 'owner' },
    frameLimit(loadConfig(home)),
    (n, d) => {
      if (n === 'feed') feed.push(d as { type: string; payload: unknown });
    },
  );
  closers.push(() => client.close());
  await client.call('owner.subscribe');
  return { client, feed };
}
const unreadOf = async (o: { client: Client }, name: string) =>
  (await o.client.call<Array<{ name: string; unread: number }>>('session.who')).find((s) => s.name === name)?.unread;

describe('delivered into the context counts as read', () => {
  it('a channel push is read at once: unread 0, default inbox empty, history and events keep it', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const o = await owner();
    const m = await send('claude-main', 'normal', 'pushed-body');
    await until(() => a.pushes.length === 1);
    expect(state(m.id, 'claude-main')).toMatchObject({ state: 'read', transport: 'claude-channel' });
    expect(events(m.id, 'claude-main')).toEqual(['pending', 'pushed', 'read']);
    expect(await unreadOf(o, 'claude-main')).toBe(0);
    expect((await a.client.call<{ messages: unknown[] }>('msg.inbox', { limit: 20 })).messages).toHaveLength(0);
    const hist = await a.client.call<{ messages: Array<{ message: { id: string }; delivery_state: string }> }>(
      'msg.inbox',
      { limit: 20, include_read: true },
    );
    expect(hist.messages.map((x) => [x.message.id, x.delivery_state])).toEqual([[m.id, 'read']]);
  });

  it('a hook digest is read; a held low item stays unread until then', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const o = await owner();
    const m = await send('claude-main', 'low', 'fyi');
    expect(state(m.id, 'claude-main')?.state).toBe('held');
    expect(await unreadOf(o, 'claude-main')).toBe(1);
    expect(broker.engine?.takeDigest('claude-main')).toContain('fyi');
    expect(state(m.id, 'claude-main')).toMatchObject({ state: 'read', transport: 'hook' });
    expect(events(m.id, 'claude-main')).toEqual(['pending', 'held', 'pushed', 'read']);
    expect(await unreadOf(o, 'claude-main')).toBe(0);
  });

  it('a codex queue push is read once the queue call succeeds; before binding it is held and unread', async () => {
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    const o = await owner();
    const m = await send('codex-merger', 'normal', 'to codex');
    expect(state(m.id, 'codex-merger')).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    expect(await unreadOf(o, 'codex-merger')).toBe(1);
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    await until(() => readCodexCalls(join(home, 'codex.jsonl')).length === 1);
    await until(() => state(m.id, 'codex-merger')?.state === 'read');
    expect(state(m.id, 'codex-merger')?.transport).toBe('codex-queue');
    expect(await unreadOf(o, 'codex-merger')).toBe(0);
  });

  it('a failed codex queue call leaves the item unread', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    try {
      const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
      closers.push(() => c.client.close());
      await c.client.call('session.bind', { agent_session_id: 'thread-9' });
      const o = await owner();
      const m = await send('codex-merger', 'normal', 'will fail');
      await until(
        () => state(m.id, 'codex-merger')?.state === 'failed' || state(m.id, 'codex-merger')?.state === 'stuck',
      );
      expect(await unreadOf(o, 'codex-merger')).toBe(1);
    } finally {
      delete process.env.FAKE_CODEX_MODE;
    }
  });

  it('survives a broker restart: still read, still not unread', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    const m = await send('claude-main', 'normal', 'persist');
    await until(() => a.pushes.length === 1);
    a.client.close();
    await broker.stop();
    broker = await startBroker(home);
    const b = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => b.client.close());
    const o = await owner();
    expect(state(m.id, 'claude-main')?.state).toBe('read');
    expect(await unreadOf(o, 'claude-main')).toBe(0);
    expect(b.pushes).toHaveLength(0);
  });

  it('the owner feed carries recipient_unread 0 after the push, so the TUI session row shows no unread', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const o = await owner();
    const m = await send('claude-main', 'normal', 'tui');
    await until(() => a.pushes.length === 1);
    await until(() => o.feed.some((f) => f.type === 'delivery' && (f.payload as { state: string }).state === 'read'));
    const sess = (await o.client.call<Array<{ name: string }>>('session.who')).find((s) => s.name === 'claude-main');
    let s = reduce({ ...EMPTY, sessions: [{ ...(sess as object), unread: 1 } as never] }, {
      type: 'feed',
      data: { type: 'message', payload: { id: m.id, subject: 's' } as never },
    } as never);
    for (const f of o.feed) if (f.type === 'delivery') s = reduce(s, { type: 'feed', data: f } as never);
    expect(s.sessions[0].unread).toBe(0);
    expect(s.deliveries).toEqual([]);
  });
});
