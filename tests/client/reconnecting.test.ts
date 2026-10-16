import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Broker } from '../../src/broker/server.js';
import { ReconnectingClient } from '../../src/client/reconnecting.js';
import { configPath, loadConfig } from '../../src/config.js';
import { startBroker, tmpHome } from '../helpers.js';

// Cleanup is registered as each resource is created, so a failing assertion leaks nothing.
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function track<T extends Broker | ReconnectingClient>(x: T): T {
  cleanups.push(() => x.stop());
  return x;
}

const ownerRc = (home: string) =>
  track(
    new ReconnectingClient({
      home,
      config: loadConfig(home),
      entry: null,
      hello: () => ({ protocol: 1, role: 'owner' }),
    }),
  );

describe('ReconnectingClient', () => {
  it('reconnects after the broker restarts and calls work again', async () => {
    const home = tmpHome();
    const broker = track(await startBroker(home));
    const rc = ownerRc(home);
    await rc.start();
    expect(await rc.call('sys.ping')).toMatchObject({ pong: true });
    const reconnected = new Promise((res) => rc.once('reconnected', res));
    await broker.stop();
    track(await startBroker(home));
    await reconnected;
    expect(await rc.call('sys.ping')).toMatchObject({ pong: true });
  });

  it('stop() during a pending reconnect closes the in-flight connection and rejects waiting calls', async () => {
    const home = tmpHome();
    const first = track(await startBroker(home));
    const rc = ownerRc(home);
    await rc.start();
    let reconnects = 0;
    rc.on('reconnected', () => reconnects++);
    await first.stop();

    // The next broker holds every hello open, so the client's reconnect is stuck mid-handshake.
    const next = track(new Broker(home, loadConfig(home)));
    let entered!: () => void;
    const inHello = new Promise<void>((r) => {
      entered = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    next.onHello = async (_conn, hello) => {
      entered();
      await gate;
      return { role: hello.role };
    };
    await next.start();
    await inHello; // the old connection is gone and the new one is mid-handshake: calls must wait
    expect(next.connections.size).toBe(1);
    const waiting = rc.call('sys.ping').then(
      () => 'resolved',
      (e: unknown) => e,
    );

    rc.stop();
    expect(await waiting).toMatchObject({ code: 'transport', message: 'wigwag client stopped' });
    await expect.poll(() => next.connections.size).toBe(0);
    release();
    await expect(rc.call('sys.ping')).rejects.toMatchObject({ code: 'transport' });
    // A late hello reply must not resurrect the connection.
    await expect.poll(() => next.connections.size).toBe(0);
    expect(reconnects).toBe(0);
  });

  it('building the hello (a process-table read) is not charged to the broker hello budget', async () => {
    const home = tmpHome();
    const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
    cfg.broker.start_timeout_ms = 300;
    writeFileSync(configPath(home), JSON.stringify(cfg));
    track(await startBroker(home));
    const rc = track(
      new ReconnectingClient({
        home,
        config: loadConfig(home),
        entry: null,
        hello: () => {
          const end = Date.now() + 600; // twice the budget, blocking as the real ps spawn is
          while (Date.now() < end);
          return { protocol: 1, role: 'owner' };
        },
      }),
    );
    await expect(rc.start()).resolves.toBeDefined();
    expect(await rc.call('sys.ping')).toMatchObject({ pong: true });
  });

  it('a call that times out waiting for a connection is rejected and forgotten', async () => {
    const home = tmpHome();
    const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
    cfg.broker.start_timeout_ms = 300;
    writeFileSync(configPath(home), JSON.stringify(cfg));
    const broker = track(await startBroker(home));
    const rc = ownerRc(home);
    await rc.start();
    await broker.stop();
    await expect.poll(() => (rc as unknown as { client: unknown }).client).toBeNull(); // disconnect observed
    await expect(rc.call('sys.ping')).rejects.toMatchObject({
      code: 'transport',
      // the last connect error is appended (final review I-6)
      message: expect.stringMatching(/^wigwag broker unavailable(: .+)?$/),
    });
    expect((rc as unknown as { waiters: Set<unknown> }).waiters.size).toBe(0);
  });
});
