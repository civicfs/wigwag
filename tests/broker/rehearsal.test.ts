import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startBroker as assemble } from '../../src/broker/assemble.js';
import { configPath, loadConfig } from '../../src/config.js';
import { deliveriesOfMessage } from '../../src/store/messages.js';
import { getSession } from '../../src/store/sessions.js';
import type { TransportRegistry } from '../../src/transports/types.js';
import { fixtureCodexNames, mcpClient, ownerClient, startBroker, tmpHome, until } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
});
function enable(home: string, external = false) {
  vi.stubEnv('WIGWAG_REHEARSAL', '1');
  vi.stubEnv('WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS', external ? '1' : '0');
  vi.stubEnv('CODEX_HOME', join(home, 'codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
  const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
  cfg.codex.binary = join(home, 'bin', 'codex-disabled');
  writeFileSync(configPath(home), JSON.stringify(cfg));
}
async function listen(path: string, connected = () => {}) {
  mkdirSync(join(path, '..'), { recursive: true });
  const server = createServer((s) => {
    connected();
    s.destroy();
  });
  await new Promise<void>((r, reject) => {
    server.once('error', reject);
    server.listen(path, r);
  });
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
}
it('never constructs native adapters, probes, watchers or pushes with retained assignment and answered relay', async () => {
  const home = tmpHome();
  const seed = await startBroker(home, {
    codexNames: fixtureCodexNames(home, () => ['T']),
    codexQuestionFactory: () =>
      new (class extends EventEmitter {
        async connect() {}
        async call() {
          return { thread: { turns: [] } };
        }
        send() {}
        close() {
          this.emit('disconnected');
        }
      })(),
  });
  cleanup.push(() => seed.stop());
  const lead = await mcpClient(home, { cwd: home, requested_name: 'lead-one' });
  const worker = await mcpClient(home, { cwd: home, agent: 'codex', requested_name: 'worker-one' });
  cleanup.push(
    () => lead.client.destroy(),
    () => worker.client.destroy(),
  );
  await lead.client.call('session.bind', { agent_session_id: 'L' });
  await worker.client.call('session.bind', { agent_session_id: 'T', question_relay_version: 1 });
  await lead.client.call('assignment.delegate', {
    to: 'worker-one',
    subject: 'retained',
    body: 'work',
    idempotency_key: 'rehearsal',
  });
  const q = seed.questions.capture(worker.welcome.session_id, {
    native_session_id: 'T',
    tool_use_id: 'tool',
    turn_id: 'turn',
    kind: 'codex',
    questions: [{ id: 'q', header: '', question: 'Which?', options: [], allowOther: true, multiSelect: false }],
  });
  if (!q) throw new Error('missing relay');
  await lead.client.call('question.answer', { relay_id: q.id, answers: { q: ['A'] } });
  await seed.stop();
  enable(home);
  let connections = 0;
  await listen(loadConfig(home).questions.app_server_socket, () => connections++);
  const probe = vi.fn(() => null),
    factory = vi.fn(() => {
      throw new Error('native factory invoked');
    }),
    push = vi.fn(async () => {});
  const names = fixtureCodexNames(home, () => ['T']);
  const refresh = vi.spyOn(names, 'refresh');
  const broker = await assemble(home, {
    processProbe: probe,
    codexNames: names,
    codexQuestionFactory: factory,
    transports: { claude: { kind: 'claude-channel', push }, codex: { kind: 'codex-queue', push } },
  });
  cleanup.push(() => broker.stop());
  const owner = await ownerClient(home);
  cleanup.push(() => owner.destroy());
  // A copied live database can retain connected rows; even those must never push.
  broker.db
    .prepare("UPDATE sessions SET state='online-idle',link='connected' WHERE id=?")
    .run(worker.welcome.session_id);
  const mail = await owner.call<{ id: string }>('owner.send', {
    to: 'worker-one',
    body: 'copy only',
    priority: 'urgent',
    attach_paths: [],
  });
  await until(() => deliveriesOfMessage(broker.db, mail.id)[0]?.state === 'held');
  expect(await owner.call('sys.ping')).toMatchObject({ rehearsal: { enabled: true, native_io: false } });
  expect(broker.questions.get(q.id)?.state).toBe('answered');
  expect(broker.questions.activeAssignment(worker.welcome.session_id)).toBeTruthy();
  expect(broker.codexNames).toBeNull();
  expect(broker.liveness).toBeNull();
  expect(probe).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(connections).toBe(0);
  // Exercise the transports themselves: a missing push-trust verdict must not mask an enabled native transport.
  const slot = getSession(broker.db, worker.welcome.session_id);
  if (!slot) throw new Error('missing copied slot');
  const registry = (broker.engine as unknown as { d: { transports: TransportRegistry } }).d.transports;
  for (const transport of Object.values(registry)) {
    await expect(transport.push(slot, [])).rejects.toThrow(/rehearsal disables native pushes/i);
    expect(transport.hasChannel?.(slot)).toBe(false);
  }
  expect(push).not.toHaveBeenCalled();
});
it.each(['mcp', 'hook'] as const)(
  'accepts owners only (refuses %s), before any native identity or session is created',
  async (role) => {
    const home = tmpHome();
    enable(home);
    const broker = await assemble(home);
    cleanup.push(() => broker.stop());
    await expect(mcpClient(home, { role })).rejects.toThrow(/rehearsal.*owner/i);
    const owner = await ownerClient(home);
    cleanup.push(() => owner.destroy());
    expect(await owner.call('session.who')).toEqual([]);
  },
);
it.each(['socket', 'binary', 'codex-home', 'claude-home', 'symlink'])(
  'rejects external %s before opening state.db',
  async (kind) => {
    const home = tmpHome(),
      outside = tmpHome();
    enable(home);
    const cfg = JSON.parse(readFileSync(configPath(home), 'utf8'));
    if (kind === 'socket') cfg.questions.app_server_socket = join(outside, 'native.sock');
    if (kind === 'binary') cfg.codex.binary = 'codex';
    if (kind === 'codex-home') vi.stubEnv('CODEX_HOME', outside);
    if (kind === 'claude-home') vi.stubEnv('CLAUDE_CONFIG_DIR', outside);
    if (kind === 'symlink') {
      symlinkSync(outside, join(home, 'escape'));
      cfg.questions.app_server_socket = join(home, 'escape', 'native.sock');
    }
    writeFileSync(configPath(home), JSON.stringify(cfg));
    await expect(assemble(home)).rejects.toThrow(/rehearsal.*(outside|absolute)/i);
    expect(existsSync(join(home, 'state.db'))).toBe(false);
  },
);
it('writes a private sticky marker and refuses normal use after rehearsal stops', async () => {
  const home = tmpHome();
  enable(home);
  const broker = await assemble(home);
  await broker.stop();
  const marker = join(home, 'rehearsal.json');
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  vi.stubEnv('WIGWAG_REHEARSAL', '0');
  expect(() => loadConfig(home)).toThrow(/marked rehearsal.*rehearsal clear/i);
  await expect(assemble(home)).rejects.toThrow(/marked rehearsal/i);
});
it.each(['default', 'xdg', 'symlink-default'])(
  'refuses the %s live home even with the external override',
  async (kind) => {
    const fakeHome = tmpHome();
    vi.stubEnv('HOME', fakeHome);
    let home = join(homedir(), '.wigwag');
    if (kind === 'xdg') {
      vi.stubEnv('XDG_STATE_HOME', join(fakeHome, 'xdg'));
      home = join(fakeHome, 'xdg', 'wigwag');
    }
    const source = tmpHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), readFileSync(configPath(source)));
    if (kind === 'symlink-default') {
      const alias = join(source, 'alias');
      symlinkSync(home, alias);
      home = alias;
    }
    enable(home, true);
    await expect(assemble(home)).rejects.toThrow(/rehearsal.*live home/i);
    expect(existsSync(join(home, 'state.db'))).toBe(false);
  },
);
it('refuses a home with a listening broker socket before opening state.db', async () => {
  const home = tmpHome();
  enable(home, true);
  await listen(join(home, 'broker.sock'));
  await expect(assemble(home)).rejects.toThrow(/rehearsal.*running broker/i);
  expect(existsSync(join(home, 'state.db'))).toBe(false);
});

