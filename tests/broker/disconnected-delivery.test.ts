import { afterEach, describe, expect, it } from 'vitest';
import { PARENT_OPEN_TEXT } from '../../src/broker/registry.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import type { ProcessProbe } from '../../src/proc/identity.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello, PushData } from '../../src/protocol/rpc.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { addThrottle } from '../../src/store/subs.js';
import { ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const probe: ProcessProbe = (pids) =>
  new Map(pids.filter((p) => p === 4242).map((p) => [p, 'start-A'] as [number, string]));
const CWD = '/Users/x/code/myproject';
async function connect(home: string, hello: Hello, pushes: PushData[] = []) {
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)), (n, d) => {
    if (n === 'push') pushes.push(d as PushData);
  });
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string } };
}
const mcp = (home: string, pushes: PushData[] = []) =>
  connect(
    home,
    {
      protocol: 1,
      role: 'mcp',
      agent: 'claude',
      cwd: CWD,
      pid_chain: [4243, 4242],
      mcp_ppid: 4242,
      requested_name: 'worker-one',
    },
    pushes,
  );
const ev = (event: string) => ({
  agent: 'claude',
  event,
  agent_session_id: 'sid-1',
  cwd: CWD,
  pid_chain: [9, 4242],
  agent_pid: 4242,
});

describe('delivery to a session whose MCP is disconnected (W8)', () => {
  it('an active throttle still prevents delivery through a disconnected session hook digest', async () => {
    const home = tmpHome();
    const broker = await startBroker(home, { processProbe: probe });
    cleanup.push(() => broker.stop());
    const a = await mcp(home);
    const h = (await connect(home, { protocol: 1, role: 'hook' })).client;
    await h.call('hook.event', ev('SessionStart'));
    a.client.close();
    await until(
      () =>
        (broker.db.prepare("SELECT link FROM sessions WHERE name = 'worker-one'").get() as { link: string }).link ===
        'disconnected',
    );
    const sender = await connect(home, {
      protocol: 1,
      role: 'mcp',
      agent: 'claude',
      cwd: CWD,
      pid_chain: [5152, 5151],
      mcp_ppid: 5151,
      requested_name: 'sender-one',
    });
    addThrottle(broker.db, 'sender-one', 'worker-one');
    const m = await sender.client.call<{ id: string }>('msg.send', {
      to: 'worker-one',
      subject: 'throttled-message',
      body: 'THROTTLED-DIGEST-TOKEN',
      priority: 'urgent',
      attachments: [],
    });
    await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'held');
    expect(deliveriesOfMessage(broker.db, m.id)[0]?.hold_reason).toBe('throttled');
    const r = await h.call<{ additional_context: string | null }>('hook.event', ev('UserPromptSubmit'));
    expect(r.additional_context ?? '').not.toContain('THROTTLED-DIGEST-TOKEN');
    expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({ state: 'held', hold_reason: 'throttled' });
  });
  it('holds pushes as disconnected, delivers them at the next hook, and pushes again after re-attach', async () => {
    const home = tmpHome();
    const broker = await startBroker(home, { processProbe: probe });
    cleanup.push(() => broker.stop());
    const a = await mcp(home);
    const h = (await connect(home, { protocol: 1, role: 'hook' })).client;
    await h.call('hook.event', ev('SessionStart'));
    a.client.close();
    await until(
      () =>
        (broker.db.prepare("SELECT link FROM sessions WHERE name = 'worker-one'").get() as { link: string } | undefined)
          ?.link === 'disconnected',
    );
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    const who = await o.call<Array<{ name: string; liveness: string | null; parent_state: string }>>('session.who');
    expect(who.find((s) => s.name === 'worker-one')).toMatchObject({
      liveness: PARENT_OPEN_TEXT,
      parent_state: 'live',
    });
    const send = (subject: string) =>
      o.call<{ id: string }>('owner.send', {
        to: 'worker-one',
        subject,
        body: 'b',
        priority: 'urgent',
        attach_paths: [],
      });
    const first = await send('first-urgent');
    await until(() => deliveriesOfMessage(broker.db, first.id)[0]?.hold_reason === 'disconnected');
    const r = await h.call<{ additional_context: string | null }>('hook.event', ev('UserPromptSubmit'));
    expect(r.additional_context).toContain('first-urgent');
    expect(deliveriesOfMessage(broker.db, first.id)[0]).toMatchObject({ transport: 'hook' });
    const second = await send('second-urgent');
    await until(() => deliveriesOfMessage(broker.db, second.id)[0]?.hold_reason === 'disconnected');
    const pushes: PushData[] = [];
    await mcp(home, pushes); // same parent: re-attaches (Task 10) and pushes the held item
    await until(() => pushes.some((p) => JSON.stringify(p).includes('second-urgent')));
  });
});
