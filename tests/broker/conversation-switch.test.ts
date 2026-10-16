import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { listLineage } from '../../src/store/recovery.js';
import {
  bindAgentSession,
  claimName,
  createSession,
  getSession,
  setNativeRef,
  setState,
} from '../../src/store/sessions.js';
import { fixtureCodexNames, mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.restoreAllMocks();
});

async function fixture(choice = 'launch') {
  const home = tmpHome();
  const processes = new Map([
    [100, 'parent-A'],
    [101, 'mcp-A'],
    [102, 'another-mcp'],
    [200, 'parent-lead'],
    [201, 'mcp-lead'],
    [300, 'parent-B'],
    [301, 'mcp-B'],
  ]);
  const options = () => ({
    processProbe: (pids: number[]) =>
      new Map(pids.flatMap((pid) => (processes.has(pid) ? [[pid, processes.get(pid) as string]] : []))),
    codexNames: fixtureCodexNames(home, () => []),
  });
  let broker = await startBroker(home, options());
  cleanup.push(() => broker.stop());
  const connect = async (ppid = 100, extra = {}) => {
    const c = await mcpClient(home, {
      agent: 'claude',
      cwd: home,
      pid_chain: [ppid + 1, ppid],
      mcp_ppid: ppid,
      channel: false,
      ...extra,
    });
    cleanup.push(() => c.client.close());
    return c;
  };
  const hook = async () => {
    const h = (await Client.connect(sockPath(home), { protocol: 1, role: 'hook' }, frameLimit(loadConfig(home))))
      .client;
    cleanup.push(() => h.close());
    return h;
  };
  const h = await hook();
  const event = (id: string, event = 'UserPromptSubmit', pid = 100) => ({
    agent: 'claude',
    event,
    agent_session_id: id,
    cwd: home,
    pid_chain: [999, pid],
    agent_pid: pid,
    source: 'resume',
  });
  const worker = await connect(100, choice === 'launch' ? { requested_name: 'launch-worker' } : {});
  await h.call('hook.event', event(A, 'SessionStart'));
  if (choice === 'register') await worker.client.call('session.register', { name: 'launch-worker' });
  setNativeRef(broker.db, worker.welcome.session_id, join(home, `${A}.jsonl`));
  const owner = await ownerClient(home);
  cleanup.push(() => owner.close());
  const send = (to: string, body: string) =>
    owner.call<{ id: string }>('owner.send', { to, subject: 'private', body, priority: 'low', attach_paths: [] });
  const canonical = (name: string, native = B) => {
    const s = createSession(broker.db, {
      agent: 'claude',
      cwd: home,
      workspace: getSession(broker.db, worker.welcome.session_id)?.workspace,
      pid_chain: [],
      mcp_ppid: null,
    });
    claimName(broker.db, s.id, name, 'custom');
    bindAgentSession(broker.db, s.id, native);
    setState(broker.db, s.id, 'offline');
    return s.id;
  };
  return {
    home,
    get broker() {
      return broker;
    },
    processes,
    worker,
    h,
    hook,
    event,
    connect,
    send,
    canonical,
    restart: async () => {
      await broker.stop();
      broker = await startBroker(home, options());
    },
  };
}

type Who = { id: string; name: string; bound: boolean; name_source: string };

