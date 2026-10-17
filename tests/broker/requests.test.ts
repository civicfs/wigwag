import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingAwaitCount, scheduleChunked } from '../../src/broker/handlers/requests.js';
import type { Broker } from '../../src/broker/server.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { mcpClient, startBroker, startTestBroker, until } from '../helpers.js';

let home: string;
let broker: Broker;
const closers: Array<() => unknown> = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await broker.stop();
});
const join = async (name: string) => {
  const c = await mcpClient(home, { requested_name: name });
  closers.push(() => c.client.close());
  return c;
};

describe('request/response', () => {
  it('request → push to responder; await returns the response; second respond is refused', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const { request_id } = await a.client.call<{ request_id: string }>('req.request', {
      to: 'beta-one',
      subject: 'which migration number?',
      body: 'Is 0724 free?',
    });
    expect(request_id).toMatch(/^req-/);
    await until(() => b.pushes.length === 1);
    expect(b.pushes[0].meta).toMatchObject({ kind: 'request', request_id });
    const waiting = a.client.call<{ status: string; response: { body: string } | null }>('req.await', {
      request_id,
      wait_s: 5,
    });
    await b.client.call('req.respond', { request_id, body: 'yes, 0724 is free', status: 'ok' });
    const r = await waiting;
    expect(r.status).toBe('answered');
    expect(r.response?.body).toBe('yes, 0724 is free');
    await expect(b.client.call('req.respond', { request_id, body: 'again', status: 'ok' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('an await whose caller renamed meanwhile neither reads nor returns the response now addressed to the new holder (final I-4)', async () => {
    const s = await join('sx-one');
    const r = await join('rr-one');
    const { request_id } = await s.client.call<{ request_id: string }>('req.request', {
      to: 'rr-one',
      subject: 's',
      body: 'b',
    });
    const waiting = s.client.call<{ status: string; response: { id: string; body: string } | null }>('req.await', {
      request_id,
      wait_s: 5,
    });
    await s.client.call('session.register', { name: 'sx-two' });
    const t = await join('sx-one');
    expect(t.welcome.name).toBe('sx-one');
    const { message_id } = await r.client.call<{ message_id: string }>('req.respond', {
      request_id,
      body: 'SECRET answer',
      status: 'ok',
    });
    const got = await waiting;
    expect(got.response).toBeNull();
    const del = deliveriesOfMessage(broker.db, message_id).find((d) => d.recipient === 'sx-one');
    // The only read is the push to the new holder; the await did not mark it read (that would carry no `delivered` detail).
    const reads = broker.db
      .prepare(`SELECT detail FROM delivery_events WHERE message_id = ? AND recipient = 'sx-one' AND to_state = 'read'`)
      .all(message_id) as Array<{ detail: string | null }>;
    expect(del?.state).toBe('read');
    expect(reads.map((x) => x.detail)).toEqual(['delivered via claude-channel']);
  });

  it('await times out with status open; only the addressee may respond; wait is capped by max_await_s', async () => {
    const a = await join('alpha-one');
    await join('beta-one');
    const c = await join('gamma-one');
    const { request_id } = await a.client.call<{ request_id: string }>('req.request', {
      to: 'beta-one',
      subject: 's',
      body: 'b',
    });
    expect(await a.client.call('req.await', { request_id, wait_s: 0 })).toEqual({ status: 'open', response: null });
    await expect(c.client.call('req.respond', { request_id, body: 'x', status: 'ok' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('expiry notifies the requester and blocks late responses', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const { request_id } = await a.client.call<{ request_id: string }>('req.request', {
      to: 'beta-one',
      subject: 'quick',
      body: 'b',
      expires_in_s: 1,
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(broker.engine?.takeDigest('alpha-one')).toMatch(/request expired/);
    await expect(b.client.call('req.respond', { request_id, body: 'late', status: 'ok' })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await a.client.call('req.list', { status: 'expired' })).toMatchObject({
      requests: [{ request_id, status: 'expired' }],
    });
  });

  it('timed-out awaits leave no waiters behind; a later respond still works', async () => {
    const a = await join('alpha-one');
    const b = await join('beta-one');
    const { request_id } = await a.client.call<{ request_id: string }>('req.request', {
      to: 'beta-one',
      subject: 's',
      body: 'b',
    });
    broker.config.limits.max_await_s = 1;
    const t0 = Date.now();
    const rs = await Promise.all(
      [1, 2, 3].map(() => a.client.call<{ status: string }>('req.await', { request_id, wait_s: 30 })),
    );
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(rs.map((r) => r.status)).toEqual(['open', 'open', 'open']);
    expect(pendingAwaitCount()).toBe(0);
    await b.client.call('req.respond', { request_id, body: 'ok', status: 'ok' });
  });

  it('req.list is scoped to participants for sessions and unscoped for the owner', async () => {
    const a = await join('alpha-one');
    await join('beta-one');
    const c = await join('gamma-one');
    const { request_id } = await a.client.call<{ request_id: string }>('req.request', {
      to: 'beta-one',
      subject: 's',
      body: 'b',
    });
    const mine = await a.client.call<{ requests: Array<{ request_id: string }> }>('req.list', {});
    expect(mine.requests.map((r) => r.request_id)).toEqual([request_id]);
    expect((await c.client.call<{ requests: unknown[] }>('req.list', {})).requests).toEqual([]);
    const { Client } = await import('../../src/client/client.js');
    const { sockPath } = await import('../../src/client/autospawn.js');
    const { loadConfig } = await import('../../src/config.js');
    const { frameLimit } = await import('../../src/protocol/frame.js');
    const { client: o } = await Client.connect(
      sockPath(home),
      { protocol: 1, role: 'owner' },
      frameLimit(loadConfig(home)),
    );
    closers.push(() => o.close());
    const all = await o.call<{ requests: Array<{ request_id: string }> }>('req.list', {});
    expect(all.requests.map((r) => r.request_id)).toEqual([request_id]);
    const shown = await o.call<{ kind: string }>('owner.show', { id: request_id });
    expect(shown.kind).toBe('request');
  });

  it('a request that expired while the broker was down gets exactly one notice, across restarts', async () => {
    const a = await join('alpha-one');
    await join('beta-one');
    const { request_id } = await a.client.call<{ request_id: string }>('req.request', {
      to: 'beta-one',
      subject: 'down',
      body: 'b',
      expires_in_s: 1,
    });
    for (const c of closers.splice(0)) await c();
    await broker.stop();
    await new Promise((r) => setTimeout(r, 1200));
    const count = () =>
      (
        broker.db
          .prepare(`SELECT count(*) AS n FROM messages WHERE kind='notice' AND subject = ?`)
          .get(`request expired: ${request_id}`) as {
          n: number;
        }
      ).n;
    broker = await startBroker(home);
    await until(() => count() === 1);
    await broker.stop();
    broker = await startBroker(home);
    await new Promise((r) => setTimeout(r, 300));
    expect(count()).toBe(1);
  });
});

describe('scheduleChunked', () => {
  it('waits in bounded chunks and fires only when actually due', () => {
    const calls: number[] = [];
    let cb: (() => void) | undefined;
    const set = ((f: () => void, ms: number) => {
      calls.push(ms);
      cb = f;
      return calls.length as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    let remaining = 5_000_000_000;
    let fired = 0;
    scheduleChunked(
      remaining,
      () => fired++,
      () => remaining,
      { set, clear: (() => {}) as typeof clearTimeout },
    );
    expect(calls).toEqual([2_147_483_647]);
    remaining -= 2_147_483_647;
    cb?.();
    expect(calls).toEqual([2_147_483_647, 2_147_483_647]);
    expect(fired).toBe(0);
    remaining -= 2_147_483_647;
    cb?.();
    expect(calls[2]).toBe(705_032_706);
    expect(fired).toBe(0);
    remaining = 0;
    cb?.();
    expect(fired).toBe(1);
  });
});
