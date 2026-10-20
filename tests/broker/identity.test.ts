import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { bindAgentSession, claimName, createSession, getSession, setState } from '../../src/store/sessions.js';
import { GIT_TIMEOUT_MS } from '../../src/workspace.js';
import {
  fakeGitDir,
  fixtureCodexNames,
  mcpClient,
  ownerClient,
  startBroker,
  startTestBroker,
  tmpHome,
} from '../helpers.js';

type Welcome = { session_id: string; name: string; agent: string; warning: string | null };
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
  const { client, welcome } = await mcpClient(home, hello);
  cleanup.push(() => client.close());
  return { client, welcome: welcome as Welcome };
}
async function hook(home: string) {
  const { client } = await Client.connect(sockPath(home), { protocol: 1, role: 'hook' }, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return client;
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('identity', () => {
  it('assigns a provisional name from agent and cwd', async () => {
    const { home } = await boot();
    const { welcome } = await mcp(home);
    expect(welcome.session_id).toMatch(/^ses-/);
    expect(welcome.name).toMatch(/^claude-myproject-[a-z2-7]{4}$/);
    expect(welcome.warning).toBeNull();
  });

  it('honors requested_name (WIGWAG_NAME, P2) and falls back with a warning when it is taken', async () => {
    const { home } = await boot();
    const a = await mcp(home, { requested_name: 'codex-merger' });
    expect(a.welcome.name).toBe('codex-merger');
    const b = await mcp(home, { requested_name: 'codex-merger' });
    expect(b.welcome.name).toMatch(/^claude-myproject-/);
    expect(b.welcome.warning).toMatch(/codex-merger.*held/);
  });

  it('rename collides with a live holder but takes over from an offline one', async () => {
    const { home } = await boot();
    const a = await mcp(home);
    const b = await mcp(home);
    await a.client.call('session.register', { name: 'reviewer' });
    await expect(b.client.call('session.register', { name: 'reviewer' })).rejects.toMatchObject({ code: 'name_taken' });
    await expect(b.client.call('session.register', { name: 'owner' })).rejects.toMatchObject({ code: 'bad_request' });
    a.client.close();
    await settle();
    await expect(b.client.call('session.register', { name: 'reviewer' })).resolves.toEqual({ name: 'reviewer' });
  });

  it('marks a session offline on disconnect and lists sessions for owner', async () => {
    const { home } = await boot();
    const a = await mcp(home, { requested_name: 'gone-soon' });
    a.client.close();
    await settle();
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    const who = await o.call<Array<{ name: string | null; state: string }>>('session.who');
    expect(who.find((s) => s.name === 'gone-soon')?.state).toBe('offline');
  });

  it('agent who excludes offline history by default and pages it when explicitly requested', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { requested_name: 'active-one' });
    const workspace = getSession(broker.db, a.welcome.session_id)?.workspace;
    for (let i = 0; i < 230; i++) {
      const s = createSession(broker.db, {
        agent: 'codex',
        cwd: '/Users/x/code/myproject',
        workspace,
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(broker.db, s.id, `old-${i}`);
      setState(broker.db, s.id, 'offline');
    }
    type Who = Array<{ id: string; name: string; state: string }>;
    const live = await a.client.call<Who>('session.who');
    expect(live.map((s) => s.name)).toEqual(['active-one']);
    const first = await a.client.call<Who>('session.who', { include_offline: true, limit: 20 });
    const next = await a.client.call<Who>('session.who', { include_offline: true, limit: 20, offset: 20 });
    expect(first).toHaveLength(20);
    expect(next).toHaveLength(20);
    expect(new Set([...first, ...next].map((s) => s.id)).size).toBe(40);
    expect([...first, ...next].some((s) => s.state === 'offline')).toBe(true);
    expect(await a.client.call('session.who', { include_offline: true, offset: 231 })).toEqual([]);
    const owner = await ownerClient(home);
    cleanup.push(() => owner.close());
    expect(await owner.call('session.who')).toHaveLength(231);
  });

  it('agent who also bounds the live list and rejects oversized or invalid pages', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const workspace = getSession(broker.db, a.welcome.session_id)?.workspace;
    for (let i = 0; i < 60; i++) {
      const s = createSession(broker.db, {
        agent: 'codex',
        cwd: '/Users/x/code/myproject',
        workspace,
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(broker.db, s.id, `live-${i}`);
    }
    expect(await a.client.call('session.who')).toHaveLength(25);
    expect(await a.client.call('session.who', { limit: 50 })).toHaveLength(50);
    for (const params of [{ limit: 51 }, { limit: 0 }, { offset: -1 }, { offset: 0.5 }]) {
      await expect(a.client.call('session.who', params)).rejects.toMatchObject({ code: 'bad_request' });
    }
  });

  it('resumes the same session and name after a broker restart', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { requested_name: 'sticky-one' });
    cleanup.pop();
    await broker.stop();
    cleanup.pop();
    a.client.close();
    const b2: Broker = await startBroker(home);
    cleanup.push(() => b2.stop());
    const again = await mcp(home, { resume_session_id: a.welcome.session_id });
    expect(again.welcome).toMatchObject({ session_id: a.welcome.session_id, name: 'sticky-one' });
  });

  it("binds a Claude hook to the MCP session whose parent is the hook's claude; tracks busy/idle", async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { mcp_ppid: 4242, requested_name: 'claude-main' });
    await mcp(home, { mcp_ppid: 5151 });
    const h = await hook(home);
    const r = await h.call<{ additional_context: string | null; bound: boolean }>('hook.event', {
      agent: 'claude',
      event: 'SessionStart',
      agent_session_id: 'claude-sess-1',
      cwd: '/Users/x/code/myproject',
      pid_chain: [9001, 9000, 4242, 1000],
      agent_pid: 4242,
    });
    expect(r.bound).toBe(true);
    expect(r.additional_context).toMatch(/registered as "claude-main"/);
    expect(getSession(broker.db, a.welcome.session_id)?.agent_session_id).toBe('claude-sess-1');
    await h.call('hook.event', {
      agent: 'claude',
      event: 'UserPromptSubmit',
      agent_session_id: 'claude-sess-1',
      cwd: '/Users/x/code/myproject',
      pid_chain: [9002, 4242, 1000],
      agent_pid: 4242,
    });
    expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('online-busy');
    await h.call('hook.event', {
      agent: 'claude',
      event: 'Stop',
      agent_session_id: 'claude-sess-1',
      cwd: '/Users/x/code/myproject',
      pid_chain: [9003, 4242, 1000],
      agent_pid: 4242,
    });
    expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('online-idle');
  });

  it('fails closed when no MCP session matches the hook chain', async () => {
    const { home } = await boot();
    await mcp(home, { mcp_ppid: 4242 });
    const h = await hook(home);
    const r = await h.call<{ bound: boolean; additional_context: string | null }>('hook.event', {
      agent: 'claude',
      event: 'SessionStart',
      agent_session_id: 'x',
      cwd: '/Users/x/code/myproject',
      pid_chain: [1, 2, 3],
      agent_pid: 2,
    });
    expect(r).toEqual({ bound: false, additional_context: null });
  });

  it('codex sessions are unbound until session.bind, then emit session.available', async () => {
    const { home, broker } = await boot();
    const seen: string[] = [];
    broker.bus.on('session.available', (s: { name: string }) => seen.push(s.name));
    const c = await mcp(home, { agent: 'codex', requested_name: 'codex-merger' });
    expect(seen).toEqual([]);
    await c.client.call('session.bind', { agent_session_id: 'thread-abc' });
    expect(seen).toEqual(['codex-merger']);
    await c.client.call('session.turn', { phase: 'started' });
    expect(getSession(broker.db, c.welcome.session_id)?.state).toBe('online-busy');
  });

  // Spec §17 (R46-N4): the hook's cwd must resolve to the session's workspace (mcp default cwd below).
  // E-4 nested, Codex side: session_bind is an mcp_tool hook that Codex runs on the thread's own MCP server, so the
  // broker binds the calling connection and never infers a session from pids.
  it('a nested codex session_bind binds only the calling connection, never the outer session', async () => {
    const { home, broker } = await boot();
    const outer = await mcp(home, {
      agent: 'codex',
      requested_name: 'codex-outer',
      mcp_ppid: 300,
      pid_chain: [301, 300],
    });
    await outer.client.call('session.bind', { agent_session_id: 'thread-outer' });
    const inner = await mcp(home, { agent: 'codex', mcp_ppid: 600, pid_chain: [601, 600, 301, 300] });
    await inner.client.call('session.bind', { agent_session_id: 'thread-inner' });
    expect(getSession(broker.db, inner.welcome.session_id)?.agent_session_id).toBe('thread-inner');
    expect(getSession(broker.db, outer.welcome.session_id)?.agent_session_id).toBe('thread-outer');
  });

  // Spec §4: one Codex thread id belongs to one live session.
  describe('codex session.bind exclusivity', () => {
    const codex = (home: string, extra: Partial<Hello> = {}) => mcp(home, { agent: 'codex', ...extra });

    it('refuses a bind to a thread a live session holds and leaves the newcomer unbound', async () => {
      const { home, broker } = await boot();
      const a = await codex(home, { requested_name: 'codex-holder', mcp_ppid: 10, pid_chain: [11, 10] });
      await a.client.call('session.bind', { agent_session_id: 'thread-1' });
      const b = await codex(home, { mcp_ppid: 20, pid_chain: [21, 20] });
      await expect(b.client.call('session.bind', { agent_session_id: 'thread-1' })).rejects.toMatchObject({
        code: 'conflict',
      });
      const row = getSession(broker.db, b.welcome.session_id);
      expect(row?.agent_session_id).toBeNull();
      expect(row?.name).toBe(b.welcome.name);
      expect(getSession(broker.db, a.welcome.session_id)?.agent_session_id).toBe('thread-1');
    });

    it('binds a new untrusted Codex slot while preserving the offline holder binding', async () => {
      const { home, broker } = await boot();
      const a = await codex(home, { requested_name: 'codex-old', mcp_ppid: 10, pid_chain: [11, 10] });
      await a.client.call('session.bind', { agent_session_id: 'thread-2' });
      a.client.close();
      await settle();
      const b = await codex(home, { mcp_ppid: 20, pid_chain: [21, 20] });
      await b.client.call('session.bind', { agent_session_id: 'thread-2' });
      expect(getSession(broker.db, b.welcome.session_id)?.agent_session_id).toBe('thread-2');
      const old = getSession(broker.db, a.welcome.session_id);
      expect(old?.agent_session_id).toBe('thread-2');
      expect(old?.name).toBe('codex-old');
    });

    it('is idempotent when the same session binds the same id again', async () => {
      const { home, broker } = await boot();
      const a = await codex(home);
      await a.client.call('session.bind', { agent_session_id: 'thread-3' });
      await a.client.call('session.bind', { agent_session_id: 'thread-3' });
      expect(getSession(broker.db, a.welcome.session_id)?.agent_session_id).toBe('thread-3');
    });

    it('a resumed session (same wigwag id) rebinds its own thread; a nested session cannot claim the outer thread', async () => {
      const home = tmpHome();
      // The native threads stay loaded while their MCP connection is replaced.
      const broker = await startBroker(home, {
        codexNames: fixtureCodexNames(home, () => ['thread-outer', 'thread-inner']),
      });
      cleanup.push(() => broker.stop());
      const outer = await codex(home, { requested_name: 'codex-outer', mcp_ppid: 300, pid_chain: [301, 300] });
      await outer.client.call('session.bind', { agent_session_id: 'thread-outer' });
      const inner = await codex(home, { mcp_ppid: 600, pid_chain: [601, 600, 301, 300] });
      await expect(inner.client.call('session.bind', { agent_session_id: 'thread-outer' })).rejects.toMatchObject({
        code: 'conflict',
      });
      await inner.client.call('session.bind', { agent_session_id: 'thread-inner' });
      outer.client.close();
      await settle();
      const again = await codex(home, {
        resume_session_id: outer.welcome.session_id,
        mcp_ppid: 700,
        pid_chain: [701, 700],
      });
      expect(again.welcome.session_id).toBe(outer.welcome.session_id);
      await again.client.call('session.bind', { agent_session_id: 'thread-outer' });
      expect(getSession(broker.db, outer.welcome.session_id)?.agent_session_id).toBe('thread-outer');
      expect(getSession(broker.db, inner.welcome.session_id)?.agent_session_id).toBe('thread-inner');
    });

    it('does not reveal a holder in an unlinked workspace', async () => {
      const { home } = await boot();
      const a = await codex(home, {
        requested_name: 'secret-holder',
        cwd: '/Users/x/code/other',
        mcp_ppid: 10,
        pid_chain: [11, 10],
      });
      await a.client.call('session.bind', { agent_session_id: 'thread-4' });
      const b = await codex(home, { mcp_ppid: 20, pid_chain: [21, 20] });
      const err = await b.client.call('session.bind', { agent_session_id: 'thread-4' }).catch((e: Error) => e);
      expect(err).toMatchObject({ code: 'conflict' });
      const msg = String((err as Error).message);
      expect(msg).not.toContain('secret-holder');
      expect(msg).not.toContain('/Users/x/code/other');
    });
  });

  // agent_pid is the hook's nearest ancestor that is not a shell or launcher, as src/hooks/claude.ts computes it.
  const hookEv = (
    agent_session_id: string,
    pid_chain: number[],
    agent_pid: number | null,
    event = 'SessionStart',
    cwd = '/Users/x/code/myproject',
  ) => ({
    agent: 'claude',
    event,
    agent_session_id,
    cwd,
    pid_chain,
    agent_pid,
  });

  it('does not let a Claude hook take over a codex session bound to the same agent_session_id', async () => {
    const { home, broker } = await boot();
    const c = await mcp(home, { agent: 'codex', requested_name: 'codex-x' });
    await c.client.call('session.bind', { agent_session_id: 'x' });
    await c.client.call('session.turn', { phase: 'started' });
    await mcp(home, { mcp_ppid: 4242 });
    const h = await hook(home);
    const r = await h.call('hook.event', hookEv('x', [1, 2, 3], 2, 'Stop'));
    expect(r).toEqual({ bound: false, additional_context: null });
    expect(getSession(broker.db, c.welcome.session_id)?.state).toBe('online-busy');
  });

  it('fails closed when two live Claude sessions carry the same agent_session_id', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { mcp_ppid: 1111 });
    const b = await mcp(home, { mcp_ppid: 2222 });
    for (const x of [a, b]) bindAgentSession(broker.db, x.welcome.session_id, 'dup');
    const h = await hook(home);
    const r = await h.call('hook.event', hookEv('dup', [9, 1111, 2222], 1111));
    expect(r).toEqual({ bound: false, additional_context: null });
  });

  it('fails closed when two MCP sessions share the same mcp_ppid', async () => {
    const { home } = await boot();
    await mcp(home, { mcp_ppid: 7777 });
    await mcp(home, { mcp_ppid: 7777 });
    const h = await hook(home);
    const r = await h.call('hook.event', hookEv('y', [9, 7777], 7777));
    expect(r).toEqual({ bound: false, additional_context: null });
  });

  // E-4 nested: `claude -p` (pid 5000) run from the shell tool of a live session whose claude is pid 4242. The outer
  // claude is in the inner hook's chain; the inner MCP server has not connected yet at the inner SessionStart.
  it('a nested claude hook is never bound to the outer session whose claude is a further ancestor', async () => {
    const { home, broker } = await boot();
    const outer = await mcp(home, { mcp_ppid: 4242, requested_name: 'outer-one' });
    const h = await hook(home);
    const r = await h.call('hook.event', hookEv('inner-sess', [9, 5000, 8000, 4242, 1000], 5000));
    expect(r).toEqual({ bound: false, additional_context: null });
    expect(getSession(broker.db, outer.welcome.session_id)).toMatchObject({
      agent_session_id: null,
      state: 'online-idle',
    });
    const inner = await mcp(home, { mcp_ppid: 5000, requested_name: 'inner-one' });
    const again = await h.call<{ bound: boolean }>(
      'hook.event',
      hookEv('inner-sess', [10, 5000, 8000, 4242, 1000], 5000, 'UserPromptSubmit'),
    );
    expect(again.bound).toBe(true);
    expect(getSession(broker.db, inner.welcome.session_id)).toMatchObject({
      agent_session_id: 'inner-sess',
      state: 'online-busy',
    });
    expect(getSession(broker.db, outer.welcome.session_id)?.agent_session_id).toBeNull();
  });

  it("fails closed when the session bound to the hook's agent_session_id belongs to another claude process", async () => {
    const { home, broker } = await boot();
    const outer = await mcp(home, { mcp_ppid: 4242 });
    const h = await hook(home);
    expect(await h.call('hook.event', hookEv('outer-sess', [9, 4242], 4242))).toMatchObject({ bound: true });
    // A nested `claude -p --continue` resumes the outer conversation id in a new claude process (5000).
    const r = await h.call('hook.event', hookEv('outer-sess', [9, 5000, 4242], 5000, 'UserPromptSubmit'));
    expect(r).toEqual({ bound: false, additional_context: null });
    expect(getSession(broker.db, outer.welcome.session_id)?.state).toBe('online-idle');
  });

  it('fails closed when the hook has no agent ancestor, or reports one outside its chain', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { mcp_ppid: 4242 });
    const h = await hook(home);
    expect(await h.call('hook.event', hookEv('s', [9, 4242], null))).toEqual({
      bound: false,
      additional_context: null,
    });
    expect(await h.call('hook.event', hookEv('s', [9, 8], 4242))).toEqual({ bound: false, additional_context: null });
    expect(getSession(broker.db, a.welcome.session_id)?.agent_session_id).toBeNull();
  });

  it('resume refreshes cwd, workspace, pid chain and mcp_ppid, drops the old binding, and rebinds via the new chain', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home, { mcp_ppid: 400, requested_name: 'resumer' });
    const h = await hook(home);
    await h.call('hook.event', hookEv('sess-old', [9, 400], 400));
    expect(getSession(broker.db, a.welcome.session_id)?.agent_session_id).toBe('sess-old');
    a.client.close();
    await settle();
    const again = await mcp(home, {
      resume_session_id: a.welcome.session_id,
      mcp_ppid: 600,
      pid_chain: [700, 600],
      cwd: '/Users/x/code/other',
    });
    expect(again.welcome).toMatchObject({ session_id: a.welcome.session_id, name: 'resumer' });
    const row = getSession(broker.db, a.welcome.session_id);
    expect(row).toMatchObject({
      cwd: '/Users/x/code/other',
      workspace: '/Users/x/code/other', // spec §17: resume recomputes the workspace (missing dir → path unchanged)
      mcp_ppid: 600,
      pid_chain: [700, 600],
      agent_session_id: null,
    });
    const r = await h.call<{ bound: boolean }>(
      'hook.event',
      hookEv('sess-new', [900, 600], 600, 'SessionStart', '/Users/x/code/other'),
    );
    expect(r.bound).toBe(true);
    expect(getSession(broker.db, a.welcome.session_id)?.agent_session_id).toBe('sess-new');
  });

  it('falls back with a reserved warning when requested_name is reserved', async () => {
    const { home } = await boot();
    const a = await mcp(home, { requested_name: 'owner' });
    expect(a.welcome.name).toMatch(/^claude-myproject-/);
    expect(a.welcome.warning).toMatch(/reserved/);
  });
});

