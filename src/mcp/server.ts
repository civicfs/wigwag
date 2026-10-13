import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ReconnectingClient } from '../client/reconnecting.js';
import { loadConfig, resolveHome } from '../config.js';
import { WigwagError } from '../errors.js';
import { pidChain } from '../proc/ancestors.js';
import { loadsWigwagChannel, processArgs } from '../proc/channel-flag.js';
import type { Hello, PushData } from '../protocol/rpc.js';
import type { Agent } from '../store/sessions.js';
import { VERSION } from '../version.js';
import { instructions } from './instructions.js';
import { parseToolInput, toolsFor } from './tools.js';

type Welcome = { session_id: string; name: string; warning: string | null };

const errorResult = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

// Every tool error reads `<code>: <message>`.
export const describeError = (e: unknown): string =>
  e instanceof WigwagError ? `${e.code}: ${e.message}` : `internal: ${e instanceof Error ? e.message : String(e)}`;

export async function runMcp(agent: Agent, entry: string): Promise<void> {
  const tools = toolsFor(agent);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server(
    { name: 'wigwag', version: VERSION },
    {
      capabilities: { tools: {}, ...(agent === 'claude' ? { experimental: { 'claude/channel': {} } } : {}) },
      instructions: instructions(agent),
    },
  );

  let rc: ReconnectingClient | null = null;
  let startError: string | null = null;
  let markReady: () => void = () => {};
  let connect: () => Promise<void> = async () => {};
  // Tool calls can arrive before the broker connection is up (autospawn); they wait for it rather than failing.
  const ready = new Promise<void>((res) => {
    markReady = res;
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input, { io: 'input' }) as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) return errorResult(`bad_request: Unknown tool ${req.params.name}`);
    await ready;
    if (!rc && !shuttingDown) await connect();
    if (!rc) return errorResult(startError ?? 'transport: wigwag is unavailable');
    const parsed = parseToolInput(tool, req.params.arguments ?? {});
    if (!parsed.success) return errorResult(`bad_request: ${z.prettifyError(parsed.error)}`);
    try {
      const args = parsed.data as Record<string, unknown>;
      const result = await rc.call(tool.method, tool.map ? tool.map(args) : args);
      return {
        content: [{ type: 'text' as const, text: tool.format ? tool.format(result) : JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return errorResult(describeError(e));
    }
  });

  let shuttingDown = false;
  let pending: ReconnectingClient | null = null;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    rc?.stop();
    pending?.stop();
    markInitialized();
    markReady();
    void server.close().finally(() => process.exit(0));
  };
  server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);

  // Keep the durable backlog at the broker until the channel consumer is ready. An MCP process that exits before
  // initialized must not leave deliveries marked pushed just because it buffered them in memory.
  let markInitialized!: () => void;
  const initialized = new Promise<void>((resolve) => {
    markInitialized = resolve;
  });
  const sendPush = (params: PushData): void => {
    server
      .notification({ method: 'notifications/claude/channel', params })
      .catch((e: unknown) => process.stderr.write(`wigwag: channel notification failed: ${String(e)}\n`));
  };
  server.oninitialized = markInitialized;

  await server.connect(new StdioServerTransport());
  await initialized;
  if (shuttingDown) return;

  // E-3: the broker must not mark a push delivered when the client will drop it. The client counts as channel-capable
  // when it advertised the capability at initialize, or the parent claude was started with the wigwag channel flag.
  const channel =
    agent === 'claude'
      ? server.getClientCapabilities()?.experimental?.['claude/channel'] !== undefined ||
        loadsWigwagChannel(processArgs(process.ppid))
      : undefined;
  if (channel === false) {
    process.stderr.write(
      'wigwag: this Claude session did not load the wigwag channel; peer messages arrive at turn boundaries and via inbox. ' +
        'Start it with: wigwag claude\n',
    );
  }
  let sessionId: string | null = null;
  const hello = (): Hello => ({
    protocol: 1,
    role: 'mcp',
    agent,
    cwd: process.cwd(),
    pid_chain: pidChain(process.pid),
    mcp_ppid: process.ppid,
    requested_name: process.env.WIGWAG_NAME || undefined,
    channel,
    resume_session_id: sessionId ?? undefined,
  });

  // Final review I-6: a failed first start no longer leaves the server dead for the whole agent session. With a
  // config, the client keeps connecting with backoff and tool calls get `transport:` errors until it connects.
  // Without a usable config (no retry settings to back off with) every tool call tries to start again.
  const attempt = async (): Promise<void> => {
    let client: ReconnectingClient | null = null;
    try {
      const home = resolveHome();
      const config = loadConfig(home);
      client = new ReconnectingClient({ home, config, entry, hello });
      pending = client;
      client.on('event', (name: string, data: unknown) => {
        if (agent !== 'claude' || name !== 'push') return;
        sendPush(data as PushData);
      });
      client.on('reconnected', (w: Welcome) => {
        sessionId = w.session_id;
      });
      const welcome = (await client.start()) as Welcome;
      if (shuttingDown) {
        client.stop();
        return;
      }
      sessionId = welcome.session_id;
      if (welcome.warning) process.stderr.write(`wigwag: ${welcome.warning}\n`);
      rc = client;
      startError = null;
    } catch (e) {
      startError = describeError(e);
      process.stderr.write(`wigwag: ${startError}\n`);
      if (client && !shuttingDown) {
        client.retryInBackground();
        rc = client;
      }
    } finally {
      pending = null;
    }
  };
  let connecting: Promise<void> | null = null;
  connect = () => {
    connecting ??= attempt().finally(() => {
      connecting = null;
    });
    return connecting;
  };
  await connect();
  markReady();
}
