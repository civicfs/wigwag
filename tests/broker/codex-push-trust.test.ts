import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { bindAgentSession, claimName, createSession, getSession, setState } from '../../src/store/sessions.js';
import { mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

class FakeApp extends EventEmitter {
  loaded = ['T'];
  down = false;
  threads: Record<string, unknown> = { T: { id: 'T', sessionId: 'T', source: 'cli', parentThreadId: null } };
  async connect() {
    if (this.down) throw new Error('fixture unavailable');
  }
  async call(method: string, p: { threadId?: string }) {
    if (this.down) throw new Error('fixture unavailable');
    return method === 'thread/loaded/list' ? { data: this.loaded } : { thread: this.threads[p.threadId ?? ''] };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
  descendant() {
    this.loaded.push('child');
    this.threads.child = { id: 'child', sessionId: 'T', source: { subAgent: 'review' }, parentThreadId: 'T' };
  }
}
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function boot() {
  const home = tmpHome(),
    app = new FakeApp(),
    pushes: string[] = [];
  const codexNames = new CodexNames({ factory: () => app, indexPath: join(home, 'missing') });
  const broker = await startBroker(home, {
    codexNames,
    transports: {
      claude: { kind: 'claude-channel', async push() {} },
      codex: {
        kind: 'codex-queue',
        async push(s) {
          pushes.push(s.agent_session_id ?? '');
        },
      },
    },
  });
  cleanup.push(() => broker.stop());
  const o = await ownerClient(home);
  cleanup.push(() => o.close());
  const c = await mcpClient(home, { agent: 'codex', requested_name: 'child-worker' });
  cleanup.push(() => c.client.close());
  const send = () =>
    o.call<{ id: string }>('owner.send', {
      to: 'child-worker',
      subject: 'trust-check',
      body: 'body',
      priority: 'urgent',
      attach_paths: [],
    });
  return { home, app, broker, pushes, o, c, send };
}
describe('Codex push trust at bind, probe and dispatch', () => {
  it.each(['offline', 'online-idle'] as const)(
    'a descendant presenting root T cannot inject into a %s root',
    async (state) => {
      const { app, broker, c, send, pushes } = await boot();
      const root = createSession(broker.db, { agent: 'codex', cwd: '/w/myproject', pid_chain: [], mcp_ppid: null });
      claimName(broker.db, root.id, 'root-worker', 'custom');
      bindAgentSession(broker.db, root.id, 'T');
      setState(broker.db, root.id, state);
      app.descendant();
      if (state === 'online-idle')
        await expect(c.client.call('session.bind', { agent_session_id: 'T' })).rejects.toThrow(/live session/);
      else await c.client.call('session.bind', { agent_session_id: 'T' });
      const m = await send();
      await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, m.id)[0]?.state ?? ''));
      expect(pushes).toEqual([]);
      expect(getSession(broker.db, root.id)?.name).toBe('root-worker');
      if (state === 'offline') expect(deliveriesOfMessage(broker.db, m.id)[0]?.hold_reason).toBe('codex-untrusted');
    },
  );
  it('pushes a single root, then catches evidence changing between bind and push; inbox/digest remains available', async () => {
    const { app, broker, c, send, pushes, o } = await boot();
    await c.client.call('session.bind', { agent_session_id: 'T' });
    const first = await send();
    await until(() => deliveriesOfMessage(broker.db, first.id)[0]?.state === 'read');
    expect(pushes).toEqual(['T']);
    app.descendant();
    const second = await send();
    await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, second.id)[0]?.state ?? ''));
    expect(pushes).toEqual(['T']);
    expect(deliveriesOfMessage(broker.db, second.id)[0]?.hold_reason).toBe('codex-untrusted');
    const whoami = await c.client.call<{ codex_push: string; capabilities: { codex_push: string } }>(
      'session.whoami',
      {},
    );
    expect(whoami.codex_push).toContain('descendant-loaded');
    expect(whoami.capabilities.codex_push).toBe('held');
    const who = await o.call<Array<{ name: string; codex_push: string }>>('session.who', {});
    expect(who.find((s) => s.name === 'child-worker')?.codex_push).toContain('thread identity unverified');
    const recovery = await o.call<{ codex_push_untrusted: Array<{ reason: string }> }>('owner.recovery', {});
    expect(recovery.codex_push_untrusted[0].reason).toBe('descendant-loaded');
    expect(broker.engine?.takeDigest('child-worker')).toContain('trust-check');
  });
  it('the probe refreshes connected sessions and app-server outages hold without queuing', async () => {
    const { app, broker, c, send, pushes } = await boot();
    await c.client.call('session.bind', { agent_session_id: 'T' });
    app.down = true;
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, c.welcome.session_id)?.codex_push_reason).toBe('app-server-unavailable');
    const m = await send();
    await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, m.id)[0]?.state ?? ''));
    expect(deliveriesOfMessage(broker.db, m.id)[0]?.hold_reason).toBe('codex-untrusted');
    expect(pushes).toEqual([]);
    app.down = false;
    await broker.liveness?.probeNow();
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'read');
    expect(pushes).toEqual(['T']);
  });
});
