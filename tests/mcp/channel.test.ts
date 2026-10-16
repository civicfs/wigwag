import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { loadConfig } from '../../src/config.js';
import { loadsWigwagChannel, processArgs } from '../../src/proc/channel-flag.js';
import { deliveriesByState } from '../../src/store/messages.js';
import { DIST_MAIN, killSpawnedBrokers, ownerClient, sessionOnline, startBroker, tmpHome, until } from '../helpers.js';

// E-3 with the real MCP server: whether a channel push is attempted depends on what the client advertised at
// initialize, or on the parent claude having been started with the wigwag channel flag.
const clients: McpClient[] = [];
let home = '';
let broker: Broker | null = null;
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  await broker?.stop().catch(() => {});
  broker = null;
  if (home) await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
});

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const env = (name: string) => ({ ...(process.env as Record<string, string>), WIGWAG_HOME: home, WIGWAG_NAME: name });

async function connect(
  command: string,
  args: string[],
  name: string,
  caps: { experimental?: Record<string, object> } = {},
) {
  const transport = new StdioClientTransport({ command, args, env: env(name) });
  const client = new McpClient({ name: 'test', version: '0' }, { capabilities: caps });
  const channel: Array<{ content: string }> = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') channel.push(n.params as never);
  };
  await client.connect(transport);
  clients.push(client);
  return { client, channel };
}
const mcp = (name: string, caps?: { experimental?: Record<string, object> }) =>
  connect(process.execPath, [DIST_MAIN, 'mcp', '--agent', 'claude'], name, caps);

async function sendOwner(to: string, body: string) {
  const o = await ownerClient(home);
  try {
    return await o.call<{ id: string }>('owner.send', { to, subject: 'e-3', body, priority: 'normal' });
  } finally {
    o.close();
  }
}
const settle = () => new Promise((r) => setTimeout(r, 400));

describe('claude MCP server channel capability (E-3)', () => {
  it('client advertises experimental claude/channel: the message is pushed over the channel', async () => {
    home = tmpHome();
    broker = await startBroker(home);
    const a = await mcp('adv-one', { experimental: { 'claude/channel': {} } });
    await sessionOnline(home, 'adv-one'); // initialize returns before the server's own cold start (pid chain, hello) ends
    await sendOwner('adv-one', 'ADV-TOKEN');
    await until(() => a.channel.length === 1);
    expect(a.channel[0].content).toContain('ADV-TOKEN');
    expect(deliveriesByState(broker.db, ['read'])).toHaveLength(1);
  });

  it('client does not advertise it and the parent has no channel flag: nothing is pushed, the delivery stays held, inbox finds it', async () => {
    home = tmpHome();
    broker = await startBroker(home);
    const a = await mcp('plain-one');
    await sessionOnline(home, 'plain-one'); // the push decision is made at hello; a send before it proves nothing
    await sendOwner('plain-one', 'PLAIN-TOKEN');
    await settle();
    expect(JSON.stringify(a.channel)).toBe('[]');
    expect(deliveriesByState(broker.db, ['read'])).toHaveLength(0);
    expect(deliveriesByState(broker.db, ['held'])).toHaveLength(1);
    const inbox = text(await a.client.callTool({ name: 'inbox', arguments: {} }));
    expect(inbox).toContain('PLAIN-TOKEN');
  });

  it('client does not advertise it but the parent claude was started with the wigwag channel flag: pushed', async () => {
    home = tmpHome();
    broker = await startBroker(home);
    // A stand-in for `claude --dangerously-load-development-channels plugin:wigwag@wigwag`: the MCP server's
    // parent process, whose argv carries the flag. It hands its own stdio to the server it spawns.
    const dir = mkdtempSync(join(tmpdir(), 'ww-parent-'));
    const parent = join(dir, 'fake-claude.mjs');
    writeFileSync(
      parent,
      `import { spawn } from 'node:child_process';
const c = spawn(process.execPath, [process.env.WW_MAIN, 'mcp', '--agent', 'claude'], { stdio: 'inherit' });
c.on('exit', (code) => process.exit(code ?? 0));
`,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [parent, '--dangerously-load-development-channels', 'plugin:wigwag@wigwag'],
      env: { ...env('flag-one'), WW_MAIN: DIST_MAIN },
    });
    const client = new McpClient({ name: 'test', version: '0' }, { capabilities: {} });
    const channel: Array<{ content: string }> = [];
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/claude/channel') channel.push(n.params as never);
    };
    await client.connect(transport);
    clients.push(client);
    await sessionOnline(home, 'flag-one');
    await sendOwner('flag-one', 'FLAG-TOKEN');
    await until(() => channel.length === 1);
    expect(channel[0].content).toContain('FLAG-TOKEN');
  });
});

describe('reading another process command line', () => {
  it('processArgs returns the argv of a live process; loadsWigwagChannel parses it', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)', '--', '--dangerously-load-development-channels', 'plugin:wigwag@wigwag'],
      { stdio: 'ignore' },
    );
    try {
      // right after fork, ps may still show the parent's command line
      await until(() => processArgs(child.pid as number).includes('--dangerously-load-development-channels'));
      const args = processArgs(child.pid as number);
      expect(args).toContain('--dangerously-load-development-channels');
      expect(loadsWigwagChannel(args), args).toBe(true);
      const own = processArgs(process.pid);
      expect(loadsWigwagChannel(own), own).toBe(false);
      const none = processArgs(2 ** 22 + 12345);
      expect(none, none).toBe('');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
