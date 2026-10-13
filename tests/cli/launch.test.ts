import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { configPath } from '../../src/config.js';
import { getSession } from '../../src/store/sessions.js';
import { DIST_MAIN, mcpClient, startTestBroker, until } from '../helpers.js';

let broker: Broker | null = null;
afterEach(async () => {
  await broker?.stop().catch(() => {});
  broker = null;
});

// A stand-in `codex` that stays up until a release file appears, and records its environment.
function blockingCodex(dir: string): { bin: string; release: string; log: string } {
  const bin = join(dir, 'codex');
  const release = join(dir, 'release');
  const log = join(dir, 'env.json');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { existsSync, renameSync, writeFileSync } from 'node:fs';
// Written whole, then renamed into place: the test treats the file's existence as "recorded", so it must never be seen half-written.
writeFileSync(${JSON.stringify(`${log}.tmp`)}, JSON.stringify({ name: process.env.WIGWAG_NAME ?? null, argv: process.argv.slice(2) }));
renameSync(${JSON.stringify(`${log}.tmp`)}, ${JSON.stringify(log)});
while (!existsSync(${JSON.stringify(release)})) await new Promise((r) => setTimeout(r, 20));
`,
  );
  chmodSync(bin, 0o755);
  return { bin, release, log };
}

describe('wigwag codex --as (E-1)', () => {
  it('registers the intended name with the broker before launching; the session that connects in this directory takes it at once', async () => {
    const t = await startTestBroker();
    broker = t.broker;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ww-launch-')));
    const work = join(dir, 'work');
    mkdirSync(work);
    const fake = blockingCodex(dir);
    const cfg = JSON.parse(readFileSync(configPath(t.home), 'utf8'));
    cfg.codex.binary = fake.bin;
    writeFileSync(configPath(t.home), JSON.stringify(cfg, null, 2));
    const child = spawn(process.execPath, [DIST_MAIN, 'codex', '--as', 'e2e-codex', '-m', 'some-model'], {
      cwd: work,
      env: { ...process.env, WIGWAG_HOME: t.home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const exited = new Promise<number | null>((res) => child.on('close', res));
    try {
      await until(() => existsSync(fake.log));
      expect(JSON.parse(readFileSync(fake.log, 'utf8'))).toEqual({
        name: 'e2e-codex',
        argv: ['-m', 'some-model', expect.stringMatching(/initialize.*wigwag/i)],
      });
      // The daemon-spawned MCP server of the new thread: no WIGWAG_NAME, cwd is the terminal's directory.
      const c = await mcpClient(t.home, { agent: 'codex', cwd: work });
      expect(c.welcome.name).toBe('e2e-codex');
      expect(getSession(broker.db, c.welcome.session_id)).toMatchObject({ name: 'e2e-codex', agent_session_id: null });
      await c.client.call('session.bind', { agent_session_id: 'thread-1' });
      expect(getSession(broker.db, c.welcome.session_id)?.name).toBe('e2e-codex');
      c.client.close();
    } finally {
      writeFileSync(fake.release, '');
      expect(await exited).toBe(0);
      expect(stderr).not.toMatch(/could not register/);
    }
    // codex exited: the launcher's connection ended and its intent with it
    const late = await mcpClient(t.home, { agent: 'codex', cwd: work });
    await late.client.call('session.bind', { agent_session_id: 'thread-2' });
    expect(getSession(broker.db, late.welcome.session_id)?.name).toMatch(/^codex-work-/);
    late.client.close();
  });

  it.each([
    { args: [], initialize: true },
    { args: ['--model', 'some-model', '-C', '/tmp'], initialize: true },
    { args: ['-msome-model', '--config=features.hooks=true', '--no-alt-screen'], initialize: true },
    { args: ['--', 'Review this code'], initialize: false },
    { args: ['--', '--as'], initialize: false },
    { args: ['-m', 'some-model', 'Review this code'], initialize: false },
    { args: ['resume', '--last'], initialize: false },
    { args: ['--help'], initialize: false },
    { args: ['--future-option', 'some-value'], initialize: false },
  ])(
    'preserves Codex arguments and initializes only a fresh session without a prompt: $args',
    async ({ args, initialize }) => {
      const t = await startTestBroker();
      broker = t.broker;
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ww-launch-')));
      const fake = blockingCodex(dir);
      const cfg = JSON.parse(readFileSync(configPath(t.home), 'utf8'));
      cfg.codex.binary = fake.bin;
      writeFileSync(configPath(t.home), JSON.stringify(cfg));
      const child = spawn(process.execPath, [DIST_MAIN, 'codex', '--as', 'e2e-codex', ...args], {
        cwd: dir,
        env: { ...process.env, WIGWAG_HOME: t.home },
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
      try {
        await until(() => existsSync(fake.log));
        const actual = JSON.parse(readFileSync(fake.log, 'utf8')).argv;
        expect(actual).toEqual(initialize ? [...args, expect.stringMatching(/initialize.*wigwag/i)] : args);
      } finally {
        writeFileSync(fake.release, '');
        expect(await exited).toBe(0);
      }
    },
  );
});
