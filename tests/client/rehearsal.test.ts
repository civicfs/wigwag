import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureBroker } from '../../src/client/autospawn.js';
import { connectOwner } from '../../src/client/owner.js';
import { loadConfig } from '../../src/config.js';
import { HANDSHAKE_VERSIONS } from '../../src/protocol/rpc.js';
import { tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
});
async function fake(ping: unknown, reply = true) {
  const home = tmpHome(),
    calls: string[] = [],
    sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    let buffer = '';
    s.on('data', (chunk) => {
      buffer += chunk.toString();
      while (true) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const f = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        calls.push(f.method);
        if (f.method === 'hello' || reply)
          s.write(
            `${JSON.stringify({ id: f.id, result: f.method === 'hello' ? { role: 'owner', ...HANDSHAKE_VERSIONS } : ping })}\n`,
          );
      }
    });
  });
  await new Promise<void>((r) => server.listen(join(home, 'broker.sock'), r));
  cleanup.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const config = loadConfig(home);
  config.rehearsal.enabled = true;
  config.broker.start_timeout_ms = 1000;
  return { home, config, calls };
}
it.each([{}, { rehearsal: { enabled: false, native_io: true } }, { rehearsal: { enabled: true, native_io: true } }])(
  'refuses missing/normal/inconsistent rehearsal evidence %j',
  async (ping) => {
    const f = await fake(ping);
    await expect(connectOwner(f.home, f.config)).rejects.toThrow(/rehearsal.*broker/i);
    expect(f.calls).toEqual(['hello', 'sys.ping']);
  },
);
it('keeps a verified rehearsal owner connection available for inspection', async () => {
  const f = await fake({ rehearsal: { enabled: true, native_io: false } });
  const { client } = await connectOwner(f.home, f.config);
  cleanup.push(() => client.destroy());
  expect(client.isClosed).toBe(false);
  expect(f.calls).toEqual(['hello', 'sys.ping']);
});
it('does not accept an existing normal broker during rehearsal autospawn', async () => {
  const f = await fake({ rehearsal: { enabled: false, native_io: true } });
  await expect(ensureBroker(f.home, f.config, '/never-run-fixture.js')).rejects.toThrow(/rehearsal.*broker/i);
  expect(f.calls).toEqual(['hello', 'sys.ping']);
});
it('bounds missing rehearsal ping evidence and closes the connection', async () => {
  const f = await fake({}, false);
  await expect(connectOwner(f.home, f.config)).rejects.toThrow(/connection closed|cancelled/);
  expect(f.calls).toEqual(['hello', 'sys.ping']);
});
