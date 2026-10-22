import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkUpdate, type Run } from '../../src/update/update.js';
import { VERSION } from '../../src/version.js';
import { isolatedApply } from './fixture.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ww-update-home-'));
  vi.stubEnv('WIGWAG_HOME', home);
});
afterEach(() => vi.unstubAllEnvs());

function fixture(fail?: string, version = '99.0.0') {
  const base = mkdtempSync(join(tmpdir(), 'ww-update-global-'));
  const root = join(base, '@civicfs', 'wigwag');
  mkdirSync(root, { recursive: true });
  const calls: Array<[string, string[]]> = [];
  const execute: Run = async (bin, args) => {
    calls.push([bin, args]);
    if (bin === 'npm' && args[0] === 'root') return base;
    if (args.includes('--version')) return version;
    if (args[1] === 'list')
      return bin === 'claude' ? '[{"id":"wigwag@wigwag"}]' : '{"installed":[{"pluginId":"wigwag@wigwag"}]}';
    if (
      (fail === 'plugins' && args.includes('install') && bin !== 'npm') ||
      (fail === 'claude' && args[1] === 'update') ||
      (fail === 'broker' && args.includes('restart')) ||
      (fail === 'package' && bin === 'npm' && args[0] === 'install')
    )
      throw new Error(`${fail} fixture failure`);
    return '';
  };
  return { root, execute, calls };
}

it.each(['plugins', 'claude'])(
  'replaces the broker despite %s failure, and resumes only pending work at the installed version',
  async (failure) => {
    const f = fixture(failure);
    const result = await isolatedApply(
      f.root,
      await checkUpdate(async () => '99.0.0'),
      f.execute,
      () => true,
      '/custom/codex',
    );
    expect(result).toMatchObject({ completed: false, cli_verified: true, pending: [failure] });
    expect(f.calls.some(([, args]) => args.includes('restart'))).toBe(true);
    const journal = JSON.parse(readFileSync(join(home, 'update-progress.json'), 'utf8'));
    expect(journal).toMatchObject({
      target: '99.0.0',
      providers: ['claude', 'codex'],
      codex_binary: '/custom/codex',
      pending: [failure],
    });
    expect(statSync(join(home, 'update-progress.json')).mode & 0o777).toBe(0o600);
    f.calls.length = 0;
    const resume: Run = async (bin, args, cwd) => {
      if (args.includes('--version')) {
        f.calls.push([bin, args]);
        return '99.0.0';
      }
      if (args.includes('install') && bin !== 'npm') {
        f.calls.push([bin, args]);
        return '';
      }
      if (args[1] === 'update') {
        f.calls.push([bin, args]);
        return '';
      }
      return f.execute(bin, args, cwd);
    };
    const repaired = await isolatedApply(
      f.root,
      { current: '99.0.0', source: 'npm', available: '99.0.0', update_available: false },
      resume,
      () => false,
      'wrong-binary',
    );
    expect(repaired).toMatchObject({ completed: true, resumed: true, pending: [], providers: ['claude', 'codex'] });
    expect(f.calls.some(([bin, args]) => bin === 'npm' && args[0] === 'install')).toBe(false);
    expect(f.calls.some(([, args]) => args.includes('restart'))).toBe(false);
    if (failure === 'plugins')
      expect(f.calls.find(([, args]) => args.includes('install'))?.[1]).toContain('/custom/codex');
    expect(existsSync(join(home, 'update-progress.json'))).toBe(false);
  },
);

it('retains broker failure as repair work and reports manual reload/trust separately', async () => {
  const f = fixture('broker');
  const result = await isolatedApply(
    f.root,
    await checkUpdate(async () => '99.0.0'),
    f.execute,
    () => true,
    '/custom/codex',
  );
  expect(result).toMatchObject({ completed: false, pending: ['broker'] });
  expect(result?.next_steps.join('\n')).toMatch(/\/reload-plugins/);
  expect(result?.next_steps.join('\n')).toMatch(/\/mcp.*reconnect.*Wigwag|restart Claude/);
  expect(result?.next_steps.join('\n')).toContain('client.version');
  expect(result?.next_steps.join('\n')).toMatch(/restart.*Codex|Codex.*restart/);
  expect(result?.next_steps.join('\n')).toMatch(/trust/);
  expect(result?.next_steps.join('\n')).toMatch(/wigwag who/);
  expect(result?.next_steps.join('\n')).toMatch(/wigwag doctor/);
});

it('refuses to refresh plugins or replace the broker if the newly installed CLI has the wrong version', async () => {
  const f = fixture(undefined, VERSION);
  const result = await isolatedApply(f.root, await checkUpdate(async () => '99.0.0'), f.execute, () => true, 'codex');
  expect(result).toMatchObject({ completed: false, cli_verified: false });
  expect(f.calls.some(([, args]) => args.includes('restart'))).toBe(false);
  expect(f.calls.some(([bin, args]) => bin !== 'npm' && args.includes('install'))).toBe(false);
  expect(existsSync(join(home, 'update-progress.json'))).toBe(true);
});

