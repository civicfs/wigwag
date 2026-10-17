import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import {
  assertRehearsalHome,
  assertRehearsalStorage,
  assertRehearsalStoragePaths,
  REHEARSAL_STORAGE_PATHS,
  writeStorageFile,
} from '../../src/rehearsal.js';
import { putBlob } from '../../src/store/blobs.js';
import { ownerClient, tmpHome } from '../helpers.js';

const fsHooks = vi.hoisted(() => ({
  beforeWrite: null as null | ((path: unknown) => void),
  beforeAppend: null as null | ((path: unknown) => void),
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      fsHooks.beforeWrite?.(args[0]);
      fsHooks.beforeAppend?.(args[0]);
      return fs.openSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      fsHooks.beforeWrite?.(args[0]);
      return fs.writeFileSync(...args);
    },
    appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
      fsHooks.beforeAppend?.(args[0]);
      return fs.appendFileSync(...args);
    },
  };
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  fsHooks.beforeWrite = null;
  fsHooks.beforeAppend = null;
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
});
async function fixture() {
  const home = tmpHome(),
    outside = tmpHome(),
    liveLogs = join(outside, '.wigwag', 'logs');
  mkdirSync(liveLogs, { recursive: true });
  vi.stubEnv('WIGWAG_REHEARSAL', '1');
  vi.stubEnv('WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS', '1');
  const broker = await startBroker(home);
  cleanup.push(() => broker.stop());
  const owner = await ownerClient(home);
  cleanup.push(() => owner.destroy());
  const blob = putBlob(
    broker.db,
    home,
    Buffer.from('copy only'),
    { created_by: 'owner', media_type: 'text/plain' },
    1024,
  );
  return { home, outside, liveLogs, broker, owner, blob };
}
it('refuses the exact symlink/../export escape before writing to a private fake live home', async () => {
  const f = await fixture();
  symlinkSync(f.liveLogs, join(f.home, 'out'));
  // Keep the raw spelling: path.join would normalize away the exploit before the RPC sees it.
  const dest = `${f.home}/out/../rehearsal-export`;
  await expect(f.owner.call('blob.get', { ref: f.blob.ref, dest_path: dest })).rejects.toThrow(/parent|\.\./i);
  expect(existsSync(join(f.outside, '.wigwag', 'rehearsal-export'))).toBe(false);
});
it('rejects parent components for every inventory path and the home itself', async () => {
  const f = await fixture();
  symlinkSync(f.liveLogs, join(f.home, 'out'));
  for (const name of REHEARSAL_STORAGE_PATHS)
    expect(() => assertRehearsalStoragePaths(f.home, [`${f.home}/out/../${name}`]), name).toThrow(/parent|\.\./i);
  expect(() => assertRehearsalHome(`${f.home}/out/../copy`)).toThrow(/parent|\.\./i);
  expect(() => assertRehearsalStorage(`${f.home}/out/../copy`)).toThrow(/parent|\.\./i);
});
it('writes to the validated canonical export even if its in-copy directory alias changes before I/O', async () => {
  const f = await fixture(),
    safe = join(f.home, 'safe-exports'),
    alias = join(f.home, 'export-alias');
  mkdirSync(safe);
  symlinkSync(safe, alias);
  const canonical = `${realpathSync.native(safe)}/exported`;
  fsHooks.beforeWrite = (path) => {
    if (typeof path === 'string' && path.endsWith('/exported')) {
      fsHooks.beforeWrite = null;
      unlinkSync(alias);
      symlinkSync(f.liveLogs, alias);
    }
  };
  expect(await f.owner.call('blob.get', { ref: f.blob.ref, dest_path: `${alias}/exported` })).toMatchObject({
    written_to: canonical,
  });
  expect(readFileSync(canonical, 'utf8')).toBe('copy only');
  expect(existsSync(join(f.liveLogs, 'exported'))).toBe(false);
});
it('does not follow a log leaf swapped to a symlink immediately before append', async () => {
  const f = await fixture(),
    foreign = join(f.liveLogs, 'escaped-log');
  fsHooks.beforeAppend = (path) => {
    if (typeof path === 'string' && path.endsWith('/broker.log')) {
      fsHooks.beforeAppend = null;
      unlinkSync(path);
      symlinkSync(foreign, path);
    }
  };
  f.broker.log('copy only');
  expect(existsSync(foreign)).toBe(false);
});
it('checks the opened descriptor before truncating a leaf swapped to a hard link', async () => {
  const f = await fixture(),
    foreign = join(f.liveLogs, 'preserved'),
    dest = join(realpathSync.native(f.home), 'swap-target');
  let swapped = false;
  writeFileSync(foreign, 'original bytes');
  fsHooks.beforeWrite = (path) => {
    if (path === dest) {
      fsHooks.beforeWrite = null;
      linkSync(foreign, dest);
      swapped = true;
    }
  };
  expect(() => writeStorageFile(f.home, dest, 'replacement', 'w')).toThrow(/hard.?link/i);
  expect(swapped).toBe(true);
  expect(readFileSync(foreign, 'utf8')).toBe('original bytes');
});
