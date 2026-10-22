import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sockPath } from '../src/client/autospawn.js';
import { HANDSHAKE_VERSIONS } from '../src/protocol/rpc.js';
import { startTestBroker } from './helpers.js';

type ClientStamp = { protocol: number | null; schema_version: number | null; version: string | null };
type SessionDiagnostic = {
  id: string;
  state: string;
  client: ClientStamp;
  broker: ClientStamp;
  version_warnings: string[];
  version_warnings_scope: string;
};

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Literal wire peers avoid today's client rewriting old or absent handshake stamps.
async function peer(home: string, hello: Record<string, unknown>) {
  const socket = createConnection(sockPath(home));
  cleanup.push(() => socket.destroy());
  let next = 0;
  let buffer = '';
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  socket.on('data', (data) => {
    buffer += data;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiting = pending.get(frame.id);
      if (!waiting) continue;
      pending.delete(frame.id);
      if (frame.error) waiting.reject(frame.error);
      else waiting.resolve(frame.result);
    }
  });
  const rejectPending = (error: unknown) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  socket.on('error', rejectPending);
  socket.on('close', () => rejectPending(new Error('Diagnostic wire peer closed')));
  const call = <T = unknown>(method: string, params: unknown = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const welcome = await call<{ session_id: string }>('hello', hello);
  return { call, welcome, socket };
}

describe('per-connection client version diagnostics', () => {
  it.each([
    {
      label: 'current stamped',
      stamp: { protocol: 1, schema_version: 5, version: '0.3.5' },
      expected: { protocol: 1, schema_version: 5, version: '0.3.5' },
    },
    {
      label: 'reviewed old wire',
      stamp: { protocol: 1, schema_version: 4, version: '0.3.0' },
      expected: { protocol: 1, schema_version: 4, version: '0.3.0' },
    },
    {
      label: 'unstamped legacy',
      stamp: { protocol: 1 },
      expected: { protocol: 1, schema_version: null, version: null },
    },
  ])('reports the $label peer independently of other peers and broker history', async ({ stamp, expected }) => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const mcp = { role: 'mcp', agent: 'claude', cwd: home, pid_chain: [] };
    const old = await peer(home, { ...mcp, protocol: 1, schema_version: 4, version: '0.3.0' });
    const legacy = await peer(home, { ...mcp, protocol: 1 });
    old.socket.destroy();
    legacy.socket.destroy();
    const own = await peer(home, { ...mcp, ...stamp });
    const diagnostic = await own.call<SessionDiagnostic>('session.whoami');
    expect(diagnostic.client).toEqual(expected);
    expect(diagnostic.broker).toEqual(HANDSHAKE_VERSIONS);
    expect(diagnostic.version_warnings_scope).toBe('broker-history');
    expect(diagnostic.version_warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('0.3.0'), expect.stringContaining('legacy client 0.2')]),
    );
    const owner = await peer(home, { ...HANDSHAKE_VERSIONS, role: 'owner' });
    const sessions = await owner.call<SessionDiagnostic[]>('session.who');
    expect(sessions.find((session) => session.id === own.welcome.session_id)?.client).toEqual(expected);
  });

  it('reports unknown client stamps once the recorded session has no connected peer', async () => {
    const { home, broker } = await startTestBroker();
    cleanup.push(() => broker.stop());
    const own = await peer(home, {
      ...HANDSHAKE_VERSIONS,
      role: 'mcp',
      agent: 'claude',
      cwd: home,
      pid_chain: [],
    });
    const owner = await peer(home, { ...HANDSHAKE_VERSIONS, role: 'owner' });
    own.socket.destroy();
    await vi.waitFor(async () => {
      const sessions = await owner.call<SessionDiagnostic[]>('session.who');
      expect(sessions.find((session) => session.id === own.welcome.session_id)).toMatchObject({
        state: 'offline',
        client: { protocol: null, schema_version: null, version: null },
      });
    });
  });
});
