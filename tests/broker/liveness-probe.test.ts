import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLiveness } from '../../src/broker/liveness.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { CodexNames } from '../../src/native/codex-names.js';
import type { ProcessProbe } from '../../src/proc/identity.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, startBroker, tmpHome, until } from '../helpers.js';

class FakeApp extends EventEmitter {
  loaded = new Set<string>();
  async connect() {}
  async call(method: string, p: { threadId?: string }) {
    if (method === 'thread/loaded/list') return { data: [...this.loaded], nextCursor: null };
    return { thread: { id: p.threadId, sessionId: p.threadId, parentThreadId: null, source: 'cli', name: null } };
  }
  send() {}
  close() {}
}
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const procs = new Map<number, string>();
let probeFails = false;
const probe: ProcessProbe = (pids) => {
  if (probeFails) return null;
  const m = new Map<number, string>();
  for (const p of pids) {
    const s = procs.get(p);
    if (s) m.set(p, s);
  }
  return m;
};
let clock = 0;
async function boot(app = new FakeApp()) {
  procs.clear();
  probeFails = false;
  clock = 0;
  const home = tmpHome();
  const broker = await startBroker(home, {
    processProbe: probe,
    codexNames: new CodexNames({ factory: () => app, indexPath: `${home}/missing-session-index.jsonl` }),
    liveness: { intervalMs: 3_600_000, graceMs: 60_000, graceProbes: 3, now: () => clock },
  });
  cleanup.push(() => broker.stop());
  return { home, broker, app };
}
async function connect(home: string, hello: Hello) {
  const { client, welcome } =
    hello.role === 'mcp'
      ? await mcpClient(home, hello)
      : await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string } };
}
const CWD = '/Users/x/code/myproject';
async function claudeBound(home: string, ppid: number, name: string) {
  const a = await connect(home, {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: CWD,
    pid_chain: [ppid + 1, ppid],
    mcp_ppid: ppid,
    requested_name: name,
  });
  const h = (await connect(home, { protocol: 1, role: 'hook' })).client;
  await h.call('hook.event', {
    agent: 'claude',
    event: 'SessionStart',
    agent_session_id: `sid-${ppid}`,
    cwd: CWD,
    pid_chain: [9, ppid],
    agent_pid: ppid,
  });
  return a;
}
// The disconnect kicks one probe (setImmediate); settle() lets it finish so probe counts below are deterministic.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('parent probe loop (W8)', () => {
  it('applies Claude process checks before awaiting a slow Codex trust scan', async () => {
    const { home, broker, app } = await boot();
    procs.set(4242, 'start-A');
    const a = await claudeBound(home, 4242, 'worker-one');
    app.loaded.add('T');
    const codex = await connect(home, {
      protocol: 1,
      role: 'mcp',
      agent: 'codex',
      cwd: CWD,
      pid_chain: [11, 2191],
      mcp_ppid: 2191,
    });
    await codex.client.call('session.bind', { agent_session_id: 'T' });
    a.client.close();
    await settle();
    procs.delete(4242);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    vi.spyOn(broker, 'checkCodexPush').mockImplementation(async () => {
      entered();
      await gate;
      return null;
    });
    const probing = broker.liveness?.probeNow();
    try {
      await waiting;
      expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('offline');
    } finally {
      release();
      await probing;
    }
  });
  it.each([false, true])(
    'a reconnect starts a fresh grace period (probe while connected: %s)',
    async (probeConnected) => {
      const { home, broker } = await boot();
      procs.set(4242, 'start-A');
      const first = await claudeBound(home, 4242, 'worker-one');
      probeFails = true;
      first.client.close();
      await settle();
      clock = 30_000;
      await broker.liveness?.probeNow();
      const again = await connect(home, {
        protocol: 1,
        role: 'mcp',
        agent: 'claude',
        cwd: CWD,
        pid_chain: [4243, 4242],
        mcp_ppid: 4242,
        resume_session_id: first.welcome.session_id,
      });
      expect(again.welcome.session_id).toBe(first.welcome.session_id);
      if (probeConnected) await broker.liveness?.probeNow();
      clock = 3_600_000;
      again.client.close();
      await settle();
      expect(getSession(broker.db, first.welcome.session_id)).toMatchObject({
        state: 'online-idle',
        link: 'disconnected',
        parent_state: 'unknown',
      });
    },
  );

  it('observing a connected link resets grace even without a new generation', async () => {
    const { home, broker } = await boot();
    procs.set(4242, 'start-A');
    const a = await claudeBound(home, 4242, 'worker-one');
    probeFails = true;
    a.client.close();
    await settle();
    clock = 30_000;
    await broker.liveness?.probeNow();
    broker.db.prepare("UPDATE sessions SET link = 'connected' WHERE id = ?").run(a.welcome.session_id);
    await broker.liveness?.probeNow();
    broker.db.prepare("UPDATE sessions SET link = 'disconnected' WHERE id = ?").run(a.welcome.session_id);
    clock = 3_600_000;
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('online-idle');
  });

  it('stop cancels queued kicks and intervals; later probes do not access the database', async () => {
    const { broker } = await boot();
    broker.liveness?.stop();
    vi.useFakeTimers();
    const prepare = vi.spyOn(broker.db, 'prepare');
    try {
      const live = installLiveness(broker, { intervalMs: 10, now: () => clock });
      live.kick();
      live.stop();
      await vi.runAllTimersAsync();
      await live.probeNow();
      expect(prepare).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      prepare.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rechecks a disconnected parent after two seconds and cancels that timer on stop', async () => {
    const { home, broker } = await boot();
    procs.set(4242, 'start-A');
    const a = await claudeBound(home, 4242, 'worker-one');
    broker.liveness?.stop();
    vi.useFakeTimers();
    const live = installLiveness(broker, { intervalMs: 10_000, now: () => clock });
    try {
      // Drive the disconnect callbacks with this fixture connection; timers are fully fake.
      const conn = broker.connectionFor(a.welcome.session_id);
      if (!conn) throw new Error('missing fixture connection');
      for (const f of broker.onDisconnect) f(conn);
      await vi.advanceTimersByTimeAsync(0);
      expect(getSession(broker.db, a.welcome.session_id)?.parent_state).toBe('live');
      procs.delete(4242);
      await vi.advanceTimersByTimeAsync(1999);
      expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('online-idle');
      await vi.advanceTimersByTimeAsync(1);
      expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('offline');
      live.kick(true);
      live.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      live.stop();
      vi.useRealTimers();
    }
  });

  it('a parent that exits while the MCP is already down: offline at the next probe, name freed', async () => {
    const { home, broker } = await boot();
    procs.set(4242, 'start-A');
    const a = await claudeBound(home, 4242, 'worker-one');
    a.client.close();
    await settle();
    expect(getSession(broker.db, a.welcome.session_id)).toMatchObject({ state: 'online-idle', parent_state: 'live' });
    procs.delete(4242);
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('offline');
    const b = await connect(home, {
      protocol: 1,
      role: 'mcp',
      agent: 'claude',
      cwd: CWD,
      pid_chain: [5152, 5151],
      mcp_ppid: 5151,
    });
    await expect(b.client.call('session.register', { name: 'worker-one' })).resolves.toEqual({ name: 'worker-one' });
  });

  it('sleep/wake: one probe after a long clock jump does not expire the grace; live parents stay live', async () => {
    const { home, broker } = await boot();
    procs.set(4242, 'start-A');
    procs.set(4343, 'start-B');
    const unsure = await claudeBound(home, 4242, 'unsure-one');
    const sure = await claudeBound(home, 4343, 'sure-one');
    probeFails = true; // the process probe cannot answer from here on
    unsure.client.close();
    await settle(); // kicked probe #1 at clock 0: unknown
    clock = 3_600_000; // the laptop slept for an hour
    await broker.liveness?.probeNow(); // probe #2
    expect(getSession(broker.db, unsure.welcome.session_id)).toMatchObject({
      state: 'online-idle',
      parent_state: 'unknown',
    });
    await broker.liveness?.probeNow(); // probe #3, an hour after the first: grace over
    expect(getSession(broker.db, unsure.welcome.session_id)?.state).toBe('offline');
    probeFails = false;
    sure.client.close();
    await settle();
    clock += 3_600_000;
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, sure.welcome.session_id)).toMatchObject({
      state: 'online-idle',
      parent_state: 'live',
    });
  });

  it('a Codex thread unloaded by the daemon timer: kept while loaded, offline once it leaves thread/loaded/list', async () => {
    const { home, broker, app } = await boot();
    app.loaded.add('T');
    const c = await connect(home, {
      protocol: 1,
      role: 'mcp',
      agent: 'codex',
      cwd: CWD,
      pid_chain: [11, 2191],
      mcp_ppid: 2191,
    });
    await c.client.call('session.bind', { agent_session_id: 'T' });
    await until(() => broker.codexNames?.available === true);
    c.client.close();
    await until(() => getSession(broker.db, c.welcome.session_id)?.parent_state === 'live');
    expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({ state: 'online-idle', link: 'disconnected' });
    app.loaded.delete('T');
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, c.welcome.session_id)?.state).toBe('offline');
  });
});