it('continues safe post-install repair when npm fails after replacing the CLI', async () => {
  const f = fixture('package');
  const result = await isolatedApply(f.root, await checkUpdate(async () => '99.0.0'), f.execute, () => true, 'codex');
  expect(result).toMatchObject({ cli_verified: true });
  expect(f.calls.some(([, args]) => args.includes('restart'))).toBe(true);
});

it('read-only checking surfaces pending work without changing the journal or calling provider commands', async () => {
  const f = fixture('broker');
  await isolatedApply(f.root, await checkUpdate(async () => '99.0.0'), f.execute, () => true, 'codex');
  const before = readFileSync(join(home, 'update-progress.json'), 'utf8');
  const status = await checkUpdate(async () => VERSION);
  expect(status).toMatchObject({ update_available: false, pending: { version: '99.0.0', pending: ['broker'] } });
  expect(readFileSync(join(home, 'update-progress.json'), 'utf8')).toBe(before);
});

it('refuses a symlink journal before running any installation command', async () => {
  const f = fixture();
  const other = join(home, 'untouched');
  writeFileSync(other, 'keep');
  symlinkSync(other, join(home, 'update-progress.json'));
  await expect(
    isolatedApply(f.root, { current: VERSION, source: 'npm', available: '99.0.0', update_available: true }, f.execute),
  ).rejects.toThrow(/progress|symlink/i);
  expect(f.calls).toEqual([]);
  expect(readFileSync(other, 'utf8')).toBe('keep');
});

it('reports pending repair during an offline read-only check', async () => {
  const f = fixture('broker');
  await isolatedApply(f.root, await checkUpdate(async () => '99.0.0'), f.execute, () => true, 'codex');
  const before = readFileSync(join(home, 'update-progress.json'), 'utf8');
  const status = await checkUpdate(async () => {
    throw new Error('offline');
  });
  expect(status).toMatchObject({
    available: null,
    update_available: false,
    pending: { version: '99.0.0', pending: ['broker'] },
  });
  expect(readFileSync(join(home, 'update-progress.json'), 'utf8')).toBe(before);
});

it('recovers a crash immediately after package replacement without reinstalling or broadening Claude-only scope', async () => {
  const f = fixture(undefined, VERSION);
  writeFileSync(
    join(home, 'update-progress.json'),
    JSON.stringify({
      format: 1,
      root: realpathSync(f.root),
      target: VERSION,
      providers: ['claude'],
      codex_binary: '/remembered/codex',
      pending: ['package', 'plugins', 'claude', 'broker'],
    }),
  );
  const result = await isolatedApply(
    f.root,
    { current: VERSION, source: 'npm', available: VERSION, update_available: false },
    f.execute,
    () => false,
    'wrong',
  );
  expect(result).toMatchObject({ resumed: true, completed: true, pending: [], providers: ['claude'] });
  expect(f.calls.some(([bin, args]) => bin === 'npm' && args[0] === 'install')).toBe(false);
  expect(f.calls.find(([, args]) => args.includes('install'))?.[1]).toEqual([
    join(f.root, 'dist', 'main.js'),
    'install',
    '--claude-only',
  ]);
  expect(result?.next_steps.join('\n')).not.toMatch(/Codex: restart/);
});

it('excludes concurrent apply before any second updater command or journal write, then releases on completion', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const status = await checkUpdate(async () => '99.0.0');
  const first = isolatedApply(
    f.root,
    status,
    async (bin, args, cwd) => {
      const result = await f.execute(bin, args, cwd);
      if (bin === 'npm' && args[0] === 'install') await held;
      return result;
    },
    () => true,
    'codex',
  );
  await vi.waitFor(() => expect(f.calls.some(([bin, args]) => bin === 'npm' && args[0] === 'install')).toBe(true));
  const before = readFileSync(join(home, 'update-progress.json'), 'utf8');
  let secondCommands = 0;
  try {
    await expect(
      isolatedApply(f.root, status, async () => {
        secondCommands++;
        return '';
      }),
    ).rejects.toThrow(/update.*running|update.*progress/i);
    await expect(
      isolatedApply(f.root, status, async () => {
        secondCommands++;
        return '';
      }),
    ).rejects.toThrow(/update.*running/i);
    expect(secondCommands).toBe(0);
    expect(readFileSync(join(home, 'update-progress.json'), 'utf8')).toBe(before);
  } finally {
    release();
    await first;
  }
  expect(await isolatedApply(f.root, { ...status, update_available: false }, f.execute)).toBeNull();
});

it('releases upgrade exclusion after preflight failure so the next apply can recover', async () => {
  const f = fixture();
  const status = await checkUpdate(async () => '99.0.0');
  await expect(
    isolatedApply(f.root, status, async () => {
      throw new Error('preflight fixture failure');
    }),
  ).rejects.toThrow('preflight fixture failure');
  expect(await isolatedApply(f.root, status, f.execute, () => true, 'codex')).toMatchObject({ completed: true });
});

