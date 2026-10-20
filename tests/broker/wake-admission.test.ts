import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryEngine } from '../../src/broker/delivery.js';
import { Broker } from '../../src/broker/server.js';
import { loadConfig } from '../../src/config.js';
import { WigwagError } from '../../src/errors.js';
import { deliveriesOfMessage, insertMessage } from '../../src/store/messages.js';
import { bindAgentSession, claimName, createSession, getSession } from '../../src/store/sessions.js';
import { activeThrottles } from '../../src/store/subs.js';
import { tmpHome } from '../helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function fixture(agent: 'claude' | 'codex' = 'codex') {
  const home = tmpHome();
  const broker = new Broker(home, loadConfig(home));
  await broker.start();
  const pushes: string[][] = [];
  let metadataFailure = false;
  let relayFailure = false;
  let channel = true;
  let transportFailure = false;
  const engine = new DeliveryEngine({
    db: broker.db,
    config: broker.config,
    log: () => {},
    emitFeed: () => {},
    codexPushTrust: async () => (metadataFailure ? 'app-server-unavailable' : null),
    codexQuestionPush: async () => {
      if (relayFailure) throw new WigwagError('transport', 'fixture relay unavailable');
      return () => {};
    },
    transports: {
      claude: {
        kind: 'claude-channel',
        hasChannel: () => channel,
        async push(_session, items) {
          pushes.push(items.map((x) => x.msg.id));
          if (transportFailure) throw new Error('fixture transport failure');
        },
      },
      codex: {
        kind: 'codex-queue',
        async push(_session, items) {
          pushes.push(items.map((x) => x.msg.id));
          if (transportFailure) throw new Error('fixture transport failure');
        },
      },
    },
  });
  broker.engine = engine;
  broker.onStop.push(() => engine.stop());
  cleanup.push(() => broker.stop());
  const target = createSession(broker.db, {
    agent,
    cwd: '/test',
    workspace: '/test',
    pid_chain: [],
    mcp_ppid: null,
  });
  claimName(broker.db, target.id, 'target-one');
  bindAgentSession(broker.db, target.id, 'T');
  const send = async () => {
    const message = insertMessage(
      broker.db,
      {
        from_name: 'sender-one',
        from_workspace: '/test',
        to_target: 'target-one',
        kind: 'message',
        priority: 'normal',
        subject: 'wake',
        body: 'body',
        attachments: [],
        reply_to: null,
        request_id: null,
        expires_at: null,
        stream: null,
      },
      ['target-one'],
    );
    await engine.dispatchMessage(message.id);
    return message.id;
  };
  return {
    broker,
    engine,
    pushes,
    send,
    target: () => getSession(broker.db, target.id) ?? target,
    failMetadata: (value: boolean) => {
      metadataFailure = value;
    },
    failRelay: (value: boolean) => {
      relayFailure = value;
    },
    channel: (value: boolean) => {
      channel = value;
    },
    failTransport: (value: boolean) => {
      transportFailure = value;
    },
    delivery: (id: string) => deliveriesOfMessage(broker.db, id)[0],
  };
}

describe('wake quota at transport admission', () => {
  it.each(['metadata', 'relay'] as const)(
    'does not spend quota on %s preflight holds, then delivers the recovered backlog',
    async (failure) => {
      const f = await fixture();
      const fail = failure === 'metadata' ? f.failMetadata : f.failRelay;
      fail(true);
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push(await f.send());
      expect(f.pushes).toHaveLength(0);
      expect(activeThrottles(f.broker.db)).toHaveLength(0);
      expect(ids.map((id) => f.delivery(id)?.hold_reason)).toEqual(Array(7).fill('codex-untrusted'));
      fail(false);
      await f.engine.onAvailable(f.target());
      expect(f.pushes).toEqual([ids]);
      expect(ids.every((id) => f.delivery(id)?.state === 'read')).toBe(true);
    },
  );

  it('counts a recovered backlog as one wake admission and still throttles real repeated pushes', async () => {
    const f = await fixture();
    f.failMetadata(true);
    await f.send();
    f.failMetadata(false);
    await f.engine.onAvailable(f.target());
    for (let i = 0; i < 5; i++) await f.send();
    const over = await f.send();
    expect(f.pushes).toHaveLength(6);
    expect(f.delivery(over)).toMatchObject({ state: 'held', hold_reason: 'throttled' });
  });

  it('does not spend Codex-to-Claude quota while the Claude channel is unavailable', async () => {
    const f = await fixture('claude');
    f.channel(false);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await f.send());
    expect(f.pushes).toHaveLength(0);
    expect(activeThrottles(f.broker.db)).toHaveLength(0);
    f.channel(true);
    await f.engine.onAvailable(f.target());
    expect(f.pushes).toEqual([ids]);
    for (let i = 0; i < 5; i++) await f.send();
    const over = await f.send();
    expect(f.pushes).toHaveLength(6);
    expect(f.delivery(over)).toMatchObject({ state: 'held', hold_reason: 'throttled' });
  });

  it('retains a retry charge through an intervening metadata hold', async () => {
    const f = await fixture();
    f.broker.config.retry.base_ms = 60000;
    f.failTransport(true);
    const retry = await f.send();
    expect(f.delivery(retry)).toMatchObject({ state: 'failed', attempts: 1 });
    f.failTransport(false);
    f.failMetadata(true);
    await f.engine.dispatch(retry, 'target-one');
    expect(f.delivery(retry)).toMatchObject({ state: 'held', hold_reason: 'codex-untrusted', attempts: 1 });
    f.failMetadata(false);
    await f.engine.onAvailable(f.target());
    for (let i = 0; i < 5; i++) expect(f.delivery(await f.send()).state).toBe('read');
    expect(f.pushes).toHaveLength(7); // original attempt, its retry, and five newly admitted pushes
    expect(f.delivery(await f.send())).toMatchObject({ state: 'held', hold_reason: 'throttled' });
  });

  it('admits an already charged retry when a new wake in its recovered batch exceeds quota', async () => {
    const f = await fixture();
    f.broker.config.retry.base_ms = 60000;
    f.failTransport(true);
    const retry = await f.send();
    f.failTransport(false);
    for (let i = 0; i < 5; i++) await f.send();
    f.failMetadata(true);
    await f.engine.dispatch(retry, 'target-one');
    const fresh = await f.send();
    f.failMetadata(false);
    await f.engine.onAvailable(f.target());
    expect(f.delivery(retry).state).toBe('read');
    expect(f.delivery(fresh)).toMatchObject({ state: 'held', hold_reason: 'throttled' });
    expect(f.pushes).toHaveLength(7);
  });
});
