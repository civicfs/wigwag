import { existsSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import { configPath, initHome } from '../../src/config.js';
import { assertRehearsalHome } from '../../src/rehearsal.js';
import { FAKE_CODEX, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
});
function account() {
  const home = tmpHome();
  vi.stubEnv('HOME', home);
  vi.stubEnv('WIGWAG_TEST_ACCOUNT_HOME', home);
  vi.stubEnv('XDG_STATE_HOME', '');
  return home;
}
function prepare(home: string) {
  initHome(home, FAKE_CODEX);
  vi.stubEnv('WIGWAG_REHEARSAL', '1');
  vi.stubEnv('WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS', '1');
  return home;
}
it.each(
  ['case', 'firmlink', 'home-override', 'default-xdg', 'xdg'].filter(
    (kind) => kind !== 'firmlink' || process.platform === 'darwin',
  ),
)('refuses a private live-home %s alias before state or marker writes', async (kind) => {
  const user = account();
  let live = join(user, '.wigwag');
  if (kind === 'default-xdg') live = join(user, '.local', 'state', 'wigwag');
  if (kind === 'xdg') {
    vi.stubEnv('XDG_STATE_HOME', join(user, 'custom-state'));
    live = join(user, 'custom-state', 'wigwag');
  }
  initHome(live, FAKE_CODEX);
  let alias = live;
  if (kind === 'case') alias = live.replace('.wigwag', '.WIGWAG');
  if (kind === 'firmlink') alias = `/System/Volumes/Data${realpathSync.native(live)}`;
  if (kind === 'case' || kind === 'firmlink') {
    // On a case-sensitive filesystem the missing leaf still must fail the conservative parent check.
    if (!existsSync(alias)) {
      expect(() => assertRehearsalHome(alias)).toThrow(/rehearsal.*live home/i);
      return;
    }
    expect(statSync(alias).ino).toBe(statSync(live).ino);
  }
  if (kind === 'home-override') vi.stubEnv('HOME', tmpHome());
  vi.stubEnv('WIGWAG_REHEARSAL', '1');
  vi.stubEnv('WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS', '1');
  const before = readFileSync(configPath(live));
  const starting = startBroker(alias);
  void starting.then(
    (b) => cleanup.push(() => b.stop()),
    () => {},
  );
  await expect(starting).rejects.toThrow(/rehearsal.*live home/i);
  expect(existsSync(join(live, 'state.db'))).toBe(false);
  expect(existsSync(join(live, 'rehearsal.json'))).toBe(false);
  expect(readFileSync(configPath(live))).toEqual(before);
});
it.each(['.WIGWAG', '.local/STATE/WIGWAG'])('refuses missing default leaves using parent identity: %s', (leaf) => {
  const home = account();
  vi.stubEnv('HOME', tmpHome());
  expect(() => assertRehearsalHome(join(home, leaf))).toThrow(/rehearsal.*live home/i);
});
it.each(['regular', 'symlink', 'listening', 'stale'])(
  'refuses every existing %s broker.sock entry before state or marker writes',
  async (kind) => {
    account();
    const home = prepare(tmpHome()),
      socket = join(home, 'broker.sock');
    let connected = 0;
    if (kind === 'regular') writeFileSync(socket, 'recorded');
    else if (kind === 'symlink') symlinkSync(join(home, 'missing-socket'), socket);
    else {
      const server = createServer((s) => {
        connected++;
        s.destroy();
      });
      await new Promise<void>((r) => server.listen(socket, r));
      if (kind === 'stale') {
        const moved = join(home, 'stale-socket');
        renameSync(socket, moved);
        await new Promise<void>((r) => server.close(() => r()));
        renameSync(moved, socket);
      } else cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    }
    const starting = startBroker(home);
    void starting.then(
      (b) => cleanup.push(() => b.stop()),
      () => {},
    );
    await expect(starting).rejects.toThrow(/rehearsal.*(?:broker\.sock|broker.socket)/i);
    expect(connected).toBe(0);
    expect(existsSync(join(home, 'state.db'))).toBe(false);
    expect(existsSync(join(home, 'rehearsal.json'))).toBe(false);
  },
);
