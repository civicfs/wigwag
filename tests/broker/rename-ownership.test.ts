import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { deliveriesOfMessage, getMessage } from '../../src/store/messages.js';
import { recoverySlot } from '../../src/store/recovery.js';
import { mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function scenario(fail = true, earlyPushed = false, attachment = false) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const home = tmpHome();
  const file = join(home, 'private-attachment.txt');
  if (attachment) writeFileSync(file, 'A private attachment');
  const broker = await startBroker(home, {
    transports: {
      claude: {
        kind: 'claude-channel',
        async push(_session, items, options) {
          started = true;
          if (earlyPushed) options?.onPushed?.(items);
          await gate;
          if (fail) throw new Error('fixture push failed');
        },
      },
      codex: { kind: 'codex-queue', async push() {} },
    },
  });
  cleanup.push(
    () => broker.stop(),
    () => release(),
  );
  const a = await mcpClient(home, { requested_name: 'alpha' });
  cleanup.push(() => a.client.destroy());
  const o = await ownerClient(home);
  cleanup.push(() => o.destroy());
  const send = (to: string, body: string, priority = 'low', attach_paths: string[] = []) =>
    o.call<{ id: string }>('owner.send', { to, body, priority, subject: body, attach_paths });
  const original = await send('alpha', 'A private mail', 'urgent', attachment ? [file] : []);
  await until(() => started);
  await a.client.call('session.register', { name: 'beta' });
  const b = await mcpClient(home, { requested_name: 'alpha', mcp_ppid: 3 });
  cleanup.push(() => b.client.destroy());
  const own = await send('alpha', 'B own mail');
  return { home, broker, a, b, o, send, original, own, release };
}

it.each([false, true])(
  'keeps exact ownership when the source is reclaimed and the push settles (failure: %s)',
  async (fail) => {
    const { broker, a, b, original, own, release } = await scenario(fail);
    await expect(b.client.call('msg.read', { msg_id: original.id })).rejects.toMatchObject({ code: 'not_found' });
    expect(await b.client.call('msg.ack', { ids: [original.id] })).toEqual({ acked: 0 });
    expect(await b.client.call('session.whoami')).toMatchObject({ unread: 1 });
    expect(recoverySlot(broker.db, a.welcome.session_id)?.undelivered).toBe(1);
    expect(recoverySlot(broker.db, b.welcome.session_id)?.undelivered).toBe(1);
    expect(deliveriesOfMessage(broker.db, original.id)[0]).toMatchObject({
      recipient: 'alpha',
      forward_to: a.welcome.session_id,
    });
    release();
    await until(() => deliveriesOfMessage(broker.db, original.id)[0]?.recipient === 'beta');
    expect(deliveriesOfMessage(broker.db, original.id)[0]?.state).toBe(fail ? 'held' : 'read');
    expect(deliveriesOfMessage(broker.db, own.id)[0]?.recipient).toBe('alpha');
    expect(JSON.stringify(await b.client.call('msg.inbox', { include_read: true }))).not.toContain('A private mail');
    expect(JSON.stringify(await a.client.call('msg.inbox', { include_read: true }))).toContain('A private mail');
  },
);

it('lets the owning inbox read deferred mail without granting it to the replacement holder', async () => {
  const { broker, a, b, original, release } = await scenario();
  expect(JSON.stringify(await a.client.call('msg.inbox'))).toContain('A private mail');
  release();
  await until(() => deliveriesOfMessage(broker.db, original.id)[0]?.recipient === 'beta');
  expect(deliveriesOfMessage(broker.db, original.id)[0]?.state).toBe('read');
  await expect(b.client.call('msg.read', { msg_id: original.id })).rejects.toMatchObject({ code: 'not_found' });
});

it('does not grant a deferred attachment through the reclaimed physical recipient', async () => {
  const { broker, a, b, original, release } = await scenario(true, false, true);
  const ref = getMessage(broker.db, original.id)?.attachments[0];
  expect(ref).toBeDefined();
  await expect(b.client.call('blob.get', { ref })).rejects.toMatchObject({ code: 'not_found' });
  expect(JSON.stringify(await a.client.call('blob.get', { ref }))).toContain('A private attachment');
  release();
});

