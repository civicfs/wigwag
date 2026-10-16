import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { getSession } from '../../src/store/sessions.js';
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
async function connect(home: string, hello: Hello) {
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}
const mcp = (home: string, extra: Partial<Hello> = {}) =>
  connect(home, {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: '/Users/x/code/myproject',
    pid_chain: [500, 400, 300],
    mcp_ppid: 400,
    ...extra,
  });
const hook = async (home: string) => (await connect(home, { protocol: 1, role: 'hook' })).client;
const ev = (event: string, extra: Record<string, unknown> = {}) => ({
  agent: 'claude',
  event,
  agent_session_id: 'sid-1',
  cwd: '/Users/x/code/myproject',
  pid_chain: [9, 400],
  agent_pid: 400,
  ...extra,
});
function transcriptFile(opts: { sidecar?: string; record?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ww-tr-'));
  const path = join(dir, 'sid-1.jsonl');
  const line = opts.record
    ? { type: 'custom-title', sessionId: 'sid-1', customTitle: opts.record }
    : { type: 'user', sessionId: 'sid-1' };
  writeFileSync(path, `${JSON.stringify(line)}\n`);
  if (opts.sidecar) {
    mkdirSync(join(dir, 'sid-1'));
    writeFileSync(join(dir, 'sid-1', 'custom-title.json'), JSON.stringify({ customTitle: opts.sidecar }));
  }
  return path;
}

describe('claude native names at hook boundaries (W2)', () => {
  it('adopts the hook session_title and records the native name', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const h = await hook(home);
    const r = await h.call<{ bound: boolean; additional_context: string }>(
      'hook.event',
      ev('SessionStart', { session_title: 'Node refactor', source: 'resume' }),
    );
    expect(r.bound).toBe(true);
    expect(r.additional_context).toMatch(/registered as "node-refactor"/);
    expect(getSession(broker.db, a.welcome.session_id)).toMatchObject({
      name: 'node-refactor',
      name_source: 'native',
      native_name: 'Node refactor',
    });
  });

  it('reads the sidecar at PostToolUse via the stored transcript path', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const h = await hook(home);
    const t = transcriptFile();
    await h.call('hook.event', ev('SessionStart', { transcript_path: t }));
    expect(getSession(broker.db, a.welcome.session_id)?.native_ref).toBe(t);
    mkdirSync(join(t, '..', 'sid-1'));
    writeFileSync(join(t, '..', 'sid-1', 'custom-title.json'), JSON.stringify({ customTitle: 'Side Title' }));
    await h.call('hook.event', ev('PostToolUse'));
    expect(getSession(broker.db, a.welcome.session_id)?.name).toBe('side-title');
  });

  it('scans the transcript only at SessionStart', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const h = await hook(home);
    const t = transcriptFile({ record: 'From transcript' });
    await h.call('hook.event', ev('UserPromptSubmit', { transcript_path: t }));
    expect(getSession(broker.db, a.welcome.session_id)?.name).toBe(a.welcome.name);
    await h.call('hook.event', ev('SessionStart', { transcript_path: t }));
    expect(getSession(broker.db, a.welcome.session_id)?.name).toBe('from-transcript');
  });

  it('does not store a transcript path for another session id, and ignores Stop titles', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const h = await hook(home);
    await h.call('hook.event', ev('SessionStart', { transcript_path: '/tmp/x/other.jsonl' }));
    expect(getSession(broker.db, a.welcome.session_id)?.native_ref).toBeNull();
    await h.call('hook.event', ev('Stop', { session_title: 'Stop title' }));
    expect(getSession(broker.db, a.welcome.session_id)?.name).toBe(a.welcome.name);
  });

  it('an unusable title never fails the bind; a custom name keeps winning', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    const h = await hook(home);
    expect(await h.call('hook.event', ev('SessionStart', { session_title: '🚀' }))).toMatchObject({ bound: true });
    expect(getSession(broker.db, a.welcome.session_id)?.name).toBe(a.welcome.name);
    await a.client.call('session.register', { name: 'role-name' });
    await h.call('hook.event', ev('UserPromptSubmit', { session_title: 'Node refactor' }));
    expect(getSession(broker.db, a.welcome.session_id)).toMatchObject({
      name: 'role-name',
      native_name: 'Node refactor',
    });
  });
});
