import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { CodexNames } from '../../src/native/codex-names.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { listLineage } from '../../src/store/recovery.js';
import { bindAgentSession, claimName, createSession, getSession, setState } from '../../src/store/sessions.js';
import { startBroker, tmpHome, until } from '../helpers.js';

class FakeApp extends EventEmitter {
  /** W8: thread/loaded/list; empty by default, so a closed MCP's thread counts as unloaded and the slot goes offline. */
  loaded = new Set<string>();
  constructor(
    readonly threads: Record<string, Record<string, unknown>>,
    readonly fail = false,
  ) {
    super();
  }
  async connect() {
    if (this.fail) throw new Error('connect ENOENT');
  }
  async call(method: string, p: { threadId?: string }) {
    if (method === 'thread/loaded/list') return { data: [...this.loaded], nextCursor: null };
    const t = this.threads[p.threadId ?? ''];
    if (!t) throw new Error('Codex app-server error -32600: thread not found');
    return { thread: t };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
const ROOT = { id: 'T', sessionId: 'T', parentThreadId: null, source: 'cli', name: null };

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function boot(app: FakeApp) {
  const home = tmpHome();
  const broker = await startBroker(home, {
    codexNames: new CodexNames({ factory: () => app, indexPath: `${home}/missing-session-index.jsonl` }),
  });
  cleanup.push(() => broker.stop());
  return { home, broker };
}
const stateOf = (broker: { db: Parameters<typeof getSession>[0] }, id: string) => getSession(broker.db, id);
async function codex(home: string, ppid: number, extra: Partial<Hello> = {}) {
  const hello: Hello = {
    protocol: 1,
    role: 'mcp',
    agent: 'codex',
    cwd: '/Users/x/code/myproject',
    pid_chain: [ppid + 1, ppid],
    mcp_ppid: ppid,
    ...extra,
  };
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

/** A bound helper whose MCP closes; with the app-server up, it goes offline once the probe sees T unloaded (W8). */
async function offlineHelper(home: string, broker: { db: Parameters<typeof getSession>[0] }) {
  const old = await codex(home, 10, { requested_name: 'codex-helper' });
  await old.client.call('session.bind', { agent_session_id: 'T' });
  await settle(); // the bind's name refresh records whether the app-server answered
  old.client.close();
  await until(() => stateOf(broker, old.welcome.session_id)?.state === 'offline');
  return old;
}

describe('codex resume recovery (W7, verified roots only)', () => {
  it('a verified root thread reclaims its canonical slot', async () => {
    const { home, broker } = await boot(new FakeApp({ T: ROOT }));
    const old = await offlineHelper(home, broker);
    const fresh = await codex(home, 20);
    await fresh.client.call('session.bind', { agent_session_id: 'T' });
    expect(await fresh.client.call('session.whoami')).toMatchObject({
      id: old.welcome.session_id,
      name: 'codex-helper',
    });
    expect(getSession(broker.db, fresh.welcome.session_id)?.retired_into).toBe(old.welcome.session_id);
    expect(listLineage(broker.db, { outcome: 'adopted', limit: 5 })).toMatchObject([
      { agent: 'codex', evidence: { root_verified: true } },
    ]);
  });

  it.each([
    ['a descendant sharing the root id', { ...ROOT, sessionId: 'ROOT-OTHER' }],
    ['a sub-agent thread', { ...ROOT, source: { subAgent: { thread_spawn: { parent_thread_id: 'P', depth: 1 } } } }],
    ['a thread with a parent', { ...ROOT, parentThreadId: 'P' }],
  ])('refuses automatic recovery for %s and flags it before clearing the old binding', async (_label, thread) => {
    const { home, broker } = await boot(new FakeApp({ T: thread }));
    const old = await offlineHelper(home, broker);
    const fresh = await codex(home, 20);
    await fresh.client.call('session.bind', { agent_session_id: 'T' });
    expect(getSession(broker.db, fresh.welcome.session_id)).toMatchObject({
      agent_session_id: 'T',
      retired_into: null,
    });
    expect(getSession(broker.db, old.welcome.session_id)).toMatchObject({
      agent_session_id: null,
      name: 'codex-helper',
    });
    expect(listLineage(broker.db, { outcome: 'flagged', limit: 5 })).toMatchObject([
      { reason: 'unverified-root', evidence: { candidates: [old.welcome.session_id], root_verified: false } },
    ]);
  });

  it('no app-server: no automatic recovery', async () => {
    const { home, broker } = await boot(new FakeApp({}, true));
    const old = await offlineHelper(home, broker);
    const fresh = await codex(home, 20);
    await fresh.client.call('session.bind', { agent_session_id: 'T' });
    expect(getSession(broker.db, fresh.welcome.session_id)?.retired_into).toBeNull();
    expect(getSession(broker.db, old.welcome.session_id)?.state).toBe('offline');
  });

  it('a live holder refuses and is flagged; ambiguous legacy duplicates never adopt', async () => {
    const { home, broker } = await boot(new FakeApp({ T: ROOT }));
    const holder = await codex(home, 10, { requested_name: 'codex-holder' });
    await holder.client.call('session.bind', { agent_session_id: 'T' });
    const other = await codex(home, 20);
    await expect(other.client.call('session.bind', { agent_session_id: 'T' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(listLineage(broker.db, { outcome: 'flagged', limit: 5 })[0]).toMatchObject({ reason: 'live-holder' });
    holder.client.close();
    await until(() => stateOf(broker, holder.welcome.session_id)?.state === 'offline');
    const workspace = getSession(broker.db, holder.welcome.session_id)?.workspace as string;
    const dup = createSession(broker.db, {
      agent: 'codex',
      cwd: '/Users/x/code/myproject',
      workspace,
      pid_chain: [],
      mcp_ppid: null,
    });
    claimName(broker.db, dup.id, 'codex-dup', 'custom');
    bindAgentSession(broker.db, dup.id, 'T');
    setState(broker.db, dup.id, 'offline');
    const fresh = await codex(home, 30);
    await fresh.client.call('session.bind', { agent_session_id: 'T' });
    expect(getSession(broker.db, fresh.welcome.session_id)?.retired_into).toBeNull();
    expect(listLineage(broker.db, { outcome: 'flagged', limit: 5 })[0]).toMatchObject({ reason: 'ambiguous' });
  });

  it('W8: an MCP reload while the thread stays loaded re-attaches a verified root to the same slot', async () => {
    const app = new FakeApp({ T: ROOT });
    app.loaded.add('T');
    const { home, broker } = await boot(app);
    const old = await codex(home, 10, { requested_name: 'codex-helper' });
    await old.client.call('session.bind', { agent_session_id: 'T' });
    await until(() => broker.codexNames?.available === true);
    old.client.close();
    await until(() => stateOf(broker, old.welcome.session_id)?.parent_state === 'live');
    expect(stateOf(broker, old.welcome.session_id)).toMatchObject({ state: 'online-idle', link: 'disconnected' });
    const fresh = await codex(home, 20);
    await fresh.client.call('session.bind', { agent_session_id: 'T' });
    expect(await fresh.client.call('session.whoami')).toMatchObject({
      id: old.welcome.session_id,
      name: 'codex-helper',
    });
    expect(stateOf(broker, old.welcome.session_id)?.link).toBe('connected');
  });

  it('W8: an unverified bind cannot take a disconnected slot whose thread is still loaded', async () => {
    const app = new FakeApp({ T: { ...ROOT, sessionId: 'ROOT-OTHER' } });
    app.loaded.add('T');
    const { home, broker } = await boot(app);
    const old = await codex(home, 10, { requested_name: 'codex-helper' });
    await old.client.call('session.bind', { agent_session_id: 'T' });
    await until(() => broker.codexNames?.available === true);
    old.client.close();
    await until(() => stateOf(broker, old.welcome.session_id)?.parent_state === 'live');
    const fresh = await codex(home, 20);
    await expect(fresh.client.call('session.bind', { agent_session_id: 'T' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(stateOf(broker, old.welcome.session_id)).toMatchObject({ link: 'disconnected', agent_session_id: 'T' });
    expect(listLineage(broker.db, { outcome: 'flagged', limit: 5 })[0]).toMatchObject({ reason: 'unverified-root' });
  });
});