describe('a hung git never freezes the broker (final I-5)', () => {
  const PATH = process.env.PATH;
  afterEach(() => {
    process.env.PATH = PATH;
  });

  it('hello and hook.event return within the git bound and sys.ping answers meanwhile', {
    timeout: 40000,
  }, async () => {
    const { home } = await boot();
    const owner = await ownerClient(home);
    cleanup.push(() => owner.close());
    process.env.PATH = `${fakeGitDir('exec sleep 30')}:${PATH}`;
    const bound = GIT_TIMEOUT_MS + 1500;
    const t0 = Date.now();
    const hello = mcp(home, { cwd: mkdtempSync(join(tmpdir(), 'ww-h-')), requested_name: 'slow-one' });
    const p0 = Date.now();
    await owner.call('sys.ping');
    expect(Date.now() - p0).toBeLessThan(500);
    const a = await hello;
    expect(Date.now() - t0).toBeLessThan(bound);
    expect(a.welcome.name).toBe('slow-one');
    const h = await hook(home);
    const t1 = Date.now();
    await h.call('hook.event', {
      agent: 'claude',
      event: 'Stop',
      agent_session_id: 'slow-sess',
      cwd: mkdtempSync(join(tmpdir(), 'ww-h-')),
      pid_chain: [],
      agent_pid: null,
    });
    expect(Date.now() - t1).toBeLessThan(bound);
  });
});

