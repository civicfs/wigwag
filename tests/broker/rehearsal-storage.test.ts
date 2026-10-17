import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startBroker } from '../../src/broker/assemble.js';
import { configPath, loadConfig } from '../../src/config.js';
import { REHEARSAL_STORAGE_PATHS, rehearsalStoragePaths } from '../../src/rehearsal.js';
import { putBlob } from '../../src/store/blobs.js';
import { ownerClient, tmpHome } from '../helpers.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  const home = tmpHome(),
    outside = tmpHome(),
    target = join(outside, 'foreign-storage');
  mkdirSync(target);
  vi.stubEnv('WIGWAG_REHEARSAL', '1');
  vi.stubEnv('WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS', '1');
  vi.stubEnv('CODEX_HOME', join(home, 'codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, 'claude'));
  return { home, outside, target };
}
it.each([
  'blobs',
  'blobs/sha256',
  'archive',
  'archive/2026-10.db',
  'state.db-wal',
  'state.db-shm',
  'state.db.pre-v4.bak',
  `state.db.pre-v4.${process.pid}.tmp`,
  `config.json.${process.pid}.tmp`,
  `broker.lock.${process.pid}.tmp`,
])('refuses escaped managed storage %s before opening state.db', async (name) => {
  const f = fixture(),
    path = join(f.home, name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(f.target, path);
  const starting = startBroker(f.home);
  void starting.then(
    (b) => cleanup.push(() => b.stop()),
    () => {},
  );
  await expect(starting).rejects.toThrow(/rehearsal.*storage.*outside/i);
  expect(existsSync(join(f.home, 'state.db'))).toBe(false);
  expect(readdirSync(f.target)).toEqual([]);
});
it.each([
  ['body', 'root'],
  ['attachment', 'root'],
  ['body', 'shard'],
  ['attachment', 'shard'],
])('contains %s blob writes through an escaped %s introduced after startup', async (kind, where) => {
  const f = fixture(),
    broker = await startBroker(f.home);
  cleanup.push(() => broker.stop());
  const owner = await ownerClient(f.home);
  cleanup.push(() => owner.destroy());
  const body = 'x'.repeat(loadConfig(f.home).limits.inline_body_bytes + 1),
    data = kind === 'body' ? Buffer.from(body) : Buffer.from('attachment fixture');
  const attachment = join(f.home, 'attachment.txt');
  writeFileSync(attachment, data);
  if (where === 'root') symlinkSync(f.target, join(f.home, 'blobs'));
  else {
    mkdirSync(join(f.home, 'blobs', 'sha256'), { recursive: true });
    const shard = createHash('sha256').update(data).digest('hex').slice(0, 2);
    symlinkSync(f.target, join(f.home, 'blobs', 'sha256', shard));
  }
  await expect(
    owner.call('owner.send', {
      to: 'no-worker',
      body: kind === 'body' ? body : 'short',
      priority: 'low',
      attach_paths: kind === 'attachment' ? [attachment] : [],
    }),
  ).rejects.toThrow(/rehearsal.*storage.*outside/i);
  expect(readdirSync(f.target, { recursive: true })).toEqual([]);
});
it('contains a pre-existing symlink at a dynamic blob temporary path', async () => {
  const f = fixture(),
    broker = await startBroker(f.home);
  cleanup.push(() => broker.stop());
  const owner = await ownerClient(f.home);
  cleanup.push(() => owner.destroy());
  const data = Buffer.from('temporary fixture'),
    hex = createHash('sha256').update(data).digest('hex'),
    parent = join(f.home, 'blobs', 'sha256', hex.slice(0, 2));
  mkdirSync(parent, { recursive: true });
  const attachment = join(f.home, 'temporary-attachment.txt');
  writeFileSync(attachment, data);
  const now = Date.now(),
    escaped = join(f.target, 'outside-file');
  symlinkSync(escaped, join(parent, `${hex.slice(2)}.tmp-${process.pid}-${now}`));
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await expect(
    owner.call('owner.send', { to: 'no-worker', body: 'short', priority: 'low', attach_paths: [attachment] }),
  ).rejects.toThrow(/rehearsal.*storage.*outside/i);
  expect(existsSync(escaped)).toBe(false);
});
it.each(['absolute', 'symlink'])(
  'contains explicit %s blob exports and keeps inline/inside-copy inspection available',
  async (where) => {
    const f = fixture(),
      broker = await startBroker(f.home);
    cleanup.push(() => broker.stop());
    const owner = await ownerClient(f.home);
    cleanup.push(() => owner.destroy());
    const data = Buffer.from('copy only'),
      blob = putBlob(broker.db, f.home, data, { created_by: 'owner', media_type: 'text/plain' }, 1024);
    let dest = join(f.target, 'exported');
    if (where === 'symlink') {
      symlinkSync(f.target, join(f.home, 'exports'));
      dest = join(f.home, 'exports', 'exported');
    }
    await expect(owner.call('blob.get', { ref: blob.ref, dest_path: dest })).rejects.toThrow(
      /rehearsal.*storage.*outside/i,
    );
    expect(readdirSync(f.target)).toEqual([]);
    expect(await owner.call('blob.get', { ref: blob.ref })).toMatchObject({ text: data.toString('utf8') });
    const safe = join(f.home, 'exported');
    await owner.call('blob.get', { ref: blob.ref, dest_path: safe });
    expect(readFileSync(safe)).toEqual(data);
  },
);

it('enumerates all implicit roots/files, current and leftover temporaries, and archive sidecars', () => {
  const f = fixture();
  mkdirSync(join(f.home, 'archive'));
  writeFileSync(join(f.home, 'archive', '2026-10.db'), '');
  writeFileSync(join(f.home, 'config.json.9876.tmp'), '');
  const paths = rehearsalStoragePaths(f.home).map((p) => relative(f.home, p));
  expect(paths).toEqual(
    expect.arrayContaining([
      'config.json',
      'rehearsal.json',
      'update-check.json',
      'broker.sock',
      'broker.lock',
      'broker.mutex',
      'broker.mutex-journal',
      'broker.mutex-wal',
      'broker.mutex-shm',
      'state.db',
      'state.db-wal',
      'state.db-shm',
      'state.db-journal',
      'state.db.pre-v3.bak',
      'state.db.pre-v4.bak',
      'logs',
      'logs/broker.log',
      'logs/hooks.log',
      'blobs',
      'blobs/sha256',
      'archive',
      'archive/2026-10.db',
      'archive/2026-10.db-wal',
      'archive/2026-10.db-shm',
      'archive/2026-10.db-journal',
      `config.json.${process.pid}.tmp`,
      `broker.lock.${process.pid}.tmp`,
      `state.db.pre-v3.${process.pid}.tmp`,
      `state.db.pre-v4.${process.pid}.tmp`,
      'config.json.9876.tmp',
    ]),
  );
});
it('refuses a symlink escape for every shared implicit storage entry', async () => {
  for (const name of REHEARSAL_STORAGE_PATHS) {
    const f = fixture(),
      path = join(f.home, name),
      foreign = join(f.target, 'escaped');
    if (name === 'config.json') {
      writeFileSync(foreign, readFileSync(configPath(f.home)));
      unlinkSync(path);
    }
    if (name === 'logs') rmdirSync(path);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(foreign, path);
    const starting = startBroker(f.home);
    void starting.then(
      (b) => cleanup.push(() => b.stop()),
      () => {},
    );
    await expect(starting, name).rejects.toThrow(/rehearsal.*storage.*outside/i);
    expect(existsSync(join(f.home, 'state.db'))).toBe(false);
  }
});
