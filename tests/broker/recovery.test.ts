import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { listLineage, recoveryCandidates } from '../../src/store/recovery.js';
import {
  bindAgentSession,
  claimName,
  createSession,
  getSession,
  listSessions,
  setState,
} from '../../src/store/sessions.js';
import type { Transport } from '../../src/transports/types.js';
import { ownerClient, startBroker, startTestBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function boot() {
  const { home, broker } = await startTestBroker();
  cleanup.push(() => broker.stop());
  return { home, broker };
}
async function connect(home: string, hello: Hello) {
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}
const CWD = '/Users/x/code/myproject';
const mcp = (home: string, ppid: number, extra: Partial<Hello> = {}) =>
  connect(home, {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: CWD,
    pid_chain: [ppid + 1, ppid],
    mcp_ppid: ppid,
    ...extra,
  });
const hook = async (home: string) => (await connect(home, { protocol: 1, role: 'hook' })).client;
const ev = (event: string, agentPid: number, sid = 'sid-1') => ({
  agent: 'claude',
  event,
  agent_session_id: sid,
  cwd: CWD,
  pid_chain: [9, agentPid],
  agent_pid: agentPid,
  source: 'resume',
});
const settle = () => new Promise((r) => setTimeout(r, 50));
type Who = { id: string; name: string; unread: number };

async function oldSession(home: string, name = 'worker-one') {
  const old = await mcp(home, 400, { requested_name: name });
  const h = await hook(home);
  await h.call('hook.event', ev('SessionStart', 400));
  return { old, h };
}

describe('claude resume recovery (W7)', () => {
  it('adopts a disconnected canonical slot after PID reuse and captures the new start identity', async () => {
    const { home, broker } = await boot();
    const processes = new Map([[400, 'old-start']]);
    broker.processProbe = () => new Map(processes);
    const { old, h } = await oldSession(home);
    old.client.close();
    await settle();
    expect(getSession(broker.db, old.welcome.session_id)?.link).toBe('disconnected');
    processes.set(400, 'new-start');
    const fresh = await mcp(home, 400);
    expect(fresh.welcome.session_id).not.toBe(old.welcome.session_id);
    expect(await h.call('hook.event', ev('SessionStart', 400))).toMatchObject({ bound: true });
    expect(await fresh.client.call('session.whoami')).toMatchObject({ id: old.welcome.session_id, name: 'worker-one' });
    expect(getSession(broker.db, old.welcome.session_id)?.agent_start).toBe('new-start');
    fresh.client.close();
    await settle();
    expect(getSession(broker.db, old.welcome.session_id)).toMatchObject({
      state: 'online-idle',
      link: 'disconnected',
      parent_state: 'live',
    });
  });

  it('carries an earlier deferred rename into canonical adoption when the push settles', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pushes: string[] = [];
    const transport: Transport = {
      kind: 'claude-channel',
      push: async (s) => {
        pushes.push(s.id);
        await gate;
        throw new Error('fixture failed push');
      },
    };
    const home = tmpHome();
    const broker = await startBroker(home, {
      transports: { claude: transport, codex: { ...transport, kind: 'codex-queue' } },
    });
    cleanup.push(
      () => broker.stop(),
      () => release(),
    );
    const { old, h } = await oldSession(home);
    old.client.close();
    await settle();
    const fresh = await mcp(home, 600, { requested_name: 'temporary-one' });
    const owner = await ownerClient(home);
    cleanup.push(() => owner.close());
    const message = await owner.call<{ id: string }>('owner.send', {
      to: 'temporary-one',
      subject: 'in-flight',
      body: 'b',
      priority: 'urgent',
      attach_paths: [],
    });
    await until(() => pushes.includes(fresh.welcome.session_id));
    await fresh.client.call('session.register', { name: 'temporary-two' });
    await h.call('hook.event', ev('SessionStart', 600));
    expect(await fresh.client.call('session.whoami')).toMatchObject({ id: old.welcome.session_id, name: 'worker-one' });
    release();
    await until(() => deliveriesOfMessage(broker.db, message.id)[0]?.state === 'held');
    expect(deliveriesOfMessage(broker.db, message.id)).toMatchObject([{ recipient: 'worker-one' }]);
    const inbox = JSON.stringify(await fresh.client.call('msg.inbox'));
    expect(inbox).toContain(message.id);
    for (const name of ['temporary-one', 'temporary-two'])
      expect(broker.db.prepare('SELECT message_id FROM deliveries WHERE recipient = ?').all(name)).toEqual([]);
  });

  it('a fresh MCP process after a resume takes the canonical slot, name and mail', async () => {
    const { home, broker } = await boot();
    const { old, h } = await oldSession(home);
    old.client.close();
    await settle();
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    await o.call('owner.send', {
      to: 'worker-one',
      subject: 'while away',
      body: 'b',
      priority: 'low',
      attach_paths: [],
    });
    const fresh = await mcp(home, 600);
    expect(await h.call('hook.event', ev('SessionStart', 600))).toMatchObject({ bound: true });
    expect(await fresh.client.call<Who>('session.whoami')).toMatchObject({
      id: old.welcome.session_id,
      name: 'worker-one',
      unread: 1,
    });
    expect(getSession(broker.db, fresh.welcome.session_id)).toMatchObject({
      state: 'offline',
      retired_into: old.welcome.session_id,
      name: null,
    });
    expect(listLineage(broker.db, { outcome: 'adopted', limit: 5 })).toHaveLength(1);
    // The handed-over connection still owns the slot: closing it marks the canonical slot offline.
    fresh.client.close();
    await settle();
    expect(getSession(broker.db, old.welcome.session_id)?.state).toBe('offline');
    // A later reconnect hint carrying the retired id lands on the canonical slot.
    const back = await mcp(home, 600, { resume_session_id: fresh.welcome.session_id });
    expect(back.welcome.session_id).toBe(old.welcome.session_id);
  });

  it.each(['pending', 'answered'])(
    'a polling Claude question stays %s after MCP adoption under the same live parent',
    async (state) => {
      const { home, broker } = await boot();
      const processes = new Map([
        [400, 'parent-A'],
        [401, 'old-mcp'],
        [601, 'new-mcp'],
      ]);
      broker.processProbe = (pids) =>
        new Map(pids.flatMap((pid) => (processes.has(pid) ? [[pid, processes.get(pid) as string]] : [])));
      const lead = await mcp(home, 100, { requested_name: 'lead-one' });
      await lead.client.call('session.bind', { agent_session_id: 'L' });
      const { old, h } = await oldSession(home);
      broker.questions.markReady(old.welcome.session_id, 'sid-1');
      await lead.client.call('assignment.delegate', {
        to: 'worker-one',
        subject: 'task',
        body: 'b',
        idempotency_key: 'k',
      });
      const q = broker.questions.capture(old.welcome.session_id, {
        native_session_id: 'sid-1',
        turn_id: 't',
        tool_use_id: 'u',
        kind: 'claude',
        questions: [
          {
            id: 'q1',
            header: '',
            question: 'Which?',
            options: [{ label: 'A', description: '' }],
            multiSelect: false,
            allowOther: true,
          },
        ],
      });
      if (!q) throw new Error('missing fixture relay');
      if (state === 'answered') await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
      const fresh = await mcp(home, 400, { pid_chain: [601, 400] });
      expect(fresh.welcome.session_id).not.toBe(old.welcome.session_id);
      old.client.close();
      await settle();
      await h.call('hook.event', ev('SessionStart', 400));
      expect(await fresh.client.call('session.whoami')).toMatchObject({ id: old.welcome.session_id });
      expect(
        await h.call('hook.question_poll', {
          agent: 'claude',
          native_session_id: 'sid-1',
          cwd: CWD,
          agent_pid: 400,
          pid_chain: [9, 400],
          relay_id: q.id,
        }),
      ).toMatchObject({ state });
    },
  );

  it('keeps an active assignment, cancels its stale question, and requires fresh readiness', async () => {
    const { home, broker } = await boot();
    const lead = await mcp(home, 100, { requested_name: 'lead-one' });
    await lead.client.call('session.bind', { agent_session_id: 'native-lead' });
    const { old, h } = await oldSession(home);
    broker.questions.markReady(old.welcome.session_id, 'sid-1');
    const a = await lead.client.call<{ id: string }>('assignment.delegate', {
      to: 'worker-one',
      subject: 's',
      body: 'b',
      idempotency_key: 'k1',
    });
    const q = broker.questions.capture(old.welcome.session_id, {
      native_session_id: 'sid-1',
      turn_id: 't1',
      tool_use_id: 'u1',
      kind: 'claude',
      questions: [
        {
          id: 'q1',
          header: '',
          question: 'Which?',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
          allowOther: true,
        },
      ],
    });
    old.client.close();
    await settle();
    await mcp(home, 600);
    await h.call('hook.event', ev('SessionStart', 600));
    const assignment = broker.questions.assignment(a.id);
    expect(assignment && broker.questions.participants(assignment)).toBeTruthy();
    expect(broker.questions.get(q?.id as string)?.state).toBe('cancelled');
    expect(broker.questions.ready(getSession(broker.db, old.welcome.session_id) as never)).toBe(false);
  });

  it('several offline candidates: no takeover, the new slot binds and the ambiguity is flagged', async () => {
    const { home, broker } = await boot();
    const ws = (await mcp(home, 100)).welcome.session_id;
    const workspace = getSession(broker.db, ws)?.workspace as string;
    const dup = (name: string) => {
      const s = createSession(broker.db, { agent: 'claude', cwd: CWD, workspace, pid_chain: [], mcp_ppid: null });
      claimName(broker.db, s.id, name, 'custom');
      bindAgentSession(broker.db, s.id, 'sid-1');
      setState(broker.db, s.id, 'offline');
      return s.id;
    };
    const ids = [dup('dup-one'), dup('dup-two')];
    const fresh = await mcp(home, 600);
    const h = await hook(home);
    expect(await h.call('hook.event', ev('SessionStart', 600))).toMatchObject({ bound: true });
    expect(getSession(broker.db, fresh.welcome.session_id)?.agent_session_id).toBe('sid-1');
    for (const id of ids)
      expect(getSession(broker.db, id)).toMatchObject({ state: 'offline', agent_session_id: 'sid-1' });
    expect(listLineage(broker.db, { outcome: 'flagged', limit: 5 })).toMatchObject([
      { reason: 'ambiguous', session_id: fresh.welcome.session_id },
    ]);
  });

  it('repeated refused resumes do not add recoverable shells, even after native titles arrive', async () => {
    const { home, broker } = await boot();
    const initial = await mcp(home, 100);
    const workspace = getSession(broker.db, initial.welcome.session_id)?.workspace as string;
    const canonicalIds = ['retained-one', 'retained-two'].map((name) => {
      const s = createSession(broker.db, { agent: 'claude', cwd: CWD, workspace, pid_chain: [], mcp_ppid: null });
      claimName(broker.db, s.id, name, 'custom');
      bindAgentSession(broker.db, s.id, 'sid-1');
      setState(broker.db, s.id, 'offline');
      return s.id;
    });
    const h = await hook(home);
    for (const ppid of [600, 700, 800]) {
      const fresh = await mcp(home, ppid);
      await h.call('hook.event', { ...ev('SessionStart', ppid), session_title: 'Same resumed conversation' });
      fresh.client.close();
      await settle();
      const candidates = recoveryCandidates(broker.db, {
        agent: 'claude',
        native: 'sid-1',
        workspace,
        exceptId: 'new',
      });
      expect(candidates.map((s) => s.id).sort()).toEqual([...canonicalIds].sort());
    }
  });

  it('two fresh processes resuming at once: exactly one adopts, the other stays unbound', async () => {
    const { home, broker } = await boot();
    const { old } = await oldSession(home);
    old.client.close();
    await settle();
    await mcp(home, 600);
    await mcp(home, 700);
    const [h1, h2] = [await hook(home), await hook(home)];
    const [r1, r2] = await Promise.all([
      h1.call<{ bound: boolean }>('hook.event', ev('SessionStart', 600)),
      h2.call<{ bound: boolean }>('hook.event', ev('SessionStart', 700)),
    ]);
    expect([r1.bound, r2.bound].filter(Boolean)).toHaveLength(1);
    const live = listSessions(broker.db).filter((s) => s.agent_session_id === 'sid-1' && s.state !== 'offline');
    expect(live.map((s) => s.id)).toEqual([old.welcome.session_id]);
  });

  it('an in-process conversation switch never adopts another slot; it is recorded as a switch', async () => {
    const { home, broker } = await boot();
    const { old: other, h } = await oldSession(home, 'other-conv');
    await h.call('hook.event', ev('SessionStart', 400, 'sid-2'));
    other.client.close();
    await settle();
    // sid-2's slot is now "other-conv" (offline). A live session on sid-1 switches to sid-2 in-process (/resume).
    const live = await mcp(home, 800, { requested_name: 'live-one' });
    await h.call('hook.event', ev('SessionStart', 800, 'sid-1'));
    await h.call('hook.event', ev('UserPromptSubmit', 800, 'sid-2'));
    expect(getSession(broker.db, live.welcome.session_id)).toMatchObject({
      name: 'live-one',
      agent_session_id: 'sid-2',
    });
    expect(getSession(broker.db, other.welcome.session_id)).toMatchObject({ state: 'offline', name: 'other-conv' });
    expect(listLineage(broker.db, { limit: 5 }).map((l) => [l.cause, l.outcome, l.previous_native_id])).toContainEqual([
      'switch',
      'observed',
      'sid-1',
    ]);
  });
});
