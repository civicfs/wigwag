import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import { verifyAtStart } from '../../src/broker/liveness.js';
import type { Broker } from '../../src/broker/server.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import type { ProcessProbe } from '../../src/proc/identity.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { openDb } from '../../src/store/db.js';
import { claimName, createSession, getSession, liveHolder, setAgentIdentity } from '../../src/store/sessions.js';
import { tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const procs = new Map<number, string>();
let probeFails = false;
let probeCalls = 0;
const probe: ProcessProbe = (pids) => {
  probeCalls++;
  if (probeFails) return null;
  const m = new Map<number, string>();
  for (const p of pids) {
    const s = procs.get(p);
    if (s) m.set(p, s);
  }
  return m;
};
async function boot(home = tmpHome()) {
  const broker = await startBroker(home, { processProbe: probe });
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
async function bound(home: string, ppid: number, name: string, sid: string) {
  const a = await mcp(home, ppid, { requested_name: name });
  const h = (await connect(home, { protocol: 1, role: 'hook' })).client;
  await h.call('hook.event', {
    agent: 'claude',
    event: 'SessionStart',
    agent_session_id: sid,
    cwd: CWD,
    pid_chain: [9, ppid],
    agent_pid: ppid,
  });
  return a;
}
const settle = () => new Promise((r) => setTimeout(r, 50));
const reset = () => {
  procs.clear();
  probeFails = false;
  probeCalls = 0;
};

describe('parent-verified disconnect (W8)', () => {
  it('parent alive: the session stays online, link disconnected, and keeps its name against takeover', async () => {
    reset();
    procs.set(4242, 'start-A');
    const { home, broker } = await boot();
    const a = await bound(home, 4242, 'worker-one', 'sid-1');
    a.client.close();
    await settle();
    expect(getSession(broker.db, a.welcome.session_id)).toMatchObject({
      state: 'online-idle',
      link: 'disconnected',
      parent_state: 'live',
      name: 'worker-one',
    });
    expect(liveHolder(broker.db, 'worker-one')?.id).toBe(a.welcome.session_id);
    const b = await mcp(home, 5151);
    await expect(b.client.call('session.register', { name: 'worker-one' })).rejects.toMatchObject({
      code: 'name_taken',
    });
    expect(claimName(broker.db, b.welcome.session_id, 'worker-one')).toMatchObject({ ok: false, reason: 'live' });
  });

  it('parent gone or pid reused: offline as before', async () => {
    reset();
    procs.set(4242, 'start-A');
    procs.set(4343, 'start-B');
    const { home, broker } = await boot();
    const gone = await bound(home, 4242, 'gone-one', 'sid-1');
    const reused = await bound(home, 4343, 'reused-one', 'sid-2');
    procs.delete(4242);
    procs.set(4343, 'start-B2');
    gone.client.close();
    reused.client.close();
    await settle();
    expect(getSession(broker.db, gone.welcome.session_id)?.state).toBe('offline');
    expect(getSession(broker.db, reused.welcome.session_id)?.state).toBe('offline');
  });

  it('no recorded parent: offline at once; probe failure: kept with an unknown parent', async () => {
    reset();
    procs.set(4242, 'start-A');
    const { home, broker } = await boot();
    const plain = await mcp(home, 6000);
    plain.client.close();
    const a = await bound(home, 4242, 'worker-one', 'sid-1');
    probeFails = true;
    a.client.close();
    await settle();
    expect(getSession(broker.db, plain.welcome.session_id)?.state).toBe('offline');
    expect(getSession(broker.db, a.welcome.session_id)).toMatchObject({
      state: 'online-idle',
      parent_state: 'unknown',
    });
  });

  it('a new MCP process under the same parent re-attaches; a reused pid does not', async () => {
    reset();
    procs.set(4242, 'start-A');
    const { home, broker } = await boot();
    const a = await bound(home, 4242, 'worker-one', 'sid-1');
    a.client.close();
    await settle();
    const again = await mcp(home, 4242);
    expect(again.welcome).toMatchObject({ session_id: a.welcome.session_id, name: 'worker-one' });
    expect(getSession(broker.db, a.welcome.session_id)).toMatchObject({ link: 'connected', agent_session_id: 'sid-1' });
    again.client.close();
    await settle();
    procs.set(4242, 'start-OTHER');
    const stranger = await mcp(home, 4242);
    expect(stranger.welcome.session_id).not.toBe(a.welcome.session_id);
  });

  it('broker restart: verified parents keep their slot and accept the reconnect hint; gone ones go offline', async () => {
    reset();
    procs.set(4242, 'start-A');
    procs.set(4343, 'start-B');
    const first = await boot();
    const keep = await bound(first.home, 4242, 'keep-one', 'sid-1');
    const lose = await bound(first.home, 4343, 'lose-one', 'sid-2');
    cleanup.splice(0); // stop the first broker by hand; its clients die with it
    await first.broker.stop();
    procs.delete(4343);
    const { broker } = await boot(first.home);
    expect(getSession(broker.db, keep.welcome.session_id)).toMatchObject({
      state: 'online-idle',
      link: 'disconnected',
      parent_state: 'live',
    });
    expect(getSession(broker.db, lose.welcome.session_id)?.state).toBe('offline');
    const back = await mcp(first.home, 4242, { resume_session_id: keep.welcome.session_id });
    expect(back.welcome.session_id).toBe(keep.welcome.session_id);
  });

  it('verifyAtStart checks every Claude parent with one probe call', () => {
    reset();
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'ww-va-')), 'state.db'));
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const s = createSession(db, { agent: 'claude', cwd: '/w', workspace: '/w', pid_chain: [], mcp_ppid: 10000 + i });
      setAgentIdentity(db, s.id, 10000 + i, 'S');
      if (i % 2 === 0) procs.set(10000 + i, 'S');
      ids.push(s.id);
    }
    const legacy = createSession(db, { agent: 'claude', cwd: '/w', workspace: '/w', pid_chain: [], mcp_ppid: null });
    const codex = createSession(db, { agent: 'codex', cwd: '/w', workspace: '/w', pid_chain: [], mcp_ppid: 2191 });
    const counts = verifyAtStart({ db, processProbe: probe, log: () => {} } as unknown as Pick<
      Broker,
      'db' | 'processProbe' | 'log'
    >);
    expect(probeCalls).toBe(1);
    expect(counts).toEqual({ live: 100, gone: 100, unknown: 2 });
    expect(getSession(db, ids[0])).toMatchObject({ state: 'online-idle', link: 'disconnected', parent_state: 'live' });
    expect(getSession(db, ids[1])?.state).toBe('offline');
    expect(getSession(db, legacy.id)).toMatchObject({ link: 'disconnected', parent_state: 'unknown' });
    expect(getSession(db, codex.id)).toMatchObject({ link: 'disconnected', parent_state: 'unknown' });
  });
});
