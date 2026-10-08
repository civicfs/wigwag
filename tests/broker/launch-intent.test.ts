import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import type { Client } from '../../src/client/client.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { getSession } from '../../src/store/sessions.js';
import { mcpClient, ownerClient, readCodexCalls, startTestBroker, until } from '../helpers.js';

// E-1: under the shared Codex daemon the MCP server is spawned by the daemon and never sees WIGWAG_NAME from
// `wigwag codex --as x`. The launcher registers the intended name with the broker (keyed by cwd); the broker applies it
// when the Codex MCP server connects (hello), and again at `session.bind` as a fallback, through the ordinary claim
// rules.
const closers: Array<() => unknown> = [];
let broker: Broker;
let home: string;
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  await broker?.stop().catch(() => {});
  delete process.env.FAKE_CODEX_LOG;
});

async function boot() {
  ({ home, broker } = await startTestBroker());
  process.env.FAKE_CODEX_LOG = join(home, 'codex.jsonl');
}
async function launcher(name: string, cwd = '/w/myproject', agent = 'codex'): Promise<Client> {
  const o = await ownerClient(home);
  closers.push(() => o.close());
  await o.call('launch.intend', { agent, name, cwd });
  return o;
}
async function codex(cwd = '/w/myproject', extra: Record<string, unknown> = {}) {
  const c = await mcpClient(home, { agent: 'codex', cwd, ...extra });
  closers.push(() => c.client.close());
  return c;
}
const nameOf = (id: string) => getSession(broker.db, id)?.name;
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('launcher name intent for daemon-spawned Codex (E-1)', () => {
  it('names the Codex session at connect, before any prompt binds it', async () => {
    await boot();
    await launcher('e2e-codex');
    const c = await codex();
    expect(c.welcome.name).toBe('e2e-codex');
    expect(nameOf(c.welcome.session_id)).toBe('e2e-codex');
    expect(await c.client.call('session.whoami')).toMatchObject({ name: 'e2e-codex', bound: false });
    const who = await (await ownerClient(home)).call<Array<{ name: string; bound: boolean }>>('session.who');
    expect(who.find((x) => x.name === 'e2e-codex')).toMatchObject({ bound: false });
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    expect(nameOf(c.welcome.session_id)).toBe('e2e-codex');
    expect(await c.client.call('session.whoami')).toMatchObject({ name: 'e2e-codex', bound: true });
    // consumed: a later Codex session in the same directory keeps its provisional name
    const d = await codex();
    await d.client.call('session.bind', { agent_session_id: 'thread-2' });
    expect(nameOf(d.welcome.session_id)).toMatch(/^codex-myproject-/);
  });

  it('delivers a message sent to the intended name once bound', async () => {
    await boot();
    await launcher('e2e-codex');
    const c = await codex();
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    const o = await ownerClient(home);
    closers.push(() => o.close());
    await o.call('owner.send', { to: 'e2e-codex', subject: 's', body: 'b', priority: 'low', attach_paths: [] });
    const inbox = await c.client.call<{ messages: unknown[] }>('msg.inbox', { include_read: false, limit: 10 });
    expect(JSON.stringify(inbox)).toContain('"subject":"s"');
  });

  it('does not apply to a session created before the intent, another directory, or after the launcher left', async () => {
    await boot();
    const early = await codex();
    const other = await codex('/w/other');
    const o = await launcher('e2e-codex');
    await early.client.call('session.bind', { agent_session_id: 'thread-early' });
    await other.client.call('session.bind', { agent_session_id: 'thread-other' });
    expect(nameOf(early.welcome.session_id)).toMatch(/^codex-myproject-/);
    expect(nameOf(other.welcome.session_id)).toMatch(/^codex-other-/);
    // the launcher's connection ends (codex exited): the intent goes with it
    o.close();
    await settle();
    const late = await codex();
    await late.client.call('session.bind', { agent_session_id: 'thread-late' });
    expect(nameOf(late.welcome.session_id)).toMatch(/^codex-myproject-/);
  });

  it('never overrides a name the session already requested or registered', async () => {
    await boot();
    await launcher('e2e-codex');
    const req = await codex('/w/myproject', { requested_name: 'chosen-one' });
    await req.client.call('session.bind', { agent_session_id: 'thread-1' });
    expect(nameOf(req.welcome.session_id)).toBe('chosen-one');
    // the intent is still unused; the right session takes it at connect
    const right = await codex();
    expect(nameOf(right.welcome.session_id)).toBe('e2e-codex');
    // an explicit register afterwards still wins over the launcher's name, and the bind keeps it
    await right.client.call('session.register', { name: 'role-name' });
    await right.client.call('session.bind', { agent_session_id: 'thread-3' });
    expect(nameOf(right.welcome.session_id)).toBe('role-name');
  });

  it('refuses a live holder and an out-of-scope offline holder: the session keeps its provisional name', async () => {
    await boot();
    const holder = await mcpClient(home, { agent: 'claude', cwd: '/w/myproject', requested_name: 'e2e-codex' });
    closers.push(() => holder.client.close());
    await launcher('e2e-codex');
    const c = await codex();
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    expect(nameOf(c.welcome.session_id)).toMatch(/^codex-myproject-/);
    expect(nameOf(holder.welcome.session_id)).toBe('e2e-codex');

    // an offline holder in a workspace outside this scope (spec §17, R42-A) is not taken over either
    const away = await mcpClient(home, { agent: 'codex', cwd: '/w/away', requested_name: 'far-name' });
    away.client.close();
    await settle();
    await launcher('far-name');
    const d = await codex();
    await d.client.call('session.bind', { agent_session_id: 'thread-2' });
    expect(nameOf(d.welcome.session_id)).toMatch(/^codex-myproject-/);
  });

  it('names only the first session that connects after the intent; a second one keeps its provisional name', async () => {
    await boot();
    await launcher('e2e-codex');
    const a = await codex();
    const b = await codex();
    await a.client.call('session.bind', { agent_session_id: 'thread-a' });
    await b.client.call('session.bind', { agent_session_id: 'thread-b' });
    expect(nameOf(a.welcome.session_id)).toBe('e2e-codex');
    expect(nameOf(b.welcome.session_id)).toMatch(/^codex-myproject-/);
  });

  it('is owner-only and Codex-only', async () => {
    await boot();
    const c = await codex();
    await expect(
      c.client.call('launch.intend', { agent: 'codex', name: 'sneaky-one', cwd: '/w/myproject' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    const o = await ownerClient(home);
    closers.push(() => o.close());
    await expect(o.call('launch.intend', { agent: 'claude', name: 'x-y', cwd: '/w/myproject' })).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(o.call('launch.intend', { agent: 'codex', name: 'owner', cwd: '/w/myproject' })).rejects.toMatchObject(
      {
        code: 'bad_request',
      },
    );
    await expect(o.call('launch.intend', { agent: 'codex', name: 'ok-name', cwd: 'rel/dir' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });
});

describe('launcher name intent: two launchers', () => {
  it('two launchers for one directory fail closed', async () => {
    await boot();
    await launcher('first-one');
    await launcher('second-one');
    const c = await codex();
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    expect(nameOf(c.welcome.session_id)).toMatch(/^codex-myproject-/);
  });
});

// Codex's shared daemon unloads a thread 60 s after its last TUI left, and only then closes its MCP server. A relaunch
// inside that window finds the old thread still live. The launcher's intent waits for the old holder to end.
describe('launcher name intent: relaunch while the previous thread is still live', () => {
  /** An old Codex thread holding `name`, as a TUI that was just quit leaves it: connected, bound, idle. */
  async function oldThread(name: string, threadId = 'thread-old') {
    const old = await codex('/w/myproject', { requested_name: name });
    await old.client.call('session.bind', { agent_session_id: threadId });
    return old;
  }
  const stateOf = (id: string) => getSession(broker.db, id)?.state;

  it('hands the name over when the old thread ends, and the old session stays as history', async () => {
    await boot();
    const old = await oldThread('e2e-codex');
    await launcher('e2e-codex');
    const fresh = await codex();
    await fresh.client.call('session.bind', { agent_session_id: 'thread-new' });
    // refused for now: the old thread is still live, so nothing is taken from it
    expect(nameOf(fresh.welcome.session_id)).toMatch(/^codex-myproject-/);
    expect(nameOf(old.welcome.session_id)).toBe('e2e-codex');
    old.client.close(); // the daemon unloaded the thread and closed its MCP server
    await settle();
    expect(stateOf(old.welcome.session_id)).toBe('offline');
    expect(nameOf(fresh.welcome.session_id)).toBe('e2e-codex');
    expect(nameOf(old.welcome.session_id)).toBeNull();
    expect(getSession(broker.db, old.welcome.session_id)?.agent_session_id).toBe('thread-old');
    expect(await fresh.client.call('session.whoami')).toMatchObject({ name: 'e2e-codex', bound: true });
  });

  it('delivers to the new session after the handoff', async () => {
    await boot();
    const old = await oldThread('e2e-codex');
    await launcher('e2e-codex');
    const fresh = await codex();
    await fresh.client.call('session.bind', { agent_session_id: 'thread-new' });
    old.client.close();
    await settle();
    const o = await ownerClient(home);
    closers.push(() => o.close());
    await o.call('owner.send', { to: 'e2e-codex', subject: 'after', body: 'b', priority: 'low', attach_paths: [] });
    const inbox = await fresh.client.call<{ messages: unknown[] }>('msg.inbox', { include_read: false, limit: 10 });
    expect(JSON.stringify(inbox)).toContain('"subject":"after"');
  });

  it('never takes the name from a thread that is still live', async () => {
    await boot();
    const old = await oldThread('e2e-codex');
    await launcher('e2e-codex');
    const fresh = await codex();
    await fresh.client.call('session.bind', { agent_session_id: 'thread-new' });
    await settle();
    await settle();
    expect(stateOf(old.welcome.session_id)).not.toBe('offline');
    expect(nameOf(old.welcome.session_id)).toBe('e2e-codex');
    expect(nameOf(fresh.welcome.session_id)).toMatch(/^codex-myproject-/);
  });

  it('does not hand over after the launcher left', async () => {
    await boot();
    const old = await oldThread('e2e-codex');
    const o = await launcher('e2e-codex');
    const fresh = await codex();
    await fresh.client.call('session.bind', { agent_session_id: 'thread-new' });
    o.close(); // the new codex exited too
    await settle();
    old.client.close();
    await settle();
    expect(nameOf(fresh.welcome.session_id)).toMatch(/^codex-myproject-/);
    expect(nameOf(old.welcome.session_id)).toBe('e2e-codex'); // offline, name kept
  });

  it('gives up after codex.name_wait_ms', async () => {
    await boot();
    broker.config.codex.name_wait_ms = 40;
    const old = await oldThread('e2e-codex');
    await launcher('e2e-codex');
    const fresh = await codex();
    await fresh.client.call('session.bind', { agent_session_id: 'thread-new' });
    await new Promise((r) => setTimeout(r, 120));
    old.client.close();
    await settle();
    expect(nameOf(fresh.welcome.session_id)).toMatch(/^codex-myproject-/);
  });

  it('does not override a name the new session registered itself while waiting', async () => {
    await boot();
    const old = await oldThread('e2e-codex');
    await launcher('e2e-codex');
    const fresh = await codex();
    await fresh.client.call('session.bind', { agent_session_id: 'thread-new' });
    await fresh.client.call('session.register', { name: 'chosen-one' });
    old.client.close();
    await settle();
    expect(nameOf(fresh.welcome.session_id)).toBe('chosen-one');
  });

  it('waits only on a live holder: an out-of-scope offline holder still refuses for good', async () => {
    await boot();
    const away = await mcpClient(home, { agent: 'codex', cwd: '/w/away', requested_name: 'far-name' });
    away.client.close();
    await settle();
    await launcher('far-name');
    const c = await codex();
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    const other = await mcpClient(home, { agent: 'codex', cwd: '/w/away2', requested_name: 'unrelated' });
    other.client.close();
    await settle();
    expect(nameOf(c.welcome.session_id)).toMatch(/^codex-myproject-/);
  });

  it('a second relaunch while the first still waits fails closed instead of racing', async () => {
    await boot();
    const old = await oldThread('e2e-codex');
    await launcher('e2e-codex');
    const a = await codex();
    await a.client.call('session.bind', { agent_session_id: 'thread-a' });
    await launcher('e2e-codex');
    const b = await codex();
    await b.client.call('session.bind', { agent_session_id: 'thread-b' });
    old.client.close();
    await settle();
    const names = [nameOf(a.welcome.session_id), nameOf(b.welcome.session_id)];
    expect(names.filter((n) => n === 'e2e-codex')).toHaveLength(1);
  });
});

// A launcher's name is applied at connect. A refusal for ambiguity must not destroy anybody's intent, and messages
// sent to the provisional name while a session waited for its name follow it.
describe('launcher name intent: refusals keep intents, renames forward messages', () => {
  const ownerSend = async (to: string, subject: string, priority = 'normal') => {
    const o = await ownerClient(home);
    closers.push(() => o.close());
    return o.call<{ id: string }>('owner.send', { to, subject, body: 'b', priority, attach_paths: [] });
  };
  const recipients = (id: string) => deliveriesOfMessage(broker.db, id).map((d) => d.recipient);

  it('an ambiguous refusal keeps both intents; the survivor applies once the other launcher is gone', async () => {
    await boot();
    await launcher('first-one');
    const second = await launcher('second-one');
    const c = await codex();
    expect(nameOf(c.welcome.session_id)).toMatch(/^codex-myproject-/); // two launchers: refused
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    expect(nameOf(c.welcome.session_id)).toMatch(/^codex-myproject-/); // still two: refused again, nothing consumed
    second.close();
    await settle();
    await c.client.call('session.bind', { agent_session_id: 'thread-1' }); // idempotent re-bind retries the fallback
    expect(nameOf(c.welcome.session_id)).toBe('first-one');
  });

  it('forwards a message sent to the provisional name when a waiting launcher name is handed over', async () => {
    await boot();
    const old = await codex('/w/myproject', { requested_name: 'e2e-codex' });
    await old.client.call('session.bind', { agent_session_id: 'thread-old' });
    await launcher('e2e-codex');
    const fresh = await codex();
    const provisional = nameOf(fresh.welcome.session_id) as string;
    expect(provisional).toMatch(/^codex-myproject-/);
    const m = await ownerSend(provisional, 'sent-while-waiting');
    expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    old.client.close();
    await settle();
    expect(nameOf(fresh.welcome.session_id)).toBe('e2e-codex');
    expect(recipients(m.id)).toEqual(['e2e-codex']);
    expect(readCodexCalls(join(home, 'codex.jsonl'))).toHaveLength(0); // still unbound: nothing to push into
    await fresh.client.call('session.bind', { agent_session_id: 'thread-new' });
    await until(() => readCodexCalls(join(home, 'codex.jsonl')).length === 1);
    await until(() => deliveriesOfMessage(broker.db, m.id)[0].state === 'read');
  });

  it('forwards and delivers when the bind-time fallback applies an intent a refusal had kept', async () => {
    await boot();
    await launcher('first-one');
    const second = await launcher('second-one');
    const c = await codex();
    const provisional = nameOf(c.welcome.session_id) as string;
    const m = await ownerSend(provisional, 'queued');
    second.close();
    await settle();
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    expect(nameOf(c.welcome.session_id)).toBe('first-one');
    expect(recipients(m.id)).toEqual(['first-one']);
    await until(() => deliveriesOfMessage(broker.db, m.id)[0].state === 'read');
    expect(readCodexCalls(join(home, 'codex.jsonl'))).toHaveLength(1);
  });

  it('messages sent to a name applied at connect are held until the first prompt binds, then delivered', async () => {
    await boot();
    await launcher('e2e-codex');
    const c = await codex();
    const m = await ownerSend('e2e-codex', 'before-first-prompt');
    expect(deliveriesOfMessage(broker.db, m.id)[0]).toMatchObject({ state: 'held', hold_reason: 'unbound' });
    await c.client.call('session.bind', { agent_session_id: 'thread-1' });
    await until(() => deliveriesOfMessage(broker.db, m.id)[0].state === 'read');
  });
});