it.each(['not running', 'wrong version'])(
  'revalidates a checkpointed broker and repairs %s before claiming completed upgrade',
  async (reason) => {
    const f = fixture(undefined, VERSION);
    writeFileSync(
      join(home, 'update-progress.json'),
      JSON.stringify({
        format: 1,
        root: realpathSync(f.root),
        target: VERSION,
        providers: ['claude'],
        codex_binary: 'codex',
        pending: ['claude'],
      }),
    );
    const result = await isolatedApply(
      f.root,
      { current: VERSION, source: 'npm', available: VERSION, update_available: false },
      async (bin, args, cwd) => {
        if (args.includes('status')) {
          f.calls.push([bin, args]);
          throw new Error(reason);
        }
        if (args.includes('restart')) {
          expect(JSON.parse(readFileSync(join(home, 'update-progress.json'), 'utf8')).pending).toContain('broker');
        }
        return f.execute(bin, args, cwd);
      },
      () => false,
      'codex',
    );
    expect(result).toMatchObject({ completed: true });
    expect(
      f.calls.some(
        ([, args]) => args.includes('status') && args.includes('--expect-version') && args.includes(VERSION),
      ),
    ).toBe(true);
    expect(f.calls.some(([, args]) => args.includes('restart'))).toBe(true);
  },
);

it.each(['claude', 'codex'])(
  'explicit same-version repair bootstraps a %s-only journal without npm installation',
  async (provider) => {
    const f = fixture(undefined, VERSION);
    const custom = '/custom/repair-codex';
    const result = await isolatedApply(
      f.root,
      { current: VERSION, source: 'npm', available: VERSION, update_available: false },
      async (bin, args, cwd) => {
        if (args.includes('--version')) {
          expect(JSON.parse(readFileSync(join(home, 'update-progress.json'), 'utf8'))).toMatchObject({
            target: VERSION,
            providers: [provider],
            codex_binary: custom,
            pending: provider === 'claude' ? ['plugins', 'claude', 'broker'] : ['plugins', 'broker'],
          });
        }
        return f.execute(bin, args, cwd);
      },
      (name) => name === (provider === 'claude' ? 'claude' : custom),
      custom,
      { repair: true },
    );
    expect(result).toMatchObject({
      version: VERSION,
      completed: true,
      cli_verified: true,
      resumed: false,
      providers: [provider],
    });
    expect(f.calls.some(([bin, args]) => bin === 'npm' && args[0] === 'install')).toBe(false);
    expect(f.calls.find(([, args]) => args.includes('install'))?.[1]).toContain(`--${provider}-only`);
    expect(f.calls.some(([, args]) => args.includes('restart') && args.includes(VERSION))).toBe(true);
  },
);

it('repair flag preserves a pending recorded version, provider scope and custom binary', async () => {
  const f = fixture(undefined, '99.0.0');
  writeFileSync(
    join(home, 'update-progress.json'),
    JSON.stringify({
      format: 1,
      root: realpathSync(f.root),
      target: '99.0.0',
      providers: ['codex'],
      codex_binary: '/recorded/codex',
      pending: ['plugins', 'broker'],
    }),
  );
  const result = await isolatedApply(
    f.root,
    { current: VERSION, source: 'npm', available: VERSION, update_available: false },
    f.execute,
    () => false,
    '/wrong/codex',
    { repair: true },
  );
  expect(result).toMatchObject({ version: '99.0.0', completed: true, resumed: true, providers: ['codex'] });
  expect(f.calls.find(([, args]) => args.includes('install'))?.[1]).toContain('/recorded/codex');
  expect(f.calls.some(([bin, args]) => bin === 'npm' && args[0] === 'install')).toBe(false);
});

it('ordinary clean same-version apply remains a no-op without a repair journal or mutex', async () => {
  const f = fixture(undefined, VERSION);
  expect(
    await isolatedApply(
      f.root,
      { current: VERSION, source: 'npm', available: VERSION, update_available: false },
      f.execute,
    ),
  ).toBeNull();
  expect(f.calls).toEqual([]);
  expect(existsSync(join(home, 'update-progress.json'))).toBe(false);
  expect(existsSync(join(home, 'update.mutex'))).toBe(false);
});

it('repairs an incompatible old broker before plugin install needs the target broker, completing explicit repair in one pass', async () => {
  const f = fixture(undefined, VERSION);
  let targetBrokerReady = false;
  const result = await isolatedApply(
    f.root,
    { current: VERSION, source: 'npm', available: VERSION, update_available: false },
    async (bin, args, cwd) => {
      if (args.includes('restart')) targetBrokerReady = true;
      if (bin !== 'npm' && args.includes('install') && !targetBrokerReady)
        throw new Error('plugin install ensureBroker rejected incompatible old broker');
      return f.execute(bin, args, cwd);
    },
    () => true,
    '/custom/codex',
    { repair: true },
  );
  expect(result).toMatchObject({ completed: true, pending: [], cli_verified: true });
  expect(f.calls.some(([, args]) => args.includes('install') && args.includes('/custom/codex'))).toBe(true);
});
