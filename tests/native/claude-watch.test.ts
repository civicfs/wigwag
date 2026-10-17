import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { ClaudeTitleWatcher } from '../../src/native/claude-watch.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { getSession } from '../../src/store/sessions.js';
import { startTestBroker, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function connect(home: string, hello: Hello) {
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}
async function boundSession(withSidecarDir = false) {
  const { home, broker } = await startTestBroker();
  cleanup.push(() => broker.stop());
  const dir = mkdtempSync(join(tmpdir(), 'ww-cw-'));
  const transcript = join(dir, '5d7c100a-7597-483c-bc8c-88a81970184d.jsonl');
  writeFileSync(transcript, '');
  if (withSidecarDir) mkdirSync(join(dir, '5d7c100a-7597-483c-bc8c-88a81970184d'));
  const a = await connect(home, {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: '/Users/x/code/myproject',
    pid_chain: [500, 400, 300],
    mcp_ppid: 400,
  });
  const h = await connect(home, { protocol: 1, role: 'hook' });
  await h.client.call('hook.event', {
    agent: 'claude',
    event: 'SessionStart',
    agent_session_id: '5d7c100a-7597-483c-bc8c-88a81970184d',
    cwd: '/Users/x/code/myproject',
    pid_chain: [9, 400],
    agent_pid: 400,
    transcript_path: transcript,
  });
  const watcher = new ClaudeTitleWatcher(broker, 3_600_000);
  cleanup.push(() => watcher.stop());
  const write = (t: string, mtimeOffsetS = 0) => {
    mkdirSync(join(dir, '5d7c100a-7597-483c-bc8c-88a81970184d'), { recursive: true });
    const p = join(dir, '5d7c100a-7597-483c-bc8c-88a81970184d', 'custom-title.json');
    writeFileSync(p, JSON.stringify({ customTitle: t }));
    const at = new Date(Date.now() + mtimeOffsetS * 1000);
    utimesSync(p, at, at);
  };
  return { broker, a, watcher, write, name: () => getSession(broker.db, a.welcome.session_id)?.name };
}

describe('claude title watcher (W2)', () => {
  it('reconcile adopts a sidecar written while idle, and a later rename', async () => {
    const { watcher, write, name } = await boundSession();
    write('Side Title');
    watcher.reconcile();
    expect(name()).toBe('side-title');
    write('Second Title', 5);
    watcher.reconcile();
    expect(name()).toBe('second-title');
  });

  it('ignores offline sessions', async () => {
    const { a, watcher, write, name } = await boundSession();
    a.client.close();
    await new Promise((r) => setTimeout(r, 50));
    write('Too late');
    watcher.reconcile();
    expect(name()).not.toBe('too-late');
  });

  it('a file change in a watched sidecar directory is picked up without waiting for the interval', async () => {
    const { watcher, write, name } = await boundSession(true);
    watcher.reconcile();
    write('Watched Title');
    await until(() => name() === 'watched-title');
  });
});
