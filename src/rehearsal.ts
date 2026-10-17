import { lstatSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  let config: Pick<Config, 'rehearsal'> | undefined;
  try {
    config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  } catch {
    /* loadConfig reports invalid config. */
  }
  return rehearsalMode(config?.rehearsal ? config : undefined);
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
function canonical(path: string, depth = 0): string {
  if (depth > 64) throw new WigwagError('config', 'Rehearsal path has too many symlinks');
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    try {
      if (lstatSync(abs).isSymbolicLink()) return canonical(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const parent = dirname(abs);
    if (parent === abs) throw e;
    return join(canonical(parent, depth + 1), abs.slice(parent.length));
  }
}
export function assertRehearsalHome(home: string): void {
  if (!isAbsolute(home)) throw new WigwagError('config', 'Rehearsal requires an explicit absolute WIGWAG_HOME');
  const actual = canonical(home);
  const defaults = [
    join(homedir(), '.wigwag'),
    ...(process.env.XDG_STATE_HOME ? [join(process.env.XDG_STATE_HOME, 'wigwag')] : []),
  ];
  if (defaults.some((p) => canonical(p) === actual))
    throw new WigwagError('config', 'Rehearsal refuses the default live home; use a separate copied WIGWAG_HOME.');
}
export function assertRehearsalStorage(home: string): void {
  const root = canonical(home);
  try {
    if (lstatSync(sockPath(home)).isSymbolicLink())
      throw new WigwagError(
        'config',
        'Rehearsal storage broker.sock is a symlink; outside or aliased broker sockets are refused.',
      );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  // External-native-path overrides never permit state/mutex/log writes or broker socket probes outside the copy.
  for (const name of [
    'state.db',
    'broker.mutex',
    'broker.lock',
    'broker.sock',
    'logs',
    'logs/broker.log',
    'rehearsal.json',
  ]) {
    const rel = relative(root, canonical(join(home, name)));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
      throw new WigwagError('config', `Rehearsal storage ${name} is outside WIGWAG_HOME`);
  }
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
  assertRehearsalHome(home);
  assertRehearsalStorage(home);
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
  const stat = markerStat(home);
  if (stat) {
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new WigwagError('config', 'Rehearsal marker must be a regular file with mode 0600');
    return;
  }
  writeFileSync(
    rehearsalMarker(home),
    `${JSON.stringify({ format: 1, created_at: new Date().toISOString(), native_disabled: true })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
}
/** Explicit owner command only: no DB open, broker start, native I/O, or config mutation. */
export async function clearRehearsal(home: string): Promise<boolean> {
  assertRehearsalHome(home);
  assertRehearsalStorage(home);
  if (await canConnect(sockPath(home), AbortSignal.timeout(1000)))
    throw new WigwagError('conflict', 'Stop the rehearsal broker before wigwag rehearsal clear.');
  const lock = BrokerLock.acquire(home);
  try {
    const stat = markerStat(home);
    if (!stat) return false;
    if (!stat.isFile()) throw new WigwagError('config', 'Rehearsal marker is not a regular file; not removed');
    unlinkSync(rehearsalMarker(home));
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
