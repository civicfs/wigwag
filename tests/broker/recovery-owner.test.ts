import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { CodexNames } from '../../src/native/codex-names.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { recoveryCandidates } from '../../src/store/recovery.js';
import { bindAgentSession, claimName, createSession, setState } from '../../src/store/sessions.js';
import { ownerClient, startBroker, startTestBroker, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function mcp(home: string, extra: Partial<Hello> = {}) {
  const hello: Hello = {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: '/Users/x/code/myproject',
    pid_chain: [500, 400],
    mcp_ppid: 400,
    ...extra,
  };
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string } };
}

describe('owner recovery diagnostics (W7)', () => {
  it('lists duplicate slots and flags; retiring a slot removes it from candidates and duplicates', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const live = await mcp(home);
    const slot = (name: string) => {
      const s = createSession(broker.db, {
        agent: 'claude',
        cwd: '/w',
        workspace: '/w',
        pid_chain: [],
        mcp_ppid: null,
      });
      claimName(broker.db, s.id, name, 'custom');
      bindAgentSession(broker.db, s.id, 'sid-dup');
      setState(broker.db, s.id, 'offline');
      return s.id;
    };
    const [a, b] = [slot('dup-one'), slot('dup-two')];
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    const report = await o.call<{ duplicates: Array<{ native_id: string; session_ids: string[] }>; flags: unknown[] }>(
      'owner.recovery',
      {},
    );
    expect(report.duplicates).toEqual([
      { agent: 'claude', native_id: 'sid-dup', workspace: '/w', session_ids: expect.arrayContaining([a, b]) },
    ]);
    await expect(o.call('owner.retire_slot', { session_id: live.welcome.session_id })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(o.call('owner.retire_slot', { session_id: 'ses-nope' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await o.call('owner.retire_slot', { session_id: a })).toEqual({ session_id: a });
    await expect(o.call('owner.retire_slot', { session_id: a })).rejects.toMatchObject({ code: 'conflict' });
    expect((await o.call<{ duplicates: unknown[] }>('owner.recovery', {})).duplicates).toEqual([]);
    expect(
      recoveryCandidates(broker.db, { agent: 'claude', native: 'sid-dup', workspace: '/w', exceptId: 'x' }).map(
        (s) => s.id,
      ),
    ).toEqual([b]);
  });

  it('whoami states what this session supports', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const claude = await mcp(home, { channel: false });
    expect(await claude.client.call('session.whoami')).toMatchObject({
      capabilities: {
        native_names: 'claude-hook-sidecar',
        resume_recovery: 'native-id',
        delivery: 'hook-boundary',
        parent_liveness: 'unavailable', // never hook-bound, so no parent identity was recorded
      },
    });
    const cx = await mcp(home, { agent: 'codex', mcp_ppid: 401 });
    await cx.client.call('session.bind', { agent_session_id: 't-x' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await cx.client.call('session.whoami')).toMatchObject({
      capabilities: {
        native_names: 'codex-session-index',
        resume_recovery: 'unavailable',
        delivery: 'codex-queue',
        parent_liveness: 'unavailable',
      },
    });
  });

  it('codex with a reachable app-server still requires a trusted concrete ID', async () => {
    class App extends EventEmitter {
      async connect() {}
      async call(_m: string, p: { threadId: string }) {
        return { thread: { id: p.threadId, sessionId: p.threadId, parentThreadId: null, source: 'cli', name: null } };
      }
      send() {}
      close() {}
    }
    const home = tmpHome();
    const broker = await startBroker(home, {
      codexNames: new CodexNames({ factory: () => new App(), indexPath: `${home}/missing-session-index.jsonl` }),
    });
    cleanup.push(() => broker.stop());
    const cx = await mcp(home, { agent: 'codex' });
    await cx.client.call('session.bind', { agent_session_id: 't-y' });
    await new Promise((r) => setTimeout(r, 100));
    expect(await cx.client.call('session.whoami')).toMatchObject({
      capabilities: {
        native_names: 'codex-app-server',
        resume_recovery: 'unavailable',
        resume_recovery_reason: 'codex-thread-id-untrusted',
        parent_liveness: 'thread-loaded',
      },
    });
  });
});
