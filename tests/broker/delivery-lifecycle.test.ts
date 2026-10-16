import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DeliveryEngine } from '../../src/broker/delivery.js';
import { sendMessage } from '../../src/broker/handlers/messages.js';
import { Broker } from '../../src/broker/server.js';
import { loadConfig } from '../../src/config.js';
import { deliveriesOfMessage, insertMessage, transition } from '../../src/store/messages.js';
import { bindAgentSession, claimName, createSession } from '../../src/store/sessions.js';
import { CODEX_ARG_BUDGET_BYTES, CodexQueueTransport } from '../../src/transports/codex-queue.js';
import type { Transport } from '../../src/transports/types.js';
import { FAKE_CODEX, readCodexCalls, tmpHome, until } from '../helpers.js';

afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_SLEEP_MS;
});

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

function setup(codex: Transport) {
  const home = tmpHome();
  const broker = new Broker(home, loadConfig(home));
  const logs: string[] = [];
  const engine = new DeliveryEngine({
    db: broker.db,
    config: broker.config,
    transports: { claude: { kind: 'claude-channel', push: async () => {} }, codex },
    emitFeed: () => {},
    log: (line) => logs.push(line),
  });
  broker.engine = engine;
  broker.onStop.push(() => engine.stop());
  for (const name of ['codex-one', 'codex-two']) {
    const session = createSession(broker.db, {
      agent: 'codex',
      cwd: '/test',
      workspace: '/test',
      pid_chain: [],
      mcp_ppid: null,
    });
    claimName(broker.db, session.id, name);
    bindAgentSession(broker.db, session.id, name);
  }
  const send = (body: string, to = 'codex-one') =>
    sendMessage(broker, {
      from: 'owner',
      to,
      kind: 'message',
      priority: 'normal',
      subject: 's',
      body,
      attachments: [],
    });
  return { broker, engine, logs, send };
}

it('preserves sequential accepted-send order for one recipient while other recipients progress (final Codex I-7)', async () => {
  const first = gate();
  const started: string[] = [];
  const { broker, engine, send } = setup({
    kind: 'codex-queue',
    push: async (_session, items) => {
      const body = items[0].msg.body;
      started.push(body);
      if (body === 'first') await first.promise;
    },
  });
  try {
    await send('first'); // accepted, transport is still waiting
    await send('second');
    await send('independent', 'codex-two');
    expect(started).toEqual(['first', 'independent']);
    first.release();
    await engine.drain(5000);
    expect(started).toEqual(['first', 'independent', 'second']);
  } finally {
    first.release();
    await broker.stop();
  }
});

it('does not record a late transport completion after drain expires and the db closes (final Codex I-10)', async () => {
  const pending = gate();
  const { broker, engine, logs, send } = setup({ kind: 'codex-queue', push: async () => pending.promise });
  broker.config.codex.queue_timeout_ms = 10;
  try {
    const message = await send('late');
    const dispatch = engine.dispatchMessage(message.id);
    engine.stop();
    await engine.drain(10);
    expect(deliveriesOfMessage(broker.db, message.id)[0].state).toBe('pending');
    await broker.stop();
    pending.release();
    await dispatch;
    await Promise.resolve();
    await Promise.resolve();
    expect(logs.join('\n')).not.toMatch(/marking .* pushed failed|failure handling/);
  } finally {
    pending.release();
    await broker.stop();
  }
});

it('a bounded drain cancels active and later chunks, keeping already queued chunks pushed (final Codex I-10)', async () => {
  const { broker, engine, logs } = setup(new CodexQueueTransport(FAKE_CODEX, 5000, async () => null));
  broker.config.codex.queue_timeout_ms = 100;
  const log = join(broker.home, 'calls.jsonl');
  process.env.FAKE_CODEX_LOG = log;
  process.env.FAKE_CODEX_SLEEP_MS = '500';
  const messages = Array.from({ length: 3 }, () =>
    insertMessage(
      broker.db,
      {
        from_name: 'owner',
        to_target: 'codex-one',
        kind: 'message',
        priority: 'normal',
        subject: 's',
        body: 'x'.repeat(CODEX_ARG_BUDGET_BYTES / 2),
        attachments: [],
        reply_to: null,
        request_id: null,
        expires_at: null,
        stream: null,
      },
      ['codex-one'],
    ),
  );
  for (const message of messages) transition(broker.db, message.id, 'codex-one', 'held', { hold_reason: 'offline' });
  const session = createSession(broker.db, {
    agent: 'codex',
    cwd: '/test',
    workspace: '/test',
    pid_chain: [],
    mcp_ppid: null,
  });
  // A single backlog push requires three codex argv chunks.
  const pushing = engine.onAvailable({ ...session, name: 'codex-one' });
  try {
    await until(() => readCodexCalls(log).length === 1);
    engine.stop();
    await engine.drain(100);
    expect(deliveriesOfMessage(broker.db, messages[0].id)[0].state).toBe('read');
    await broker.stop();
    await pushing;
    expect(readCodexCalls(log)).toHaveLength(1);
    expect(logs.join('\n')).not.toMatch(/marking .* pushed failed|failure handling/);
  } finally {
    engine.stop();
    await pushing;
    await broker.stop();
  }
});
