import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { configPath } from '../../src/config.js';
import { DIST_MAIN, tmpHome } from '../helpers.js';

function fixture() {
  const home = tmpHome(),
    bin = join(home, 'bin'),
    called = join(home, 'native-called');
  mkdirSync(bin);
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/bin/sh\ntouch '${called}'\nexit 0\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // Keep even a regression of the update guard offline; Yoga's embedded WASM uses a local data: fetch.
  const networkCalled = join(home, 'network-called'),
    preload = join(home, 'offline.mjs');
  writeFileSync(
    preload,
    `import { appendFileSync } from 'node:fs'; const localFetch = globalThis.fetch; globalThis.fetch = async (input, options) => { if (String(input?.url ?? input).startsWith('data:')) return localFetch(input, options); appendFileSync(${JSON.stringify(networkCalled)}, 'called'); throw new Error('fixture forbids network'); };`,
  );
  const config = JSON.parse(readFileSync(configPath(home), 'utf8'));
  config.codex.binary = join(bin, 'codex');
  writeFileSync(configPath(home), JSON.stringify(config));
  return {
    home,
    called,
    networkCalled,
    env: {
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      WIGWAG_HOME: home,
      WIGWAG_REHEARSAL: '1',
      WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS: '1',
      CODEX_HOME: join(home, 'codex'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}
function cli(args: string[], env: Record<string, string>, stdin = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((r) => {
    const child = spawn(process.execPath, [DIST_MAIN, ...args], { env: { ...process.env, ...env } });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => r({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
it('doctor reports rehearsal and the external-path warning without running native executable probes or opening a new DB', async () => {
  const f = fixture(),
    result = await cli(['doctor'], f.env);
  expect(result.stdout).toContain('rehearsal');
  expect(result.stdout).toContain('WARNING: rehearsal allows external paths');
  expect(result.stdout).toContain('native I/O disabled');
  expect(existsSync(f.called)).toBe(false);
  expect(existsSync(join(f.home, 'state.db'))).toBe(false);
});
it('normal CLI refuses a marked home before database inspection; explicit clear removes only the marker', async () => {
  const f = fixture(),
    marker = join(f.home, 'rehearsal.json');
  writeFileSync(marker, '{"format":1}', { mode: 0o600 });
  const normal = { ...f.env, WIGWAG_REHEARSAL: '0' };
  const denied = await cli(['doctor'], normal);
  expect(denied.code).not.toBe(0);
  expect(denied.stderr).toMatch(/marked rehearsal.*rehearsal clear/i);
  expect(denied.stdout).toBe('');
  expect(existsSync(marker)).toBe(true);
  const before = readFileSync(configPath(f.home));
  const cleared = await cli(['rehearsal', 'clear'], normal);
  expect(cleared.code).toBe(0);
  expect(cleared.stdout).toContain('retained answers');
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(configPath(f.home))).toEqual(before);
  expect(existsSync(join(f.home, 'state.db'))).toBe(false);
  expect(existsSync(f.called)).toBe(false);
});
it.each([
  ['claude'],
  ['codex'],
  ['install'],
  ['uninstall'],
  ['update', '--check'],
  ['update', '--apply'],
  ['mcp', '--agent', 'codex'],
])('refuses native/update command %j before invoking it', async (...args) => {
  const f = fixture(),
    result = await cli(args, f.env);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(/rehearsal.*disables/i);
  expect(existsSync(f.called)).toBe(false);
  expect(existsSync(join(f.home, 'update-check.json'))).toBe(false);
  expect(existsSync(f.networkCalled)).toBe(false);
});
it('requires an explicit absolute WIGWAG_HOME for rehearsal CLI', async () => {
  const f = fixture();
  expect((await cli(['doctor'], { ...f.env, WIGWAG_HOME: '' })).stderr).toMatch(/rehearsal.*absolute WIGWAG_HOME/i);
  expect((await cli(['doctor'], { ...f.env, WIGWAG_HOME: 'relative' })).stderr).toMatch(
    /rehearsal.*absolute WIGWAG_HOME/i,
  );
});
it('lifecycle hooks still fail open in a marked home', async () => {
  const f = fixture();
  writeFileSync(join(f.home, 'rehearsal.json'), '{}', { mode: 0o600 });
  const result = await cli(['hook', 'claude', 'Stop'], { ...f.env, WIGWAG_REHEARSAL: '0' }, '{"session_id":"T"}');
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

it('explicit clear refuses a home with a running broker socket and keeps its marker', async () => {
  const f = fixture(),
    marker = join(f.home, 'rehearsal.json'),
    server = createServer((s) => s.destroy());
  writeFileSync(marker, '{}', { mode: 0o600 });
  await new Promise<void>((r) => server.listen(join(f.home, 'broker.sock'), r));
  try {
    const result = await cli(['rehearsal', 'clear'], f.env);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Stop the rehearsal broker');
    expect(existsSync(marker)).toBe(true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
