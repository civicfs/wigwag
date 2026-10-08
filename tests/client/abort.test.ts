import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canConnect, ensureBroker, sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { DIST_MAIN, killSpawnedBrokers, spawnedBrokerPids, tmpHome } from '../helpers.js';

// Ruling R35: abort semantics for Client.connect, canConnect and ensureBroker.

const servers: Server[] = [];
const accepted: Socket[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const s of accepted.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await new Promise<void>((res) => s.close(() => res()));
  for (const home of homes.splice(0)) await killSpawnedBrokers(home, loadConfig(home).broker.start_timeout_ms);
});

const HELLO = { protocol: 1, role: 'owner' } as const;
const FRAME = 1 << 20;

/** A raw listener that accepts connections and never answers: counts accepted sockets. */
async function silentServer(): Promise<{ path: string; accepted: () => number }> {
  const path = join(tmpHome(), 's.sock');
  let n = 0;
  const server = createServer((socket) => {
    n++;
    accepted.push(socket);
    socket.resume();
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(path, () => res()));
  return { path, accepted: () => n };
}

/** Counts listeners added to and removed from the signal (once-listeners fired by abort remove themselves). */
function countingSignal(ac: AbortController): { signal: AbortSignal; live: () => number } {
  let live = 0;
  const signal = ac.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((...a: Parameters<typeof add>) => {
    live++;
    add(...a);
  }) as typeof add;
  signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
    live--;
    remove(...a);
  }) as typeof remove;
  return { signal, live: () => live };
}

describe('abort semantics (R35)', () => {
  it('Client.connect: a pre-aborted signal rejects with transport and opens no socket', async () => {
    const { path, accepted } = await silentServer();
    const ac = new AbortController();
    ac.abort();
    await expect(Client.connect(path, HELLO, FRAME, undefined, ac.signal)).rejects.toMatchObject({
      code: 'transport',
    });
    await sleep(50);
    expect(accepted()).toBe(0);
  });

  it('Client.connect: abort before the socket connects settles the promise', async () => {
    const { path } = await silentServer();
    const ac = new AbortController();
    const p = Client.connect(path, HELLO, FRAME, undefined, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'transport' });
  });

  it('Client.connect: abort while waiting for the hello reply settles the promise', async () => {
    const { path, accepted } = await silentServer();
    const ac = new AbortController();
    const p = Client.connect(path, HELLO, FRAME, undefined, ac.signal);
    while (accepted() === 0) await sleep(5);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'transport' });
  });

  it('Client.connect: listeners on the signal are removed once the attempt settles', async () => {
    const ac = new AbortController();
    const { signal, live } = countingSignal(ac);
    await expect(Client.connect(join(tmpHome(), 'none.sock'), HELLO, FRAME, undefined, signal)).rejects.toThrow();
    expect(live()).toBe(0);
  });

  it('canConnect: pre-aborted rejects without a socket; mid-probe abort rejects; listeners removed', async () => {
    const { path, accepted } = await silentServer();
    const pre = new AbortController();
    pre.abort();
    await expect(canConnect(path, pre.signal)).rejects.toMatchObject({ code: 'transport' });
    await sleep(50);
    expect(accepted()).toBe(0);

    const mid = new AbortController();
    const p = canConnect(path, mid.signal);
    mid.abort();
    await expect(p).rejects.toMatchObject({ code: 'transport' });

    const ok = new AbortController();
    const { signal, live } = countingSignal(ok);
    expect(await canConnect(path, signal)).toBe(true);
    expect(await canConnect(join(tmpHome(), 'none.sock'), signal)).toBe(false);
    expect(live()).toBe(0);
  });

  it('ensureBroker: a pre-aborted signal spawns nothing and rejects', async () => {
    const home = tmpHome();
    homes.push(home);
    const ac = new AbortController();
    ac.abort();
    await expect(ensureBroker(home, loadConfig(home), DIST_MAIN, ac.signal)).rejects.toMatchObject({
      code: 'transport',
    });
    expect(spawnedBrokerPids(home)).toEqual([]);
    expect(await canConnect(sockPath(home))).toBe(false);
  });

  it('ensureBroker: an abort during the initial probe spawns nothing and rejects', async () => {
    const home = tmpHome();
    homes.push(home);
    const ac = new AbortController();
    const p = ensureBroker(home, loadConfig(home), DIST_MAIN, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'transport' });
    await sleep(100);
    expect(spawnedBrokerPids(home)).toEqual([]);
    expect(await canConnect(sockPath(home))).toBe(false);
  });
});