it('keeps already-pushed chunks private while the remaining transport call is in flight', async () => {
  const { broker, a, b, original, release } = await scenario(true, true);
  expect(deliveriesOfMessage(broker.db, original.id)[0]).toMatchObject({
    state: 'read',
    forward_to: a.welcome.session_id,
  });
  await expect(b.client.call('msg.read', { msg_id: original.id })).rejects.toMatchObject({ code: 'not_found' });
  expect(JSON.stringify(await b.client.call('msg.inbox', { include_read: true }))).not.toContain('A private mail');
  release();
  await until(() => deliveriesOfMessage(broker.db, original.id)[0]?.recipient === 'beta');
  expect(deliveriesOfMessage(broker.db, original.id)[0]?.state).toBe('read');
});

it('follows the owning session through a second rename without changing the new holder mail', async () => {
  const { broker, a, b, original, own, release } = await scenario();
  await a.client.call('session.register', { name: 'gamma' });
  release();
  await until(() => deliveriesOfMessage(broker.db, original.id)[0]?.recipient === 'gamma');
  expect(deliveriesOfMessage(broker.db, own.id)[0]?.recipient).toBe('alpha');
  await expect(b.client.call('msg.read', { msg_id: original.id })).rejects.toMatchObject({ code: 'not_found' });
});

it('recovers durable ownership after shutdown interrupts the in-flight push', async () => {
  const { home, broker, a, b, original, release } = await scenario();
  broker.config.codex.queue_timeout_ms = 1;
  await broker.stop();
  release();
  const restarted = await startBroker(home, {
    transports: {
      claude: {
        kind: 'claude-channel',
        hasChannel: () => false,
        async push() {
          throw new Error('must stay held');
        },
      },
      codex: {
        kind: 'codex-queue',
        async push() {
          throw new Error('unexpected Codex push');
        },
      },
    },
  });
  cleanup.push(() => restarted.stop());
  const backA = await mcpClient(home, { resume_session_id: a.welcome.session_id, channel: false });
  const backB = await mcpClient(home, { resume_session_id: b.welcome.session_id, mcp_ppid: 3, channel: false });
  cleanup.push(
    () => backA.client.destroy(),
    () => backB.client.destroy(),
  );
  expect(deliveriesOfMessage(restarted.db, original.id)[0]?.recipient).toBe('beta');
  await expect(backB.client.call('msg.read', { msg_id: original.id })).rejects.toMatchObject({ code: 'not_found' });
  expect(JSON.stringify(await backB.client.call('msg.inbox', { include_read: true }))).not.toContain('A private mail');
  expect(JSON.stringify(await backA.client.call('msg.inbox', { include_read: true }))).toContain('A private mail');
});

it('records ownership in the claim transaction before post-claim forwarding can fail', async () => {
  const home = tmpHome();
  let started = false,
    release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const broker = await startBroker(home, {
    transports: {
      claude: {
        kind: 'claude-channel',
        async push() {
          started = true;
          await gate;
          throw new Error('fixture failed');
        },
      },
      codex: { kind: 'codex-queue', async push() {} },
    },
  });
  cleanup.push(
    () => broker.stop(),
    () => release(),
  );
  const a = await mcpClient(home, { requested_name: 'alpha' });
  const owner = await ownerClient(home);
  cleanup.push(
    () => a.client.destroy(),
    () => owner.destroy(),
  );
  const m = await owner.call<{ id: string }>('owner.send', {
    to: 'alpha',
    subject: 'claim gap',
    body: 'A private mail',
    priority: 'urgent',
    attach_paths: [],
  });
  await until(() => started);
  const engine = broker.engine;
  if (!engine) throw new Error('missing fixture engine');
  const forward = vi.spyOn(engine, 'forward').mockImplementation(() => {
    throw new Error('post-claim interruption');
  });
  try {
    await expect(a.client.call('session.register', { name: 'beta' })).rejects.toThrow('post-claim interruption');
    expect(deliveriesOfMessage(broker.db, m.id)[0]?.forward_to).toBe(a.welcome.session_id);
    const b = await mcpClient(home, { requested_name: 'alpha', mcp_ppid: 3 });
    cleanup.push(() => b.client.destroy());
    await expect(b.client.call('msg.read', { msg_id: m.id })).rejects.toMatchObject({ code: 'not_found' });
  } finally {
    forward.mockRestore();
    release();
  }
});
