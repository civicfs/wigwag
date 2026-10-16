import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveStatus } from '../../src/cli/commands/broker.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { ReconnectingClient } from '../../src/client/reconnecting.js';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/store/db.js';
import { createSession } from '../../src/store/sessions.js';
import { DIST_MAIN, mcpClient, startTestBroker, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fakeBroker(result: unknown, error?: unknown) {
  const home = tmpHome();
  const s = createServer((socket) => {
    let buf = '';
    socket.on('error', () => socket.destroy());
    socket.on('data', (d) => {
      buf += d;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const f = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        socket.write(
          `${JSON.stringify({
            id: f.id,
            ...(error ? { error } : { result: typeof result === 'function' ? result(f.method) : result }),
          })}\n`,
        );
        i = buf.indexOf('\n');
      }
    });
  });
  await new Promise<void>((r) => s.listen(sockPath(home), r));
  cleanup.push(() => new Promise<void>((r) => s.close(() => r())));
  return home;
}
async function rawHello(home: string, params: unknown) {
  const socket = createConnection(sockPath(home));
  const reply = new Promise<{ error?: { message: string } }>((resolve) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        resolve(JSON.parse(buf.split('\n')[0]));
        socket.destroy();
      }
    });
  });
  socket.write(`${JSON.stringify({ id: 1, method: 'hello', params })}\n`);
  return reply;
}
const command = (home: string, args: string[], input = '') =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [DIST_MAIN, ...args], { env: { ...process.env, WIGWAG_HOME: home } });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
describe('protocol/schema version skew', () => {
  it('rejects a legacy client before creating a session and exposes the warning to a compatible whoami', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const old = await rawHello(home, {
      protocol: 1,
      role: 'mcp',
      agent: 'claude',
      cwd: '/w',
      pid_chain: [],
      mcp_ppid: 2,
    });
    expect(old.error?.message).toContain('client is older than the broker');
    expect(broker.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    const peer = await mcpClient(home);
    cleanup.push(() => peer.client.close());
    const who = await peer.client.call<{ version_warnings: string[] }>('session.whoami');
    expect(who.version_warnings.join(' ')).toContain('update/reload the plugin');
  });
  it.each([
    ['older', { role: 'owner' }],
    ['newer', { role: 'owner', protocol: 1, schema_version: 999, version: '999.0.0' }],
  ])('a current client rejects a %s broker with an actionable error', async (direction, welcome) => {
    const home = await fakeBroker(welcome);
    const expected = direction === 'older' ? 'broker is older than this client' : 'client is older than the broker';
    const attempt = Client.connect(sockPath(home), { protocol: 1, role: 'owner' }, 1 << 20);
    void attempt.then(
      ({ client }) => client.destroy(),
      () => {},
    );
    await expect(attempt).rejects.toThrow(expected);
  });
  it('maps the old strict hello rejection to restart advice, and hooks still exit zero', async () => {
    const home = await fakeBroker(null, { code: 'bad_request', message: 'Unrecognized keys: schema_version, version' });
    await expect(Client.connect(sockPath(home), { protocol: 1, role: 'owner' }, 1 << 20)).rejects.toThrow(
      'wigwag broker stop',
    );
    const hook = await command(
      home,
      ['hook', 'claude', 'SessionStart'],
      JSON.stringify({ session_id: 'fixture', cwd: home }),
    );
    expect(hook.code).toBe(0);
    expect(hook.stdout).toBe('');
    expect(hook.stderr).toContain('broker is older than this client');
    const doctor = await command(home, ['doctor', '--claude-only']);
    expect(doctor.stdout).toContain('broker is older than this client');
  });
  it('QuestionReady fails open with skew advice while supervised PreToolUse retains an actionable denial', async () => {
    const home = await fakeBroker(null, { code: 'bad_request', message: 'Unrecognized keys: schema_version, version' });
    const db = openDb(join(home, 'state.db'));
    const worker = createSession(db, { agent: 'claude', cwd: home, pid_chain: [], mcp_ppid: null });
    db.exec(
      "INSERT INTO messages(id,from_name,to_target,kind,priority,subject,body,attachments,created_at) VALUES('task','owner','worker','message','urgent','s','b','[]','t')",
    );
    db.prepare("INSERT INTO assignments VALUES('a',?,'L',?,'fixture','key','{}','task','t',NULL)").run(
      worker.id,
      worker.id,
    );
    db.close();
    const input = JSON.stringify({
      session_id: 'fixture',
      cwd: home,
      tool_name: 'AskUserQuestion',
      tool_use_id: 'tool',
      tool_input: { questions: [{ question: 'Choose?', header: 'Choice' }] },
    });
    const ready = await command(home, ['hook', 'claude', 'QuestionReady'], input);
    expect(ready.code).toBe(0);
    expect(ready.stdout).toBe('');
    expect(ready.stderr).toContain('broker is older than this client');
    const ask = await command(home, ['hook', 'claude', 'PreToolUse'], input);
    expect(ask.code).toBe(0);
    expect(JSON.parse(ask.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('wigwag broker stop'),
    });
  });
  it('refuses to open a database newer than this build', () => {
    const file = join(tmpHome(), 'future.db'),
      db = openDb(file);
    db.exec('INSERT INTO schema_version VALUES(999)');
    db.close();
    expect(() => openDb(file)).toThrow('client is older than the broker');
  });
  it('MCP calls surface compatibility errors immediately while background recovery remains possible', async () => {
    const home = await fakeBroker({ role: 'owner' }),
      config = loadConfig(home);
    config.broker.start_timeout_ms = 200;
    const client = new ReconnectingClient({ home, config, entry: null, hello: () => ({ protocol: 1, role: 'owner' }) });
    cleanup.push(() => client.stop());
    await expect(client.start()).rejects.toThrow('broker is older than this client');
    await expect(client.call('session.whoami')).rejects.toMatchObject({
      code: 'schema',
      message: expect.stringContaining('wigwag broker stop'),
    });
  });
  it('restart advice remains usable: read-only broker status can verify an old broker pid', async () => {
    const home = await fakeBroker((method: string) =>
      method === 'hello' ? { role: 'owner' } : { pid: 4242, version: '0.1.0' },
    );
    expect(await liveStatus(home)).toEqual({ pid: 4242, version: '0.1.0' });
  });
  it('rejects newer client protocol/schema versions before registering', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    for (const fields of [
      { protocol: 999, schema_version: 4 },
      { protocol: 1, schema_version: 999 },
    ]) {
      const reply = await rawHello(home, { role: 'owner', version: '0.2.0', ...fields });
      expect(reply.error?.message).toContain('broker is older than this client');
    }
  });
});
