import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { nowIso } from '../../src/store/db.js';
import { attachConnection, createSession, getSession, setState } from '../../src/store/sessions.js';
import { startTestBroker } from '../helpers.js';

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
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('connection generations (W7)', () => {
  it('the current connection marks its slot offline on disconnect', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    expect(getSession(broker.db, a.welcome.session_id)?.conn_generation).toBe(1);
    a.client.close();
    await settle();
    expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('offline');
  });

  it('a connection that lost its slot to a newer generation does not mark it offline', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    attachConnection(broker.db, a.welcome.session_id); // a handoff gave the slot to another connection
    a.client.close();
    await settle();
    expect(getSession(broker.db, a.welcome.session_id)?.state).toBe('online-idle');
    expect(readFileSync(join(home, 'logs', 'broker.log'), 'utf8')).toMatch(/stale connection/);
  });

  it('a reconnect hint naming a retired slot resumes its canonical slot', async () => {
    const { home, broker } = await boot();
    const c = await mcp(home, { requested_name: 'canon-one' });
    c.client.close();
    await settle();
    const p = createSession(broker.db, {
      agent: 'claude',
      cwd: '/Users/x/code/myproject',
      pid_chain: [],
      mcp_ppid: null,
    });
    setState(broker.db, p.id, 'offline');
    broker.db
      .prepare('UPDATE sessions SET retired_at = ?, retired_into = ? WHERE id = ?')
      .run(nowIso(), c.welcome.session_id, p.id);
    const again = await mcp(home, { resume_session_id: p.id, mcp_ppid: 600, pid_chain: [700, 600] });
    expect(again.welcome).toMatchObject({ session_id: c.welcome.session_id, name: 'canon-one' });
  });

  it('a hint naming an owner-retired slot (no pointer) gets a new slot', async () => {
    const { home, broker } = await boot();
    const r = await mcp(home);
    r.client.close();
    await settle();
    broker.db.prepare('UPDATE sessions SET retired_at = ? WHERE id = ?').run(nowIso(), r.welcome.session_id);
    const again = await mcp(home, { resume_session_id: r.welcome.session_id });
    expect(again.welcome.session_id).not.toBe(r.welcome.session_id);
  });
});
