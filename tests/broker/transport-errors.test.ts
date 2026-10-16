import { afterEach, expect, it } from 'vitest';
import { DeliveryEngine } from '../../src/broker/delivery.js';
import { Broker } from '../../src/broker/server.js';
import { loadConfig } from '../../src/config.js';
import { deliveriesOfMessage, insertMessage } from '../../src/store/messages.js';
import { bindAgentSession, claimName, createSession } from '../../src/store/sessions.js';
import { CodexQueueTransport } from '../../src/transports/codex-queue.js';
import { FAKE_CODEX, tmpHome } from '../helpers.js';

afterEach(() => {
  delete process.env.FAKE_CODEX_MODE;
});

it('keeps stderr echoes out of stored errors, audit events, notices and owner delivery feed (final Codex I-1)', async () => {
  const home = tmpHome();
  const config = loadConfig(home);
  config.retry.max_attempts = 1;
  const broker = new Broker(home, config); // real store and engine; no socket needed
  const ownerFeed: unknown[] = [];
  const engine = new DeliveryEngine({
    db: broker.db,
    config,
    transports: {
      claude: { kind: 'claude-channel', push: async () => {} },
      codex: new CodexQueueTransport(FAKE_CODEX, 5000, async () => null),
    },
    emitFeed: (_type, payload) => ownerFeed.push(payload),
    log: () => {},
  });
  try {
    const receiver = createSession(broker.db, {
      agent: 'codex',
      cwd: '/test',
      workspace: '/test',
      pid_chain: [],
      mcp_ppid: null,
    });
    claimName(broker.db, receiver.id, 'codex-one');
    bindAgentSession(broker.db, receiver.id, 'thread-1');
    const insert = (from: string, priority: 'normal' | 'low', body: string) =>
      insertMessage(
        broker.db,
        {
          from_name: from,
          to_target: 'codex-one',
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
        ['codex-one'],
      );
    const low = insert('owner', 'low', 'OWNER_SECRET\nsecond secret line');
    await engine.dispatchMessage(low.id);
    process.env.FAKE_CODEX_MODE = 'fail-echo';
    const wake = insert('peer-one', 'normal', 'WAKE_SECRET');
    await engine.dispatchMessage(wake.id);
    const [delivery] = deliveriesOfMessage(broker.db, wake.id);
    expect(delivery.state).toBe('stuck');
    expect(delivery.last_error).toMatch(/exit code 3/);
    const events = broker.db.prepare('SELECT detail FROM delivery_events WHERE message_id = ?').all(wake.id);
    const notice = engine.takeDigest('peer-one');
    expect(notice).toContain('stuck');
    for (const value of [delivery.last_error, JSON.stringify(events), notice, JSON.stringify(ownerFeed)]) {
      expect(value).not.toMatch(/OWNER_SECRET|WAKE_SECRET|second secret line|rejected input/);
    }
  } finally {
    engine.stop();
    await engine.drain(5000);
    await broker.stop();
  }
});