it('external-path override still disables every native factory and announces the warning in ping', async () => {
  const home = tmpHome(),
    outside = tmpHome();
  enable(home, true);
  const config = JSON.parse(readFileSync(configPath(home), 'utf8'));
  config.questions.app_server_socket = join(outside, 'native.sock');
  config.codex.binary = join(outside, 'codex');
  writeFileSync(configPath(home), JSON.stringify(config));
  let connections = 0;
  await listen(config.questions.app_server_socket, () => connections++);
  const factory = vi.fn(() => {
    throw new Error('forbidden native I/O');
  });
  const broker = await assemble(home, { codexQuestionFactory: factory });
  cleanup.push(() => broker.stop());
  const owner = await ownerClient(home);
  cleanup.push(() => owner.destroy());
  expect(await owner.call('sys.ping')).toMatchObject({
    rehearsal: {
      enabled: true,
      native_io: false,
      allow_external_paths: true,
      warning: expect.stringContaining('WARNING'),
    },
  });
  expect(connections).toBe(0);
  expect(factory).not.toHaveBeenCalled();
  expect(broker.codexNames).toBeNull();
});
it.each(['state.db', 'broker.mutex', 'broker.sock', 'logs'])(
  'never opens an escaped storage path %s even with external native paths allowed',
  async (name) => {
    const home = tmpHome(),
      outside = tmpHome();
    enable(home, true);
    if (name === 'logs') {
      /* init creates logs: use an escaped child log instead */ name = 'logs/broker.log';
    }
    symlinkSync(join(outside, 'untouched'), join(home, name));
    await expect(assemble(home)).rejects.toThrow(/rehearsal.*storage.*outside/i);
    expect(existsSync(join(outside, 'untouched'))).toBe(false);
  },
);

it('config-enabled rehearsal persists without the environment switch and never rewrites old config on load', async () => {
  const home = tmpHome();
  enable(home);
  const config = JSON.parse(readFileSync(configPath(home), 'utf8'));
  config.rehearsal = { enabled: true, allow_external_paths: false };
  writeFileSync(configPath(home), JSON.stringify(config));
  vi.stubEnv('WIGWAG_REHEARSAL', '0');
  const broker = await assemble(home);
  await broker.stop();
  const restarted = await assemble(home);
  cleanup.push(() => restarted.stop());
  expect(restarted.rehearsal.enabled).toBe(true);
});
it('retains the marker when database opening/migration fails, so normal retry cannot contact native integrations', async () => {
  const home = tmpHome();
  enable(home);
  writeFileSync(join(home, 'state.db'), 'not a database');
  await expect(assemble(home)).rejects.toThrow();
  expect(statSync(join(home, 'rehearsal.json')).mode & 0o777).toBe(0o600);
  vi.stubEnv('WIGWAG_REHEARSAL', '0');
  await expect(assemble(home)).rejects.toThrow(/marked rehearsal/);
});
