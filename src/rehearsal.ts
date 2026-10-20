import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BrokerLock } from './broker/lock.js';
import { canConnect, sockPath } from './client/autospawn.js';
import type { Config } from './config.js';
import { WigwagError } from './errors.js';

export interface RehearsalMode {
  enabled: boolean;
  allow_external_paths: boolean;
  native_io: boolean;
  warning: string | null;
}
export const EXTERNAL_REHEARSAL_WARNING = 'WARNING: rehearsal allows external paths; ALL native I/O remains disabled.';
export const rehearsalMarker = (home: string): string => join(home, 'rehearsal.json');
export function rehearsalMode(config?: Pick<Config, 'rehearsal'>): RehearsalMode {
  const enabled = process.env.WIGWAG_REHEARSAL === '1' || config?.rehearsal.enabled === true;
  const external =
    enabled &&
    (process.env.WIGWAG_REHEARSAL_ALLOW_EXTERNAL_PATHS === '1' || config?.rehearsal.allow_external_paths === true);
  return {
    enabled,
    allow_external_paths: external,
    native_io: !enabled,
    warning: external ? EXTERNAL_REHEARSAL_WARNING : null,
  };
}
/** No config creation/migration; usable before init and before update network/cache work. */
export function homeRehearsalMode(home: string): RehearsalMode {
  if (process.env.WIGWAG_REHEARSAL === '1') noParentComponents(home);
  const configFile =
    process.env.WIGWAG_REHEARSAL === '1'
      ? containedStorage(assertRehearsalHome(home), join(home, 'config.json'))
      : join(home, 'config.json');
  let config: Pick<Config, 'rehearsal'> | undefined;
  try {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch {
    /* loadConfig reports invalid config. */
  }
  const mode = rehearsalMode(config?.rehearsal ? config : undefined);
  if (mode.enabled) noParentComponents(home);
  return mode;
}
function markerStat(home: string) {
  try {
    return lstatSync(rehearsalMarker(home));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export function assertRehearsalAccess(home: string, mode = homeRehearsalMode(home)): void {
  if (markerStat(home) && !mode.enabled)
    throw new WigwagError(
      'config',
      'Home is marked rehearsal; use WIGWAG_REHEARSAL=1 or explicitly remove the marker with wigwag rehearsal clear before normal use.',
    );
}
/** Resolve even missing leaves and dangling symlinks, without executing binaries or following an escape unnoticed. */
function noParentComponents(path: string): void {
  if (path.split('/').includes('..'))
    throw new WigwagError('config', 'Rehearsal paths must not contain a parent (..) component');
}
function canonical(path: string, depth = 0): string {
  noParentComponents(path); // before resolve/join can erase the OS's symlink-first meaning
  if (depth > 64) throw new WigwagError('config', 'Rehearsal path has too many symlinks');
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    try {
      if (lstatSync(abs).isSymbolicLink()) {
        const target = readlinkSync(abs);
        noParentComponents(target);
        return canonical(isAbsolute(target) ? target : `${dirname(abs)}/${target}`, depth + 1);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parent = dirname(abs);
    if (parent === abs) throw e;
    return join(canonical(parent, depth + 1), abs.slice(parent.length));
  }
}
/** Native realpath alone does not collapse every APFS firmlink; compare filesystem identity as well. */
function pathIdentity(path: string): { dev: number; ino: number; missing: string } {
  let existing = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = statSync(existing);
      return { dev: stat.dev, ino: stat.ino, missing: missing.join('/').toLowerCase() };
    } catch (e) {
      if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      const parent = dirname(existing);
      if (parent === existing) throw e;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}
function knownLiveHomes(): string[] {
  const accountHomes = new Set([userInfo().homedir, homedir(), process.env.HOME].filter((p): p is string => !!p));
  return [
    ...[...accountHomes].flatMap((p) => [join(p, '.wigwag'), join(p, '.local', 'state', 'wigwag')]),
    ...(process.env.XDG_STATE_HOME ? [join(process.env.XDG_STATE_HOME, 'wigwag')] : []),
  ];
}
export function assertRehearsalHome(home: string): string {
  if (!isAbsolute(home)) throw new WigwagError('config', 'Rehearsal requires an explicit absolute WIGWAG_HOME');
  const actual = canonical(home);
  const identity = pathIdentity(actual);
  // userInfo is independent of $HOME; nearest-parent identity also catches missing nested leaves and firmlinks.
  if (
    knownLiveHomes().some((p) => {
      const rel = relative(canonical(p), actual);
      if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))) return true;
      const candidate = pathIdentity(p);
      const within = (x: ReturnType<typeof pathIdentity>) =>
        candidate.dev === x.dev &&
        candidate.ino === x.ino &&
        (candidate.missing === '' || candidate.missing === x.missing || x.missing.startsWith(`${candidate.missing}/`));
      if (within(identity)) return true;
      for (let parent = dirname(actual); ; parent = dirname(parent)) {
        if (within(pathIdentity(parent))) return true;
        if (dirname(parent) === parent) return false;
      }
    })
  )
    throw new WigwagError('config', 'Rehearsal refuses the default live home; use a separate copied WIGWAG_HOME.');
  return actual;
}
/** Every implicit writable root/file. Dynamic leaves must also use assertRehearsalStoragePaths before I/O. */
export const REHEARSAL_STORAGE_PATHS: readonly string[] = Object.freeze([
  'config.json',
  'rehearsal.json',
  'update-check.json',
  'broker.lock',
  'broker.sock',
  'logs',
  'logs/broker.log',
  'logs/hooks.log',
  'blobs',
  'blobs/sha256',
  'archive',
  ...['state.db', 'broker.mutex'].flatMap((file) => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]),
  ...[3, 4, 5].map((version) => `state.db.pre-v${version}.bak`),
]);
function containedStorage(home: string, path: string): string {
  if (!isAbsolute(path)) throw new WigwagError('config', 'Rehearsal storage requires absolute paths');
  const actual = canonical(path),
    rel = relative(canonical(home), actual);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
    throw new WigwagError('config', `Rehearsal storage ${path} is outside WIGWAG_HOME`);
  let stat: Stats;
  try {
    stat = statSync(actual);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return actual;
    throw e;
  }
  if (stat.isFile()) {
    if (stat.nlink > 1)
      throw new WigwagError('config', `Rehearsal storage ${path} has a hard link; use an independent copy.`);
    for (const live of knownLiveHomes()) {
      try {
        const other = statSync(join(live, rel));
        if (other.isFile() && other.dev === stat.dev && other.ino === stat.ino)
          throw new WigwagError(
            'config',
            `Rehearsal storage ${path} shares an inode with a live home; use an independent copy.`,
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  }
  return actual;
}
/** Include current temporary names and leftover managed temp/archive entries, without traversing the blob store. */
export function rehearsalStoragePaths(home: string): string[] {
  noParentComponents(home);
  const paths = new Set(REHEARSAL_STORAGE_PATHS.map((name) => join(home, name)));
  for (const name of [
    `config.json.${process.pid}.tmp`,
    `broker.lock.${process.pid}.tmp`,
    ...[3, 4, 5].map((version) => `state.db.pre-v${version}.${process.pid}.tmp`),
  ])
    paths.add(join(home, name));
  for (const directory of [home, join(home, 'archive')]) {
    const actualDirectory = containedStorage(home, directory);
    try {
      for (const name of readdirSync(actualDirectory))
        if (
          directory !== home ||
          /^(?:config\.json\.\d+\.tmp|broker\.lock\.\d+\.tmp|state\.db\.pre-v\d+(?:\.\d+\.tmp|\.bak))$/.test(name)
        ) {
          const file = join(directory, name);
          paths.add(file);
          if (directory !== home && name.endsWith('.db'))
            for (const suffix of ['-wal', '-shm', '-journal']) paths.add(file + suffix);
        }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return [...paths];
}
export function assertRehearsalStorage(home: string): void {
  noParentComponents(home);
  try {
    if (lstatSync(sockPath(home)).isSymbolicLink())
      throw new WigwagError(
        'config',
        'Rehearsal storage broker.sock is a symlink; outside or aliased broker sockets are refused.',
      );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // Validate roots before listing any archive directory, so a copied symlink cannot even route inspection outside.
  for (const name of REHEARSAL_STORAGE_PATHS) containedStorage(home, join(home, name));
  for (const path of rehearsalStoragePaths(home)) containedStorage(home, path);
}
/** Validate actual blob/temp/export leaves again at I/O time; the external-native-path override never applies. */
export function assertRehearsalStoragePaths(home: string, paths: string[], mode = homeRehearsalMode(home)): string[] {
  assertRehearsalAccess(home, mode);
  if (!mode.enabled) return paths;
  assertRehearsalHome(home);
  return paths.map((path) => containedStorage(home, path));
}
/** Use on the returned canonical leaf; prevent a final-leaf symlink swap where Node exposes O_NOFOLLOW. */
export function storageFlags(home: string, flag: 'a' | 'w' | 'wx', mode = homeRehearsalMode(home)): string | number {
  if (!mode.enabled) return flag;
  return (
    constants.O_WRONLY |
    constants.O_CREAT |
    (constants.O_NOFOLLOW ?? 0) |
    (flag === 'a' ? constants.O_APPEND : flag === 'wx' ? constants.O_EXCL : constants.O_TRUNC)
  );
}
/** Open our own checked descriptor; never truncate or pass a newly swapped hard link to a child. */
export function openStorageFile(
  home: string,
  file: string,
  flag: 'a' | 'w' | 'wx',
  mode = homeRehearsalMode(home),
): number {
  const [actual] = assertRehearsalStoragePaths(home, [file], mode);
  if (!mode.enabled) return openSync(actual, flag, 0o600);
  const flags = (storageFlags(home, flag, mode) as number) & ~constants.O_TRUNC;
  const fd = openSync(actual, flags | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink > 1)
      throw new WigwagError('config', 'Rehearsal write refuses non-regular or hard-linked storage');
    if (flag === 'w') ftruncateSync(fd, 0);
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}
export function writeStorageFile(
  home: string,
  file: string,
  data: string | Uint8Array,
  flag: 'a' | 'w' | 'wx',
  mode = homeRehearsalMode(home),
): void {
  const fd = openStorageFile(home, file, flag, mode);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}
/** SQLite chooses its own auxiliary filenames; require canonical, unshared paths instead of following aliases. */
export function rehearsalSqlitePath(
  home: string,
  file: string,
  migrations = false,
  mode = homeRehearsalMode(home),
): string {
  const [actual] = assertRehearsalStoragePaths(home, [file], mode);
  if (mode.enabled) {
    const auxiliary = ['-wal', '-shm', '-journal'].map((suffix) => actual + suffix);
    if (migrations)
      for (const v of [3, 4, 5]) auxiliary.push(`${actual}.pre-v${v}.bak`, `${actual}.pre-v${v}.${process.pid}.tmp`);
    const checked = assertRehearsalStoragePaths(home, auxiliary, mode);
    if (auxiliary.some((path, i) => path !== checked[i]))
      throw new WigwagError('config', 'Rehearsal SQLite auxiliary paths must not be aliased');
  }
  return actual;
}
/** Used by every owner CLI connection before any socket probe or autospawn. */
export function assertRehearsalClientPaths(home: string, config: Config): RehearsalMode {
  const mode = rehearsalMode(config);
  assertRehearsalAccess(home, mode);
  if (mode.enabled) {
    assertRehearsalHome(home);
    assertRehearsalStorage(home);
  }
  return mode;
}
export async function validateRehearsal(home: string, config: Config, mode = rehearsalMode(config)): Promise<void> {
  assertRehearsalAccess(home, mode);
  if (!mode.enabled) return;
  home = assertRehearsalHome(home);
  assertRehearsalStorage(home);
  // Startup only: a prepared sqlite backup/config copy contains no socket. Owner inspection connections still work.
  try {
    lstatSync(sockPath(home));
    throw new WigwagError(
      'config',
      'Rehearsal refuses an existing broker.sock entry (possibly a running broker); prepare a copy without sockets, or deliberately remove this entry after confirming its broker is stopped.',
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // Every broker owns <home>/broker.sock. Probe only this explicit home (including aliases), never enumerate pids/homes.
  if (await canConnect(sockPath(home), AbortSignal.timeout(1000)))
    throw new WigwagError('config', 'Rehearsal refuses the home of a running broker.');
  if (mode.allow_external_paths) return;
  const root = canonical(home);
  for (const [label, path] of Object.entries({
    socket: config.questions.app_server_socket,
    binary: config.codex.binary,
    CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  })) {
    if (!isAbsolute(path))
      throw new WigwagError('config', `Rehearsal ${label} must be an absolute path inside WIGWAG_HOME`);
    const rel = relative(root, canonical(path));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
      throw new WigwagError(
        'config',
        `Rehearsal ${label} is outside WIGWAG_HOME; native I/O is disabled, but external paths require an explicit override.`,
      );
  }
}
/** Called only while the broker mutex is held, before state.db is opened. The marker survives failed migrations. */
export function markRehearsal(home: string, mode: RehearsalMode): void {
  assertRehearsalAccess(home, mode);
  if (!mode.enabled) return;
  const [marker] = assertRehearsalStoragePaths(home, [rehearsalMarker(home)], mode);
  const stat = markerStat(home);
  if (stat) {
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new WigwagError('config', 'Rehearsal marker must be a regular file with mode 0600');
    return;
  }
  writeStorageFile(
    home,
    marker,
    `${JSON.stringify({ format: 1, created_at: new Date().toISOString(), native_disabled: true })}\n`,
    'wx',
    mode,
  );
}
/** Explicit owner command only: no DB open, broker start, native I/O, or config mutation. */
export async function clearRehearsal(home: string): Promise<boolean> {
  home = assertRehearsalHome(home);
  assertRehearsalStorage(home);
  if (await canConnect(sockPath(home), AbortSignal.timeout(1000)))
    throw new WigwagError('conflict', 'Stop the rehearsal broker before wigwag rehearsal clear.');
  const mode = { ...homeRehearsalMode(home), enabled: true, native_io: false };
  const [marker] = assertRehearsalStoragePaths(home, [rehearsalMarker(home)], mode);
  const lock = BrokerLock.acquire(home, mode);
  try {
    const stat = markerStat(home);
    if (!stat) return false;
    if (!stat.isFile()) throw new WigwagError('config', 'Rehearsal marker is not a regular file; not removed');
    unlinkSync(marker);
    return true;
  } finally {
    lock.release();
  }
}
export function assertNativeAllowed(home: string, action: string): void {
  const mode = homeRehearsalMode(home);
  assertRehearsalAccess(home, mode);
  if (mode.enabled)
    throw new WigwagError('forbidden', `Rehearsal disables ${action}; native I/O and update checks are unavailable.`);
}
