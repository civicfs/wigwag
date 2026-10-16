import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { listLineage } from '../../src/store/recovery.js';
import { getSession, setState } from '../../src/store/sessions.js';
import { fixtureCodexNames, mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const legacy = { schema_version: undefined, version: undefined };
async function boot() {
  const home = tmpHome();
  class Questions extends EventEmitter {
    async connect() {}
    async call() {
      return { thread: { turns: [] } };
    }
    send() {}
    close() {
      this.emit('disconnected');
    }
  }
  const broker = await startBroker(home, {
    processProbe: (pids) => new Map(pids.map((pid) => [pid, `fixture-${pid}`])),
    codexNames: fixtureCodexNames(home, () => ['N', 'L', 'B', 'C']),
    codexQuestionFactory: () => new Questions(),
    transports: {
      claude: { kind: 'claude-channel', hasChannel: () => false, async push() {} },
      codex: { kind: 'codex-queue', async push() {} },
    },
  });
  cleanup.push(() => broker.stop());
  const connect = async (pid: number, extra = {}) => {
    const c = await mcpClient(home, {
      agent: 'claude',
      cwd: home,
      pid_chain: [pid + 1, pid],
      mcp_ppid: pid,
      channel: false,
      ...extra,
    });
    cleanup.push(() => c.client.destroy());
    return c;
  };
  const hook = async (old = false) => {
    const { client } = await Client.connect(
      sockPath(home),
      { protocol: 1, role: 'hook', ...(old ? legacy : {}) },
      1 << 20,
    );
    cleanup.push(() => client.destroy());
    return client;
  };
  const event = (pid: number, native = 'N') => ({
    agent: 'claude',
    event: 'SessionStart',
    cwd: home,
    agent_session_id: native,
    agent_pid: pid,
    pid_chain: [9, pid],
  });
  const owner = await ownerClient(home);
  cleanup.push(() => owner.destroy());
  const send = async (to: string, body: string) => {
    const mail = await owner.call<{ id: string }>('owner.send', {
      to,
      subject: 'private',
      body,
      priority: 'low',
      attach_paths: [],
    });
    await until(() => deliveriesOfMessage(broker.db, mail.id)[0]?.state === 'held');
    return mail;
  };
  const retainWork = async (workerId: string, name: string) => {
    broker.questions.markReady(workerId, 'N');
    const lead = await connect(300, { requested_name: 'lead-one' });
    const h = await hook();
    await h.call('hook.event', event(300, 'L'));
    const assignment = await lead.client.call<{ id: string }>('assignment.delegate', {
      to: name,
      subject: 'task',
      body: 'retained assignment',
      idempotency_key: 'key',
    });
    const mail = await send(name, 'retained-private-mail');
    return { assignment, mail };
  };
  return { home, broker, connect, hook, event, send, retainWork, owner };
}
describe('untrusted binds cannot move or block trusted state', () => {
  it.each([false, true])(
    'raw Claude bind refuses an existing canonical slot (legacy=%s), then its trusted hook recovers',
    async (old) => {
      const f = await boot();
      const canonical = await f.connect(100, { requested_name: 'canonical-worker', ...(old ? legacy : {}) });
      const h = await f.hook(old);
      await h.call('hook.event', f.event(100));
      const { assignment, mail } = await f.retainWork(canonical.welcome.session_id, 'canonical-worker');
      canonical.client.destroy();
      await until(() => {
        const s = getSession(f.broker.db, canonical.welcome.session_id);
        return s?.link === 'disconnected' || s?.state === 'offline';
      });
      setState(f.broker.db, canonical.welcome.session_id, 'offline');
      const fresh = await f.connect(200);
      await expect(fresh.client.call('session.bind', { agent_session_id: 'N' })).rejects.toMatchObject({
        code: 'conflict',
      });
      const trusted = await f.hook();
      await trusted.call('hook.event', f.event(200));
      expect(await fresh.client.call('session.whoami')).toMatchObject({
        id: canonical.welcome.session_id,
        name: 'canonical-worker',
      });
      expect(f.broker.questions.assignment(assignment.id)?.worker_session_id).toBe(canonical.welcome.session_id);
      expect(JSON.stringify(await fresh.client.call('msg.inbox'))).toContain(mail.id);
    },
  );

  it('refuses a raw Claude native-ID change before it can donate the old mailbox', async () => {
    const f = await boot(),
      c = await f.connect(100, { requested_name: 'b-worker' }),
      h = await f.hook();
    await h.call('hook.event', f.event(100, 'B'));
    const mail = await f.send('b-worker', 'B-private-mail');
    await expect(c.client.call('session.bind', { agent_session_id: 'C' })).rejects.toMatchObject({ code: 'conflict' });
    expect(getSession(f.broker.db, c.welcome.session_id)?.agent_session_id).toBe('B');
    const reply = await h.call('hook.event', { ...f.event(100, 'C'), event: 'UserPromptSubmit' });
    expect(JSON.stringify(reply)).not.toContain('B-private-mail');
    expect(JSON.stringify(await c.client.call('msg.inbox'))).not.toContain(mail.id);
  });

  it('never adopts an offline slot whose native binding is positively stamped raw', async () => {
    const f = await boot(),
      squatter = await f.connect(100, { requested_name: 'squatter-one' });
    await squatter.client.call('session.bind', { agent_session_id: 'N' });
    const { assignment, mail } = await f.retainWork(squatter.welcome.session_id, 'squatter-one');
    squatter.client.destroy();
    await until(() => getSession(f.broker.db, squatter.welcome.session_id)?.state === 'offline');
    const real = await f.connect(200),
      h = await f.hook();
    expect(await h.call('hook.event', f.event(200))).toMatchObject({ bound: true });
    expect(await real.client.call('session.whoami')).toMatchObject({ id: real.welcome.session_id });
    expect(JSON.stringify(await real.client.call('msg.inbox'))).not.toContain(mail.id);
    expect(f.broker.questions.assignment(assignment.id)?.worker_session_id).toBe(squatter.welcome.session_id);
    expect(deliveriesOfMessage(f.broker.db, mail.id)[0]?.state).toBe('held');
  });

  it.each(['claude', 'codex'] as const)(
    'a trusted %s hook displaces a proven raw/legacy squatter without taking its work',
    async (agent) => {
      const f = await boot();
      const squatter = await f.connect(100, {
        agent,
        requested_name: 'squatter-one',
        ...(agent === 'codex' ? legacy : {}),
      });
      await squatter.client.call('session.bind', { agent_session_id: 'N' });
      const { assignment, mail } = await f.retainWork(squatter.welcome.session_id, 'squatter-one');
      const real = await f.connect(200, { agent });
      if (agent === 'claude') {
        const h = await f.hook();
        expect(await h.call('hook.event', f.event(200))).toMatchObject({ bound: true });
      } else await real.client.call('session.bind', { agent_session_id: 'N' });
      expect(await real.client.call('session.whoami')).toMatchObject({ id: real.welcome.session_id, bound: true });
      const fresh = await squatter.client.call<{ id: string; bound: boolean; name: string }>('session.whoami');
      expect(fresh.id).not.toBe(squatter.welcome.session_id);
      expect(fresh).toMatchObject({ bound: false });
      expect(fresh.name).not.toBe('squatter-one');
      expect(getSession(f.broker.db, squatter.welcome.session_id)).toMatchObject({
        agent_session_id: null,
        state: 'offline',
        name: 'squatter-one',
      });
      expect(f.broker.questions.assignment(assignment.id)?.worker_session_id).toBe(squatter.welcome.session_id);
      expect(deliveriesOfMessage(f.broker.db, mail.id)[0]?.state).toBe('held');
      expect(JSON.stringify(await real.client.call('msg.inbox'))).not.toContain(mail.id);
      expect(JSON.stringify(await squatter.client.call('msg.inbox'))).not.toContain(mail.id);
      expect(listLineage(f.broker.db, { outcome: 'flagged', limit: 10 })).toContainEqual(
        expect.objectContaining({ reason: 'untrusted-binding-detached', session_id: squatter.welcome.session_id }),
      );
    },
  );

  it('protects an unstamped historical Claude binding, flags the conflict, and upgrades only its own hook', async () => {
    const f = await boot(),
      old = await f.connect(100, { requested_name: 'historical-worker' }),
      h = await f.hook();
    await h.call('hook.event', f.event(100));
    // Model a pre-guard row: the default unverified column is not proof of a raw bind.
    f.broker.db
      .prepare("DELETE FROM session_lineage WHERE session_id=? AND reason='binding-origin'")
      .run(old.welcome.session_id);
    f.broker.db.prepare("UPDATE sessions SET bind_origin='unverified' WHERE id=?").run(old.welcome.session_id);
    const caller = await f.connect(200);
    expect(await h.call('hook.event', f.event(200))).toMatchObject({ bound: false });
    expect(await caller.client.call('session.whoami')).toMatchObject({ bound: false });
    expect(getSession(f.broker.db, old.welcome.session_id)).toMatchObject({
      agent_session_id: 'N',
      state: 'online-idle',
      bind_origin: 'unverified',
    });
    const report = JSON.stringify(await f.owner.call('owner.recovery'));
    expect(report).toContain('binding-origin-unknown');
    expect(report).toContain('wigwag recovery');
    expect(await h.call('hook.event', f.event(100))).toMatchObject({ bound: true });
    expect(getSession(f.broker.db, old.welcome.session_id)?.bind_origin).toBe('hook-verified');
    expect(JSON.stringify(await f.owner.call('owner.recovery'))).not.toContain('binding-origin-unknown');
  });
});
