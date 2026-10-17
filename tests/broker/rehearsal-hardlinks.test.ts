import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import { BrokerLock } from '../../src/broker/lock.js';
import { initHome } from '../../src/config.js';
import { assertRehearsalHome, assertRehearsalStorage, REHEARSAL_STORAGE_PATHS } from '../../src/rehearsal.js';
import { SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from '../../src/store/schema.js';
import { FAKE_CODEX, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture() {
  const account = tmpHome(),
    live = join(account, '.wigwag'),
    copy = tmpHome();
  vi.stubEnv('HOME', account);
  vi.stubEnv('WIGWAG_TEST_ACCOUNT_HOME', account);
  vi.stubEnv('XDG_STATE_HOME', '');
  initHome(live, FAKE_CODEX);
  const file = join(live, 'state.db'),
    db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE schema_version(version INTEGER NOT NULL);${SCHEMA_V1}${SCHEMA_V2}${SCHEMA_V3}INSERT INTO schema_version VALUES(1),(2),(3);`,
  );
  db.close();
  vi.stubEnv('WIGWAG_REHEARSAL', '1');
  vi.stubEnv('WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS', '1');
  return { live, copy, file };
}
it.each(['before-validation', 'after-lock'])(
  'refuses a private fake live v3 database hard link introduced %s without migrating it',
  async (when) => {
    const f = fixture(),
      before = readFileSync(f.file);
    if (when === 'before-validation') linkSync(f.file, join(f.copy, 'state.db'));
    else {
      const acquire = BrokerLock.acquire;
      vi.spyOn(BrokerLock, 'acquire').mockImplementation((home, mode) => {
        const lock = acquire(home, mode);
        if (home === realpathSync.native(f.copy)) linkSync(f.file, join(f.copy, 'state.db'));
        return lock;
      });
    }
    const starting = startBroker(f.copy);
    void starting.then(
      (b) => cleanup.push(() => b.stop()),
      () => {},
    );
    await expect(starting).rejects.toThrow(/hard.?link|shared.*inode/i);
    expect(readFileSync(f.file)).toEqual(before);
    expect(existsSync(`${f.file}.pre-v4.bak`)).toBe(false);
    expect(existsSync(join(f.copy, 'state.db.pre-v4.bak'))).toBe(false);
  },
);
it.each([
  ...REHEARSAL_STORAGE_PATHS.filter((p) => !['logs', 'blobs', 'blobs/sha256', 'archive'].includes(p)),
  'archive/2026-10.db',
])('refuses a hard-linked inventoried regular file %s', (path) => {
  const f = fixture(),
    dest = join(f.copy, path);
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) unlinkSync(dest);
  linkSync(f.file, dest);
  expect(() => assertRehearsalStorage(f.copy)).toThrow(/hard.?link|shared.*inode/i);
});
it.each(['nested', 'nested/not-created'])('refuses a copy nested inside a private live home: %s', (part) => {
  const f = fixture();
  expect(() => assertRehearsalHome(join(f.live, part))).toThrow(/live home/i);
});
