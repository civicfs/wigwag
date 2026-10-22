import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { listSessions } from '../../src/store/sessions.js';
import { DIST_MAIN, fixtureCodexNames, killSpawnedBrokers, startBroker, tmpHome } from '../helpers.js';

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text;

it('recovers an unbound Codex slot only from genuine host metadata across the MCP tool boundary', async () => {
  const home = tmpHome();
  const broker = await startBroker(home, { codexNames: fixtureCodexNames(home, () => ['root-A', 'root-B']) });
  const client = new McpClient({ name: 'codex-mcp-client', version: '0.162.1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [DIST_MAIN, 'mcp', '--agent', 'codex'],
        env: { ...(process.env as Record<string, string>), WIGWAG_HOME: home, WIGWAG_NAME: 'recover-worker' },
      }),
    );
    for (const request of [
      { name: 'turn_started', arguments: {} },
      { name: 'hook_digest', arguments: {}, _meta: { threadId: 'root-A', callId: 'model-call' } },
      { name: 'turn_started', arguments: { hook_origin: { thread_id: 'root-A' } }, _meta: { threadId: 'root-A' } },
      { name: 'turn_ended', arguments: { session_id: 'root-B' }, _meta: { threadId: 'root-A' } },
    ])
      expect((await client.callTool(request)).isError).toBe(true);
    expect(JSON.parse(text(await client.callTool({ name: 'whoami', arguments: {} })))).toMatchObject({ bound: false });
    const recovered = await client.callTool({ name: 'turn_started', arguments: {}, _meta: { threadId: 'root-A' } });
    expect(recovered.isError, text(recovered)).toBeFalsy();
    expect(JSON.parse(text(await client.callTool({ name: 'whoami', arguments: {} })))).toMatchObject({
      bound: true,
      bind_origin: 'hook-verified',
      state: 'online-busy',
    });
    expect(listSessions(broker.db).find((s) => s.name === 'recover-worker')?.agent_session_id).toBe('root-A');
    expect((await client.callTool({ name: 'hook_digest', arguments: {}, _meta: { threadId: 'root-B' } })).isError).toBe(
      true,
    );
    const digest = await client.callTool({ name: 'hook_digest', arguments: {}, _meta: { threadId: 'root-A' } });
    expect(digest.isError).toBeFalsy();
    expect(JSON.parse(text(digest))).toEqual({});
  } finally {
    await client.close();
    await broker.stop();
    await killSpawnedBrokers(home, 30000);
  }
});
