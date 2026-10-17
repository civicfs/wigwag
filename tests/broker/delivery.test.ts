import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { deliveriesOfMessage, insertMessage, transition } from '../../src/store/messages.js';
import { activeThrottles } from '../../src/store/subs.js';
import { CODEX_ARG_BUDGET_BYTES } from '../../src/transports/codex-queue.js';
import type { Transport } from '../../src/transports/types.js';
import { mcpClient, readCodexCalls, startBroker, startTestBroker, until } from '../helpers.js';

let home: string;
let broker: Broker;
let codexLog: string;
const closers: Array<() => unknown> = [];
beforeEach(async () => {
  ({ home, broker } = await startTestBroker());
  codexLog = join(home, 'codex.jsonl');
  process.env.FAKE_CODEX_LOG = codexLog;
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  await broker.stop().catch(() => {});
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.FAKE_CODEX_SLEEP_MS;
});

const send = async (from: string, to: string, priority: 'urgent' | 'normal' | 'low', body = 'hi') => {
  const m = insertMessage(
    broker.db,
    {
      from_name: from,
      to_target: to,
      kind: 'message',
      priority,
      subject: 's',
      body,
      attachments: [],
      reply_to: null,
      request_id: null,
      expires_at: null,
      stream: null,
    },
    [to],
  );
  await broker.engine?.dispatchMessage(m.id);
  return m;
};
const state = (id: string, to: string) => deliveriesOfMessage(broker.db, id).find((d) => d.recipient === to);

