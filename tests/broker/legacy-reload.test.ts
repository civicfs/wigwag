import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { isLegacySession } from '../../src/store/compatibility.js';
import { deliveriesFor } from '../../src/store/messages.js';
import { listLineage } from '../../src/store/recovery.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, startTestBroker, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const legacy = { schema_version: undefined, version: undefined };
const questions = [
  {
    id: 'q1',
    header: '',
    question: 'Which?',
    options: [{ label: 'A', description: '' }],
    multiSelect: false,
    allowOther: true,
  },
];
async function boot() {
  const { home, broker } = await startTestBroker();
  cleanup.push(() => broker.stop());
  broker.processProbe = (pids) => new Map(pids.map((p) => [p, `fixture-${p}`]));
  const mcp = async (pid: number, old = false, name?: string) => {
    const c = await mcpClient(home, {
      agent: 'claude',
      cwd: home,
      pid_chain: [pid + 1, pid],
      mcp_ppid: pid,
      ...(old ? legacy : {}),
      ...(name ? { requested_name: name } : {}),
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
  const oldSlot = async (pid = 100, name = 'old-worker') => {
    const c = await mcp(pid, true, name);
    const h = await hook(true);
    await h.call('hook.event', event(pid));
    return c;
  };
  return { home, broker, mcp, hook, event, oldSlot };
}

describe('stamped Claude reload upgrades a legacy slot', () => {
  it.each(['pending', 'answered'] as const)(
    'keeps name/mail/assignment and %s relays, then applies or cancels only the correlated invocation',
    async (state) => {
      const { home, broker, mcp, hook, event, oldSlot } = await boot();
      const lead = await mcp(300, false, 'lead-one');
      const h = await hook();
      await h.call('hook.event', event(300, 'L'));
      const old = await oldSlot();
      const id = old.welcome.session_id;
      expect(isLegacySession(broker.db, id)).toBe(true);
      expect(getSession(broker.db, id)?.agent_start).toBeNull();
      broker.questions.markReady(id, 'N');
      const assignment = await lead.client.call<{ id: string }>('assignment.delegate', {
        to: 'old-worker',
        subject: 'task',
        body: 'b',
        idempotency_key: 'key',
      });
      const capture = (tool: string) =>
        broker.questions.capture(id, {
          native_session_id: 'N',
          turn_id: 'turn',
          tool_use_id: tool,
          kind: 'claude',
          questions,
        });
      const stale = capture('stale-call'),
        alive = capture('alive-call');
      if (!stale || !alive) throw new Error('missing relays');
      if (state === 'answered') broker.questions.answer(stale.id, lead.welcome.session_id, { q1: ['A'] });
      broker.questions.answer(alive.id, lead.welcome.session_id, { q1: ['A'] });
      broker.engine?.notice('old-worker', 'mail', 'retained-mail');
      await until(() => deliveriesFor(broker.db, 'old-worker', ['held']).length === 1);
      old.client.destroy();
      await until(() => getSession(broker.db, id)?.state === 'offline');
      const fresh = await mcp(100);
      expect(fresh.welcome.session_id).not.toBe(id);
      await h.call('hook.event', event(100));
      expect(await fresh.client.call('session.whoami')).toMatchObject({
        id,
        name: 'old-worker',
        client_mode: 'current',
        capabilities: { resume_recovery: 'native-id', parent_liveness: 'process-identity' },
      });
      expect(isLegacySession(broker.db, id)).toBe(false);
      expect(broker.questions.assignment(assignment.id)?.worker_session_id).toBe(id);
      expect(deliveriesFor(broker.db, 'old-worker', ['held'])).toHaveLength(1);
      expect(broker.questions.get(stale.id)?.state).toBe(state);
      expect(broker.questions.get(alive.id)?.state).toBe('answered');
      const line = listLineage(broker.db, { outcome: 'adopted', limit: 1 })[0];
      expect(line.evidence).toMatchObject({
        legacy_upgrade_relays_preserved: 2,
        legacy_upgrade_relay_ids: expect.arrayContaining([stale.id, alive.id]),
      });
      const identity = { agent: 'claude', native_session_id: 'N', cwd: home, agent_pid: 100, pid_chain: [9, 100] };
      expect(await h.call('hook.question_poll', { ...identity, relay_id: alive.id })).toMatchObject({
        state: 'answered',
        answers: { q1: ['A'] },
      });
      await h.call('hook.question_applied', { ...identity, relay_id: alive.id });
      await expect(h.call('hook.question_applied', { ...identity, relay_id: alive.id })).rejects.toMatchObject({
        code: 'conflict',
      });
      expect(broker.questions.get(alive.id)?.state).toBe('applied');
      const later = capture('next-call');
      expect(broker.questions.get(stale.id)?.state).toBe('cancelled');
      expect(broker.questions.get(alive.id)?.state).toBe('applied');
      capture('parallel-call');
      expect(broker.questions.get(later?.id as string)?.state).toBe('pending');
      const audit = listLineage(broker.db, { outcome: 'adopted', limit: 1 })[0];
      expect(audit.evidence.legacy_upgrade_cancellations).toEqual([
        { tool_use_id: 'next-call', count: 1, relay_ids: [stale.id] },
      ]);
    },
  );
  it('two eligible legacy candidates flag ambiguity and stay degraded', async () => {
    const { broker, mcp, hook, event, oldSlot } = await boot();
    const old = await oldSlot(100, 'old-worker');
    old.client.destroy();
    await until(() => getSession(broker.db, old.welcome.session_id)?.state === 'offline');
    const other = await oldSlot(200, 'old-duplicate');
    other.client.destroy();
    await until(() => getSession(broker.db, other.welcome.session_id)?.state === 'offline');
    const fresh = await mcp(100),
      h = await hook();
    await h.call('hook.event', event(100));
    expect(await fresh.client.call('session.whoami')).toMatchObject({ id: fresh.welcome.session_id });
    expect(listLineage(broker.db, { outcome: 'flagged', limit: 1 })[0]?.reason).toBe('ambiguous');
    expect(isLegacySession(broker.db, old.welcome.session_id)).toBe(true);
    expect(isLegacySession(broker.db, other.welcome.session_id)).toBe(true);
  });
  it.each([true, false])(
    'a legacy hook (%s), or a different native ID, cannot upgrade a legacy slot',
    async (oldHook) => {
      const { broker, mcp, hook, event, oldSlot } = await boot();
      const old = await oldSlot();
      old.client.destroy();
      await until(() => getSession(broker.db, old.welcome.session_id)?.state === 'offline');
      const fresh = await mcp(100),
        h = await hook(oldHook);
      await h.call('hook.event', event(100, oldHook ? 'N' : 'different-N'));
      expect(await fresh.client.call('session.whoami')).toMatchObject({ id: fresh.welcome.session_id });
      expect(isLegacySession(broker.db, old.welcome.session_id)).toBe(true);
      expect(getSession(broker.db, old.welcome.session_id)).toMatchObject({
        name: 'old-worker',
        agent_session_id: 'N',
      });
      expect(listLineage(broker.db, { outcome: 'adopted', limit: 5 })).toEqual([]);
    },
  );
});