describe('Claude in-process conversation switches', () => {
  it('refuses a changed conversation while MCP is disconnected, preserving the old mailbox', async () => {
    const f = await fixture();
    const oldId = f.worker.welcome.session_id;
    await f.send('launch-worker', 'A-private-body');
    f.worker.client.destroy();
    await until(() => getSession(f.broker.db, oldId)?.link === 'disconnected');
    expect(getSession(f.broker.db, oldId)?.parent_state).toBe('live');
    const reply = await f.h.call('hook.event', f.event(B));
    expect(reply).toMatchObject({ bound: false, additional_context: null });
    expect(getSession(f.broker.db, oldId)).toMatchObject({
      agent_session_id: A,
      name: 'launch-worker',
      link: 'disconnected',
      parent_state: 'live',
    });
    const back = await f.connect();
    const bound = await f.h.call('hook.event', f.event(B));
    expect(bound).toMatchObject({ bound: true });
    expect(JSON.stringify(bound)).not.toContain('A-private-body');
    expect(await back.client.call('session.whoami')).toMatchObject({ bound: true });
    expect((await back.client.call<Who>('session.whoami')).id).not.toBe(oldId);
    expect(getSession(f.broker.db, oldId)?.agent_session_id).toBe(A);
    expect(JSON.stringify(await back.client.call('msg.inbox'))).not.toContain('A-private-body');
  });

  it.each(['launch', 'register'])(
    'leaves A with its %s name and mail, gives B a fresh identity, then safely switches back',
    async (choice) => {
      const f = await fixture(choice);
      const old = getSession(f.broker.db, f.worker.welcome.session_id);
      const mailA = await f.send('launch-worker', 'A-private-body');
      const identities: unknown[] = [];
      f.worker.client.on('event', (name, data) => {
        if (name === 'session.identity') identities.push(data);
      });
      const reply = await f.h.call('hook.event', f.event(B));
      expect(JSON.stringify(reply)).not.toContain('A-private-body');
      const b = await f.worker.client.call<Who>('session.whoami');
      expect(b.id).not.toBe(old?.id);
      expect(b).toMatchObject({ bound: true, name_source: 'provisional' });
      expect(b.name).not.toBe('launch-worker');
      expect(getSession(f.broker.db, b.id)).toMatchObject({ native_name: null, native_ref: null });
      expect(getSession(f.broker.db, old?.id as string)).toMatchObject({
        agent_session_id: A,
        name: 'launch-worker',
        name_source: 'custom',
        state: 'offline',
        link: 'disconnected',
        agent_pid: 100,
        agent_start: 'parent-A',
        parent_state: 'live',
        retired_into: null,
        native_ref: join(f.home, `${A}.jsonl`),
      });
      expect(JSON.stringify(await f.worker.client.call('msg.inbox'))).not.toContain(mailA.id);
      const mailB = await f.send(b.name, 'B-private-body');
      const back = await f.h.call('hook.event', f.event(A));
      expect(JSON.stringify(back)).toContain('A-private-body');
      expect(JSON.stringify(back)).not.toContain('B-private-body');
      expect(await f.worker.client.call('session.whoami')).toMatchObject({ id: old?.id, name: 'launch-worker' });
      expect(getSession(f.broker.db, b.id)).toMatchObject({
        agent_session_id: B,
        state: 'offline',
        link: 'disconnected',
      });
      expect(JSON.stringify(await f.worker.client.call('msg.inbox'))).not.toContain(mailB.id);
      expect(identities).toContainEqual({ session_id: b.id });
      expect(identities.at(-1)).toEqual({ session_id: old?.id });
      expect(listLineage(f.broker.db, { limit: 20 })).toContainEqual(
        expect.objectContaining({
          cause: 'switch',
          session_id: old?.id,
          canonical_session_id: b.id,
          evidence: expect.objectContaining({ mcp_pid: 101, mcp_start: 'mcp-A' }),
        }),
      );
    },
  );

  it('adopts canonical B without taking A’s launch name or native metadata', async () => {
    const f = await fixture();
    const b = f.canonical('canonical-b');
    f.broker.naming.adoptNative(f.worker.welcome.session_id, 'Title A', 'claude-hook');
    await f.send('launch-worker', 'A-private-body');
    await f.send('canonical-b', 'B-private-body');
    const reply = await f.h.call('hook.event', { ...f.event(B), session_title: 'Title B' });
    expect(JSON.stringify(reply)).not.toContain('A-private-body');
    expect(JSON.stringify(reply)).toContain('B-private-body');
    expect(await f.worker.client.call('session.whoami')).toMatchObject({ id: b, name: 'canonical-b' });
    expect(getSession(f.broker.db, f.worker.welcome.session_id)).toMatchObject({
      agent_session_id: A,
      name: 'launch-worker',
      native_name: 'Title A',
    });
    expect(getSession(f.broker.db, b)).toMatchObject({ native_name: 'Title B', native_ref: null });
  });

  it.each(['ambiguous', 'live-holder'])(
    'a %s B leaves the connection on a fresh unbound flagged slot',
    async (reason) => {
      const f = await fixture();
      const b = f.canonical('canonical-b');
      if (reason === 'ambiguous') f.canonical('duplicate-b');
      else {
        const other = await f.connect(300, { resume_session_id: b });
        await f.h.call('hook.event', f.event(B, 'SessionStart', 300));
        expect(await other.client.call('session.whoami')).toMatchObject({ id: b });
      }
      await f.send('launch-worker', 'A-private-body');
      for (let i = 0; i < 2; i++) {
        expect(await f.h.call('hook.event', f.event(B))).toMatchObject({ bound: false, additional_context: null });
        const fresh = await f.worker.client.call<Who>('session.whoami');
        expect(fresh.id).not.toBe(f.worker.welcome.session_id);
        expect(fresh).toMatchObject({ bound: false });
        expect(JSON.stringify(await f.worker.client.call('msg.inbox'))).not.toContain('A-private-body');
        expect(listLineage(f.broker.db, { outcome: 'flagged', limit: 10 })).toContainEqual(
          expect.objectContaining({ reason, session_id: fresh.id }),
        );
      }
      expect(getSession(f.broker.db, f.worker.welcome.session_id)).toMatchObject({
        agent_session_id: A,
        state: 'offline',
      });
      expect(getSession(f.broker.db, b)?.agent_session_id).toBe(B);
    },
  );

  it.each(['pending', 'answered'])(
    'preserves A’s assignment, %s relay, subscriptions and mutes without exposing them to B',
    async (state) => {
      const f = await fixture();
      const a = f.worker.welcome.session_id;
      const lead = await f.connect(200, { requested_name: 'lead-one' });
      await f.h.call('hook.event', f.event('leader-native', 'SessionStart', 200));
      f.broker.questions.markReady(a, A);
      const assignment = await lead.client.call<{ id: string }>('assignment.delegate', {
        to: 'launch-worker',
        subject: 'task',
        body: 'body',
        idempotency_key: 'switch',
      });
      const q = f.broker.questions.capture(a, {
        native_session_id: A,
        turn_id: 'turn-A',
        tool_use_id: 'tool-A',
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
      await f.worker.client.call('kv.watch', { prefix: 'A-prefix' });
      await f.worker.client.call('mute.add', { target: 'sender:A-muted' });
      const subs = f.broker.db.prepare('SELECT * FROM subscriptions WHERE session_name=?').all('launch-worker');
      const mutes = f.broker.db.prepare('SELECT * FROM mutes WHERE session_name=?').all('launch-worker');
      await f.h.call('hook.event', f.event(B));
      const b = await f.worker.client.call<Who>('session.whoami');
      expect(f.broker.questions.assignment(assignment.id)).toMatchObject({ worker_session_id: a, worker_native_id: A });
      expect(f.broker.questions.get(q.id)?.state).toBe(state);
      expect(f.broker.db.prepare('SELECT * FROM subscriptions WHERE session_name=?').all('launch-worker')).toEqual(
        subs,
      );
      expect(f.broker.db.prepare('SELECT * FROM mutes WHERE session_name=?').all('launch-worker')).toEqual(mutes);
      expect(f.broker.db.prepare('SELECT * FROM subscriptions WHERE session_name=?').all(b.name)).toEqual([]);
      const poll = {
        agent: 'claude',
        native_session_id: B,
        cwd: f.home,
        agent_pid: 100,
        pid_chain: [999, 100],
        relay_id: q.id,
      };
      await expect(f.h.call('hook.question_poll', poll)).rejects.toMatchObject({ code: 'not_found' });
      await f.h.call('hook.event', f.event(A));
      expect(await f.h.call('hook.question_poll', { ...poll, native_session_id: A })).toMatchObject({ state });
      if (state === 'pending') await lead.client.call('question.answer', { relay_id: q.id, answers: { q1: ['A'] } });
      await f.h.call('hook.question_applied', { ...poll, native_session_id: A });
      await expect(f.h.call('hook.question_applied', { ...poll, native_session_id: A })).rejects.toMatchObject({
        code: 'conflict',
      });
    },
  );

  it('ignores a switched-away hint from the same verified MCP after restart before its identity event arrives', async () => {
    const f = await fixture();
    await f.send('launch-worker', 'A-private-body');
    const conn = f.broker.connectionFor(f.worker.welcome.session_id);
    if (!conn) throw new Error('missing fixture connection');
    const original = conn.event.bind(conn);
    vi.spyOn(conn, 'event').mockImplementation((name, data) =>
      name === ('session.identity' as string) ? true : original(name, data),
    );
    await f.h.call('hook.event', f.event(B));
    const b = await f.worker.client.call<Who>('session.whoami');
    await f.send(b.name, 'B-retained-body');
    await f.restart();
    const back = await f.connect(100, {
      resume_session_id: f.worker.welcome.session_id,
      requested_name: 'launch-worker',
    });
    expect(back.welcome.session_id).not.toBe(f.worker.welcome.session_id);
    expect(back.welcome.session_id).not.toBe(b.id);
    expect(await back.client.call('session.whoami')).toMatchObject({ bound: false });
    const hook = await f.hook();
    const reply = await hook.call('hook.event', f.event(B));
    expect(JSON.stringify(reply)).not.toContain('A-private-body');
    expect(JSON.stringify(reply)).toContain('B-retained-body');
    expect(await back.client.call('session.whoami')).toMatchObject({ id: b.id });
    expect(getSession(f.broker.db, f.worker.welcome.session_id)).toMatchObject({
      agent_session_id: A,
      name: 'launch-worker',
    });
    expect(JSON.stringify(await back.client.call('msg.inbox'))).not.toContain('A-private-body');
  });

  it('rolls back both halves of the split if the durable switch record cannot commit', async () => {
    const f = await fixture();
    const events: string[] = [];
    f.worker.client.on('event', (name) => events.push(name));
    const before = f.broker.db.prepare('SELECT id FROM sessions ORDER BY id').all();
    f.broker.db.exec(`CREATE TRIGGER switch_failure BEFORE INSERT ON session_lineage
      WHEN NEW.reason='conversation-split' BEGIN SELECT RAISE(ABORT,'fixture switch failure'); END`);
    await expect(f.h.call('hook.event', f.event(B))).rejects.toMatchObject({
      message: expect.stringContaining('fixture switch failure'),
    });
    expect(await f.worker.client.call('session.whoami')).toMatchObject({
      id: f.worker.welcome.session_id,
      name: 'launch-worker',
      bound: true,
    });
    expect(getSession(f.broker.db, f.worker.welcome.session_id)).toMatchObject({
      agent_session_id: A,
      link: 'connected',
      state: 'online-idle',
    });
    expect(f.broker.db.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual(before);
    expect(events).not.toContain('session.identity');
  });

  it.each(['capture-failed', 'verification-failed'])(
    'ignores a switched-away hint before channel delivery when MCP identity is %s',
    async (failure) => {
      const f = await fixture();
      await f.h.call('hook.event', f.event(B));
      const b = await f.worker.client.call<Who>('session.whoami');
      await f.send(b.name, 'B-retained-body');
      const owner = await ownerClient(f.home);
      cleanup.push(() => owner.close());
      const mail = await owner.call<{ id: string }>('owner.send', {
        to: 'launch-worker',
        subject: 'A only',
        body: 'A-private-body',
        priority: 'urgent',
        attach_paths: [],
      });
      await until(() => deliveriesOfMessage(f.broker.db, mail.id)[0]?.state === 'held');
      await f.restart();
      let mcpProbes = 0;
      f.broker.processProbe = (pids) => {
        if (pids.includes(101)) {
          mcpProbes++;
          if (failure === 'capture-failed' || mcpProbes > 1) return null;
        }
        return new Map(pids.flatMap((pid) => (f.processes.has(pid) ? [[pid, f.processes.get(pid) as string]] : [])));
      };
      const back = await f.connect(100, {
        resume_session_id: f.worker.welcome.session_id,
        requested_name: 'launch-worker',
        channel: true,
      });
      await back.client.call('sys.ping');
      expect(deliveriesOfMessage(f.broker.db, mail.id)[0]?.state).toBe('held');
      expect(back.welcome.session_id).not.toBe(f.worker.welcome.session_id);
      expect(await back.client.call('session.whoami')).toMatchObject({ bound: false });
      expect(JSON.stringify(await back.client.call('msg.inbox'))).not.toContain(mail.id);
      const h = await f.hook();
      const reply = await h.call('hook.event', f.event(B));
      expect(JSON.stringify(reply)).not.toContain('A-private-body');
      expect(await back.client.call('session.whoami')).toMatchObject({ id: b.id, bound: true });
      expect(getSession(f.broker.db, f.worker.welcome.session_id)).toMatchObject({
        agent_session_id: A,
        name: 'launch-worker',
      });
      expect(deliveriesOfMessage(f.broker.db, mail.id)[0]?.state).toBe('held');
    },
  );

  it.each(['different', 'reused-pid'])(
    'keeps normal explicit reattach for a %s MCP identity, but splits on a different hook native id',
    async (identity) => {
      const f = await fixture();
      await f.send('launch-worker', 'A-private-body');
      await f.h.call('hook.event', f.event(B));
      await f.restart();
      if (identity === 'reused-pid') f.processes.set(101, 'new-mcp-start');
      const back = await f.connect(100, {
        pid_chain: [identity === 'reused-pid' ? 101 : 102, 100],
        resume_session_id: f.worker.welcome.session_id,
      });
      expect(back.welcome.session_id).toBe(f.worker.welcome.session_id);
      const hook = await f.hook();
      const reply = await hook.call('hook.event', f.event(B));
      expect(JSON.stringify(reply)).not.toContain('A-private-body');
      expect((await back.client.call<Who>('session.whoami')).id).not.toBe(f.worker.welcome.session_id);
      expect(getSession(f.broker.db, f.worker.welcome.session_id)?.agent_session_id).toBe(A);
    },
  );
});