// A message sent to a session's provisional name must not be stranded when the session moves to another name: inbox
// and unread look up only the name it has now.
describe('undelivered messages follow a rename away from the provisional name', () => {
  type Inbox = { messages: Array<{ message: { id: string; subject: string; to_target: string } }> };
  const inbox = (c: { client: Client }) => c.client.call<Inbox>('msg.inbox', { include_read: false, limit: 20 });
  const ownerSend = async (home: string, to: string, subject: string, priority = 'low') => {
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    return o.call<{ id: string }>('owner.send', { to, subject, body: 'b', priority, attach_paths: [] });
  };
  const rows = (broker: Broker, id: string) => deliveriesOfMessage(broker.db, id);
  const events = (broker: Broker, id: string) =>
    broker.db
      .prepare('SELECT recipient, from_state, to_state, detail FROM delivery_events WHERE message_id = ?')
      .all(id);

  it('register moves held messages to the new name; the message stays as sent and the event records the origin', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const old = a.welcome.name;
    const m = await ownerSend(home, old, 'for-the-old-name');
    expect(rows(broker, m.id)).toMatchObject([{ recipient: old, state: 'held', hold_reason: 'low' }]);
    await a.client.call('session.register', { name: 'role-name' });
    expect(rows(broker, m.id)).toMatchObject([{ recipient: 'role-name', state: 'held', hold_reason: 'low' }]);
    expect(events(broker, m.id)).toContainEqual({
      recipient: 'role-name',
      from_state: 'held',
      to_state: 'held',
      detail: `forwarded from ${old}`,
    });
    expect(await a.client.call('session.whoami')).toMatchObject({ name: 'role-name', unread: 1 });
    const got = await inbox(a);
    expect(got.messages.map((x) => x.message.subject)).toEqual(['for-the-old-name']);
    expect(got.messages[0].message.to_target).toBe(old);
  });

  it('moves pending, held, stuck and failed deliveries, but leaves pushed and read ones', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const old = a.welcome.name;
    const ids = {
      pending: (await ownerSend(home, old, 'pending')).id,
      stuck: (await ownerSend(home, old, 'stuck')).id,
      failed: (await ownerSend(home, old, 'failed')).id,
      read: (await ownerSend(home, old, 'read')).id,
    };
    const set = (id: string, state: string) =>
      broker.db.prepare('UPDATE deliveries SET state = ?, hold_reason = NULL WHERE message_id = ?').run(state, id);
    set(ids.pending, 'pending');
    set(ids.stuck, 'stuck');
    set(ids.failed, 'failed');
    set(ids.read, 'read');
    await a.client.call('session.register', { name: 'role-name' });
    const where = (id: string) => rows(broker, id)[0].recipient;
    expect([ids.pending, ids.stuck, ids.failed].map(where)).toEqual(['role-name', 'role-name', 'role-name']);
    expect(where(ids.read)).toBe(old);
  });

  it('also forwards when the session leaves a name it registered itself (W2a)', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    await a.client.call('session.register', { name: 'first-name' });
    const m = await ownerSend(home, 'first-name', 'to-first');
    await a.client.call('session.register', { name: 'second-name' });
    expect(rows(broker, m.id)[0].recipient).toBe('second-name');
  });

  it('a broadcast that reached both names keeps its old-name row; other messages still move', async () => {
    const { home, broker } = await boot();
    const taken = await mcp(home, { requested_name: 'taken-one' });
    taken.client.close();
    await settle();
    const sender = await mcp(home, { requested_name: 'sender-one' });
    const a = await mcp(home);
    const old = a.welcome.name;
    const bc = await sender.client.call<{ id: string }>('msg.send', {
      to: 'all',
      subject: 'bc',
      body: 'b',
      priority: 'low',
    });
    expect(rows(broker, bc.id).map((r) => r.recipient)).toEqual(expect.arrayContaining([old, 'taken-one']));
    const solo = await ownerSend(home, old, 'solo');
    await a.client.call('session.register', { name: 'taken-one' }); // offline holder in scope: allowed
    expect(rows(broker, solo.id)[0].recipient).toBe('taken-one');
    const bcRows = rows(broker, bc.id).map((r) => r.recipient);
    expect(bcRows).toEqual(expect.arrayContaining([old, 'taken-one'])); // no row lost, no collision error
    expect(bcRows.filter((r) => r === 'taken-one')).toHaveLength(1);
  });
});
