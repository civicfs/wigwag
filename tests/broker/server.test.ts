import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import { Broker } from '../../src/broker/server.js';
import { canConnect, sockPath } from '../../src/client/autospawn.js';
import { loadConfig } from '../../src/config.js';
import { WigwagError } from '../../src/errors.js';
import { ownerClient, staleSocket, startTestBroker, tmpHome } from '../helpers.js';

const brokers: Broker[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop();
});

/** Registers for cleanup before start(), so a failing assertion never leaks a listening broker. */
function track(b: Broker): Broker {
  brokers.push(b);
  return b;
}

const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const HELLO = { protocol: 1, role: 'owner' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Collects every frame the socket receives, in order. */
function collect(s: Socket): unknown[] {
  const frames: unknown[] = [];
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString();
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      frames.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  });
  return frames;
}

async function rawSocket(home: string): Promise<Socket> {
  const s = createConnection(sockPath(home));
  await new Promise((res) => s.once('connect', res));
  return s;
}

describe('broker server', () => {
  it('serves ping on a 0600 socket', async () => {
    const { home, broker } = await startTestBroker();
    track(broker);
    expect(statSync(sockPath(home)).mode & 0o777).toBe(0o600);
    const c = await ownerClient(home);
    expect(await c.call('sys.ping')).toMatchObject({ pong: true, pid: process.pid });
    c.close();
  });

  it('requires hello first', async () => {
    const { home, broker } = await startTestBroker();
    track(broker);
    const reply = await new Promise<string>((res) => {
      const s = createConnection(sockPath(home));
      s.on('data', (d) => {
        res(d.toString());
        s.destroy();
      });
      s.write(`${JSON.stringify({ id: 1, method: 'sys.ping', params: {} })}\n`);
    });
    expect(JSON.parse(reply)).toMatchObject({ id: 1, error: { code: 'bad_request' } });
  });

  it('rejects unknown methods, invalid params, wrong access, and reserved spawn (P3)', async () => {
    const { home, broker } = await startTestBroker();
    track(broker);
    const c = await ownerClient(home);
    await expect(c.call('nope' as never)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(c.call('owner.show', {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(c.call('msg.send', { to: 'a-b', subject: 's', body: 'b', priority: 'low' })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/not allowed/),
    });
    await expect(c.call('session.spawn', {})).rejects.toMatchObject({ code: 'not_implemented' });
    c.close();
  });

  it('refuses a second broker on the same home and recovers from a stale lock + socket', async () => {
    const { home, broker } = await startTestBroker();
    track(broker);
    await expect(startBroker(home)).rejects.toMatchObject({ code: 'already_running' });
    await broker.stop();
    const stale = tmpHome();
    writeFileSync(join(stale, 'broker.lock'), '999999');
    writeFileSync(sockPath(stale), '');
    track(await startBroker(stale));
    const c = await ownerClient(stale);
    expect(await c.call('sys.ping')).toMatchObject({ pong: true });
    c.close();
  });

  describe('concurrent start on one home (in-process)', () => {
    const cases: Array<[string, (home: string) => void]> = [
      ['fresh home', () => {}],
      [
        'stale lock naming a dead pid + stale socket',
        (home) => {
          writeFileSync(join(home, 'broker.lock'), '999999');
          staleSocket(sockPath(home));
        },
      ],
      [
        'stale lock naming a live unrelated pid (pid reuse) + stale socket',
        (home) => {
          writeFileSync(join(home, 'broker.lock'), String(process.ppid));
          staleSocket(sockPath(home));
        },
      ],
    ];
    for (const [name, prepare] of cases) {
      it(`exactly one of 8 starts wins; losers' stop() keeps the winner's socket and lock (${name})`, async () => {
        const home = tmpHome();
        prepare(home);
        const all = Array.from({ length: 8 }, () => track(new Broker(home, loadConfig(home))));
        const results = await Promise.allSettled(all.map((b) => b.start()));
        const winners = all.filter((_, i) => results[i].status === 'fulfilled');
        expect(winners).toHaveLength(1);
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'already_running' });
        }
        // Losers never owned anything: stopping them (twice) must not touch the winner's socket or lock.
        for (const b of all) if (b !== winners[0]) await b.stop();
        for (const b of all) if (b !== winners[0]) await b.stop();
        expect(await canConnect(sockPath(home))).toBe(true);
        expect(Number(readFileSync(join(home, 'broker.lock'), 'utf8'))).toBe(process.pid);
        const c = await ownerClient(home);
        expect(winners[0].connections.size).toBe(1);
        c.close();
        await expect(startBroker(home)).rejects.toMatchObject({ code: 'already_running' });
      });
    }
  });

  it('stop() twice is safe and a stopped old instance cannot remove a newer instance socket or lock', async () => {
    const home = tmpHome();
    const old = track(await startBroker(home));
    await old.stop();
    await old.stop();
    expect(existsSync(sockPath(home))).toBe(false);
    const fresh = track(await startBroker(home));
    await old.stop();
    expect(await canConnect(sockPath(home))).toBe(true);
    await expect(startBroker(home)).rejects.toMatchObject({ code: 'already_running' });
    const c = await ownerClient(home);
    expect(fresh.connections.size).toBe(1);
    c.close();
  });

  it('a throwing onStart hook releases the lock and the db; the next start succeeds', async () => {
    const home = tmpHome();
    const b = track(new Broker(home, loadConfig(home)));
    b.onStart.push(() => {
      throw new Error('hook failed');
    });
    await expect(b.start()).rejects.toThrow('hook failed');
    expect(existsSync(sockPath(home))).toBe(false);
    expect(() => b.db.prepare('SELECT 1')).toThrow();
    track(await startBroker(home));
    expect(await canConnect(sockPath(home))).toBe(true);
  });

  it('R34: an unwritable broker.log and a throwing onStop hook never strand the lock or the db', async () => {
    const home = tmpHome();
    const b = track(await startBroker(home));
    const logFile = join(home, 'logs', 'broker.log');
    unlinkSync(logFile);
    mkdirSync(logFile); // appendFileSync now fails with EISDIR
    expect(() => b.log('ignored')).not.toThrow();
    b.onStop.unshift(() => {
      throw new Error('hook failed');
    });
    await expect(b.stop()).resolves.toBeUndefined();
    expect(() => b.db.prepare('SELECT 1')).toThrow();
    expect(existsSync(sockPath(home))).toBe(false);
    rmdirSync(logFile);
    track(await startBroker(home));
    expect(await canConnect(sockPath(home))).toBe(true);
  });

  it('a socket-setup failure after the lock releases the lock; the next start succeeds', async () => {
    const home = tmpHome();
    mkdirSync(sockPath(home)); // a directory where the socket goes: neither unlink nor listen can use it
    await expect(startBroker(home)).rejects.toThrow();
    rmdirSync(sockPath(home));
    track(await startBroker(home));
    expect(await canConnect(sockPath(home))).toBe(true);
  });

  it('rejects null/number/string/boolean/array frames with bad_request and keeps serving the connection', async () => {
    const { home, broker } = await startTestBroker();
    track(broker);
    const s = await rawSocket(home);
    const got = collect(s);
    const bad = ['null', '42', '"x"', 'true', '[1,2]'];
    const badReply = { id: null, error: { code: 'bad_request', message: 'frame must be a JSON object' } };
    s.write(`${bad.join('\n')}\n${line({ id: 1, method: 'hello', params: HELLO })}`);
    await expect.poll(() => got.length).toBe(bad.length + 1);
    expect(got).toEqual([...bad.map(() => badReply), { id: 1, result: { role: 'owner' } }]);
    s.write(`null\n[]\n${line({ id: 2, method: 'sys.ping', params: {} })}`);
    await expect.poll(() => got.length).toBe(bad.length + 4);
    expect(got.slice(bad.length + 1)).toEqual([
      badReply,
      badReply,
      { id: 2, result: { pong: true, pid: process.pid } },
    ]);
    s.destroy();
  });

  it('a rejected hello never authorizes frames sent behind it, and the broker drops the connection', async () => {
    const home = tmpHome();
    const b = track(new Broker(home, loadConfig(home)));
    const inHello = deferred();
    const gate = deferred();
    b.onHello = async () => {
      inHello.resolve();
      await gate.promise;
      throw new WigwagError('bad_request', 'hello refused');
    };
    let snapshots = 0;
    b.handle('owner.snapshot', () => {
      snapshots++;
      return { leaked: true };
    });
    await b.start();
    const s = await rawSocket(home);
    const got = collect(s);
    const closed = new Promise((res) => s.once('close', res));
    s.write(line({ id: 1, method: 'hello', params: HELLO }) + line({ id: 2, method: 'owner.snapshot', params: {} }));
    await inHello.promise;
    gate.resolve();
    await closed; // the broker drops the connection; the test never closes it
    expect(got).toEqual([{ id: 1, error: { code: 'bad_request', message: 'hello refused' } }]);
    expect(snapshots).toBe(0);
    await expect.poll(() => b.connections.size).toBe(0);
  });

  it('frames pipelined behind a slow successful hello run after it, in order', async () => {
    const home = tmpHome();
    const b = track(new Broker(home, loadConfig(home)));
    const inHello = deferred();
    const gate = deferred();
    b.onHello = async (_conn, hello) => {
      inHello.resolve();
      await gate.promise;
      return { role: hello.role };
    };
    b.handle('sys.ping', ({ conn }) => ({ role: conn.role }));
    await b.start();
    const s = await rawSocket(home);
    const got = collect(s);
    s.write(line({ id: 1, method: 'hello', params: HELLO }) + line({ id: 2, method: 'sys.ping', params: {} }));
    await inHello.promise;
    gate.resolve();
    await expect.poll(() => got.length).toBe(2);
    expect(got).toEqual([
      { id: 1, result: { role: 'owner' } },
      { id: 2, result: { role: 'owner' } },
    ]);
    s.destroy();
  });
});