describe('delivery engine', () => {
  it('pushes normal to an idle Claude session over the channel', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const m = await send('codex-merger', 'claude-main', 'normal', 'body text');
    await until(() => a.pushes.length === 1);
    expect(a.pushes[0].content).toContain('body text');
    expect(state(m.id, 'claude-main')?.state).toBe('read');
  });

  it('holds low, then hands it over as a digest at the next turn boundary', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const m = await send('codex-merger', 'claude-main', 'low', 'fyi');
    expect(state(m.id, 'claude-main')).toMatchObject({ state: 'held', hold_reason: 'low' });
    expect(a.pushes).toHaveLength(0);
    const text = broker.engine?.takeDigest('claude-main');
    expect(text).toContain('fyi');
    expect(state(m.id, 'claude-main')).toMatchObject({ state: 'read', transport: 'hook' });
    expect(broker.engine?.takeDigest('claude-main')).toBeNull();
  });

  it('pushes to Codex via codex queue once bound; holds as unbound before that', async () => {
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    const m = await send('claude-main', 'codex-merger', 'normal', 'to codex');
    expect(state(m.id, 'codex-merger')).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    await until(() => readCodexCalls(codexLog).length === 1);
    expect(readCodexCalls(codexLog)[0].argv.slice(0, 3)).toEqual(['queue', '--thread', 'thread-9']);
    await until(() => state(m.id, 'codex-merger')?.state === 'read');
  });

  it('a wake push to Codex carries its held low items along', async () => {
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const low = await send('claude-main', 'codex-merger', 'low', 'fyi-low');
    expect(readCodexCalls(codexLog)).toHaveLength(0);
    await send('claude-main', 'codex-merger', 'normal', 'wake-up');
    await until(() => readCodexCalls(codexLog).length === 1);
    const text = readCodexCalls(codexLog)[0].argv[4];
    expect(text).toContain('wake-up');
    expect(text).toContain('fyi-low');
    await until(() => state(low.id, 'codex-merger')?.state === 'read');
  });

  it('delivers an offline backlog as ONE push when the name comes back (review focus 3)', async () => {
    await send('codex-merger', 'reviewer', 'normal', 'one');
    await send('codex-merger', 'reviewer', 'urgent', 'two');
    await send('codex-merger', 'reviewer', 'low', 'three');
    const r = await mcpClient(home, { requested_name: 'reviewer' });
    closers.push(() => r.client.close());
    await until(() => r.pushes.length === 1);
    expect(r.pushes[0].meta).toEqual({ digest: 'true', count: '2' });
    expect(r.pushes[0].content).toContain('one');
    expect(r.pushes[0].content).toContain('two');
    expect(r.pushes[0].content).not.toContain('three');
  });

  it('retries a failing codex queue with backoff, then marks stuck and notifies the sender (review focus 4)', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const sender = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => sender.client.close());
    const m = await send('claude-main', 'codex-merger', 'normal');
    await until(() => state(m.id, 'codex-merger')?.state === 'stuck');
    expect(state(m.id, 'codex-merger')?.attempts).toBe(broker.config.retry.max_attempts);
    expect(state(m.id, 'codex-merger')?.last_error).toMatch(/exit code 3; stderr omitted/);
    expect(broker.engine?.takeDigest('claude-main')).toMatch(/stuck/);
  });

  it('never puts message text from the codex argv into errors, events or the stuck notice (final I-1)', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const sender = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => sender.client.close());
    await send('owner', 'codex-merger', 'low', 'owner SECRET ride-along');
    const m = await send('claude-main', 'codex-merger', 'normal', 'wake body WAKEBODY');
    await until(() => state(m.id, 'codex-merger')?.state === 'stuck');
    const lastError = state(m.id, 'codex-merger')?.last_error ?? '';
    expect(lastError).toMatch(/exit code 3; stderr omitted/);
    expect(lastError).not.toMatch(/SECRET|WAKEBODY|--message/);
    const details = (
      broker.db
        .prepare('SELECT detail FROM delivery_events WHERE message_id = ? AND detail IS NOT NULL')
        .all(m.id) as Array<{ detail: string }>
    ).map((r) => r.detail);
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) expect(d).not.toMatch(/SECRET|WAKEBODY|--message/);
    const notice = broker.engine?.takeDigest('claude-main') ?? '';
    expect(notice).toMatch(/stuck/);
    expect(notice).not.toMatch(/SECRET|WAKEBODY/);
  });

  it('msg.send and kv.cas return once committed; slow codex pushes finish later (final I-7)', async () => {
    process.env.FAKE_CODEX_SLEEP_MS = '3000';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    await c.client.call('kv.watch', { prefix: 'lane/', priority: 'normal' });
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const t0 = Date.now();
    const { id } = await a.client.call<{ id: string }>('msg.send', {
      to: 'codex-merger',
      subject: 's',
      body: 'slow',
      priority: 'normal',
      attachments: [],
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    const t1 = Date.now();
    await a.client.call('kv.cas', { key: 'lane/x', expected_version: null, value: 1 });
    expect(Date.now() - t1).toBeLessThan(1500);
    await until(() => state(id, 'codex-merger')?.state === 'read');
    await until(() => readCodexCalls(codexLog).length >= 2);
  });

  it('an item over the codex argv budget goes stuck on the first attempt, wake or ride-along (final I-11)', async () => {
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const huge = 'x'.repeat(CODEX_ARG_BUDGET_BYTES + 1);
    const big = await send('claude-main', 'codex-merger', 'normal', huge);
    await until(() => state(big.id, 'codex-merger')?.state === 'stuck');
    expect(state(big.id, 'codex-merger')?.attempts).toBe(1);
    expect(state(big.id, 'codex-merger')?.last_error).toMatch(/argv budget/);
    expect(broker.engine?.takeDigest('claude-main')).toMatch(/stuck/);
    // An oversized held low item must not break every later wake push it would ride along with.
    const bigLow = await send('claude-main', 'codex-merger', 'low', huge);
    const wake = await send('claude-main', 'codex-merger', 'normal', 'small wake');
    await until(() => state(wake.id, 'codex-merger')?.state === 'read');
    expect(state(bigLow.id, 'codex-merger')).toMatchObject({ state: 'stuck', attempts: 1 });
    expect(readCodexCalls(codexLog)).toHaveLength(1);
  });

  it('throttles a chatty pair after rate.wake_pushes and releases on demand', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const max = broker.config.rate.wake_pushes;
    for (let i = 0; i < max; i++) await send('chatty-bot', 'claude-main', 'normal', `n${i}`);
    const over = await send('chatty-bot', 'claude-main', 'normal', 'over');
    expect(state(over.id, 'claude-main')).toMatchObject({ state: 'held', hold_reason: 'throttled' });
    await broker.engine?.release('chatty-bot', 'claude-main');
    await until(() => state(over.id, 'claude-main')?.state === 'read');
  });

  it('re-dispatches undelivered messages after a broker restart (review focus 1)', async () => {
    const m = await send('codex-merger', 'later-one', 'normal', 'survives');
    await broker.stop();
    broker = await startBroker(home);
    const r = await mcpClient(home, { requested_name: 'later-one' });
    closers.push(() => r.client.close());
    await until(() => r.pushes.length === 1);
    expect(r.pushes[0].content).toContain('survives');
    expect(state(m.id, 'later-one')?.state).toBe('read');
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a graceful stop waits for an in-flight codex push, so it is not pushed again after restart (final I-10)', async () => {
    process.env.FAKE_CODEX_SLEEP_MS = '1500';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    const m = await a.client.call<{ id: string }>('msg.send', {
      to: 'codex-merger',
      subject: 's',
      body: 'mid-stop',
      priority: 'normal',
      attachments: [],
    });
    await sleep(300); // the codex queue call is running
    expect(readCodexCalls(codexLog)).toHaveLength(0);
    await broker.stop();
    delete process.env.FAKE_CODEX_SLEEP_MS;
    broker = await startBroker(home);
    expect(state(m.id, 'codex-merger')?.state).toBe('read');
    const again = await mcpClient(home, {
      agent: 'codex',
      requested_name: 'codex-merger',
      resume_session_id: c.welcome.session_id,
    });
    closers.push(() => again.client.close());
    await again.client.call('session.bind', { agent_session_id: 'thread-9' });
    await sleep(500);
    expect(readCodexCalls(codexLog)).toHaveLength(1);
  });
  const throttle = async (from: string, to: string) => {
    const max = broker.config.rate.wake_pushes;
    for (let i = 0; i < max; i++) await send(from, to, 'normal', `${from}-ok${i}`);
    return send(from, to, 'normal', `${from}-over`);
  };

  it('does not push a held low item twice when two wake pushes run concurrently (I-1)', async () => {
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const low = await send('claude-main', 'codex-merger', 'low', 'fyi-once');
    await Promise.all([
      send('claude-main', 'codex-merger', 'normal', 'wake-1'),
      send('other-bot', 'codex-merger', 'normal', 'wake-2'),
    ]);
    await until(() => readCodexCalls(codexLog).length === 2);
    await until(() => state(low.id, 'codex-merger')?.state === 'read');
    const withLow = readCodexCalls(codexLog).filter((c2) => c2.argv[4]?.includes('fyi-once'));
    expect(withLow).toHaveLength(1);
  });

  it('does not run a retry timer for a delivery that was read meanwhile (I-3)', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const m = await send('claude-main', 'codex-merger', 'normal');
    await until(() => state(m.id, 'codex-merger')?.state === 'failed');
    transition(broker.db, m.id, 'codex-merger', 'read');
    delete process.env.FAKE_CODEX_MODE;
    await sleep(500);
    expect(readCodexCalls(codexLog)).toHaveLength(0);
    expect(state(m.id, 'codex-merger')?.state).toBe('read');
  });

  it('a failing codex wake neither moves nor counts against its ride-along items (I-4)', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const low = await send('claude-main', 'codex-merger', 'low', 'fyi-low');
    const wake = await send('claude-main', 'codex-merger', 'normal', 'wake');
    await until(() => (state(wake.id, 'codex-merger')?.attempts ?? 0) >= 2);
    expect(state(low.id, 'codex-merger')).toMatchObject({ state: 'held', hold_reason: 'low', attempts: 0 });
  });

  it('release pushes the whole throttled backlog as one push and does not throttle again (I-5)', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const max = broker.config.rate.wake_pushes;
    for (let i = 0; i < max; i++) await send('chatty-bot', 'claude-main', 'normal', `ok${i}`);
    await until(() => a.pushes.length === max);
    const over = [];
    for (let i = 0; i < max + 3; i++) over.push(await send('chatty-bot', 'claude-main', 'normal', `over${i}`));
    expect(a.pushes).toHaveLength(max);
    await broker.engine?.release('chatty-bot', 'claude-main');
    await until(() => a.pushes.length === max + 1);
    await sleep(100);
    expect(a.pushes).toHaveLength(max + 1);
    for (let i = 0; i < over.length; i++) expect(a.pushes[max].content).toContain(`over${i}`);
    expect(over.every((m) => state(m.id, 'claude-main')?.state === 'read')).toBe(true);
    expect(activeThrottles(broker.db)).toHaveLength(0);
  });

  it('release leaves other pairs throttled items alone (M-5a)', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const one = await throttle('chatty-bot', 'claude-main');
    const two = await throttle('noisy-bot', 'claude-main');
    await broker.engine?.release('chatty-bot', 'claude-main');
    await until(() => state(one.id, 'claude-main')?.state === 'read');
    expect(state(two.id, 'claude-main')).toMatchObject({ state: 'held', hold_reason: 'throttled' });
  });

  it('stop() clears retry timers: no codex call after stop (M-5c)', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const m = await send('claude-main', 'codex-merger', 'normal');
    await until(() => state(m.id, 'codex-merger')?.state === 'failed');
    broker.engine?.stop();
    delete process.env.FAKE_CODEX_MODE;
    await sleep(500);
    expect(readCodexCalls(codexLog)).toHaveLength(0);
    expect(state(m.id, 'codex-merger')?.state).toBe('failed');
  });

  it('sends no stuck notice when the sender is owner or wigwag (M-5d)', async () => {
    process.env.FAKE_CODEX_MODE = 'fail';
    const c = await mcpClient(home, { agent: 'codex', requested_name: 'codex-merger' });
    closers.push(() => c.client.close());
    await c.client.call('session.bind', { agent_session_id: 'thread-9' });
    const a = await send('owner', 'codex-merger', 'normal', 'from owner');
    const b = await send('wigwag', 'codex-merger', 'normal', 'from wigwag');
    await until(
      () => state(a.id, 'codex-merger')?.state === 'stuck' && state(b.id, 'codex-merger')?.state === 'stuck',
      15000,
    );
    const n = broker.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'notice'").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('takeDigest leaves out throttled items (M-5f)', async () => {
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const over = await throttle('chatty-bot', 'claude-main');
    await send('quiet-bot', 'claude-main', 'low', 'fyi-low');
    const text = broker.engine?.takeDigest('claude-main');
    expect(text).toContain('fyi-low');
    expect(text).not.toContain('chatty-bot-over');
    expect(state(over.id, 'claude-main')).toMatchObject({ state: 'held', hold_reason: 'throttled' });
  });

  it('a Claude channel failure is an offline hold, not a retry (M-6)', async () => {
    await broker.stop();
    const failing: Transport = {
      kind: 'claude-channel',
      push: async () => {
        throw new Error('no channel');
      },
    };
    broker = await startBroker(home, { transports: { claude: failing, codex: { ...failing, kind: 'codex-queue' } } });
    const a = await mcpClient(home, { requested_name: 'claude-main' });
    closers.push(() => a.client.close());
    const m = await send('codex-merger', 'claude-main', 'normal');
    expect(state(m.id, 'claude-main')).toMatchObject({ state: 'held', hold_reason: 'offline', attempts: 0 });
  });
});
