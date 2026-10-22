import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { getSession } from '../../src/store/sessions.js';
import { DIST_MAIN, fixtureCodexNames, ownerClient, startBroker, tmpHome, WAIT_MS } from '../helpers.js';
import { previousRelease } from './previous-release.js';

let previous: Awaited<ReturnType<typeof previousRelease>>;
const cleanup: Array<() => Promise<unknown> | unknown> = [];
beforeAll(async () => {
  previous = await previousRelease();
});
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
const text = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0].text;
const parsed = <T>(result: unknown): T => JSON.parse(text(result));
type Identity = { id: string; name: string; bound: boolean; state: string; broker: { schema_version: number } };

class Metadata extends EventEmitter {
  async connect() {}
  async call(method: string, params: { threadId?: string }) {
    return method === 'thread/loaded/list'
      ? { data: ['upgrade-root'] }
      : {
          thread: { id: params.threadId, sessionId: params.threadId, source: 'cli', parentThreadId: null, name: null },
        };
  }
  send() {}
  close() {
    this.emit('disconnected');
  }
}
async function mcp(home: string, agent: 'claude' | 'codex', entry: string, name: string) {
  const client = new McpClient(
    agent === 'codex' ? { name: 'codex-mcp-client', version: '0.162.1' } : { name: 'claude-code', version: '2.1.296' },
    {
      capabilities: { experimental: { 'claude/channel': {} } },
    },
  );
  const channel: string[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/claude/channel') channel.push(String(notification.params?.content));
  };
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, 'mcp', '--agent', agent],
      env: { ...(process.env as Record<string, string>), WIGWAG_HOME: home, WIGWAG_NAME: name },
      stderr: 'pipe',
    }),
  );
  cleanup.push(() => client.close());
  return { client, channel };
}

// Actual previous-release MCP stays alive while its broker is upgraded and the on-disk schema migrates.
describe('retained previous-release MCP across broker upgrade', () => {
  it.each(['claude', 'codex'] as const)(
    '%s retains identity, mail ownership and transport after replacement',
    async (agent) => {
      const home = tmpHome();
      let broker: Broker = await previous.startBroker(home, {
        processProbe: () => new Map(),
        codexNames: new previous.CodexNames({ factory: () => new Metadata(), indexPath: join(home, 'missing-index') }),
      });
      cleanup.push(() => broker.stop());
      const peer = await mcp(home, agent, previous.entry, `old-${agent}`);
      if (agent === 'codex')
        expect(
          (
            await peer.client.callTool({
              name: 'session_bind',
              arguments: { session_id: 'upgrade-root' },
              _meta: { threadId: 'upgrade-root' },
            })
          ).isError,
        ).toBeFalsy();
      const before = parsed<Identity>(await peer.client.callTool({ name: 'whoami', arguments: {} }));
      expect(before.broker.schema_version).toBe(4);
      const held = parsed<{ id: string }>(
        await peer.client.callTool({
          name: 'send',
          arguments: {
            to: `old-${agent}`,
            priority: 'low',
            subject: 'before-upgrade',
            body: 'RETAINED-LOW-TOKEN',
          },
        }),
      );
      // Schema 4 has no recipient_session_id column; migration must capture this live holder below.
      await vi.waitFor(() => expect(deliveriesOfMessage(broker.db, held.id)[0]).toMatchObject({ state: 'held' }), {
        timeout: WAIT_MS,
      });
      await broker.stop();
      broker = await startBroker(home, { codexNames: fixtureCodexNames(home, () => ['upgrade-root']) });
      await vi.waitFor(
        async () => {
          const response = await peer.client.callTool({ name: 'whoami', arguments: {} });
          expect(response.isError).toBeFalsy();
          expect(parsed<Identity>(response)).toMatchObject({ id: before.id, name: before.name });
        },
        { timeout: WAIT_MS },
      );
      expect(
        (broker.db.prepare('SELECT max(version) AS version FROM schema_version').get() as { version: number }).version,
      ).toBe(5);
      expect(deliveriesOfMessage(broker.db, held.id)[0].recipient_session_id).toBe(before.id);
      if (agent === 'codex') {
        expect(
          (await peer.client.callTool({ name: 'turn_started', arguments: {}, _meta: { threadId: 'upgrade-root' } }))
            .isError,
        ).toBeFalsy();
        expect(getSession(broker.db, before.id)?.state).toBe('online-busy');
        const digest = await peer.client.callTool({
          name: 'hook_digest',
          arguments: {},
          _meta: { threadId: 'upgrade-root' },
        });
        expect(digest.isError).toBeFalsy();
        expect(text(digest)).toContain('RETAINED-LOW-TOKEN');
        expect(
          (await peer.client.callTool({ name: 'turn_ended', arguments: {}, _meta: { threadId: 'upgrade-root' } }))
            .isError,
        ).toBeFalsy();
        expect(getSession(broker.db, before.id)?.state).toBe('online-idle');
      } else {
        const owner = await ownerClient(home);
        try {
          await owner.call('owner.send', {
            to: before.name,
            priority: 'normal',
            subject: 'after-upgrade',
            body: 'CHANNEL-AFTER-UPGRADE',
            attach_paths: [],
          });
        } finally {
          owner.close();
        }
        await vi.waitFor(() => expect(peer.channel.join('\n')).toContain('CHANNEL-AFTER-UPGRADE'), {
          timeout: WAIT_MS,
        });
        const inbox = await peer.client.callTool({ name: 'inbox', arguments: {} });
        expect(inbox.isError).toBeFalsy();
        expect(text(inbox)).toContain('RETAINED-LOW-TOKEN');
      }
    },
  );
});

it('a failed SessionStart recovers on a later real MCP hook after upgrading the broker', async () => {
  const home = tmpHome();
  let broker: Broker = await previous.startBroker(home, {
    processProbe: () => new Map(),
    codexNames: new previous.CodexNames({ factory: () => new Metadata(), indexPath: join(home, 'missing-index') }),
  });
  cleanup.push(() => broker.stop());
  const peer = await mcp(home, 'codex', DIST_MAIN, 'current-codex');
  const failed = await peer.client.callTool({
    name: 'session_bind',
    arguments: { session_id: 'upgrade-root' },
    _meta: { threadId: 'upgrade-root' },
  });
  expect(failed.isError).toBe(true);
  expect(text(failed)).toContain('broker is older');
  await broker.stop();
  broker = await startBroker(home, { codexNames: fixtureCodexNames(home, () => ['upgrade-root']) });
  await vi.waitFor(
    async () => {
      const result = await peer.client.callTool({ name: 'whoami', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(parsed<Identity>(result).bound).toBe(false);
    },
    { timeout: WAIT_MS },
  );
  // No second session_bind: this is the hook the host already runs after every tool call.
  expect(
    (await peer.client.callTool({ name: 'hook_digest', arguments: {}, _meta: { threadId: 'upgrade-root' } })).isError,
  ).toBeFalsy();
  const recovered = parsed<Identity>(await peer.client.callTool({ name: 'whoami', arguments: {} }));
  expect(recovered.bound).toBe(true);
  expect(
    (await peer.client.callTool({ name: 'turn_started', arguments: {}, _meta: { threadId: 'upgrade-root' } })).isError,
  ).toBeFalsy();
  expect(getSession(broker.db, recovered.id)?.state).toBe('online-busy');
  expect(
    (await peer.client.callTool({ name: 'turn_ended', arguments: {}, _meta: { threadId: 'upgrade-root' } })).isError,
  ).toBeFalsy();
  expect(getSession(broker.db, recovered.id)?.state).toBe('online-idle');
});
