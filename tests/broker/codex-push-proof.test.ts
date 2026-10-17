import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codexPushHold } from '../../src/broker/codex-push.js';
import type { Broker } from '../../src/broker/server.js';
import { WigwagError } from '../../src/errors.js';
import { CodexNames } from '../../src/native/codex-names.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { bindAgentSession, createSession, getSession } from '../../src/store/sessions.js';
import { mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

it.each(['fresh', 'age-999', 'age-1000', 'disconnected', 'generation', 'native', 'duplicate', 'host'])(
  'reuses only this push’s valid sub-second engine verdict (%s)',
  async (scenario) => {
    const age = scenario === 'age-999' ? 999 : scenario === 'age-1000' ? 1000 : 0;
    const blocked = !['fresh', 'age-999', 'age-1000'].includes(scenario);
    const home = tmpHome();
    let clock = 10000,
      scans = 0,
      queued = 0;
    class Metadata extends EventEmitter {
      async connect() {}
      async call(method: string, p: { threadId?: string }) {
        if (method === 'thread/loaded/list') {
          return { data: ['T'] };
        }
        // This fixture has one root: count metadata scans, excluding each scan's before/after listings.
        scans++;
        return { thread: { id: p.threadId, sessionId: p.threadId, source: 'cli', parentThreadId: null } };
      }
      close() {}
      send() {}
    }
    let broker: Broker;
    broker = await startBroker(home, {
      codexPushNow: () => clock,
      codexNames: new CodexNames({ factory: () => new Metadata(), indexPath: join(home, 'missing') }),
      transports: {
        claude: { kind: 'claude-channel', async push() {} },
        codex: {
          kind: 'codex-queue',
          async push(s, _items, options) {
            clock += age;
            if (scenario === 'disconnected')
              broker.db.prepare("UPDATE sessions SET link='disconnected' WHERE id=?").run(s.id);
            if (scenario === 'generation')
              broker.db.prepare('UPDATE sessions SET conn_generation=conn_generation+1 WHERE id=?').run(s.id);
            if (scenario === 'native') bindAgentSession(broker.db, s.id, 'different-native');
            if (scenario === 'host')
              broker.db.prepare("UPDATE sessions SET host_client_version='999.0.0' WHERE id=?").run(s.id);
            if (scenario === 'duplicate') {
              const d = createSession(broker.db, {
                agent: 'codex',
                cwd: s.cwd,
                workspace: s.workspace,
                pid_chain: [],
                mcp_ppid: null,
              });
              bindAgentSession(broker.db, d.id, 'T');
            }
            const reason = await broker.checkCodexPush(s, true, false, options?.codexPushProof);
            if (reason) throw new WigwagError('unbound', reason, { hold_reason: codexPushHold(reason) });
            queued++;
          },
        },
      },
    });
    cleanup.push(() => broker.stop());
    await broker.liveness?.probeNow();
    broker.liveness?.stop();
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'root-worker' });
    cleanup.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'T' });
    expect(getSession(broker.db, c.welcome.session_id)?.codex_push_reason).toBeNull();
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    const baseline = scans;
    const message = await o.call<{ id: string }>('owner.send', {
      to: 'root-worker',
      body: 'b',
      priority: 'urgent',
      attach_paths: [],
    });
    await until(() => deliveriesOfMessage(broker.db, message.id)[0]?.state === (blocked ? 'held' : 'read'));
    expect(queued).toBe(blocked ? 0 : 1);
    expect(scans - baseline).toBe(age < 1000 ? 1 : 2);
    if (!blocked) {
      const second = await o.call<{ id: string }>('owner.send', {
        to: 'root-worker',
        body: 'next',
        priority: 'urgent',
        attach_paths: [],
      });
      await until(() => deliveriesOfMessage(broker.db, second.id)[0]?.state === 'read');
      expect(queued).toBe(2);
      expect(scans - baseline).toBe(age < 1000 ? 2 : 4);
    }
  },
);
