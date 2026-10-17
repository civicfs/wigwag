import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFor } from '../../src/broker/capabilities.js';
import { CodexNames } from '../../src/native/codex-names.js';
import { deliveriesOfMessage, insertMessage } from '../../src/store/messages.js';
import { bindAgentSession, claimName, createSession, getSession, setState } from '../../src/store/sessions.js';
import { addThrottle } from '../../src/store/subs.js';
import { mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

class FakeApp extends EventEmitter {
  loaded = ['T'];
  pauseList?: { entered: () => void; release: Promise<void> };
  down = false;
  threads: Record<string, unknown> = { T: { id: 'T', sessionId: 'T', source: 'cli', parentThreadId: null } };
  async connect() {
    if (this.down) throw new Error('fixture unavailable');
  }
  async call(method: string, p: { threadId?: string }) {
    if (this.down) throw new Error('fixture unavailable');
    if (method === 'thread/loaded/list' && this.pauseList) {
      const pause = this.pauseList;
      this.pauseList = undefined;
      pause.entered();
      await pause.release;
    }
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
    pushes: string[] = [],
    pushedMail: Array<{ session: string; messages: string[] }> = [];
  const codexNames = new CodexNames({ factory: () => app, indexPath: join(home, 'missing') });
  const broker = await startBroker(home, {
    codexNames,
    transports: {
      claude: { kind: 'claude-channel', async push() {} },
      codex: {
        kind: 'codex-queue',
        async push(s, items) {
          pushes.push(s.agent_session_id ?? '');
          pushedMail.push({ session: s.id, messages: items.map((x) => x.msg.id) });
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
  return { home, app, broker, pushes, pushedMail, o, c, send };
}
describe('Codex push trust at bind, probe and dispatch', () => {
  it.each(['hold', 'push'])(
    'rechecks delivery ownership after trust I/O before a %s, including a forwarded ride-along',
    async (mode) => {
      const f = await boot();
      await f.c.client.call('session.bind', { agent_session_id: 'T' });
      const owner = getSession(f.broker.db, f.c.welcome.session_id);
      if (!owner) throw new Error('missing owner');
      const other = createSession(f.broker.db, {
        agent: 'codex',
        cwd: owner.cwd,
        workspace: owner.workspace,
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(f.broker.db, other.id, 'other-worker', 'custom');
      setState(f.broker.db, other.id, 'offline');
      let enter = () => {},
        release = () => {};
      const entered = new Promise<void>((r) => {
          enter = r;
        }),
        gate = new Promise<void>((r) => {
          release = r;
        });
      f.broker.checkCodexPush = async () => {
        enter();
        await gate;
        return mode === 'hold' ? 'app-server-unavailable' : null;
      };
      const wake = await f.send();
      try {
        await entered;
        f.broker.db.prepare('UPDATE deliveries SET forward_to=? WHERE message_id=?').run(other.id, wake.id);
        // A physical old address legitimately rides along for this session through durable forward_to ownership.
        const ride = insertMessage(
          f.broker.db,
          {
            from_name: 'owner',
            to_target: 'old-address',
            kind: 'message',
            priority: 'low',
            subject: 'ride',
            body: 'owned ride',
            attachments: [],
            reply_to: null,
            request_id: null,
            expires_at: null,
            stream: null,
          },
          ['old-address'],
        );
        f.broker.db
          .prepare("UPDATE deliveries SET state='held',hold_reason='low',forward_to=? WHERE message_id=?")
          .run(owner.id, ride.id);
        release();
        await f.c.client.call('sys.ping');
        if (mode === 'push') await until(() => deliveriesOfMessage(f.broker.db, ride.id)[0]?.state === 'read');
        expect(f.pushedMail.filter((x) => x.session === owner.id).flatMap((x) => x.messages)).not.toContain(wake.id);
        if (mode === 'push') expect(f.pushedMail.flatMap((x) => x.messages)).toContain(ride.id);
        else
          expect(deliveriesOfMessage(f.broker.db, wake.id)[0]).toMatchObject({
            state: 'pending',
            hold_reason: null,
            forward_to: other.id,
          });
      } finally {
        release();
      }
    },
  );
  it('replans after generation changes during trust I/O even when every delivery still belongs to the same slot', async () => {
    const f = await boot();
    await f.c.client.call('session.bind', { agent_session_id: 'T' });
    const s = getSession(f.broker.db, f.c.welcome.session_id);
    if (!s) throw new Error('missing slot');
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      }),
      generations: number[] = [];
    f.broker.checkCodexPush = async (current) => {
      generations.push(current.conn_generation);
      if (generations.length === 1) {
        enter();
        await gate;
        return null;
      }
      return 'app-server-unavailable';
    };
    const wake = await f.send();
    try {
      await entered;
      f.broker.db.prepare('UPDATE sessions SET conn_generation=conn_generation+1 WHERE id=?').run(s.id);
      release();
      await until(() => deliveriesOfMessage(f.broker.db, wake.id)[0]?.state === 'held');
      expect(generations).toEqual([s.conn_generation, s.conn_generation + 1]);
      expect(f.pushedMail).toEqual([]);
      expect(deliveriesOfMessage(f.broker.db, wake.id)[0]?.hold_reason).toBe('codex-untrusted');
    } finally {
      release();
    }
  });
  it('never collects a replacement holder’s low mail after a rename during metadata preflight', async () => {
    const { home, app, broker, pushedMail, o, c } = await boot();
    app.loaded.push('U');
    app.threads.U = { id: 'U', sessionId: 'U', parentThreadId: null, source: 'cli' };
    await c.client.call('session.bind', { agent_session_id: 'T' });
    await c.client.call('session.register', { name: 'alpha' });
    const other = await mcpClient(home, { agent: 'codex', requested_name: 'other-worker' });
    cleanup.push(() => other.client.close());
    await other.client.call('session.bind', { agent_session_id: 'U' });
    const privateMail = await o.call<{ id: string }>('owner.send', {
      to: 'other-worker',
      subject: 'private',
      body: 'U-only',
      priority: 'low',
      attach_paths: [],
    });
    await until(() => deliveriesOfMessage(broker.db, privateMail.id)[0]?.state === 'held');
    expect(deliveriesOfMessage(broker.db, privateMail.id)[0]?.hold_reason).toBe('low');
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    app.pauseList = { entered: enter, release: gate };
    const wake = await o.call<{ id: string }>('owner.send', {
      to: 'alpha',
      subject: 'wake',
      body: 'T-only',
      priority: 'urgent',
      attach_paths: [],
    });
    try {
      await entered;
      await c.client.call('session.register', { name: 'beta' });
      await other.client.call('session.register', { name: 'alpha' });
    } finally {
      release();
    }
    // A ping arrives after the released preflight's continuation, so its final selection has run.
    await c.client.call('sys.ping');
    await until(() => deliveriesOfMessage(broker.db, wake.id)[0]?.state === 'read');
    expect(pushedMail.filter((x) => x.session === c.welcome.session_id).flatMap((x) => x.messages)).not.toContain(
      privateMail.id,
    );
    expect(deliveriesOfMessage(broker.db, privateMail.id)[0]).toMatchObject({
      recipient: 'alpha',
      state: 'held',
      hold_reason: 'low',
    });
    expect(JSON.stringify(await c.client.call('msg.inbox'))).not.toContain(privateMail.id);
    const otherWake = await o.call<{ id: string }>('owner.send', {
      to: 'alpha',
      subject: 'own wake',
      body: 'U',
      priority: 'urgent',
      attach_paths: [],
    });
    await until(() => deliveriesOfMessage(broker.db, otherWake.id)[0]?.state === 'read');
    expect(pushedMail.filter((x) => x.session === other.welcome.session_id).flatMap((x) => x.messages)).toContain(
      privateMail.id,
    );
    expect(JSON.stringify(await other.client.call('msg.inbox', { include_read: true }))).toContain(privateMail.id);
  });
  it.each(['too-many-loaded', 'unreadable-loaded'])('persists and reports the distinct %s hold', async (reason) => {
    const { app, broker, c, send, pushes, o } = await boot();
    app.loaded =
      reason === 'too-many-loaded'
        ? ['T', ...Array.from({ length: 256 }, (_, i) => `other-${i}`)]
        : ['T', 'unreadable'];
    await c.client.call('session.bind', { agent_session_id: 'T' });
    expect(getSession(broker.db, c.welcome.session_id)?.codex_push_reason).toBe(reason);
    const m = await send();
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'held');
    expect(deliveriesOfMessage(broker.db, m.id)[0]?.hold_reason).toBe('codex-untrusted');
    expect(pushes).toEqual([]);
    for (const output of [
      await c.client.call('session.whoami'),
      await o.call('session.who'),
      await o.call('owner.recovery'),
    ])
      expect(JSON.stringify(output)).toContain(reason);
  });
  it.each(['bind-first', 'reattach-first'])(
    'keeps one live holder when an offline binding returns (%s)',
    async (order) => {
      const { home, broker, c } = await boot();
      await c.client.call('session.bind', { agent_session_id: 'T' });
      c.client.destroy();
      await until(() => getSession(broker.db, c.welcome.session_id)?.link === 'disconnected');
      setState(broker.db, c.welcome.session_id, 'offline');
      const other = await mcpClient(home, { agent: 'codex', requested_name: 'other-worker' });
      cleanup.push(() => other.client.destroy());
      const reattach = () => mcpClient(home, { agent: 'codex', resume_session_id: c.welcome.session_id });
      if (order === 'bind-first') {
        await other.client.call('session.bind', { agent_session_id: 'T' });
        const attempt = reattach();
        void attempt.then(
          ({ client }) => client.destroy(),
          () => {},
        );
        await expect(attempt).rejects.toMatchObject({ code: 'conflict' });
        expect(getSession(broker.db, c.welcome.session_id)?.state).toBe('offline');
        expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBe('T');
      } else {
        const back = await reattach();
        cleanup.push(() => back.client.destroy());
        expect(back.welcome.session_id).toBe(c.welcome.session_id);
        await expect(other.client.call('session.bind', { agent_session_id: 'T' })).rejects.toMatchObject({
          code: 'conflict',
        });
        expect(getSession(broker.db, other.welcome.session_id)?.agent_session_id).toBeNull();
      }
    },
  );
  it('holds both live duplicate Codex bindings even when metadata is a clean loaded root', async () => {
    const { broker, c, send, pushes } = await boot();
    await c.client.call('session.bind', { agent_session_id: 'T' });
    const current = getSession(broker.db, c.welcome.session_id);
    if (!current) throw new Error('missing session');
    const duplicate = createSession(broker.db, {
      agent: 'codex',
      cwd: current.cwd,
      workspace: current.workspace,
      pid_chain: [],
      mcp_ppid: null,
    });
    bindAgentSession(broker.db, duplicate.id, 'T');
    // Both rows carry fixture hook evidence; this regression isolates the duplicate-holder gate.
    broker.db
      .prepare(
        "UPDATE sessions SET bind_origin='hook-verified',host_client_name='codex-mcp-client',host_client_version='0.162.1' WHERE id=?",
      )
      .run(duplicate.id);
    expect(await broker.checkCodexPush(current, true)).toBe('shared-root');
    expect(await broker.checkCodexPush(getSession(broker.db, duplicate.id) ?? duplicate, true)).toBe('shared-root');
    const m = await send();
    await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, m.id)[0]?.state ?? ''));
    expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({ state: 'held', hold_reason: 'codex-untrusted' });
    expect(pushes).toEqual([]);
  });
  it('rechecks duplicate bindings after metadata I/O', async () => {
    const { app, broker, c, send, pushes } = await boot();
    await c.client.call('session.bind', { agent_session_id: 'T' });
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      waiting = new Promise<void>((r) => {
        release = r;
      });
    app.pauseList = { entered: enter, release: waiting };
    const m = await send();
    await entered;
    const current = getSession(broker.db, c.welcome.session_id);
    if (!current) throw new Error('missing session');
    const duplicate = createSession(broker.db, { agent: 'codex', cwd: current.cwd, pid_chain: [], mcp_ppid: null });
    bindAgentSession(broker.db, duplicate.id, 'T');
    release();
    await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, m.id)[0]?.state ?? ''));
    expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({ state: 'held', hold_reason: 'codex-untrusted' });
    expect(pushes).toEqual([]);
  });
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
  it('holds a trusted loaded root while MCP is disconnected and releases on reattach', async () => {
    const { home, broker, c, send, pushes, o } = await boot();
    await c.client.call('session.bind', { agent_session_id: 'T' });
    c.client.close();
    await until(() => getSession(broker.db, c.welcome.session_id)?.link === 'disconnected');
    const m = await send();
    await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, m.id)[0]?.state ?? ''));
    expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({ state: 'held', hold_reason: 'disconnected' });
    expect(pushes).toEqual([]);
    const who = await o.call<Array<{ name: string; codex_push: string }>>('session.who');
    expect(who.find((s) => s.name === 'child-worker')?.codex_push).toContain('MCP disconnected');
    const slot = getSession(broker.db, c.welcome.session_id);
    if (!slot) throw new Error('missing slot');
    expect(capabilitiesFor(broker, slot)).toMatchObject({
      delivery: 'hook-boundary',
      codex_push: 'held',
      codex_push_reason: 'mcp-disconnected',
    });
    const recovery = await o.call<{ codex_push_untrusted: Array<{ reason: string }> }>('owner.recovery', {});
    expect(recovery.codex_push_untrusted.some((s) => s.reason === 'mcp-disconnected')).toBe(true);
    const next = await mcpClient(home, { agent: 'codex', requested_name: 'child-worker', resume_session_id: slot.id });
    cleanup.push(() => next.client.close());
    expect(next.welcome.session_id).toBe(slot.id);
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'read');
    expect(pushes).toEqual(['T']);
  });
  it('a disconnect during fresh metadata I/O holds before reaching the queue transport', async () => {
    const { app, broker, c, send, pushes } = await boot();
    await c.client.call('session.bind', { agent_session_id: 'T' });
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((r) => {
        enter = r;
      }),
      waiting = new Promise<void>((r) => {
        release = r;
      });
    app.pauseList = { entered: enter, release: waiting };
    const m = await send();
    await entered;
    c.client.close();
    await until(() => getSession(broker.db, c.welcome.session_id)?.link === 'disconnected');
    release();
    await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, m.id)[0]?.state ?? ''));
    expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({ state: 'held', hold_reason: 'disconnected' });
    expect(pushes).toEqual([]);
  });
  it('keeps throttle precedence while disconnected and permits non-throttled hook delivery', async () => {
    const { broker, c, send, pushes } = await boot();
    await c.client.call('session.bind', { agent_session_id: 'T' });
    c.client.close();
    await until(() => getSession(broker.db, c.welcome.session_id)?.link === 'disconnected');
    const first = await send();
    await until(() => ['held', 'read'].includes(deliveriesOfMessage(broker.db, first.id)[0]?.state ?? ''));
    expect(broker.engine?.takeDigest('child-worker')).toContain('trust-check');
    expect(pushes).toEqual([]);
    addThrottle(broker.db, 'owner', 'child-worker');
    const second = await send();
    await until(() => deliveriesOfMessage(broker.db, second.id)[0]?.state === 'held');
    expect(deliveriesOfMessage(broker.db, second.id)[0]?.hold_reason).toBe('throttled');
    expect(broker.engine?.takeDigest('child-worker')).toBeNull();
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
