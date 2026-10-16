import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '../../src/client/client.js';
import { HANDSHAKE_VERSIONS } from '../../src/protocol/rpc.js';
import { tmpHome } from '../helpers.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((res) => s.close(res));
});

/** A fake broker that answers each received line with `reply(frame, socket)`. */
async function fakeBroker(reply: (frame: { id: number; method: string }, s: Socket) => void): Promise<string> {
  const path = join(tmpHome(), 'fake.sock');
  const server = createServer((s) => {
    let buf = '';
    s.on('error', () => s.destroy());
    s.on('data', (d) => {
      buf += d.toString();
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        reply(JSON.parse(buf.slice(0, nl)), s);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(path, res));
  return path;
}

const HELLO = { protocol: 1, role: 'owner' } as const;

describe('Client frame validation', () => {
  for (const bad of ['null', '42', '"x"', 'true', '[1,2]', '[]']) {
    it(`rejects connect with transport when the broker answers hello with ${bad}`, async () => {
      const path = await fakeBroker((_f, s) => s.write(`${bad}\n`));
      await expect(Client.connect(path, HELLO, 1 << 20)).rejects.toMatchObject({ code: 'transport' });
    });
  }

  it('drops the connection and rejects pending calls when a non-object frame arrives after hello', async () => {
    const path = await fakeBroker((f, s) => {
      if (f.method === 'hello')
        s.write(`${JSON.stringify({ id: f.id, result: { role: 'owner', ...HANDSHAKE_VERSIONS } })}\n`);
      else s.write('null\n');
    });
    const { client } = await Client.connect(path, HELLO, 1 << 20);
    const closed = new Promise((res) => client.once('close', res));
    await expect(client.call('sys.ping')).rejects.toMatchObject({ code: 'transport' });
    await closed;
    expect(client.isClosed).toBe(true);
  });
});
