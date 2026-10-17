import { writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { sockPath } from '../../src/client/autospawn.js';
import { Client } from '../../src/client/client.js';
import { configPath, loadConfig } from '../../src/config.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { getSession } from '../../src/store/sessions.js';
import { fixtureCodexNames, mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
it('rejects a stamped direct bind with no host hook origin before changing identity', async () => {
  const home = tmpHome();
  const broker = await startBroker(home, { codexNames: fixtureCodexNames(home, () => ['root-B']) });
  cleanup.push(() => broker.stop());
  const c = await mcpClient(home, { agent: 'codex' }, false);
  cleanup.push(() => c.client.destroy());
  await expect(c.client.call('session.bind', { agent_session_id: 'root-B' })).rejects.toMatchObject({
    code: 'bad_request',
  });
  expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBeNull();
});

async function boot(version = '0.162.1', extraVersions: string[] = []) {
  const home = tmpHome();
  const config = loadConfig(home);
  config.codex.trusted_host_versions = extraVersions;
  writeFileSync(configPath(home), JSON.stringify(config));
  const pushes: string[] = [];
  const broker = await startBroker(home, {
    codexNames: fixtureCodexNames(home, () => ['root-A', 'root-B']),
    transports: {
      claude: { kind: 'claude-channel', async push() {} },
      codex: {
        kind: 'codex-queue',
        async push(s) {
          pushes.push(s.agent_session_id ?? '');
        },
      },
    },
  });
  cleanup.push(() => broker.stop());
  const c = await mcpClient(
    home,
    { agent: 'codex', requested_name: 'guarded-worker', host_client: { name: 'codex-mcp-client', version } },
    false,
  );
  cleanup.push(() => c.client.destroy());
  const o = await ownerClient(home);
  cleanup.push(() => o.destroy());
  const origin = (thread_id = 'root-A') => ({ name: 'codex-mcp-client', version, thread_id });
  const bind = () => c.client.call('session.bind', { agent_session_id: 'root-A', hook_origin: origin() });
  const send = () =>
    o.call<{ id: string }>('owner.send', {
      to: 'guarded-worker',
      subject: 'identity',
      body: 'safe mailbox',
      priority: 'urgent',
      attach_paths: [],
    });
  return { home, broker, c, o, pushes, origin, bind, send };
}

it.each(['0.162.1', '0.163.0', '0.164.0'])(
  'refuses model-origin and root/descendant mismatches for host %s',
  async (version) => {
    const { broker, c, origin } = await boot(version);
    for (const hook_origin of [
      { ...origin(), call_id: 'model-call' },
      origin('descendant-of-root-A'),
      { ...origin(), version: 'forged-version' },
    ])
      await expect(c.client.call('session.bind', { agent_session_id: 'root-A', hook_origin })).rejects.toMatchObject({
        code: 'bad_request',
      });
    await expect(
      c.client.call('session.bind', { agent_session_id: 'root-B', hook_origin: origin('root-A') }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBeNull();
  },
);

it('trusts a valid pinned hook, exposes host/origin, and keeps automatic recovery disabled', async () => {
  const { c, bind, send, pushes, broker } = await boot();
  await bind();
  expect(await c.client.call('session.whoami')).toMatchObject({
    bind_origin: 'hook-verified',
    host_client_name: 'codex-mcp-client',
    host_client_version: '0.162.1',
    capabilities: { codex_push: 'trusted', resume_recovery: 'unavailable' },
  });
  const m = await send();
  await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'read');
  expect(pushes).toEqual(['root-A']);
});

it('keeps unsupported-host inbox and hook delivery, then upgrades only on the next allowed bind', async () => {
  const { c, bind, send, pushes, broker, origin } = await boot('0.164.0');
  await bind();
  expect(await c.client.call('session.whoami')).toMatchObject({
    bound: true,
    bind_origin: 'unverified',
    host_client_version: '0.164.0',
    codex_push_reason: 'unverified-bind',
    codex_host_warning: expect.stringContaining('Codex host codex-mcp-client 0.164.0 not in the verified list'),
    capabilities: { delivery: 'hook-boundary', codex_push: 'held' },
  });
  await c.client.call('session.register', { name: 'guarded-worker' });
  const m = await send();
  await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'held');
  expect(pushes).toEqual([]);
  expect(JSON.stringify(await c.client.call('msg.inbox'))).toContain('safe mailbox');
  const hookMail = await send();
  await until(() => deliveriesOfMessage(broker.db, hookMail.id)[0]?.state === 'held');
  expect(await c.client.call('session.digest', { hook_origin: origin() })).toMatchObject({
    text: expect.stringContaining('safe mailbox'),
  });
  await c.client.call('session.turn', { phase: 'ended', hook_origin: origin() });
  broker.config.codex.trusted_host_versions.push('0.164.0');
  expect(getSession(broker.db, c.welcome.session_id)?.bind_origin).toBe('unverified');
  await bind();
  expect(await c.client.call('session.whoami')).toMatchObject({
    bind_origin: 'hook-verified',
    codex_host_warning: null,
  });
});

it('loads the owner trusted-host extension from config for a fresh bind', async () => {
  const { c, bind } = await boot('0.164.0', ['0.164.0']);
  await bind();
  expect(await c.client.call('session.whoami')).toMatchObject({
    bind_origin: 'hook-verified',
    host_client_version: '0.164.0',
  });
});

it('keeps pre-guard remembered-slot delivery hooks without allowing new identity or pushes', async () => {
  const { home, c, broker, bind, send, pushes } = await boot();
  await bind();
  c.client.destroy();
  await until(() => getSession(broker.db, c.welcome.session_id)?.link === 'disconnected');
  const { client } = await Client.connect(
    sockPath(home),
    {
      protocol: 1,
      role: 'mcp',
      agent: 'codex',
      cwd: '/w/myproject',
      pid_chain: [3, 2],
      mcp_ppid: 2,
      resume_session_id: c.welcome.session_id,
    },
    1 << 20,
  );
  cleanup.push(() => client.destroy());
  expect(await client.call('session.whoami')).toMatchObject({
    id: c.welcome.session_id,
    bound: true,
    bind_origin: 'unverified',
    host_client_name: null,
  });
  await expect(client.call('session.bind', { agent_session_id: 'root-B' })).rejects.toMatchObject({
    code: 'bad_request',
  });
  const m = await send();
  await until(() => deliveriesOfMessage(broker.db, m.id)[0]?.state === 'held');
  expect(await client.call('session.digest')).toMatchObject({ text: expect.stringContaining('safe mailbox') });
  await client.call('session.turn', { phase: 'ended' });
  expect(pushes).toEqual([]);
  expect(getSession(broker.db, c.welcome.session_id)?.agent_session_id).toBe('root-A');
});
