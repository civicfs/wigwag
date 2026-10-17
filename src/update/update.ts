import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { whichBin } from '../cli/commands/init.js';
import { loadConfig, resolveHome } from '../config.js';
import { assertNativeAllowed, assertRehearsalAccess, homeRehearsalMode } from '../rehearsal.js';
import { VERSION } from '../version.js';

const PACKAGE = '@civicfs/wigwag';
export interface UpdateStatus {
  current: string;
  source: 'npm';
  available: string | null;
  update_available: boolean;
  reason?: string;
}
export type Run = (bin: string, args: string[], cwd: string) => Promise<string>;
export const run: Run = (bin, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { cwd, timeout: 120000, maxBuffer: 1048576 }, (error, stdout) => {
      // Command errors may echo credentials or remote URLs. Report the operation only.
      if (error) reject(new Error(`${bin} ${args[0]} failed; inspect the installation locally`));
      else resolve(stdout.trim());
    });
  });
async function latest(): Promise<string> {
  const response = await fetch('https://registry.npmjs.org/@civicfs%2fwigwag/latest', {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('No published npm release is available for checking');
  let body = '';
  if (!response.body) throw new Error('Empty update response');
  const decoder = new TextDecoder();
  for await (const part of response.body) {
    body += decoder.decode(part, { stream: true });
    if (Buffer.byteLength(body) > 65536) {
      throw new Error('Update response exceeds limit');
    }
  }
  const version: unknown = JSON.parse(body).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  return version;
}
const newer = (a: string, b: string) => {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
};
export async function checkUpdate(readLatest: () => Promise<string> = latest): Promise<UpdateStatus> {
  assertNativeAllowed(resolveHome(), 'update checks');
  const available = await readLatest();
  if (!/^\d+\.\d+\.\d+$/.test(available)) throw new Error('Invalid release version');
  return { current: VERSION, source: 'npm', available, update_available: newer(available, VERSION) };
}
function configuredCodex(): string {
  try {
    return loadConfig(resolveHome()).codex.binary;
  } catch {
    return 'codex';
  }
}
export async function applyUpdate(
  root: string,
  status: UpdateStatus,
  execute: Run = run,
  hasCli: (name: string) => boolean = (name) => whichBin(name) !== null,
  codexBinary = configuredCodex(),
): Promise<void> {
  assertNativeAllowed(resolveHome(), 'updates');
  if (!status.update_available || !status.available) return;
  if (existsSync(join(root, '.git')))
    throw new Error(
      'Development checkout links are not self-updated. Install the published npm CLI and re-register its plugin marketplaces first.',
    );
  if (!/^\d+\.\d+\.\d+$/.test(status.available) || !newer(status.available, VERSION))
    throw new Error('Invalid or older release');
  const globalRoot = await execute('npm', ['root', '--global'], root);
  const installed = join(globalRoot, '@civicfs', 'wigwag');
  if (!existsSync(installed) || realpathSync(installed) !== realpathSync(root))
    throw new Error('This is not a global CLI install; update with your package manager');
  if (lstatSync(installed).isSymbolicLink())
    throw new Error('Linked development installs are not self-updated; use a published npm installation');
  const providers: string[] = [];
  if (hasCli('claude')) {
    const list: unknown = JSON.parse(await execute('claude', ['plugin', 'list', '--json'], root));
    if (!Array.isArray(list)) throw new Error('Cannot determine installed Claude plugin scope');
    if (list.some((p) => p?.id === 'wigwag@wigwag')) providers.push('claude');
  }
  if (hasCli(codexBinary)) {
    const list = JSON.parse(await execute(codexBinary, ['plugin', 'list', '--json'], root)) as {
      installed?: Array<{ pluginId?: string }>;
    };
    if (!Array.isArray(list.installed)) throw new Error('Cannot determine installed Codex plugin scope');
    if (list.installed.some((p) => p.pluginId === 'wigwag@wigwag')) providers.push('codex');
  }
  if (!providers.length) throw new Error('No installed Wigwag agent plugins found; run wigwag install first');
  await execute('npm', ['install', '--global', `${PACKAGE}@${status.available}`, '--ignore-scripts'], root);
  // Fresh CLI processes load the installed code; never terminate agent sessions.
  const scope = providers.length === 2 ? [] : [`--${providers[0]}-only`];
  await execute('wigwag', ['install', ...scope], root);
  if (providers.includes('claude')) await execute('claude', ['plugin', 'update', 'wigwag@wigwag'], root);
  await execute('wigwag', ['broker', 'restart', '--expect-version', status.available], root);
}
export function describeUpdate(s: UpdateStatus): string {
  if (s.reason) return s.reason;
  return s.update_available
    ? `Wigwag update available (${s.available}). Run wigwag update --apply when ready.`
    : `Wigwag ${s.current}: no newer update found.`;
}
/** Best-effort human notice, at most daily; never called by MCP or native hooks. */
export async function notifyUpdate(home: string, readLatest?: () => Promise<string>): Promise<void> {
  if (!existsSync(home)) return;
  const mode = homeRehearsalMode(home);
  if (mode.enabled) return;
  try {
    assertRehearsalAccess(home, mode);
  } catch {
    return;
  }
  const path = join(home, 'update-check.json');
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8')) as {
      version: string;
      checked_at: number;
      status: UpdateStatus;
    };
    if (cache.version === VERSION && Date.now() - cache.checked_at < 86400000) {
      if (cache.status.update_available) process.stderr.write(`${describeUpdate(cache.status)}\n`);
      return;
    }
  } catch {
    /* No valid cache. */
  }
  try {
    const status = await checkUpdate(readLatest);
    writeFileSync(path, JSON.stringify({ version: VERSION, checked_at: Date.now(), status }), { mode: 0o600 });
    if (status.update_available) process.stderr.write(`${describeUpdate(status)}\n`);
  } catch {
    // Cache failures too, so an offline host does not check again on every launch.
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: VERSION,
          checked_at: Date.now(),
          status: { current: VERSION, source: 'npm', available: null, update_available: false },
        }),
        { mode: 0o600 },
      );
    } catch {
      /* Best effort. */
    }
  }
}
