import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { deliveriesOfMessage, insertMessage } from '../../src/store/messages.js';
import { mcpClient, startTestBroker } from '../helpers.js';

// E-3: a Claude session started without the development-channels flag cannot receive channel pushes. The MCP server
// reports whether the channel is usable (hello.channel); the broker must not mark such a push as delivered.
let home: string;
let broker: Broker;
const closers: Array<() => unknown> = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await broker.stop().catch(() => {});
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
const settle = () => new Promise((r) => setTimeout(r, 80));

async function hook(event: string, sessionId: string, mcpPpid: number) {
  const { client } = await Client.connect(sockPath(home), { protocol: 1, role: 'hook' }, frameLimit(loadConfig(home)));
  closers.push(() => client.close());
  return client.call<{ bound: boolean; additional_context: string | null }>('hook.event', {
    agent: 'claude',
    event,
    agent_session_id: sessionId,
    cwd: '/w/myproject',
    pid_chain: [9001, mcpPpid, 1],
    agent_pid: mcpPpid,
  });
}

describe('claude channel capability (E-3)', () => {
  it('does not mark a push delivered when the client has no channel: the delivery stays held', async () => {
    const a = await mcpClient(home, { requested_name: 'no-chan', mcp_ppid: 4001, channel: false });
    closers.push(() => a.client.close());
    const m = await send('no-chan', 'normal', 'E3-TOKEN');
    await settle();
    expect(a.pushes).toHaveLength(0);
    expect(state(m.id, 'no-chan')).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    expect(state(m.id, 'no-chan')?.last_error).toMatch(/channel/);
    const u = await send('no-chan', 'urgent', 'URGENT-TOKEN');
    expect(state(u.id, 'no-chan')).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    // low keeps its own reason
    const l = await send('no-chan', 'low', 'LOW-TOKEN');
    expect(state(l.id, 'no-chan')).toMatchObject({ state: 'held', hold_reason: 'low' });
  });

  // The held reason stays `unbound` either way (a fixed enum); only last_error tells the owner which fix applies.
  it('says the session is not bound, not that it lacks the channel, while no hook has bound it', async () => {
    const a = await mcpClient(home, { requested_name: 'no-chan', mcp_ppid: 4001, channel: false });
    closers.push(() => a.client.close());
    const m = await send('no-chan', 'normal', 'UNBOUND-TOKEN');
    expect(state(m.id, 'no-chan')).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    const text = state(m.id, 'no-chan')?.last_error ?? '';
    expect(text).toMatch(/no wigwag hook has bound/);
    expect(text).toMatch(/not bound/);
    expect(text).not.toMatch(/did not load the wigwag channel|start it with/);
  });

  it('says the session did not load the channel once a hook has bound it', async () => {
    const a = await mcpClient(home, { requested_name: 'no-chan', mcp_ppid: 4001, channel: false });
    closers.push(() => a.client.close());
    expect((await hook('SessionStart', 'claude-sess-b', 4001)).bound).toBe(true);
    const m = await send('no-chan', 'normal', 'BOUND-TOKEN');
    expect(state(m.id, 'no-chan')).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    const text = state(m.id, 'no-chan')?.last_error ?? '';
    expect(text).toMatch(/did not load the wigwag channel \(start it with: wigwag claude\)/);
    expect(text).not.toMatch(/no wigwag hook has bound/);
  });

  it('keeps pushing over the channel when the client advertised it (and for a legacy hello without the field)', async () => {
    const yes = await mcpClient(home, { requested_name: 'with-chan', mcp_ppid: 4002, channel: true });
    const legacy = await mcpClient(home, { requested_name: 'legacy-chan', mcp_ppid: 4003 });
    closers.push(
      () => yes.client.close(),
      () => legacy.client.close(),
    );
    const a = await send('with-chan', 'normal', 'A-TOKEN');
    const b = await send('legacy-chan', 'normal', 'B-TOKEN');
    await settle();
    expect(yes.pushes).toHaveLength(1);
    expect(legacy.pushes).toHaveLength(1);
    expect(state(a.id, 'with-chan')?.state).toBe('read');
    expect(state(b.id, 'legacy-chan')?.state).toBe('read');
  });

  it('does not retry-push a held backlog on later session events, and hands it over as a hook digest', async () => {
    const a = await mcpClient(home, { requested_name: 'no-chan', mcp_ppid: 4001, channel: false });
    closers.push(() => a.client.close());
    const m = await send('no-chan', 'normal', 'E3-TOKEN');
    const start = await hook('SessionStart', 'claude-sess-1', 4001);
    expect(start.bound).toBe(true);
    // the hook context states the unread count and tells the model to call inbox
    expect(start.additional_context).toMatch(/1 unread/);
    expect(start.additional_context).toMatch(/inbox/);
    expect(start.additional_context).toMatch(/channel/i);
    // the session events above (hello, bind, turn state) did not re-attempt the push: one held transition only
    const heldEvents = broker.db
      .prepare(`SELECT count(*) AS n FROM delivery_events WHERE message_id = ? AND to_state = 'held'`)
      .get(m.id) as { n: number };
    expect(heldEvents.n).toBe(1);
    // the next turn boundary delivers the held item as hook context
    const next = await hook('UserPromptSubmit', 'claude-sess-1', 4001);
    expect(next.additional_context).toContain('E3-TOKEN');
    expect(state(m.id, 'no-chan')).toMatchObject({ state: 'read', transport: 'hook' });
    expect(a.pushes).toHaveLength(0);
  });

  it('a channel-capable session still gets a plain registration context with an unread count only when there is one', async () => {
    const a = await mcpClient(home, { requested_name: 'with-chan', mcp_ppid: 4002, channel: true });
    closers.push(() => a.client.close());
    const none = await hook('SessionStart', 'claude-sess-2', 4002);
    expect(none.additional_context).toMatch(/registered as "with-chan"/);
    expect(none.additional_context).not.toMatch(/unread/);
    expect(none.additional_context).not.toMatch(/channel/i);
  });

  it('reports the unread count to a channel-capable session too (offline backlog)', async () => {
    const a = await mcpClient(home, { requested_name: 'with-chan', mcp_ppid: 4002, channel: true });
    closers.push(() => a.client.close());
    await send('with-chan', 'low', 'BACKLOG'); // low is held until a turn boundary, so it is still unread
    const start = await hook('SessionStart', 'claude-sess-2', 4002);
    expect(start.additional_context).toMatch(/1 unread/);
    expect(start.additional_context).toMatch(/inbox/);
  });

  it('a reconnect that now has the channel pushes the held backlog', async () => {
    const a = await mcpClient(home, { requested_name: 'no-chan', mcp_ppid: 4001, channel: false });
    const m = await send('no-chan', 'normal', 'LATER');
    a.client.close();
    await settle();
    // Resume this concrete session: a new holder of the same display name must not inherit its backlog.
    const b = await mcpClient(home, {
      requested_name: 'no-chan',
      mcp_ppid: 4001,
      channel: true,
      resume_session_id: a.welcome.session_id,
    });
    closers.push(() => b.client.close());
    await settle();
    expect(b.pushes).toHaveLength(1);
    expect(state(m.id, 'no-chan')?.state).toBe('read');
  });
});
