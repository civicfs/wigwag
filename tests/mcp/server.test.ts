import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import { configPath, loadConfig } from '../../src/config.js';
import { WigwagError } from '../../src/errors.js';
import { describeError } from '../../src/mcp/server.js';
import {
  BOUND_SLACK_MS,
  DIST_MAIN,
  killSpawnedBrokers,
  ownerClient,
  readCodexCalls,
  tmpHome,
  until,
  WAIT_MS,
} from '../helpers.js';

const clients: McpClient[] = [];
let home = '';
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  // Every broker any MCP server spawned for this home, including a concurrent spawn still booting
  // (it would otherwise take the lock after the winner exits and outlive the test).
  if (home) await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
});

async function start(agent: 'claude' | 'codex', name: string, extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_MAIN, 'mcp', '--agent', agent],
    env: { ...(process.env as Record<string, string>), WIGWAG_HOME: home, WIGWAG_NAME: name, ...extraEnv },
  });
  // Claude Code advertises the channel only when it was started with the development-channels flag; this stands in for that.
  const client = new McpClient(
    { name: 'test', version: '0' },
    { capabilities: { experimental: { 'claude/channel': {} } } },
  );
  const channel: Array<{ content: string; meta: Record<string, string> }> = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') channel.push(n.params as never);
  };
  await client.connect(transport);
  clients.push(client);
  return { client, channel };
}
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;

