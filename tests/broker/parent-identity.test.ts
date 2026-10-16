import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import type { ProcessProbe } from '../../src/proc/identity.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { getSession } from '../../src/store/sessions.js';
import { startBroker, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const procs = new Map<number, string>();
const calls: number[][] = [];
const probe: ProcessProbe = (pids) => {
  calls.push(pids);
  const m = new Map<number, string>();
  for (const p of pids) {
    const s = procs.get(p);
    if (s) m.set(p, s);
  }
  return m;
};
async function boot() {
  const home = tmpHome();
  const broker = await startBroker(home, { processProbe: probe });
  cleanup.push(() => broker.stop());
  return { home, broker };
}
async function connect(home: string, hello: Hello) {
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string } };
}
const CWD = '/Users/x/code/myproject';
const mcp = (home: string, ppid: number, agent: 'claude' | 'codex' = 'claude') =>
  connect(home, { protocol: 1, role: 'mcp', agent, cwd: CWD, pid_chain: [ppid + 1, ppid], mcp_ppid: ppid });
const ev = (event: string, pid: number, sid: string) => ({
  agent: 'claude',
  event,
  agent_session_id: sid,
  cwd: CWD,
  pid_chain: [9, pid],
  agent_pid: pid,
});

describe('parent identity at bind (W8)', () => {
  it('records the Claude parent once; an unknown pid records no start identity', async () => {
    procs.clear();
    procs.set(4242, 'start-A');
    const { home, broker } = await boot();
    const a = await mcp(home, 4242);
    const h = (await connect(home, { protocol: 1, role: 'hook' })).client;
    await h.call('hook.event', ev('SessionStart', 4242, 'sid-1'));
    expect(getSession(broker.db, a.welcome.session_id)).toMatchObject({
      agent_pid: 4242,
      agent_start: 'start-A',
      parent_state: 'live',
    });
    calls.length = 0;
    await h.call('hook.event', ev('UserPromptSubmit', 4242, 'sid-1'));
    expect(calls).toEqual([]);
    const b = await mcp(home, 5151);
    await h.call('hook.event', ev('SessionStart', 5151, 'sid-2'));
    expect(getSession(broker.db, b.welcome.session_id)).toMatchObject({
      agent_pid: 5151,
      agent_start: null,
      parent_state: 'unknown',
    });
  });

  it('records nothing for Codex: the shared daemon pid is not one thread', async () => {
    const { home, broker } = await boot();
    const c = await mcp(home, 2191, 'codex');
    await c.client.call('session.bind', { agent_session_id: 't-1' });
    expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({ agent_pid: null, agent_start: null });
  });
});
