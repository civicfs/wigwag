import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { noProcesses } from '../../src/proc/identity.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { FeedData, Hello } from '../../src/protocol/rpc.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import type { Transport } from '../../src/transports/types.js';
import { ownerClient, startTestBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function boot() {
  const { home, broker } = await startTestBroker();
  cleanup.push(() => broker.stop());
  return { home, broker };
}
async function mcp(home: string, extra: Partial<Hello> = {}) {
  const hello: Hello = {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: '/Users/x/code/myproject',
    pid_chain: [500, 400, 300],
    mcp_ppid: 400,
    ...extra,
  };
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const ownerSend = async (home: string, to: string, subject: string, priority = 'low') => {
  const o = await ownerClient(home);
  cleanup.push(() => o.close());
  return o.call<{ id: string }>('owner.send', { to, subject, body: 'b', priority, attach_paths: [] });
};
const notices = (broker: Broker) =>
  broker.db
    .prepare(
      "SELECT to_target, subject FROM messages WHERE kind = 'notice' AND subject LIKE 'session renamed:%' ORDER BY rowid",
    )
    .all() as Array<{ to_target: string; subject: string }>;

describe('every rename (W2a)', () => {
  it.each([false, true])(
    'reclaiming a deferred source name leaves the new holder mail in place (push in flight: %s)',
    async (busyB) => {
      let releaseA = () => {};
      let releaseB = () => {};
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      let aId = '';
      const pushed: string[] = [];
      const transport: Transport = {
        kind: 'claude-channel',
        push: async (s) => {
          pushed.push(s.id);
          await (s.id === aId ? gateA : gateB);
          throw new Error('fixture push failed');
        },
      };
      const home = tmpHome();
      const broker = await startBroker(home, {
        processProbe: noProcesses,
        transports: { claude: transport, codex: { ...transport, kind: 'codex-queue' } },
      });
      cleanup.push(
        () => broker.stop(),
        () => {
          releaseA();
          releaseB();
        },
      );
      const a = await mcp(home, { requested_name: 'busy-name' });
      aId = a.welcome.session_id;
      const original = await ownerSend(home, 'busy-name', 'for-a', 'urgent');
      await until(() => pushed.includes(aId));
      await a.client.call('session.register', { name: 'new-name' });
      const b = await mcp(home, { mcp_ppid: 401 });
      await b.client.call('session.register', { name: 'busy-name' });
      const held = await ownerSend(home, 'busy-name', 'for-b');
      const wake = busyB ? await ownerSend(home, 'busy-name', 'wake-b', 'urgent') : null;
      releaseA();
      await until(() => deliveriesOfMessage(broker.db, original.id)[0]?.state === 'held');
      expect(deliveriesOfMessage(broker.db, held.id)[0]?.recipient).toBe('busy-name');
      if (wake) {
        expect(deliveriesOfMessage(broker.db, wake.id)[0]?.recipient).toBe('busy-name');
        await until(() => pushed.includes(b.welcome.session_id));
        releaseB();
        await until(() => deliveriesOfMessage(broker.db, wake.id)[0]?.state === 'held');
        expect(deliveriesOfMessage(broker.db, wake.id)[0]?.recipient).toBe('busy-name');
        expect(deliveriesOfMessage(broker.db, held.id)[0]?.recipient).toBe('busy-name');
      }
    },
  );
  it('forwards undelivered mail from a registered name too and audits the rename', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { requested_name: 'first-name' });
    const m = await ownerSend(home, 'first-name', 'to-first');
    await a.client.call('session.register', { name: 'second-name' });
    expect(deliveriesOfMessage(broker.db, m.id)[0].recipient).toBe('second-name');
    expect(
      broker.db.prepare('SELECT from_name, to_name, cause, name_source, mail_moved FROM session_renames').all(),
    ).toEqual([
      { from_name: 'first-name', to_name: 'second-name', cause: 'register', name_source: 'custom', mail_moved: 1 },
    ]);
  });

  it('notifies live sessions in scope, not itself, offline sessions or other workspaces', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { requested_name: 'alpha-one' });
    await mcp(home, { requested_name: 'peer-one', mcp_ppid: 401 });
    await mcp(home, { requested_name: 'far-one', cwd: '/Users/x/code/other', mcp_ppid: 402 });
    const gone = await mcp(home, { requested_name: 'gone-one', mcp_ppid: 403 });
    gone.client.close();
    await settle();
    await a.client.call('session.register', { name: 'alpha-two' });
    expect(notices(broker)).toEqual([{ to_target: 'peer-one', subject: 'session renamed: alpha-one → alpha-two' }]);
  });

  it('skips the notice when leaving an unused provisional name, and sends it once that name had traffic', async () => {
    const { home, broker } = await boot();
    await mcp(home, { requested_name: 'peer-one', mcp_ppid: 401 });
    const a = await mcp(home);
    await a.client.call('session.register', { name: 'quiet-one' });
    expect(notices(broker)).toEqual([]);
    const b = await mcp(home, { mcp_ppid: 402 });
    await ownerSend(home, b.welcome.name, 'hello');
    await b.client.call('session.register', { name: 'busy-one' });
    expect(
      notices(broker)
        .map((n) => n.to_target)
        .sort(),
    ).toEqual(['peer-one', 'quiet-one']);
    expect(new Set(notices(broker).map((n) => n.subject))).toEqual(
      new Set([`session renamed: ${b.welcome.name} → busy-one`]),
    );
  });

  it('moves active subscriptions and mutes with the name', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { requested_name: 'watcher-one' });
    await a.client.call('kv.watch', { prefix: 'lane/' });
    await a.client.call('mute.add', { target: 'sender:noisy-one' });
    await a.client.call('session.register', { name: 'watcher-two' });
    const active = (t: string) => broker.db.prepare(`SELECT session_name FROM ${t} WHERE removed_at IS NULL`).all();
    expect(active('subscriptions')).toEqual([{ session_name: 'watcher-two' }]);
    expect(active('mutes')).toEqual([{ session_name: 'watcher-two' }]);
    expect(broker.db.prepare('SELECT subscriptions_moved, mutes_moved FROM session_renames').get()).toEqual({
      subscriptions_moved: 1,
      mutes_moved: 1,
    });
  });

  it('broadcasts the renamed session to subscribed owners', async () => {
    const { home } = await boot();
    const feed: FeedData[] = [];
    const { client: o } = await Client.connect(
      sockPath(home),
      { protocol: 1, role: 'owner' },
      frameLimit(loadConfig(home)),
      (name, data) => {
        if (name === 'feed') feed.push(data as FeedData);
      },
    );
    cleanup.push(() => o.close());
    await o.call('owner.subscribe', {});
    const a = await mcp(home, { requested_name: 'feed-one' });
    await a.client.call('session.register', { name: 'feed-two' });
    await until(() => feed.some((f) => f.type === 'session' && (f.payload as { name: string }).name === 'feed-two'));
  });

  it('a delivery whose push was in flight during the rename follows once the push settles', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pushes: string[] = [];
    const claude: Transport = {
      kind: 'claude-channel',
      push: async (s) => {
        pushes.push(s.name ?? '');
        await gate;
        throw new Error('channel gone');
      },
    };
    const home = tmpHome();
    const broker = await startBroker(home, { transports: { claude, codex: { ...claude, kind: 'codex-queue' } } });
    cleanup.push(() => broker.stop());
    const a = await mcp(home, { requested_name: 'busy-name' });
    const m = await ownerSend(home, 'busy-name', 'urgent-one', 'urgent');
    await until(() => pushes.length === 1);
    await a.client.call('session.register', { name: 'new-name' });
    expect(deliveriesOfMessage(broker.db, m.id)[0].recipient).toBe('busy-name');
    release();
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.recipient === 'new-name');
  });
});
