import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveStatus } from '../../src/cli/commands/broker.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { ReconnectingClient } from '../../src/client/reconnecting.js';
import { loadConfig } from '../../src/config.js';
import { assertPeerVersions, HANDSHAKE_VERSIONS } from '../../src/protocol/rpc.js';
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
  it('accepts legacy clients in degraded mode and exposes the warning to whoami/ping/doctor', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const peer = await mcpClient(home, { schema_version: undefined, version: undefined });
    cleanup.push(() => peer.client.close());
    const who = await peer.client.call<{ version_warnings: string[] }>('session.whoami');
    expect(who).toMatchObject({
      client_mode: 'legacy',
      compatibility_warning: 'legacy client 0.2: reload plugin for new features',
    });
    expect(who.version_warnings.join(' ')).toContain('legacy client 0.2');
    const ping = await peer.client.call<{ version_warnings: string[] }>('sys.ping');
    expect(ping.version_warnings.join(' ')).toContain('legacy client 0.2');
    const diagnostic = await command(home, ['doctor', '--claude-only']);
    expect(diagnostic.stdout).toContain('legacy client 0.2');
  });
  it.each(['0.1.9', '0.2.1'])('accepts package version %s with a soft warning in both directions', async (version) => {
    expect(() => assertPeerVersions({ ...HANDSHAKE_VERSIONS, version }, 'client')).not.toThrow();
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const peer = await mcpClient(home, { version });
    cleanup.push(() => peer.client.close());
    const who = await peer.client.call<{ version_warnings: string[] }>('session.whoami');
    expect(who.version_warnings.join(' ')).toContain(`client ${version} differs from broker`);
    const diagnostic = await command(home, ['doctor', '--claude-only']);
    expect(diagnostic.stdout).toContain('restart/reload when convenient');
    const remoteHome = await fakeBroker({ role: 'owner', ...HANDSHAKE_VERSIONS, version });
    const current = await Client.connect(sockPath(remoteHome), { protocol: 1, role: 'owner' }, 1 << 20);
    cleanup.push(() => current.client.destroy());
    expect((current.client as unknown as { versionWarning: string }).versionWarning).toContain(
      `differs from broker ${version}`,
    );
    const remoteDiagnostic = await command(remoteHome, ['doctor', '--claude-only']);
    expect(remoteDiagnostic.stdout).toContain(`differs from broker ${version}`);
  });
  it('rejects missing schema stamps with a package version, mismatched legacy protocols and unknown roles', () => {
    for (const p of [
      { protocol: 1, role: 'mcp', version: '0.2.0' },
      { protocol: 2, role: 'mcp' },
      { protocol: 1, role: 'future' },
    ])
      expect(() => assertPeerVersions(p, 'client')).toThrow();
  });
  it('a missing package stamp cannot upgrade a client to full features', () => {
    expect(
      assertPeerVersions({ protocol: 1, schema_version: HANDSHAKE_VERSIONS.schema_version, role: 'mcp' }, 'client'),
    ).toMatchObject({ legacy: true });
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
  it.each([{ role: 'owner' }, { role: 'owner', protocol: 2, schema_version: 5, version: '0.4.0' }])(
    'incompatible broker guidance distinguishes broker replacement from loaded-provider repair: %j',
    async (welcome) => {
      const home = await fakeBroker(welcome);
      const attempt = Client.connect(sockPath(home), { protocol: 1, role: 'owner' }, 1 << 20);
      await expect(attempt).rejects.toMatchObject({
        code: 'schema',
        message: expect.stringMatching(/Claude.*\/reload-plugins.*Codex.*restart.*trust/),
      });
      await expect(attempt).rejects.toThrow('wigwag doctor');
      await expect(attempt).rejects.toThrow('client.version');
      await expect(attempt).rejects.toThrow('bound: true');
      await expect(attempt).rejects.toThrow('restart Claude');
    },
  );
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
      { protocol: 0, schema_version: 4 },
      { protocol: 1, schema_version: 3 },
      { protocol: 999, schema_version: 4 },
      { protocol: 1, schema_version: 999 },
    ]) {
      const reply = await rawHello(home, {
        role: 'mcp',
        agent: 'claude',
        cwd: home,
        pid_chain: [],
        version: '0.2.0',
        ...fields,
      });
      expect(reply.error?.message).toMatch(/(?:broker|client) is older/);
      expect(broker.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    }
  });
});

it.each(['broker', 'client'] as const)('identifies a fractional schema from the %s as malformed, not older', (peer) => {
  expect(() => assertPeerVersions({ ...HANDSHAKE_VERSIONS, schema_version: 4.5, role: 'mcp' }, peer)).toThrow(
    `invalid schema_version from ${peer}`,
  );
});