describe('MCP server', () => {
  it('claude ↔ claude: send via tool arrives as a channel notification', async () => {
    home = tmpHome();
    const a = await start('claude', 'alpha-one');
    const b = await start('claude', 'beta-one');
    expect(JSON.parse(text(await a.client.callTool({ name: 'whoami', arguments: {} })))).toMatchObject({
      name: 'alpha-one',
    });
    await a.client.callTool({
      name: 'send',
      arguments: { to: 'beta-one', subject: 'hi', body: 'over the channel', priority: 'normal' },
    });
    await until(() => b.channel.length === 1);
    expect(b.channel[0].content).toContain('over the channel');
    expect(b.channel[0].meta).toMatchObject({ from: 'alpha-one' });
  });

  it('claude → codex: session_bind via hook-only tool, then delivery runs codex queue', async () => {
    home = tmpHome();
    const log = join(home, 'codex.jsonl');
    // The first MCP server autospawns the broker, which inherits its env: pass the log path to both.
    const a = await start('claude', 'alpha-one', { FAKE_CODEX_LOG: log });
    const c = await start('codex', 'codex-merger', { FAKE_CODEX_LOG: log });
    await c.client.callTool({ name: 'session_bind', arguments: { session_id: 'thread-77' } });
    await a.client.callTool({
      name: 'send',
      arguments: { to: 'codex-merger', subject: 's', body: 'to codex', priority: 'normal' },
    });
    await until(() => readCodexCalls(log).length === 1);
    expect(readCodexCalls(log)[0].argv.slice(0, 3)).toEqual(['queue', '--thread', 'thread-77']);
  });

  it('kv_cas works with the argument shapes Claude Code sends (E4): "null" version and JSON-text value', async () => {
    home = tmpHome();
    const a = await start('claude', 'alpha-one');
    const first = await a.client.callTool({
      name: 'kv_cas',
      arguments: { key: 'e2e/lock', expected_version: 'null', value: '"e2e-claude"' },
    });
    expect((first as { isError?: boolean }).isError).toBeFalsy();
    expect(JSON.parse(text(first))).toMatchObject({ version: 1 });
    const got = JSON.parse(text(await a.client.callTool({ name: 'kv_get', arguments: { key: 'e2e/lock' } })));
    expect(got.entry).toMatchObject({ version: 1, value: 'e2e-claude', updated_by: 'alpha-one' });
    // create-only loses the second time and reports the current version; a numeric-string version then wins.
    const again = await a.client.callTool({
      name: 'kv_cas',
      arguments: { key: 'e2e/lock', expected_version: 'null', value: '"other"' },
    });
    expect(JSON.parse(text(again))).toMatchObject({ ok: false, current: { version: 1, value: 'e2e-claude' } });
    const next = await a.client.callTool({
      name: 'kv_cas',
      arguments: { key: 'e2e/lock', expected_version: '1', value: '{"owner":"alpha-one"}' },
    });
    expect(JSON.parse(text(next))).toMatchObject({ version: 2 });
    const bad = (await a.client.callTool({
      name: 'kv_cas',
      arguments: { key: 'e2e/lock', expected_version: 'soon', value: '1' },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^bad_request:/);
  });

  it('tool errors come back as isError results, not crashes', async () => {
    home = tmpHome();
    const a = await start('claude', 'alpha-one');
    const r = (await a.client.callTool({ name: 'register', arguments: { name: 'owner' } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/bad_request: "owner" is reserved/);
  });

  it('uniform error codes: unknown tool, unexpected exception, startup failure', async () => {
    home = tmpHome();
    const a = await start('claude', 'alpha-one');
    expect(text(await a.client.callTool({ name: 'nope', arguments: {} }))).toMatch(/^bad_request: Unknown tool nope/);
    // blob_get of a path that does not exist is reported by the broker with its own code, never a bare String(e)
    const r = await a.client.callTool({ name: 'blob_get', arguments: { ref: `sha256:${'0'.repeat(64)}` } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(text(r)).toMatch(/^[a-z_]+: /);
    // Startup failure keeps the WigwagError code (no config.json -> config ... Run: wigwag init).
    const noConfigHome = join(mkdtempSync(join(tmpdir(), 'ww-')), 'h');
    const b = await start('claude', 'beta-one', { WIGWAG_HOME: noConfigHome });
    const e = (await b.client.callTool({ name: 'whoami', arguments: {} })) as { isError?: boolean };
    expect(e.isError).toBe(true);
    expect(text(e)).toMatch(/^config: .*Run: wigwag init/);
  });

  it('describeError: WigwagError keeps its code, anything else becomes internal', () => {
    expect(describeError(new WigwagError('conflict', 'stale'))).toBe('conflict: stale');
    expect(describeError(new TypeError('boom'))).toBe('internal: boom');
    expect(describeError('plain')).toBe('internal: plain');
  });

  describe('lifecycle', () => {
    let hung: Server | null = null;
    afterEach(() => {
      hung?.close();
      hung = null;
    });

    it('a broker that accepts but never answers hello yields a bounded transport error', async () => {
      home = tmpHome();
      const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
      cfg.broker.start_timeout_ms = 800;
      writeFileSync(configPath(home), JSON.stringify(cfg, null, 2));
      // The server's first received byte is the hello frame: the moment the hello budget starts. Everything before it
      // (cold node start, config, process table) is not the bound under test and stalls for seconds under load.
      let helloAt = 0;
      hung = createServer((sock) => {
        sock.on('error', () => {});
        sock.on('data', () => {
          helloAt ||= Date.now();
        });
      }); // accept, never reply
      await new Promise<void>((res) => hung?.listen(join(home, 'broker.sock'), res));
      const a = await start('claude', 'alpha-one');
      const r = (await a.client.callTool({ name: 'whoami', arguments: {} })) as { isError?: boolean };
      const answeredAt = Date.now();
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^transport: .*did not answer hello within 800 ms/);
      expect(helloAt).toBeGreaterThan(0);
      const budget = cfg.broker.start_timeout_ms;
      // At least the budget, and within it plus scheduling slack (not the 30 s the helper's default start budget would give).
      expect(answeredAt - helloAt).toBeGreaterThanOrEqual(budget - 100);
      expect(answeredAt - helloAt).toBeLessThan(budget + BOUND_SLACK_MS);
    });

    it('holds channel pushes until the MCP client has initialized, then sends the backlog once (final I-3)', async () => {
      home = tmpHome();
      const broker = await startBroker(home);
      const owner = await ownerClient(home);
      const child = spawn(process.execPath, [DIST_MAIN, 'mcp', '--agent', 'claude'], {
        env: { ...(process.env as Record<string, string>), WIGWAG_HOME: home, WIGWAG_NAME: 'gate-one' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      try {
        await owner.call('owner.send', { to: 'gate-one', subject: 's', body: 'offline backlog', priority: 'normal' });
        let out = '';
        child.stdout.on('data', (d) => {
          out += String(d);
        });
        // No broker hello before initialized: the backlog stays durable even if this MCP process exits now.
        type Who = Array<{ name: string; state: string }>;
        await new Promise((r) => setTimeout(r, 300));
        expect((await owner.call<Who>('session.who')).some((x) => x.name === 'gate-one' && x.state !== 'offline')).toBe(
          false,
        );
        expect(out).not.toContain('notifications/claude/channel');
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: { experimental: { 'claude/channel': {} } }, clientInfo: { name: 't', version: '0' } } })}\n`,
        );
        await until(() => out.includes('"id":1'));
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        await until(() => out.includes('notifications/claude/channel'));
        await new Promise((r) => setTimeout(r, 200));
        const lines = out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { id?: number; method?: string; params?: { content: string } });
        const init = lines.findIndex((l) => l.id === 1);
        const pushes = lines.flatMap((l, i) => (l.method === 'notifications/claude/channel' ? [i] : []));
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toBeGreaterThan(init);
        expect(lines[pushes[0]].params?.content).toContain('offline backlog');
      } finally {
        child.kill('SIGKILL');
        owner.close();
        await broker.stop();
      }
    });

    it('recovers without a restart when the config appears after a failed start (final I-6)', async () => {
      home = join(mkdtempSync(join(tmpdir(), 'ww-')), 'h');
      const a = await start('claude', 'late-one');
      const first = (await a.client.callTool({ name: 'whoami', arguments: {} })) as { isError?: boolean };
      expect(first.isError).toBe(true);
      expect(text(first)).toMatch(/^config: .*Run: wigwag init/);
      const ready = tmpHome();
      mkdirSync(home, { recursive: true });
      writeFileSync(configPath(home), readFileSync(configPath(ready)));
      let who = '';
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        const r = (await a.client.callTool({ name: 'whoami', arguments: {} })) as { isError?: boolean };
        if (!r.isError) {
          who = text(r);
          break;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(JSON.parse(who)).toMatchObject({ name: 'late-one' });
    });

    it('a failed first hello keeps retrying in the background and recovers when a broker answers (final I-6)', async () => {
      home = tmpHome();
      const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
      cfg.broker.start_timeout_ms = 800;
      writeFileSync(configPath(home), JSON.stringify(cfg, null, 2));
      const hungSockets: Socket[] = [];
      hung = createServer((sock) => {
        sock.on('error', () => {});
        hungSockets.push(sock);
      });
      await new Promise<void>((res) => hung?.listen(join(home, 'broker.sock'), res));
      const a = await start('claude', 'retry-one');
      const r = (await a.client.callTool({ name: 'whoami', arguments: {} })) as { isError?: boolean };
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^transport: /);
      const closed = new Promise<void>((res) => hung?.close(() => res()));
      for (const c of hungSockets.splice(0)) c.destroy();
      await closed;
      hung = null;
      let who = '';
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        const ok = (await a.client.callTool({ name: 'whoami', arguments: {} })) as { isError?: boolean };
        if (!ok.isError) {
          who = text(ok);
          break;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(JSON.parse(who)).toMatchObject({ name: 'retry-one' });
    });

    it('exits 0 on its own when the MCP client disconnects, and the session goes offline', async () => {
      home = tmpHome();
      const child = spawn(process.execPath, [DIST_MAIN, 'mcp', '--agent', 'claude'], {
        env: { ...(process.env as Record<string, string>), WIGWAG_HOME: home, WIGWAG_NAME: 'gone-one' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
      let out = '';
      child.stdout.on('data', (d) => {
        out += String(d);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`,
      );
      await until(() => out.includes('"id":1'));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      // broker.lock is written before the socket is listening, so it is not a readiness signal: retry
      // the connect until the broker the MCP server spawned is accepting.
      const owner = await (async () => {
        const end = Date.now() + WAIT_MS;
        for (;;) {
          try {
            return await ownerClient(home);
          } catch (e) {
            if (Date.now() > end) throw e;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })();
      type Who = Array<{ name: string; state: string }>;
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const who = await owner.call<Who>('session.who');
        if (who.some((x) => x.name === 'gone-one' && x.state !== 'offline')) break;
        if (Date.now() > deadline) throw new Error('session never came online');
        await new Promise((r) => setTimeout(r, 50));
      }
      child.stdin.end();
      const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('hung'), WAIT_MS))]);
      if (code === 'hung') child.kill('SIGKILL');
      expect(code).toBe(0);
      const end = Date.now() + WAIT_MS;
      let state = '';
      while (Date.now() < end) {
        state = (await owner.call<Who>('session.who')).find((x) => x.name === 'gone-one')?.state ?? '';
        if (state === 'offline') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(state).toBe('offline');
      owner.close();
    });
  });
});
