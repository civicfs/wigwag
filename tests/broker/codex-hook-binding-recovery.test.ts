import { EventEmitter } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import { getSession } from '../../src/store/sessions.js';
import { fixtureCodexNames, mcpClient, startBroker, tmpHome, until } from '../helpers.js';

const host = { name: 'codex-mcp-client', version: '0.162.1' };
const origin = (thread_id = 'root-A') => ({ ...host, thread_id });
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function boot(version = host.version) {
  const home = tmpHome();
  const broker = await startBroker(home, { codexNames: fixtureCodexNames(home, () => ['root-A', 'root-B']) });
  cleanup.push(() => broker.stop());
  const c = await mcpClient(home, { agent: 'codex', host_client: { ...host, version } }, false);
  cleanup.push(() => c.client.destroy());
  return { home, broker, c };
}

it.each(['started', 'ended', 'digest'])(
  'recovers a failed SessionStart bind after broker replacement on a genuine %s hook',
  async (hook) => {
    const home = tmpHome();
    const previous = await startBroker(home, { codexNames: fixtureCodexNames(home, () => ['root-A']) });
    const old = await mcpClient(home, { agent: 'codex', host_client: host }, false);
    cleanup.push(() => old.client.destroy());
    await previous.stop();
    await expect(
      old.client.call('session.bind', { agent_session_id: 'root-A', hook_origin: origin() }),
    ).rejects.toMatchObject({ code: 'transport' });
    const broker = await startBroker(home, { codexNames: fixtureCodexNames(home, () => ['root-A']) });
    cleanup.push(() => broker.stop());
    const c = await mcpClient(
      home,
      { agent: 'codex', host_client: host, resume_session_id: old.welcome.session_id },
      false,
    );
    cleanup.push(() => c.client.destroy());
    expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBeNull();
    if (hook === 'digest')
      expect(await c.client.call('session.digest', { hook_origin: origin() })).toEqual({ text: null });
    else await c.client.call('session.turn', { phase: hook, hook_origin: origin() });
    expect(await c.client.call('session.whoami')).toMatchObject({
      id: old.welcome.session_id,
      bound: true,
      bind_origin: 'hook-verified',
      capabilities: { codex_push: 'trusted' },
      state: hook === 'started' ? 'online-busy' : 'online-idle',
    });
    expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBe('root-A');
  },
);

