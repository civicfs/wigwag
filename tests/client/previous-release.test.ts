import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { assertPeerVersions } from '../../src/protocol/rpc.js';
import { getSession } from '../../src/store/sessions.js';
import { VERSION } from '../../src/version.js';
import { fixtureCodexNames, startBroker, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

// Literal v0.3.0 stamps from 36d80db:src/version.ts and src/protocol/rpc.ts.
// This socket helper deliberately does not apply today's Client.connect welcome validator.
const previous = { protocol: 1, schema_version: 4, version: '0.3.0' };
async function wirePeer(home: string, hello: Record<string, unknown>) {
  const socket = createConnection(sockPath(home));
  cleanup.push(() => socket.destroy());
  let next = 0;
  let buf = '';
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('wire peer closed'));
    pending.clear();
  });
  socket.on('data', (data) => {
    buf += data;
    let end = buf.indexOf('\n');
    while (end >= 0) {
      const frame = JSON.parse(buf.slice(0, end));
      buf = buf.slice(end + 1);
      const p = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) p?.reject(frame.error);
      else p?.resolve(frame.result);
      end = buf.indexOf('\n');
    }
  });
  const call = <T = unknown>(method: string, params: unknown = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const welcome = await call<{ session_id: string; name: string }>('hello', hello);
  return { call, welcome, socket };
}

describe('reviewed v0.3.0 wire compatibility', () => {
  it.each(['owner', 'hook', 'mcp'])(
    'negotiates the previous %s contract while keeping the broker database current',
    async (role) => {
      const home = tmpHome();
      const broker = await startBroker(home);
      cleanup.push(() => broker.stop());
      const peer = await wirePeer(home, {
        ...previous,
        role,
        ...(role === 'mcp' ? { agent: 'claude', cwd: home, pid_chain: [] } : {}),
      });
      // v0.3.0 rejects a welcome unless protocol=1/schema_version=4.
      expect(peer.welcome).toMatchObject({ protocol: 1, schema_version: 4, version: VERSION, client_mode: 'current' });
      expect(await peer.call('sys.ping')).toMatchObject({ pong: true, version: VERSION });
      expect(broker.db.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 5 });
    },
  );

  it.each(['claude', 'codex'] as const)(
    'retains %s identity, name, mailbox ownership and generation across broker replacement',
    async (agent) => {
      const home = tmpHome();
      const opts = {
        processProbe: () =>
          new Map([
            [100, 'parent-start'],
            [101, 'mcp-start'],
          ]),
        codexNames: fixtureCodexNames(home, () => ['native-root']),
      };
      let broker = await startBroker(home, opts);
      cleanup.push(() => broker.stop());
      const hello = {
        ...previous,
        role: 'mcp',
        agent,
        cwd: home,
        pid_chain: [101, 100],
        mcp_ppid: 100,
        requested_name: 'retained-worker',
        channel: false,
        ...(agent === 'codex' ? { host_client: { name: 'codex-mcp-client', version: '0.162.1' } } : {}),
      };
      const before = await wirePeer(home, hello);
      const id = before.welcome.session_id;
      const origin = { name: 'codex-mcp-client', version: '0.162.1', thread_id: 'native-root' };
      if (agent === 'codex') {
        await expect(before.call('session.bind', { agent_session_id: 'native-root' })).rejects.toMatchObject({
          code: 'bad_request',
        });
        await before.call('session.bind', { agent_session_id: 'native-root', hook_origin: origin });
      } else {
        const hook = await wirePeer(home, { ...previous, role: 'hook' });
        await hook.call('hook.event', {
          agent: 'claude',
          event: 'SessionStart',
          agent_session_id: 'native-root',
          cwd: home,
          agent_pid: 100,
          pid_chain: [9, 100],
        });
      }
      const message = await before.call<{ id: string }>('msg.send', {
        to: 'retained-worker',
        subject: 'retained',
        body: 'mail stays with its slot',
        priority: 'low',
        attachments: [],
      });
      const generation = getSession(broker.db, id)?.conn_generation;
      await broker.stop();
      broker = await startBroker(home, { ...opts, codexNames: fixtureCodexNames(home, () => ['native-root']) });
      const after = await wirePeer(home, { ...hello, resume_session_id: id });
      expect(after.welcome).toMatchObject({ session_id: id, name: 'retained-worker', schema_version: 4 });
      expect(await after.call('session.whoami')).toMatchObject({ id, bound: true, client_mode: 'current' });
      expect(getSession(broker.db, id)).toMatchObject({
        agent_session_id: 'native-root',
        conn_generation: (generation ?? 0) + 1,
      });
      expect(
        broker.db.prepare('SELECT sender_session_id FROM message_ownership WHERE message_id=?').get(message.id),
      ).toEqual({ sender_session_id: id });
      expect(
        broker.db.prepare('SELECT recipient_session_id FROM deliveries WHERE message_id=?').get(message.id),
      ).toEqual({ recipient_session_id: id });
      expect(JSON.stringify(await after.call('msg.inbox'))).toContain('mail stays with its slot');
      if (agent === 'codex') {
        await expect(
          after.call('session.turn', { phase: 'ended', hook_origin: { ...origin, call_id: 'model' } }),
        ).rejects.toMatchObject({ code: 'bad_request' });
        expect(getSession(broker.db, id)?.bind_origin).toBe('hook-verified');
      }
    },
  );

  it.each([
    { ...previous, version: undefined },
    { ...previous, version: '0.2.0' },
    { ...previous, version: '0.3.1' },
    { ...previous, version: '0.3.0-custom' },
    { ...previous, protocol: 0 },
    { ...previous, protocol: 2 },
    { ...previous, schema_version: 3 },
    { ...previous, schema_version: 6 },
  ])('rejects unreviewed client stamps %j before creating a slot', async (stamp) => {
    const home = tmpHome();
    const broker = await startBroker(home);
    cleanup.push(() => broker.stop());
    await expect(
      wirePeer(home, { ...stamp, role: 'mcp', agent: 'codex', cwd: home, pid_chain: [] }),
    ).rejects.toMatchObject({ code: 'schema' });
    expect(broker.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('does not treat schema4 broker replies or unknown roles as reviewed clients', () => {
    expect(() => assertPeerVersions({ ...previous, role: 'owner' }, 'broker')).toThrow('broker is older');
    expect(() => assertPeerVersions({ ...previous, role: 'future' }, 'client')).toThrow();
  });
});
