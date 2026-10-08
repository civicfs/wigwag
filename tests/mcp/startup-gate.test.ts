import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { runMcp } from '../../src/mcp/server.js';
import { tmpHome } from '../helpers.js';

const state = vi.hoisted(() => ({
  servers: [] as Array<{ oninitialized?: () => void; onclose?: () => void; sent: unknown[] }>,
  starts: 0,
  stops: 0,
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    oninitialized?: () => void;
    onclose?: () => void;
    sent: unknown[] = [];
    constructor() {
      state.servers.push(this);
    }
    setRequestHandler() {}
    getClientCapabilities() {
      return { experimental: { 'claude/channel': {} } };
    }
    async connect() {}
    async close() {}
    async notification(value: unknown) {
      this.sent.push(value);
    }
  },
}));
vi.mock('../../src/proc/ancestors.js', () => ({ pidChain: () => [1] }));
vi.mock('../../src/client/reconnecting.js', () => ({
  ReconnectingClient: class extends EventEmitter {
    async start() {
      state.starts++;
      this.emit('event', 'push', { content: 'one', meta: { msg_id: 'one' } });
      this.emit('event', 'push', { content: 'two', meta: { msg_id: 'two' } });
      return { session_id: 'ses-one', name: 'peer-one', warning: null };
    }
    stop() {
      state.stops++;
    }
  },
}));

const originalEnd = process.stdin.listeners('end');
const originalClose = process.stdin.listeners('close');
afterEach(() => {
  for (const listener of process.stdin.listeners('end'))
    if (!originalEnd.includes(listener)) process.stdin.removeListener('end', listener);
  for (const listener of process.stdin.listeners('close'))
    if (!originalClose.includes(listener)) process.stdin.removeListener('close', listener);
  state.servers.length = 0;
  state.starts = 0;
  state.stops = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('leaves the backlog at the broker until MCP initialized, then sends multiple pushes exactly once in order (final Codex I-3)', async () => {
  vi.stubEnv('WIGWAG_HOME', tmpHome());
  const running = runMcp('claude', '/unused');
  await Promise.resolve();
  await Promise.resolve();
  const server = state.servers[0];
  try {
    expect(state.starts).toBe(0);
    expect(server.sent).toEqual([]);
    server.oninitialized?.();
    await running;
    server.oninitialized?.(); // a repeated initialized must not replay a backlog
    expect(server.sent).toEqual([
      { method: 'notifications/claude/channel', params: { content: 'one', meta: { msg_id: 'one' } } },
      { method: 'notifications/claude/channel', params: { content: 'two', meta: { msg_id: 'two' } } },
    ]);
    expect(state.starts).toBe(1);
  } finally {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    server.onclose?.();
    server.oninitialized?.();
    await running;
    await Promise.resolve();
  }
});

it('closing before initialized starts no broker client and releases the startup wait (final Codex I-3)', async () => {
  vi.stubEnv('WIGWAG_HOME', tmpHome());
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const running = runMcp('claude', '/unused');
  await Promise.resolve();
  const server = state.servers[0];
  server.onclose?.();
  await running;
  expect(state.starts).toBe(0);
  expect(state.stops).toBe(0);
  expect(server.sent).toEqual([]);
});
