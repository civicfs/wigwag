import { afterEach, expect, it } from 'vitest';
import { DeliveryEngine } from '../../src/broker/delivery.js';
import { Broker } from '../../src/broker/server.js';
import { loadConfig } from '../../src/config.js';
import { deliveriesFor, deliveriesOfMessage, insertMessage } from '../../src/store/messages.js';
import { bindAgentSession, claimName, createSession, getSession, setState } from '../../src/store/sessions.js';
import { addMute, removeMute } from '../../src/store/subs.js';
import { tmpHome } from '../helpers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

it.each(['claude', 'codex'] as const)(
  'keeps an offline %s recipient when another session reclaims its name, then delivers after rename',
  async (agent) => {
    const home = tmpHome();
    const broker = new Broker(home, loadConfig(home));
    await broker.start();
    const pushed: string[] = [];
    const transport = {
      kind: agent === 'claude' ? ('claude-channel' as const) : ('codex-queue' as const),
      async push(session: { id: string }) {
        pushed.push(session.id);
      },
    };
    const engine = new DeliveryEngine({
      db: broker.db,
      config: broker.config,
      transports: { claude: transport, codex: transport },
      emitFeed: () => {},
      log: () => {},
    });
    broker.engine = engine;
    broker.onStop.push(() => engine.stop());
    cleanup.push(() => broker.stop());
    const make = (native: string) => {
      const s = createSession(broker.db, { agent, cwd: '/test', workspace: '/test', pid_chain: [], mcp_ppid: null });
      bindAgentSession(broker.db, s.id, native);
      return s;
    };
    const original = make('original');
    claimName(broker.db, original.id, 'worker-one');
    setState(broker.db, original.id, 'offline');
    const message = insertMessage(
      broker.db,
      {
        from_name: 'owner',
        to_target: 'worker-one',
        kind: 'message',
        priority: 'normal',
        subject: 'private work',
        body: 'belongs to original',
        attachments: [],
        reply_to: null,
        request_id: null,
        expires_at: null,
        stream: null,
      },
      ['worker-one'],
    );
    await engine.dispatchMessage(message.id);
    const replacement = make('replacement');
    claimName(broker.db, replacement.id, 'worker-one');
    engine.nameClaimed(replacement.id, 'worker-one');
    await engine.dispatch(message.id, 'worker-one');
    expect(pushed).toEqual([]);
    expect(deliveriesFor(broker.db, 'worker-one', ['pending', 'held', 'read'])).toEqual([]);
    expect(deliveriesOfMessage(broker.db, message.id)[0]).toMatchObject({
      recipient_session_id: original.id,
      state: 'held',
      hold_reason: 'offline',
    });
    claimName(broker.db, original.id, 'worker-two');
    setState(broker.db, original.id, 'online-idle');
    engine.nameClaimed(original.id, 'worker-two');
    const renamed = getSession(broker.db, original.id);
    if (!renamed) throw new Error('original session vanished');
    addMute(broker.db, 'worker-two', 'sender:owner');
    await engine.onAvailable(renamed);
    expect(pushed).toEqual([]);
    expect(deliveriesOfMessage(broker.db, message.id)[0]).toMatchObject({ state: 'held', hold_reason: 'muted' });
    removeMute(broker.db, 'worker-two', 'sender:owner');
    await engine.dispatch(message.id, 'worker-one');
    expect(pushed).toEqual([original.id]);
    expect(deliveriesOfMessage(broker.db, message.id)[0].state).toBe('read');
  },
);
