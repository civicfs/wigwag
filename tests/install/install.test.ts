import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DIST_MAIN } from '../helpers.js';

const ROOT = realpathSync(resolve(import.meta.dirname, '../..'));
const FAKE = resolve(import.meta.dirname, '../fixtures/fake-agent.mjs');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'ww-inst-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'h');
  mkdirSync(bin);
  symlinkSync(FAKE, join(bin, 'claude'));
  symlinkSync(FAKE, join(bin, 'codex'));
  return { dir, bin, home, log: join(dir, 'calls.jsonl') };
}

const run = (s: ReturnType<typeof sandbox>, args: string[], extra: Record<string, string> = {}) =>
  new Promise<{ code: number | null; stdout: string }>((res) => {
    const child = spawn(process.execPath, [DIST_MAIN, ...args], {
      env: {
        ...process.env,
        PATH: `${s.bin}:${process.env.PATH}`,
        WIGWAG_HOME: s.home,
        FAKE_AGENT_LOG: s.log,
        ...extra,
      },
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.on('close', (code) => res({ code, stdout }));
  });

const calls = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { bin: string; argv: string[] })
    : [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const boxes: Array<ReturnType<typeof sandbox>> = [];
afterEach(async () => {
  for (const s of boxes.splice(0)) {
    const lock = join(s.home, 'broker.lock');
    const pid = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0;
    await run(s, ['broker', 'stop']);
    for (let i = 0; pid && alive(pid) && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
    expect(pid && alive(pid)).toBeFalsy();
  }
});

const rec = (log: string) => calls(log).map((c) => [c.bin, ...c.argv]);

describe('wigwag install / uninstall', () => {
  it('fresh install: config, broker, claude marketplace+install, codex marketplace+add', async () => {
    const s = sandbox();
    boxes.push(s);
    const r = await run(s, ['install', '--codex-binary', join(s.bin, 'codex')]);
    expect(r.code).toBe(0);
    expect(existsSync(join(s.home, 'config.json'))).toBe(true);
    expect(existsSync(join(s.home, 'broker.sock'))).toBe(true);
    expect(rec(s.log)).toEqual([
      ['claude', 'plugin', 'validate', ROOT],
      ['claude', 'plugin', 'marketplace', 'add', ROOT],
      ['claude', 'plugin', 'install', 'wigwag@wigwag'],
      ['codex', 'plugin', 'marketplace', 'add', ROOT],
      ['codex', 'plugin', 'add', 'wigwag@wigwag'],
    ]);
    expect(r.stdout).toMatch(/wigwag claude --as <name>/);
  });

  it('re-running when already installed updates instead of failing', async () => {
    const s = sandbox();
    boxes.push(s);
    const r = await run(s, ['install', '--codex-binary', join(s.bin, 'codex')], { FAKE_AGENT_ALREADY: '1' });
    expect(r.code).toBe(0);
    expect(rec(s.log)).toContainEqual(['claude', 'plugin', 'marketplace', 'update', 'wigwag']);
    expect(rec(s.log)).toContainEqual(['claude', 'plugin', 'update', 'wigwag@wigwag']);
    const again = await run(s, ['install', '--codex-binary', join(s.bin, 'codex')]);
    expect(again.code).toBe(0);
    expect(again.stdout).not.toMatch(/FAIL/);
  });

  it('second install in the same sandbox is all PASS', async () => {
    const s = sandbox();
    boxes.push(s);
    const first = await run(s, ['install', '--codex-binary', join(s.bin, 'codex')]);
    expect(first.code).toBe(0);
    const second = await run(s, ['install', '--codex-binary', join(s.bin, 'codex')], { FAKE_AGENT_ALREADY: '1' });
    expect(second.code).toBe(0);
    expect(second.stdout).not.toMatch(/FAIL/);
  });

  it('"marketplace wigwag exists" takes the update path; an unrelated "already expired" fails', async () => {
    const s = sandbox();
    boxes.push(s);
    const ok = await run(s, ['install', '--claude-only'], {
      FAKE_AGENT_OUTPUT: 'marketplace wigwag exists',
      FAKE_AGENT_MATCH: '^plugin marketplace add',
    });
    expect(ok.code).toBe(0);
    expect(rec(s.log)).toContainEqual(['claude', 'plugin', 'marketplace', 'update', 'wigwag']);
    const bad = await run(s, ['install', '--claude-only'], {
      FAKE_AGENT_OUTPUT: 'authentication token already expired',
      FAKE_AGENT_MATCH: '^plugin install',
    });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/FAIL\s+claude\s+plugin/);
  });

  it('a failed update is a FAIL step', async () => {
    const s = sandbox();
    boxes.push(s);
    const r = await run(s, ['install', '--claude-only'], {
      FAKE_AGENT_ALREADY: '1',
      FAKE_AGENT_OUTPUT: 'update exploded',
      FAKE_AGENT_MATCH: '^plugin (marketplace )?update',
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL.*update exploded/);
  });

  it('an explicit --codex-binary applies to this run and is saved over an existing config', async () => {
    const s = sandbox();
    boxes.push(s);
    await run(s, ['init', '--codex', '/nonexistent/codex']);
    const fake = join(s.bin, 'codex');
    const r = await run(s, ['install', '--codex-only', '--codex-binary', fake]);
    expect(r.code).toBe(0);
    expect(rec(s.log).every((c) => c[0] === 'codex')).toBe(true);
    expect(rec(s.log)).toContainEqual(['codex', 'plugin', 'add', 'wigwag@wigwag']);
    expect(JSON.parse(readFileSync(join(s.home, 'config.json'), 'utf8')).codex.binary).toBe(fake);
    expect(r.stdout).toMatch(/codex.binary set to/);
  });

  it('works when the package root path contains a space', async () => {
    const s = sandbox();
    boxes.push(s);
    const root = join(realpathSync(s.dir), 'pkg with space');
    mkdirSync(root);
    cpSync(resolve(ROOT, 'dist'), join(root, 'dist'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(join(root, 'package.json'), '{}');
    const child = spawn(process.execPath, [join(root, 'dist/main.js'), 'install', '--claude-only'], {
      env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, WIGWAG_HOME: s.home, FAKE_AGENT_LOG: s.log },
    });
    const code = await new Promise((res) => child.on('close', res));
    expect(code).toBe(0);
    expect(rec(s.log)[0]).toEqual(['claude', 'plugin', 'validate', root]);
    expect(rec(s.log)[1]).toEqual(['claude', 'plugin', 'marketplace', 'add', root]);
  });

  it('exclusive flags exit 2 for install and uninstall', async () => {
    const s = sandbox();
    boxes.push(s);
    expect((await run(s, ['install', '--claude-only', '--codex-only'])).code).toBe(2);
    expect((await run(s, ['uninstall', '--claude-only', '--codex-only'])).code).toBe(2);
  });

  it('uninstall: "unknown command" is a FAIL, "wigwag not installed" is accepted', async () => {
    const s = sandbox();
    boxes.push(s);
    await run(s, ['install', '--codex-binary', join(s.bin, 'codex')]);
    const bad = await run(s, ['uninstall'], {
      FAKE_AGENT_OUTPUT: 'error: unknown command remove',
      FAKE_AGENT_MATCH: 'remove',
    });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/FAIL\s+codex/);
    const absent = await run(s, ['uninstall'], {
      FAKE_AGENT_OUTPUT: 'plugin wigwag@wigwag is not installed',
      FAKE_AGENT_MATCH: 'uninstall|remove',
    });
    expect(absent.code).toBe(0);
  });

  it('uninstall accepts the real absent-target wording of claude and codex (e2e, R39)', async () => {
    for (const out of [
      'Plugin "wigwag@wigwag" not found in installed plugins',
      "Marketplace 'wigwag' not found",
      'Error: marketplace `wigwag` is not configured or installed',
    ]) {
      const s = sandbox();
      boxes.push(s);
      await run(s, ['install', '--codex-binary', join(s.bin, 'codex')]);
      const r = await run(s, ['uninstall'], { FAKE_AGENT_OUTPUT: out, FAKE_AGENT_MATCH: 'uninstall|remove' });
      expect(r.code, out).toBe(0);
    }
  });

  it('uninstall with the claude CLI missing is a FAIL step and exits 1', async () => {
    const s = sandbox();
    boxes.push(s);
    await run(s, ['init', '--codex', join(s.bin, 'codex')]);
    const r = await run(s, ['uninstall', '--claude-only'], {
      PATH: `/usr/bin:/bin:${process.execPath.replace(/\/node$/, '')}`,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+claude/);
  });

  it('doctor --claude-only does not FAIL on codex rows when codex is absent', async () => {
    const s = sandbox();
    boxes.push(s);
    await run(s, ['init', '--codex', '/nonexistent/codex']);
    const r = await run(s, ['doctor', '--claude-only', '--codex-binary', 'ignored']);
    expect(r.stdout).not.toMatch(/(PASS|FAIL)\s+codex/);
    expect(r.stdout).toMatch(/PASS\s+claude/);
  });

  it('--claude-only skips codex; uninstall removes plugins and marketplaces but keeps data', async () => {
    const s = sandbox();
    boxes.push(s);
    await run(s, ['install', '--claude-only', '--codex-binary', join(s.bin, 'codex')]);
    expect(calls(s.log).some((c) => c.bin === 'codex')).toBe(false);
    const u = await run(s, ['uninstall']);
    expect(u.code).toBe(0);
    expect(rec(s.log)).toEqual(
      expect.arrayContaining([
        ['claude', 'plugin', 'uninstall', 'wigwag@wigwag'],
        ['claude', 'plugin', 'marketplace', 'remove', 'wigwag'],
        ['codex', 'plugin', 'remove', 'wigwag@wigwag'],
        ['codex', 'plugin', 'marketplace', 'remove', 'wigwag'],
      ]),
    );
    expect(existsSync(join(s.home, 'config.json'))).toBe(true);
    expect(u.stdout).toMatch(/data kept/);
  });

  it('reports a failed step and exits 1 when an agent CLI is missing', async () => {
    const s = sandbox();
    boxes.push(s);
    const r = await run(s, ['install', '--codex-binary', '/nonexistent/codex'], {
      PATH: `/usr/bin:/bin:${process.execPath.replace(/\/node$/, '')}`,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+claude/);
    expect(r.stdout).toMatch(/FAIL\s+codex/);
  });
});
