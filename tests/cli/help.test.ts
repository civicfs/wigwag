import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/cli/help.js';
import { DIST_MAIN } from '../helpers.js';

const home = join(mkdtempSync(join(tmpdir(), 'ww-help-')), 'never-created');
const run = (...args: string[]) =>
  spawnSync(process.execPath, [DIST_MAIN, ...args], { env: { ...process.env, WIGWAG_HOME: home }, encoding: 'utf8' });

describe('help', () => {
  it.each([['--help'], ['-h'], ['help'], []])('top-level %s lists every command and the home note', (...args) => {
    const r = run(...args);
    expect(r.status).toBe(0);
    for (const c of COMMANDS) expect(r.stdout).toContain(`  wigwag ${c.name} `);
    expect(r.stdout).toContain('WIGWAG_HOME');
    expect(r.stdout).toContain('ww is an alias');
    expect(r.stdout).not.toMatch(/…|\.\.\./);
  });

  it.each(COMMANDS.map((c) => c.name))('%s --help, -h and help <name> agree', (name) => {
    const a = run(name, '--help');
    expect(a.status).toBe(0);
    expect(a.stdout).toContain(COMMANDS.find((c) => c.name === name)?.usage[0]);
    expect(a.stdout).not.toMatch(/…|\.\.\./);
    expect(run(name, '-h').stdout).toBe(a.stdout);
    expect(run('help', name).stdout).toBe(a.stdout);
  });

  it('help never creates the home directory', () => {
    run('doctor', '--help');
    run('--help');
    expect(existsSync(home)).toBe(false);
  });

  it('unknown commands exit 2 with usage; help of an unknown command too', () => {
    for (const args of [['frobnicate'], ['help', 'frobnicate']]) {
      const r = run(...args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('unknown command: frobnicate');
      expect(r.stderr).toContain('commands:');
    }
  });

  it('usage errors reuse the table text', () => {
    const r = run('links', 'extra');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: wigwag links');
  });
});
