import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicSession } from '../../src/broker/registry.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { deliveriesFor } from '../../src/store/messages.js';
import { adoptCanonical, recoveryCandidates } from '../../src/store/recovery.js';
import { bindAgentSession, claimName, createSession, getSession, setState } from '../../src/store/sessions.js';
import { fixtureCodexNames, mcpClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const legacy = { schema_version: undefined, version: undefined };
async function boot() {
  const home = tmpHome();
  const probe = vi.fn(
    () =>
      new Map([
        [100, 'parent-start'],
        [101, 'mcp-start'],
      ]),
  );
  const opts = { processProbe: probe, codexNames: fixtureCodexNames(home, () => ['T']), trustedThreadId: () => 'T' };
  const broker = await startBroker(home, opts);
  cleanup.push(() => broker.stop());
  return { home, broker, probe, opts };
}
async function hook(home: string, fields = {}) {
  const { client } = await Client.connect(sockPath(home), { protocol: 1, role: 'hook', ...fields }, 1 << 20);
  cleanup.push(() => client.destroy());
  return client;
}
const event = (home: string, pid = 100, native = 'legacy-native') => ({
  agent: 'claude',
  event: 'SessionStart',
  agent_session_id: native,
  cwd: home,
  agent_pid: pid,
  pid_chain: [9, pid],
});
async function peer(home: string, extra = {}) {
  const c = await mcpClient(home, { agent: 'claude', cwd: home, pid_chain: [101, 100], mcp_ppid: 100, ...extra });
  cleanup.push(() => c.client.destroy());
  return c;
}

describe('legacy 0.2 client degraded slots', () => {
  it('accepts legacy hook/owner roles and never captures identity from either a legacy hook or MCP', async () => {
    const { home, broker, probe } = await boot();
    const old = await peer(home, legacy);
    const h = await hook(home, legacy);
    await h.call('hook.event', event(home));
    expect(probe).not.toHaveBeenCalled();
    expect(getSession(broker.db, old.welcome.session_id)).toMatchObject({
      agent_pid: null,
      agent_start: null,
      parent_state: 'unknown',
    });
    const owner = await Client.connect(sockPath(home), { protocol: 1, role: 'owner', ...legacy }, 1 << 20);
    cleanup.push(() => owner.client.destroy());
    expect(await owner.client.call('sys.ping')).toMatchObject({ pong: true });
    old.client.destroy();
    await until(() => getSession(broker.db, old.welcome.session_id)?.state === 'offline');
    const modern = await peer(home);
    probe.mockClear();
    await h.call('hook.event', event(home, 100, 'modern-native'));
    expect(probe).not.toHaveBeenCalled();
    expect(getSession(broker.db, modern.welcome.session_id)?.agent_start).toBeNull();
  });
  it('keeps name/mail/assignment across restart only by explicit resume, then a valid stamped reconnect upgrades it', async () => {
    const { home, broker, opts } = await boot();
    const old = await peer(home, { ...legacy, requested_name: 'old-worker' });
    const h = await hook(home);
    await h.call('hook.event', event(home));
    const id = old.welcome.session_id;
    broker.db.exec(
      "INSERT INTO messages(id,from_name,to_target,kind,priority,subject,body,attachments,created_at) VALUES('task','owner','old-worker','message','low','s','b','[]','t')",
    );
    broker.db
      .prepare("INSERT INTO assignments VALUES('assignment',?,'leader',?,'legacy-native','key','{}','task','t',NULL)")
      .run(id, id);
    broker.engine?.notice('old-worker', 'mail', 'retained-mail');
    await until(() => deliveriesFor(broker.db, 'old-worker', ['held']).length === 1);
    await broker.stop();
    const nextBroker = await startBroker(home, opts);
    cleanup.push(() => nextBroker.stop());
    const stored = getSession(nextBroker.db, id);
    if (!stored) throw new Error('legacy slot missing after restart');
    expect(publicSession(nextBroker.db, stored)).toMatchObject({
      client_mode: 'legacy',
      compatibility_warning: 'legacy client 0.2: reload plugin for new features',
    });
    const resumed = await peer(home, { ...legacy, resume_session_id: id });
    expect(resumed.welcome).toMatchObject({ session_id: id, name: 'old-worker' });
    expect(await resumed.client.call('session.whoami')).toMatchObject({
      client_mode: 'legacy',
      capabilities: { resume_recovery: 'unavailable', parent_liveness: 'unavailable' },
    });
    expect(nextBroker.db.prepare('SELECT id FROM assignments WHERE ended_at IS NULL').all()).toEqual([
      { id: 'assignment' },
    ]);
    expect(deliveriesFor(nextBroker.db, 'old-worker', ['held'])).toHaveLength(1);
    const outsider = await peer(home, { ...legacy, mcp_ppid: 200, pid_chain: [201, 200] });
    expect(outsider.welcome.session_id).not.toBe(id);
    resumed.client.destroy();
    await until(() => getSession(nextBroker.db, id)?.state === 'offline');
    expect(
      recoveryCandidates(nextBroker.db, {
        agent: 'claude',
        native: 'legacy-native',
        workspace: home,
        exceptId: outsider.welcome.session_id,
      }),
    ).toEqual([]);
    const candidate = createSession(nextBroker.db, { agent: 'claude', cwd: home, pid_chain: [], mcp_ppid: null });
    expect(
      adoptCanonical(nextBroker.db, {
        provisionalId: candidate.id,
        canonicalId: id,
        native: 'legacy-native',
        state: 'online-idle',
        evidence: {},
      }),
    ).toEqual({ ok: false, reason: 'canonical-changed' });
    const upgraded = await peer(home, { resume_session_id: id });
    expect(upgraded.welcome.session_id).toBe(id);
    expect(await upgraded.client.call('session.whoami')).toMatchObject({
      client_mode: 'current',
      compatibility_warning: null,
    });
    const freshHook = await hook(home);
    await freshHook.call('hook.event', event(home));
    expect(getSession(nextBroker.db, id)?.agent_start).toBe('parent-start');
  });
  it('cannot recover/adopt a canonical slot or take over a connected parent slot', async () => {
    const { home, broker } = await boot();
    const canonical = createSession(broker.db, { agent: 'claude', cwd: home, pid_chain: [], mcp_ppid: null });
    claimName(broker.db, canonical.id, 'canonical-worker', 'custom');
    bindAgentSession(broker.db, canonical.id, 'legacy-native');
    setState(broker.db, canonical.id, 'offline');
    const old = await peer(home, legacy);
    const h = await hook(home);
    await h.call('hook.event', event(home));
    expect(await old.client.call('session.whoami')).toMatchObject({
      id: old.welcome.session_id,
      client_mode: 'legacy',
    });
    expect(getSession(broker.db, canonical.id)).toMatchObject({
      name: 'canonical-worker',
      agent_session_id: 'legacy-native',
      state: 'offline',
    });
    expect(
      adoptCanonical(broker.db, {
        provisionalId: old.welcome.session_id,
        canonicalId: canonical.id,
        native: 'legacy-native',
        state: 'online-idle',
        evidence: {},
      }).ok,
    ).toBe(false);
    old.client.destroy();
    await until(() => getSession(broker.db, old.welcome.session_id)?.state === 'offline');
    const modern = await peer(home);
    await h.call('hook.event', event(home, 100, 'new-native'));
    broker.processProbe = () => new Map([[100, 'parent-start']]);
    const duplicate = await peer(home, legacy);
    expect(duplicate.welcome.session_id).not.toBe(modern.welcome.session_id);
    expect(getSession(broker.db, modern.welcome.session_id)?.link).toBe('connected');
  });
  it('invalid resume hints cannot clear a legacy marker, follow a retired slot or cross workspaces', async () => {
    const { home, broker } = await boot();
    const old = await peer(home, legacy);
    const id = old.welcome.session_id;
    const liveHint = await peer(home, { resume_session_id: id });
    expect(liveHint.welcome.session_id).not.toBe(id);
    expect(await old.client.call('session.whoami')).toMatchObject({ client_mode: 'legacy' });
    old.client.destroy();
    await until(() => getSession(broker.db, id)?.state === 'offline');
    const elsewhere = await peer(home, { resume_session_id: id, cwd: '/different-workspace' });
    expect(elsewhere.welcome.session_id).not.toBe(id);
    broker.db
      .prepare('UPDATE sessions SET retired_at=?,retired_into=? WHERE id=?')
      .run('t', liveHint.welcome.session_id, id);
    const retired = await peer(home, { ...legacy, resume_session_id: id });
    expect(retired.welcome.session_id).not.toBe(liveHint.welcome.session_id);
    expect(retired.welcome.session_id).not.toBe(id);
  });
  it('Codex remains push-untrusted and cannot use an injected recovery seam or loaded liveness evidence', async () => {
    const { home, broker } = await boot();
    const canonical = createSession(broker.db, { agent: 'codex', cwd: home, pid_chain: [], mcp_ppid: null });
    claimName(broker.db, canonical.id, 'root-worker', 'custom');
    bindAgentSession(broker.db, canonical.id, 'T');
    setState(broker.db, canonical.id, 'offline');
    const old = await peer(home, { ...legacy, agent: 'codex' });
    await old.client.call('session.bind', { agent_session_id: 'T' });
    expect(await old.client.call('session.whoami')).toMatchObject({
      id: old.welcome.session_id,
      client_mode: 'legacy',
      capabilities: { resume_recovery: 'unavailable', codex_push: 'held', parent_liveness: 'unavailable' },
    });
    expect(getSession(broker.db, canonical.id)?.agent_session_id).toBe('T');
    const slot = getSession(broker.db, old.welcome.session_id);
    if (!slot) throw new Error('missing legacy slot');
    expect(await broker.checkCodexPush(slot, true)).not.toBeNull();
    old.client.destroy();
    await until(() => getSession(broker.db, old.welcome.session_id)?.link === 'disconnected');
    await broker.liveness?.probeNow();
    expect(getSession(broker.db, old.welcome.session_id)?.parent_state).toBe('unknown');
  });
});
