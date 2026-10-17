import { afterEach, describe, expect, it } from 'vitest';
import { nameCandidates, sanitizeNativeName } from '../../src/broker/naming.js';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { loadConfig } from '../../src/config.js';
import { frameLimit } from '../../src/protocol/frame.js';
import type { Hello } from '../../src/protocol/rpc.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import type { Agent } from '../../src/store/sessions.js';
import { ownerClient, startTestBroker } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function boot() {
  const { home, broker } = await startTestBroker();
  cleanup.push(() => broker.stop());
  return { home, broker };
}
async function mcp(home: string, extra: Partial<Hello> = {}) {
  const hello: Hello = {
    protocol: 1,
    role: 'mcp',
    agent: 'claude',
    cwd: '/Users/x/code/myproject',
    pid_chain: [500, 400, 300],
    mcp_ppid: 400,
    ...extra,
  };
  const { client, welcome } = await Client.connect(sockPath(home), hello, frameLimit(loadConfig(home)));
  cleanup.push(() => client.close());
  return { client, welcome: welcome as { session_id: string; name: string } };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('sanitizeNativeName', () => {
  it.each([
    ['Node refactor', 'claude', 'node-refactor'],
    ['  Initialize Wigwag session ', 'codex', 'initialize-wigwag-session'],
    ['Ünïcode Plan!', 'claude', 'unicode-plan'],
    ['2026 plan', 'claude', 'claude-2026-plan'],
    ['--x--', 'codex', null],
    ['   ', 'claude', null],
    ['🚀🚀', 'claude', null],
    ['Owner', 'claude', 'owner'],
  ])('%s (%s) -> %s', (raw, agent, want) => {
    expect(sanitizeNativeName(raw, agent as Agent)).toBe(want);
  });
  it('caps the base at 43 characters without a trailing hyphen, and ignores non-strings', () => {
    expect(sanitizeNativeName('a'.repeat(100), 'claude')).toBe('a'.repeat(43));
    expect(sanitizeNativeName(`${'a'.repeat(42)} b`, 'claude')).toBe('a'.repeat(42));
    expect(sanitizeNativeName(42, 'claude')).toBeNull();
  });
  it('nameCandidates skips reserved names, then numbers, then random suffixes', () => {
    const c = nameCandidates('owner', () => 'zzzz');
    expect(c.slice(0, 2)).toEqual(['owner-2', 'owner-3']);
    expect(c.at(-1)).toBe('owner-zzzz');
    expect(nameCandidates('plan', () => 'zzzz')[0]).toBe('plan');
  });
});

describe('native name adoption', () => {
  it.each([
    ['Fix test', 'Fix', 'fix'],
    ['API docs', 'API', 'api'],
    ['Web auth', 'Web', 'web'],
  ])('shortens %s to %s without mistaking a word for a collision suffix', async (before, after, want) => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    broker.naming.adoptNative(a.welcome.session_id, before, 'claude-hook');
    expect(broker.naming.adoptNative(a.welcome.session_id, after, 'claude-hook')).toEqual({
      changed: true,
      name: want,
    });
    expect(await a.client.call('session.whoami')).toMatchObject({ name: want, native_name: after });
  });

  it('keeps a genuine random collision suffix when its original base becomes free', async () => {
    const { home, broker } = await boot();
    const holders = [];
    for (const [i, name] of ['plan', ...Array.from({ length: 8 }, (_, n) => `plan-${n + 2}`)].entries()) {
      holders.push(await mcp(home, { requested_name: name, mcp_ppid: 401 + i }));
    }
    const a = await mcp(home, { mcp_ppid: 420 });
    const first = broker.naming.adoptNative(a.welcome.session_id, 'Plan', 'claude-hook').name;
    expect(first).toMatch(/^plan-[a-z2-7]{4}$/);
    await holders[0].client.call('session.register', { name: 'free-plan' });
    expect(broker.naming.adoptNative(a.welcome.session_id, 'Plan', 'claude-sidecar')).toEqual({
      changed: false,
      name: first,
    });
  });

  it.each([false, true])(
    'stores a bounded native display title without control characters (custom: %s)',
    async (custom) => {
      const { home, broker } = await boot();
      const a = await mcp(home);
      if (custom) await a.client.call('session.register', { name: 'custom-role' });
      broker.naming.adoptNative(
        a.welcome.session_id,
        `Plan\nnext\tstep\u001b[31m\u0000\u202e ${'z'.repeat(250)}`,
        'claude-hook',
      );
      const me = await a.client.call<{ name: string; native_name: string }>('session.whoami');
      expect(me.native_name).not.toMatch(/[\p{Cc}\p{Cf}]/u);
      expect(me.native_name).toHaveLength(200);
      expect(me.native_name).toMatch(/^Plan next step/);
      if (custom) expect(me.name).toBe('custom-role');
      else expect(me.name).toBe(sanitizeNativeName(me.native_name, 'claude'));
    },
  );

  it('adopts a sanitized native name for a provisional session and audits it', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    expect(broker.naming.adoptNative(a.welcome.session_id, 'Node refactor', 'claude-hook')).toEqual({
      changed: true,
      name: 'node-refactor',
    });
    expect(await a.client.call('session.whoami')).toMatchObject({
      name: 'node-refactor',
      name_source: 'native',
      native_name: 'Node refactor',
    });
    expect(broker.db.prepare('SELECT cause FROM session_renames').all()).toEqual([{ cause: 'native' }]);
    expect(broker.naming.adoptNative(a.welcome.session_id, 'Node refactor', 'claude-sidecar').changed).toBe(false);
  });

  it('suffixes past live and offline holders and reserved names; never inherits offline mail', async () => {
    const { home, broker } = await boot();
    await mcp(home, { requested_name: 'node-refactor', mcp_ppid: 401 });
    const off = await mcp(home, { requested_name: 'node-refactor-2', mcp_ppid: 402 });
    off.client.close();
    await settle();
    const o = await ownerClient(home);
    cleanup.push(() => o.close());
    const held = await o.call<{ id: string }>('owner.send', {
      to: 'node-refactor-2',
      subject: 'for the offline one',
      body: 'b',
      priority: 'low',
      attach_paths: [],
    });
    const a = await mcp(home, { mcp_ppid: 403 });
    expect(broker.naming.adoptNative(a.welcome.session_id, 'Node Refactor', 'claude-hook').name).toBe(
      'node-refactor-3',
    );
    expect(deliveriesOfMessage(broker.db, held.id)[0].recipient).toBe('node-refactor-2');
    const b = await mcp(home, { mcp_ppid: 404 });
    expect(broker.naming.adoptNative(b.welcome.session_id, 'Owner', 'claude-hook').name).toBe('owner-2');
  });

  it('an explicit register wins; register native=true goes back to the native name', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    await a.client.call('session.register', { name: 'role-name' });
    expect(broker.naming.adoptNative(a.welcome.session_id, 'Node refactor', 'claude-hook')).toEqual({
      changed: false,
      name: 'role-name',
    });
    expect(await a.client.call('session.whoami')).toMatchObject({
      name: 'role-name',
      name_source: 'custom',
      native_name: 'Node refactor',
    });
    expect(await a.client.call('session.register', { native: true })).toEqual({
      name: 'node-refactor',
      name_source: 'native',
    });
  });

  it('register native=true without a native name keeps the name until a native title appears', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    await a.client.call('session.register', { name: 'role-name' });
    expect(await a.client.call('session.register', { native: true })).toEqual({
      name: 'role-name',
      name_source: 'provisional',
    });
    expect(broker.naming.adoptNative(a.welcome.session_id, 'Later title', 'claude-hook').name).toBe('later-title');
  });

  it('rejects register with both or neither of name and native', async () => {
    const { home } = await boot();
    const a = await mcp(home);
    await expect(a.client.call('session.register', {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(a.client.call('session.register', { name: 'x-name', native: true })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('leaves the name alone for unusable titles and for offline sessions', async () => {
    const { home, broker } = await boot();
    const a = await mcp(home);
    for (const raw of ['', '   ', '🚀', null, undefined]) {
      expect(broker.naming.adoptNative(a.welcome.session_id, raw, 'claude-hook')).toEqual({
        changed: false,
        name: a.welcome.name,
      });
    }
    a.client.close();
    await settle();
    expect(broker.naming.adoptNative(a.welcome.session_id, 'Late title', 'claude-hook').changed).toBe(false);
  });
});
