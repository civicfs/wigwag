import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexNames } from '../../src/native/codex-names.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, startBroker, tmpHome, until } from '../helpers.js';

class FakeApp extends EventEmitter {
  constructor(
    readonly threads: Record<string, Record<string, unknown>>,
    public fail = false,
  ) {
    super();
  }
  async connect() {
    if (this.fail) throw new Error('connect ENOENT');
  }
  async call(_m: string, p: { threadId: string }) {
    const t = this.threads[p.threadId];
    if (!t) throw new Error('Codex app-server error -32600: thread not found');
    return { thread: t };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
const root = (id: string, name: string | null) => ({ id, sessionId: id, parentThreadId: null, source: 'cli', name });

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function boot(app: FakeApp, opts: { indexPath?: string; refreshMs?: number } = {}) {
  const home = tmpHome();
  const codexNames = new CodexNames({
    factory: () => app,
    indexPath: opts.indexPath ?? join(home, 'missing-session-index.jsonl'),
  });
  const broker = await startBroker(home, { codexNames, codexNameRefreshMs: opts.refreshMs });
  cleanup.push(() => broker.stop());
  return { home, broker };
}
async function codex(home: string, extra: Partial<Hello> = {}) {
  const hello: Hello = {
    protocol: 1,
    role: 'mcp',
    agent: 'codex',
    cwd: '/Users/x/code/myproject',
    pid_chain: [11, 10],
    mcp_ppid: 10,
    ...extra,
  };
  const { client, welcome } = await mcpClient(home, hello);
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}

describe('codex native names (W2)', () => {
  it('adopts the thread name after bind', async () => {
    const { home, broker } = await boot(new FakeApp({ 't-1': root('t-1', 'Initialize Wigwag session') }));
    const c = await codex(home);
    await c.client.call('session.bind', { agent_session_id: 't-1' });
    await until(() => getSession(broker.db, c.welcome.session_id)?.name === 'initialize-wigwag-session');
    expect(getSession(broker.db, c.welcome.session_id)?.name_source).toBe('native');
  });

  it('follows thread/name/updated and the periodic refresh', async () => {
    const app = new FakeApp({ 't-1': root('t-1', 'First') });
    const { home, broker } = await boot(app, { refreshMs: 50 });
    const c = await codex(home);
    await c.client.call('session.bind', { agent_session_id: 't-1' });
    await until(() => getSession(broker.db, c.welcome.session_id)?.name === 'first');
    app.emit('message', { method: 'thread/name/updated', params: { threadId: 't-1', threadName: 'Second' } });
    await until(() => getSession(broker.db, c.welcome.session_id)?.name === 'second');
    app.threads['t-1'].name = 'Third';
    await until(() => getSession(broker.db, c.welcome.session_id)?.name === 'third');
  });

  it('keeps an API title through an outage with a lagging index, then accepts the recovered API title', async () => {
    const indexPath = join(mkdtempSync(join(tmpdir(), 'ww-ci-outage-')), 'session_index.jsonl');
    writeFileSync(indexPath, '{"id":"t-1","thread_name":"Old index title"}\n');
    const app = new FakeApp({ 't-1': root('t-1', 'Current API title') });
    const { home, broker } = await boot(app, { indexPath });
    const c = await codex(home);
    await c.client.call('session.bind', { agent_session_id: 't-1' });
    await until(() => getSession(broker.db, c.welcome.session_id)?.native_name === 'Current API title');
    app.fail = true;
    app.close();
    await broker.codexNames?.refresh('t-1');
    expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({
      name: 'current-api-title',
      native_name: 'Current API title',
    });
    app.fail = false;
    app.threads['t-1'].name = 'Newest API title';
    await broker.codexNames?.refresh('t-1');
    expect(getSession(broker.db, c.welcome.session_id)?.name).toBe('newest-api-title');
  });

  it('adopts an index title once, then ignores later index changes until the API is available', async () => {
    const indexPath = join(mkdtempSync(join(tmpdir(), 'ww-ci-first-')), 'session_index.jsonl');
    writeFileSync(indexPath, '{"id":"t-1","thread_name":"First index title"}\n');
    const { home, broker } = await boot(new FakeApp({}, true), { indexPath });
    const c = await codex(home);
    await c.client.call('session.bind', { agent_session_id: 't-1' });
    await until(() => getSession(broker.db, c.welcome.session_id)?.native_name === 'First index title');
    writeFileSync(indexPath, '{"id":"t-1","thread_name":"Changed index title"}\n');
    await broker.codexNames?.refresh('t-1');
    expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({
      name: 'first-index-title',
      native_name: 'First index title',
    });
  });

  it('uses the session index when the app-server is unavailable; a custom name still wins', async () => {
    const indexPath = join(mkdtempSync(join(tmpdir(), 'ww-ci-')), 'session_index.jsonl');
    writeFileSync(indexPath, '{"id":"t-2","thread_name":"From index","updated_at":"1"}\n');
    const { home, broker } = await boot(new FakeApp({}, true), { indexPath });
    const c = await codex(home);
    await c.client.call('session.bind', { agent_session_id: 't-2' });
    await until(() => getSession(broker.db, c.welcome.session_id)?.name === 'from-index');
    const d = await codex(home, { requested_name: 'codex-helper', mcp_ppid: 20, pid_chain: [21, 20] });
    writeFileSync(indexPath, '{"id":"t-3","thread_name":"Other","updated_at":"1"}\n');
    await d.client.call('session.bind', { agent_session_id: 't-3' });
    await until(() => getSession(broker.db, d.welcome.session_id)?.native_name === 'Other');
    expect(getSession(broker.db, d.welcome.session_id)?.name).toBe('codex-helper');
  });
});
