import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readUpdateOperation } from '../../src/update/operation.js';
import { checkUpdate } from '../../src/update/update.js';
import { VERSION } from '../../src/version.js';
import { isolatedApply } from './fixture.js';

afterEach(() => vi.unstubAllEnvs());

function interrupted(state = 'running', step = 'claude') {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ww-operation-')));
  vi.stubEnv('WIGWAG_HOME', home);
  const base = join(home, 'global');
  const root = join(base, '@civicfs', 'wigwag');
  mkdirSync(root, { recursive: true });
  const progress = { format: 1, root, target: VERSION, providers: ['claude'], codex_binary: 'codex', pending: [step] };
  writeFileSync(join(home, 'update-progress.json'), JSON.stringify(progress));
  const receipt = {
    format: 1,
    id: '7354588e-5062-4f97-9ea8-f899b792629a',
    root,
    target: VERSION,
    step,
    state,
    worker_pid: 999999,
  };
  writeFileSync(join(home, 'update-operation.json'), JSON.stringify(receipt));
  return { home, root, base, receipt };
}

it('refuses an unknown command outcome before any external command on retry', async () => {
  const { home } = interrupted();
  const calls: string[] = [];
  await expect(
    isolatedApply(
      home,
      { current: VERSION, source: 'npm', available: VERSION, update_available: false },
      async (bin) => {
        calls.push(bin);
        throw new Error('external command must not run');
      },
    ),
  ).rejects.toThrow(/outcome unknown/i);
  expect(calls).toEqual([]);
});

it('reports an outstanding operation read-only without creating mutex files', async () => {
  const { home, receipt } = interrupted();
  const before = readFileSync(join(home, 'update-operation.json'), 'utf8');
  const status = await checkUpdate(async () => VERSION);
  expect(status).toMatchObject({ operation: { id: receipt.id, step: 'claude', state: 'running' } });
  expect(readFileSync(join(home, 'update-operation.json'), 'utf8')).toBe(before);
  expect(existsSync(join(home, 'update.mutex'))).toBe(false);
  expect(existsSync(join(home, 'update-operation.mutex'))).toBe(false);
});

it.each(['plugins', 'claude', 'package', 'broker'])(
  'reconciles successful %s receipt without replaying its command',
  async (step) => {
    const { root, home, base } = interrupted('succeeded', step);
    const calls: string[][] = [];
    const result = await isolatedApply(
      root,
      { current: VERSION, source: 'npm', available: VERSION, update_available: false },
      async (bin, args) => {
        calls.push([bin, ...args]);
        if (bin === 'npm' && args[0] === 'root') return base;
        if (args.includes('--version')) return VERSION;
        if (args.includes('status')) return 'healthy';
        throw new Error('completed mutation replayed');
      },
    );
    expect(result).toMatchObject({ completed: true, cli_verified: true, pending: [] });
    expect(calls.some((args) => args.includes('install') || args.includes('update') || args.includes('restart'))).toBe(
      false,
    );
    expect(readUpdateOperation(home)).toBeNull();
  },
);

it('does not mistake a successful package receipt for a verified CLI version', async () => {
  const { root, home, base } = interrupted('succeeded', 'package');
  const calls: string[][] = [];
  const result = await isolatedApply(
    root,
    { current: VERSION, source: 'npm', available: VERSION, update_available: false },
    async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'npm' && args[0] === 'root') return base;
      return '0.0.1';
    },
  );
  expect(result).toMatchObject({ completed: false, cli_verified: false, pending: ['package'] });
  expect(calls.some((args) => args.includes('install'))).toBe(false);
  expect(readUpdateOperation(home)?.state).toBe('succeeded');
});

it('rechecks and repairs a missing broker after reconciling its old success receipt', async () => {
  const { root, home, base } = interrupted('succeeded', 'broker');
  const calls: string[][] = [];
  const result = await isolatedApply(
    root,
    { current: VERSION, source: 'npm', available: VERSION, update_available: false },
    async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === 'npm' && args[0] === 'root') return base;
      if (args.includes('--version')) return VERSION;
      if (args.includes('status')) throw new Error('broker stopped');
      if (args.includes('restart')) return 'replaced';
      throw new Error('unexpected mutation');
    },
  );
  expect(result).toMatchObject({ completed: true });
  expect(calls.filter((args) => args.includes('restart'))).toHaveLength(1);
  expect(readUpdateOperation(home)).toBeNull();
});
