import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import { bindAgentSession, createSession, getSession, setAgentIdentity } from '../../src/store/sessions.js';
import { startBroker, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

class Metadata extends EventEmitter {
  loaded = ['T'];
  reads: string[] = [];
  lists = 0;
  onRead?: (id: string) => Promise<void> | void;
  async connect() {}
  async call(method: string, p: { threadId?: string }) {
    if (method === 'thread/loaded/list') {
      this.lists++;
      return { data: this.loaded };
    }
    const id = p.threadId as string;
    this.reads.push(id);
    await this.onRead?.(id);
    return {
      thread: {
        id,
        sessionId: id === 'child' ? 'T' : id,
        parentThreadId: id === 'child' ? 'T' : null,
        source: id === 'child' ? { subAgent: 'review' } : 'cli',
      },
    };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
async function boot(app: Metadata, deadline = 1000) {
  const home = tmpHome();
  const broker = await startBroker(home, {
    codexNames: new CodexNames({ factory: () => app, indexPath: join(home, 'missing') }),
    codexNameRefreshMs: 3_600_000,
    liveness: { intervalMs: 3_600_000, codexDeadlineMs: deadline },
  });
  cleanup.push(() => broker.stop());
  await broker.liveness?.probeNow();
  const seed = (native: string) => {
    const s = createSession(broker.db, { agent: 'codex', cwd: home, workspace: home, pid_chain: [], mcp_ppid: null });
    bindAgentSession(broker.db, s.id, native);
    broker.db
      .prepare(
        "UPDATE sessions SET bind_origin='hook-verified',host_client_name='codex-mcp-client',host_client_version='0.162.1',codex_push_reason=NULL WHERE id=?",
      )
      .run(s.id);
    return s.id;
  };
  return { home, broker, seed };
}

it('reads each of 256 loaded roots once per probe pass for 256 slots', async () => {
  const app = new Metadata();
  app.loaded = Array.from({ length: 256 }, (_, i) => `T-${i}`);
  const { broker, seed } = await boot(app);
  const ids = app.loaded.map(seed);
  await broker.liveness?.probeNow();
  expect(app.reads).toHaveLength(256);
  expect(new Set(app.reads)).toEqual(new Set(app.loaded));
  expect(app.lists).toBe(2);
  for (const id of ids) expect(getSession(broker.db, id)?.codex_push_reason).toBeNull();
});

it('finishes a blocked Codex pass by its deadline and still applies a new Claude probe independently', async () => {
  const app = new Metadata();
  app.loaded = ['T', 'other'];
  const { broker, seed, home } = await boot(app, 20);
  const c = seed('T');
  const claude = createSession(broker.db, {
    agent: 'claude',
    cwd: home,
    workspace: home,
    pid_chain: [],
    mcp_ppid: 100,
  });
  setAgentIdentity(broker.db, claude.id, 100, 'start-A');
  broker.db.prepare("UPDATE sessions SET link='disconnected' WHERE id=?").run(claude.id);
  let alive = true;
  broker.processProbe = () => new Map(alive ? [[100, 'start-A']] : []);
  let release = () => {},
    enter = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  app.onRead = async () => {
    enter();
    await gate;
  };
  const probing = broker.liveness?.probeNow();
  try {
    await entered;
    expect(getSession(broker.db, claude.id)?.parent_state).toBe('live');
    alive = false;
    void broker.liveness?.probeNow();
    expect(getSession(broker.db, claude.id)?.state).toBe('offline');
    const outcome = await Promise.race([
      probing?.then(() => 'complete'),
      new Promise((r) => setTimeout(() => r('late'), 100)),
    ]);
    expect(outcome).toBe('complete');
    expect(getSession(broker.db, c)?.codex_push_reason).toBe('app-server-unavailable');
    const reads = app.reads.length;
    release();
    await new Promise<void>((r) => setImmediate(r));
    expect(app.reads).toHaveLength(reads);
  } finally {
    release();
    await probing;
  }
});

it('trusts a verified concrete root when newly loaded unrelated metadata has not been read', async () => {
  const app = new Metadata();
  const { broker, seed } = await boot(app);
  const id = seed('T');
  app.onRead = () => {
    if (!app.loaded.includes('child')) app.loaded.push('child');
  };
  await broker.liveness?.probeNow();
  expect(getSession(broker.db, id)?.codex_push_reason).toBeNull();
  expect(app.lists).toBe(2);
  await broker.liveness?.probeNow();
  expect(getSession(broker.db, id)?.codex_push_reason).toBeNull();
  expect(app.reads).toEqual(['T', 'T']);
});

it('reads only actual recipients from a large loaded set and isolates an unreadable recipient', async () => {
  const app = new Metadata();
  app.loaded = ['T', 'U', ...Array.from({ length: 256 }, (_, i) => `unrelated-${i}`)];
  const { broker, seed } = await boot(app);
  const healthy = seed('T'),
    unreadable = seed('U');
  app.onRead = (id) => {
    if (id === 'U') throw new Error('Codex app-server error: fixture unreadable');
  };
  await broker.liveness?.probeNow();
  expect(getSession(broker.db, healthy)?.codex_push_reason).toBeNull();
  expect(getSession(broker.db, unreadable)?.codex_push_reason).toBe('unreadable-loaded');
  expect(app.reads.sort()).toEqual(['T', 'U']);
  expect(app.lists).toBe(2);
});

it('stops a blocked snapshot without waiting for its long deadline or touching the closed DB later', async () => {
  const app = new Metadata();
  app.loaded = Array.from({ length: 16 }, (_, i) => `T-${i}`);
  const { broker, seed } = await boot(app, 60000);
  seed('T-0');
  let release = () => {},
    enter = () => {};
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      enter = r;
    });
  app.onRead = async () => {
    enter();
    await gate;
  };
  const probing = broker.liveness?.probeNow();
  try {
    await entered;
    await broker.stop();
    expect(
      await Promise.race([probing?.then(() => 'stopped'), new Promise((r) => setTimeout(() => r('late'), 100))]),
    ).toBe('stopped');
    await expect(broker.liveness?.probeNow()).resolves.toBeUndefined();
    const reads = app.reads.length;
    expect(reads).toBeLessThanOrEqual(8);
    release();
    await new Promise<void>((r) => setImmediate(r));
    expect(app.reads).toHaveLength(reads);
  } finally {
    release();
    await probing;
  }
});

it.each(['native-only', 'generation'])(
  'does not apply a stale snapshot after the %s binding changes',
  async (change) => {
    const app = new Metadata(),
      { broker, seed } = await boot(app);
    const id = seed('T');
    broker.db.prepare("UPDATE sessions SET link='disconnected' WHERE id=?").run(id);
    let release = () => {},
      enter = () => {};
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      entered = new Promise<void>((r) => {
        enter = r;
      });
    app.onRead = async () => {
      enter();
      await gate;
    };
    const probing = broker.liveness?.probeNow();
    try {
      await entered;
      broker.db
        .prepare(
          "UPDATE sessions SET agent_session_id='U',parent_state='unknown',codex_push_reason='root-not-loaded',conn_generation=conn_generation+? WHERE id=?",
        )
        .run(change === 'generation' ? 1 : 0, id);
      release();
      await probing;
      expect(getSession(broker.db, id)).toMatchObject({
        agent_session_id: 'U',
        parent_state: 'unknown',
        codex_push_reason: 'root-not-loaded',
      });
    } finally {
      release();
      await probing;
    }
  },
);