it('serializes concurrent first hooks and refuses a different concrete conversation', async () => {
  const { broker, c } = await boot();
  const results = await Promise.allSettled([
    c.client.call('session.turn', { phase: 'started', hook_origin: origin() }),
    c.client.call('session.digest', { hook_origin: origin() }),
    c.client.call('session.turn', { phase: 'ended', hook_origin: origin('root-B') }),
  ]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
  expect(results[2]).toMatchObject({ reason: { code: 'bad_request' } });
  expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({
    agent_session_id: 'root-A',
    bind_origin: 'hook-verified',
    state: 'online-busy',
  });
});

it.each([
  undefined,
  { ...origin(), call_id: 'model-call' },
  { ...origin(), version: 'forged-version' },
  { ...origin(), name: 'other-client' },
])('refuses missing or forged first-hook origin %j without granting identity', async (hook_origin) => {
  const { broker, c } = await boot();
  for (const method of ['session.turn', 'session.digest'] as const)
    await expect(
      c.client.call(method, { ...(method === 'session.turn' ? { phase: 'started' } : {}), hook_origin }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({
    agent_session_id: null,
    bind_origin: 'unverified',
    state: 'online-idle',
  });
});

it.each(['0.164.0', '1.0.0', '999.1.2-alpha.3+build.4'])(
  'recovers a missed bind from a future host %s without a version override',
  async (version) => {
    const { broker, c } = await boot(version);
    await c.client.call('session.turn', {
      phase: 'started',
      hook_origin: { ...origin(), version },
    });
    expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({
      agent_session_id: 'root-A',
      bind_origin: 'hook-verified',
      codex_push_reason: null,
    });
  },
);

it('does not grant automatic first-hook binding to an older host', async () => {
  const { broker, c } = await boot('0.161.0');
  await expect(
    c.client.call('session.turn', {
      phase: 'started',
      hook_origin: { ...origin(), version: '0.161.0' },
    }),
  ).rejects.toMatchObject({ code: 'bad_request' });
  expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBeNull();
});

it('preserves the already-bound mismatch guard and accepts the existing conversation', async () => {
  const { broker, c } = await boot();
  await c.client.call('session.bind', { agent_session_id: 'root-A', hook_origin: origin() });
  for (const method of ['session.turn', 'session.digest'] as const)
    await expect(
      c.client.call(method, {
        ...(method === 'session.turn' ? { phase: 'started' } : {}),
        hook_origin: origin('root-B'),
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  await c.client.call('session.turn', { phase: 'started', hook_origin: origin() });
  expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({
    agent_session_id: 'root-A',
    bind_origin: 'hook-verified',
    state: 'online-busy',
  });
});

it.each(['generation', 'native', 'host', 'workspace', 'retired'])(
  'refuses stale automatic recovery when %s changes during native verification',
  async (change) => {
    const home = tmpHome();
    let loaded = true;
    let onRead: (() => Promise<void>) | undefined;
    class Metadata extends EventEmitter {
      async connect() {}
      async call(method: string, params: { threadId?: string }) {
        if (method === 'thread/loaded/list') return { data: loaded ? ['root-A'] : [] };
        await onRead?.();
        return { thread: { id: params.threadId, sessionId: params.threadId, source: 'cli', parentThreadId: null } };
      }
      send() {}
      close() {
        this.emit('disconnected');
      }
    }
    const broker = await startBroker(home, {
      trustedThreadId: () => 'root-A',
      codexNames: new CodexNames({ factory: () => new Metadata(), indexPath: `${home}/missing-index` }),
    });
    cleanup.push(() => broker.stop());
    const old = await mcpClient(home, { agent: 'codex', requested_name: 'canonical-worker' }, false);
    cleanup.push(() => old.client.destroy());
    await old.client.call('session.bind', { agent_session_id: 'root-A', hook_origin: origin() });
    loaded = false;
    old.client.destroy();
    await until(() => getSession(broker.db, old.welcome.session_id)?.state === 'offline');
    broker.liveness?.stop();
    const fresh = await mcpClient(home, { agent: 'codex' }, false);
    cleanup.push(() => fresh.client.destroy());
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onRead = async () => {
      onRead = undefined;
      enter();
      await gate;
    };
    const pending = fresh.client.call('session.turn', { phase: 'started', hook_origin: origin() });
    const refused = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    try {
      await entered;
      const assignments = {
        generation: 'conn_generation=conn_generation+1',
        native: "agent_session_id='root-B'",
        host: "host_client_version='forged-version'",
        workspace: "workspace='/other/workspace'",
        retired: "retired_at='2026-10-22T00:00:00.000Z'",
      };
      broker.db
        .prepare(`UPDATE sessions SET ${assignments[change as keyof typeof assignments]} WHERE id=?`)
        .run(fresh.welcome.session_id);
    } finally {
      release();
    }
    await refused;
    expect(getSession(broker.db, fresh.welcome.session_id)).toMatchObject({
      agent_session_id: change === 'native' ? 'root-B' : null,
      bind_origin: 'unverified',
      retired_into: null,
      state: 'online-idle',
    });
    expect(getSession(broker.db, old.welcome.session_id)).toMatchObject({
      agent_session_id: 'root-A',
      name: 'canonical-worker',
      state: 'offline',
    });
  },
);

it.each(['host-name', 'host-version', 'bind-origin'])(
  'refuses disconnected canonical reattach when incoming %s changes during metadata I/O',
  async (change) => {
    const home = tmpHome();
    let onRead: (() => Promise<void>) | undefined;
    class Metadata extends EventEmitter {
      async connect() {}
      async call(method: string, params: { threadId?: string }) {
        if (method === 'thread/loaded/list') return { data: ['root-A'] };
        await onRead?.();
        return { thread: { id: params.threadId, sessionId: params.threadId, source: 'cli', parentThreadId: null } };
      }
      send() {}
      close() {
        this.emit('disconnected');
      }
    }
    const broker = await startBroker(home, {
      codexNames: new CodexNames({ factory: () => new Metadata(), indexPath: `${home}/missing-index` }),
    });
    cleanup.push(() => broker.stop());
    const old = await mcpClient(home, { agent: 'codex', requested_name: 'canonical-worker' }, false);
    cleanup.push(() => old.client.destroy());
    await old.client.call('session.bind', { agent_session_id: 'root-A', hook_origin: origin() });
    broker.liveness?.stop();
    old.client.destroy();
    await until(() => getSession(broker.db, old.welcome.session_id)?.link === 'disconnected');
    const canonical = getSession(broker.db, old.welcome.session_id);
    expect(canonical?.state).not.toBe('offline');
    const fresh = await mcpClient(home, { agent: 'codex' }, false);
    cleanup.push(() => fresh.client.destroy());
    let enter = () => {},
      release = () => {};
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    onRead = async () => {
      onRead = undefined;
      enter();
      await gate;
    };
    const pending = fresh.client.call('session.turn', { phase: 'started', hook_origin: origin() });
    const refused = expect(pending).rejects.toMatchObject({ code: 'conflict' });
    try {
      await entered;
      const assignments = {
        'host-name': "host_client_name='forged-host'",
        'host-version': "host_client_version='0.163.0'",
        'bind-origin': "bind_origin='hook-verified'",
      };
      broker.db
        .prepare(`UPDATE sessions SET ${assignments[change as keyof typeof assignments]} WHERE id=?`)
        .run(fresh.welcome.session_id);
    } finally {
      release();
    }
    await refused;
    expect(getSession(broker.db, fresh.welcome.session_id)).toMatchObject({
      agent_session_id: null,
      retired_at: null,
      retired_into: null,
      state: 'online-idle',
      link: 'connected',
    });
    expect(getSession(broker.db, old.welcome.session_id)).toMatchObject({
      agent_session_id: 'root-A',
      name: 'canonical-worker',
      link: 'disconnected',
      conn_generation: canonical?.conn_generation,
    });
  },
);
