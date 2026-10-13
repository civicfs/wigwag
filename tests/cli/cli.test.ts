import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signalBroker } from '../../src/cli/commands/broker.js';
import { VERSION } from '../../src/version.js';
import { DIST_MAIN, gitRepo, mcpClient, startTestBroker, tmpHome } from '../helpers.js';

const runCli = (home: string, args: string[], stdin = '', env: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [DIST_MAIN, ...args], {
      env: { ...process.env, WIGWAG_HOME: home, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await runCli(h, ['broker', 'stop']);
});

describe('cli', () => {
  it('restarts and verifies the replacement broker version', async () => {
    const home = tmpHome();
    homes.push(home);
    expect((await runCli(home, ['broker', 'start'])).code).toBe(0);
    const before = (await runCli(home, ['broker', 'status'])).stdout;
    const result = await runCli(home, ['broker', 'restart', '--expect-version', VERSION]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`version ${VERSION}`);
    expect(result.stdout.match(/pid (\d+)/)?.[1]).not.toBe(before.match(/pid (\d+)/)?.[1]);
  });

  it('--version matches package.json; help lists every command', async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    const home = tmpHome();
    expect((await runCli(home, ['--version'])).stdout.trim()).toBe(VERSION);
    const help = (await runCli(home, ['help'])).stdout;
    for (const c of [
      'init',
      'install',
      'uninstall',
      'doctor',
      'broker',
      'who',
      'send',
      'tail',
      'show',
      'kv',
      'streams',
      'deliveries',
      'release-throttle',
      'link',
      'unlink',
      'links',
      'tui',
      'claude',
      'codex',
    ]) {
      expect(help).toContain(`wigwag ${c}`);
    }
  });

  it('init writes config once', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'ww-i-')), 'h');
    expect((await runCli(home, ['init', '--codex', '/opt/codex'])).stdout).toMatch(/Created/);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).codex.binary).toBe('/opt/codex');
    expect((await runCli(home, ['init', '--codex', '/other'])).stdout).toMatch(/unchanged/);
  });

  it('init on an older config adds the missing key, reports it, and keeps the other values', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'ww-i-')), 'h');
    await runCli(home, ['init', '--codex', '/opt/codex']);
    const path = join(home, 'config.json');
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    cfg.codex.name_wait_ms = undefined;
    cfg.codex.queue_timeout_ms = 7;
    writeFileSync(path, JSON.stringify(cfg));
    const r = await runCli(home, ['init']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/added missing keys \(codex\.name_wait_ms\)/);
    expect(JSON.parse(readFileSync(path, 'utf8')).codex).toEqual({
      binary: '/opt/codex',
      queue_timeout_ms: 7,
      name_wait_ms: 120000,
    });
  });

  it('send to an offline name, then deliveries and show reflect it; body from stdin', async () => {
    const home = tmpHome();
    homes.push(home);
    const sent = await runCli(
      home,
      ['send', 'nobody-yet', '--priority', 'normal', '--subject', 'hello', '--body-file', '-'],
      'from stdin ✓',
    );
    expect(sent.code).toBe(0);
    const id = sent.stdout.trim();
    expect(id).toMatch(/^msg-/);
    const del = (await runCli(home, ['deliveries'])).stdout;
    expect(del).toMatch(/nobody-yet\s+held\s+offline/);
    expect((await runCli(home, ['show', id])).stdout).toContain('from stdin ✓');
    expect((await runCli(home, ['tail', '--limit', '5'])).stdout).toContain('from stdin ✓');
    expect((await runCli(home, ['who'])).code).toBe(0);
  });

  it('send without --subject is accepted (spec §10) and the message carries the no-subject marker', async () => {
    const home = tmpHome();
    homes.push(home);
    const sent = await runCli(home, ['send', 'nobody-yet', '--priority', 'normal', '--body', 'b']);
    expect(sent.code).toBe(0);
    expect((await runCli(home, ['show', sent.stdout.trim()])).stdout).toContain('(no subject)');
  });

  it('a losing `broker run` exits 0 without writing to a non-terminal stderr (broker.log stays clean)', async () => {
    const home = tmpHome();
    const { broker } = await startTestBroker(home);
    try {
      const r = await runCli(home, ['broker', 'run']);
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/already running/i);
      expect(r.stderr).toBe('');
    } finally {
      await broker.stop();
    }
  });

  it('prints no SQLite ExperimentalWarning, on the CLI or in the broker log', async () => {
    const home = tmpHome();
    homes.push(home);
    const r = await runCli(home, ['broker', 'status']);
    expect(r.stderr).not.toMatch(/ExperimentalWarning|SQLite is an experimental/);
    await runCli(home, ['broker', 'start']);
    await runCli(home, ['who']);
    const log = readFileSync(join(home, 'logs', 'broker.log'), 'utf8');
    expect(log).toContain('broker started');
    expect(log).not.toMatch(/ExperimentalWarning|SQLite is an experimental/);
    expect(log).not.toMatch(/already running/i);
  });

  it('rejects bad send arguments with exit 2 and a usage line', async () => {
    const home = tmpHome();
    const r = await runCli(home, ['send', 'x-y', '--subject', 's', '--body', 'b']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--priority urgent\|normal\|low/);
  });

  it('doctor checks that git is on the PATH the broker inherits (final I-5)', async () => {
    const home = tmpHome();
    homes.push(home);
    const ok = await runCli(home, ['doctor', '--claude-only']);
    expect(ok.stdout).toMatch(/PASS\s+git \(workspace ids\)/);
    const noGit = await runCli(home, ['doctor', '--claude-only'], '', {
      PATH: mkdtempSync(join(tmpdir(), 'ww-e-')),
    });
    expect(noGit.stdout).toMatch(/FAIL\s+git \(workspace ids\)\s+git not found/);
    expect(noGit.code).toBe(1);
  });

  it('init on an invalid existing config says so and exits 1 instead of "unchanged" (final m-4)', async () => {
    const home = tmpHome();
    writeFileSync(join(home, 'config.json'), '{"limits": ');
    const r = await runCli(home, ['init']);
    expect(r.code).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/invalid/i);
    expect(r.stdout).not.toMatch(/unchanged/);
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{"limits": ');
  });

  it('broker start/status/stop', async () => {
    const home = tmpHome();
    expect((await runCli(home, ['broker', 'start'])).code).toBe(0);
    expect((await runCli(home, ['broker', 'status'])).stdout).toMatch(/running pid \d+/);
    const stopped = await runCli(home, ['broker', 'stop']);
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toMatch(/sent SIGTERM to broker pid \d+/);
    expect(stopped.stdout).toMatch(/live MCP servers start it again/);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(home, 'broker.sock'))).toBe(false);
  });

  it('broker stop never signals a pid from a stale lock when no broker answers (final I-2)', async () => {
    const home = tmpHome();
    const victim = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeFileSync(join(home, 'broker.lock'), String(victim.pid));
      const r = await runCli(home, ['broker', 'stop']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/not running \(stale lock/);
      await new Promise((res) => setTimeout(res, 200));
      expect(victim.exitCode).toBeNull();
      expect(victim.signalCode).toBeNull();
    } finally {
      victim.kill('SIGKILL');
    }
  });

  it('signalBroker: ESRCH means already gone (exit 0), EPERM is a failure (exit 1) (T13 pin)', () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(signalBroker(4242, fail('ESRCH'))).toMatchObject({ code: 0, out: expect.stringMatching(/not running/) });
    expect(signalBroker(4242, fail('EPERM'))).toMatchObject({ code: 1, err: expect.stringMatching(/cannot signal/) });
    const sent: Array<[number, string]> = [];
    expect(signalBroker(4242, (p, s) => sent.push([p, s]))).toMatchObject({ code: 0 });
    expect(sent).toEqual([[4242, 'SIGTERM']]);
  });

  it("tail --name shows only that name's messages, each once, before and after -f starts (T13 pin)", async () => {
    const { home, broker } = await startTestBroker();
    const a = await mcpClient(home, { requested_name: 'alpha-one' });
    const b = await mcpClient(home, { requested_name: 'beta-one' });
    const send = (c: typeof a, to: string, subject: string) =>
      c.client.call<{ id: string }>('msg.send', { to, subject, body: 'b', priority: 'low', attachments: [] });
    const child = spawn(process.execPath, [DIST_MAIN, 'tail', '-f', '--name', 'alpha-one'], {
      env: { ...process.env, WIGWAG_HOME: home },
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    try {
      const before = await send(a, 'beta-one', 'before-f');
      const other = await send(b, 'gamma-one', 'not-alpha');
      const deadline = Date.now() + 8000;
      while (!stdout.includes(before.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const live = await send(b, 'alpha-one', 'live-f');
      while (!stdout.includes(live.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      // -f is now live: a message without alpha-one goes through the live filter, then a sentinel that matches
      const otherLive = await send(b, 'gamma-one', 'not-alpha-live');
      const sentinel = await send(a, 'beta-one', 'sentinel');
      while (!stdout.includes(sentinel.id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      const count = (id: string) => stdout.split(id).length - 1;
      expect(count(before.id)).toBe(1);
      expect(count(live.id)).toBe(1);
      expect(count(sentinel.id)).toBe(1);
      expect(count(other.id)).toBe(0);
      expect(count(otherLive.id)).toBe(0);
    } finally {
      child.kill('SIGINT');
      a.client.close();
      b.client.close();
      await broker.stop();
    }
  });

  it('broker stop refuses malformed locks and never signals a process group', async () => {
    for (const content of ['', '   \n', '0', '1', '-5', 'abc', '12abc']) {
      const home = tmpHome();
      writeFileSync(join(home, 'broker.lock'), content);
      const r = await runCli(home, ['broker', 'stop']);
      expect(r.code, JSON.stringify(content)).toBe(1);
      expect(r.stderr).toMatch(/malformed; not signalling/);
    }
  });

  it('usage errors exit 2 before contacting the broker', async () => {
    const home = tmpHome();
    for (const args of [
      ['init', '--unknown'],
      ['send', 'x-y', '--priority'],
      ['send', 'a', 'b', '--priority', 'low', '--subject', 's', '--body', 'b'],
      ['kv', 'get'],
      ['streams', 'read'],
      ['streams', 'read', 'n', '--limit', 'abc'],
      ['tail', '--limit', 'abc'],
      ['claude', '--as'],
      ['link'],
      ['link', 'only-one'],
      ['unlink', 'a-a'],
      ['link', 'a-a', 'b-b', 'c-c'],
      ['links', 'extra'],
      // R38: numeric flags are range-checked against the RPC bounds; doctor rejects unknown flags as usage errors
      ['tail', '--limit', '0'],
      ['tail', '--limit', '1001'],
      ['streams', 'read', 'n', '--limit', '0'],
      ['streams', 'read', 'n', '--limit', '1001'],
      ['streams', 'read', 'n', '--after', '99999999999999999999'],
      ['doctor', '--unknown'],
    ]) {
      const r = await runCli(home, args);
      expect(r.code, args.join(' ')).toBe(2);
    }
    expect(existsSync(join(home, 'broker.sock'))).toBe(false);
  });
});

describe('cli links (spec §17)', () => {
  it('link/links/who/unlink against a real broker with two repos; names and relative paths resolve', async () => {
    const { home, broker } = await startTestBroker();
    const repoA = gitRepo();
    const repoB = gitRepo();
    const a = await mcpClient(home, { requested_name: 'alpha-one', cwd: join(repoA, 'sub') });
    const b = await mcpClient(home, { requested_name: 'beta-one', cwd: join(repoB, 'sub') });
    try {
      expect((await runCli(home, ['links'])).stdout.trim()).toBe('no links');
      const who = (await runCli(home, ['who'])).stdout;
      expect(who).toMatch(/WORKSPACE/);
      expect(who).toContain(realpathSync(repoA));
      expect(who).toContain(realpathSync(repoB));

      const linked = await runCli(home, ['link', 'alpha-one', repoB]);
      expect(linked.code, linked.stderr).toBe(0);
      expect(linked.stdout.trim()).toBe(`linked ${realpathSync(repoA)} ↔ ${realpathSync(repoB)}`);
      const listed = (await runCli(home, ['links'])).stdout;
      expect(listed).toMatch(/^WORKSPACE A\s+WORKSPACE B\s+SINCE/);
      expect(listed).toContain(realpathSync(repoA));
      expect(listed).toContain(realpathSync(repoB));

      const dup = await runCli(home, ['link', 'beta-one', 'alpha-one']);
      expect(dup.code).toBe(0);
      expect((await runCli(home, ['links'])).stdout.trim().split('\n')).toHaveLength(2);

      const gone = await runCli(home, ['unlink', 'beta-one', 'alpha-one']);
      expect(gone.code, gone.stderr).toBe(0);
      expect(gone.stdout.trim()).toBe(`unlinked ${realpathSync(repoB)} ↔ ${realpathSync(repoA)}`);
      expect((await runCli(home, ['links'])).stdout.trim()).toBe('no links');
      const again = await runCli(home, ['unlink', 'beta-one', 'alpha-one']);
      expect(again.code).toBe(1);
      expect(again.stderr).toMatch(/not linked/);
    } finally {
      a.client.close();
      b.client.close();
      await broker.stop();
    }
  });

  it('a relative path argument is resolved against the cwd; an unknown session name exits 1 with the broker error', async () => {
    const { home, broker } = await startTestBroker();
    const repoA = gitRepo();
    const repoB = gitRepo();
    try {
      const rel = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [DIST_MAIN, 'link', '.', repoB], {
          cwd: repoA,
          env: { ...process.env, WIGWAG_HOME: home },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr += d;
        });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
      expect(rel.code, rel.stderr).toBe(0);
      expect(rel.stdout).toContain(realpathSync(repoA));
      const bad = await runCli(home, ['link', 'no-such-session', repoB]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('No session named "no-such-session"');
    } finally {
      await broker.stop();
    }
  });
});
