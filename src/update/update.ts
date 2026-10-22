import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { whichBin } from '../cli/commands/init.js';
import { loadConfig, resolveHome } from '../config.js';
import { assertNativeAllowed, assertRehearsalAccess, homeRehearsalMode } from '../rehearsal.js';
import { VERSION } from '../version.js';
import { lockUpdate } from './lock.js';
import {
  checkUpdateOperation,
  clearUpdateOperation,
  readUpdateOperation,
  runUpdateOperation,
  type UpdateOperation,
  UpdateOperationPending,
} from './operation.js';
import {
  clearUpdateProgress,
  readUpdateProgress,
  saveUpdateProgress,
  type UpdateProgress,
  type UpdateStep,
} from './progress.js';

export { readUpdateProgress } from './progress.js';

const PACKAGE = '@civicfs/wigwag';
export interface UpdateStatus {
  current: string;
  source: 'npm';
  available: string | null;
  update_available: boolean;
  reason?: string;
  pending?: { version: string; providers: string[]; pending: UpdateStep[] };
  operation?: UpdateOperation;
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
  const progress = readUpdateProgress();
  const operation = readUpdateOperation() ?? undefined;
  const pending = progress
    ? { version: progress.target, providers: progress.providers, pending: progress.pending }
    : undefined;
  let available: string;
  try {
    available = await readLatest();
  } catch (e) {
    if (!pending && !operation) throw e;
    return {
      current: VERSION,
      source: 'npm',
      available: null,
      update_available: false,
      pending,
      operation,
      reason: 'Could not check npm; pending repair can still resume with wigwag update --apply.',
    };
  }
  if (!/^\d+\.\d+\.\d+$/.test(available)) throw new Error('Invalid release version');
  return {
    current: VERSION,
    source: 'npm',
    available,
    update_available: newer(available, VERSION),
    ...(pending ? { pending } : {}),
    ...(operation ? { operation } : {}),
  };
}
function configuredCodex(): string {
  try {
    return loadConfig(resolveHome()).codex.binary;
  } catch {
    return 'codex';
  }
}
export interface UpdateResult {
  version: string;
  providers: Array<'claude' | 'codex'>;
  resumed: boolean;
  cli_verified: boolean;
  completed: boolean;
  pending: UpdateStep[];
  failures: Array<{ step: UpdateStep; detail: string }>;
  next_steps: string[];
}
function nextSteps(providers: UpdateResult['providers'], pending: UpdateStep[]): string[] {
  return [
    ...(pending.length
      ? [
          'Retry pending installation work with: wigwag update --apply (the recorded version and provider scope are preserved).',
        ]
      : []),
    ...(providers.includes('claude')
      ? [
          'Claude: run /reload-plugins in each running session, then check whoami client.version. If it is older than the installed CLI, restart Claude: reloading plugin definitions can retain the old MCP process.',
        ]
      : []),
    ...(providers.includes('codex')
      ? [
          'Codex: restart each Codex session and trust the changed Wigwag hooks when prompted so it loads the updated hooks and tools.',
        ]
      : []),
    'Broker replacement does not reload agent plugins or prove native binding/push readiness.',
    `Verify: wigwag broker status; wigwag doctor${providers.length === 1 ? ` --${providers[0]}-only` : ''}; wigwag who. Check BOUND=yes and resolve any Codex push-held reason.`,
    'In each agent, run the Wigwag whoami tool after a genuine prompt/turn; verify client.version matches the installed CLI, the expected session name, bound: true, and delivery/push capabilities before relying on delivery. version_warnings is broker history, not the connected client version.',
  ];
}
export function describeApply(result: UpdateResult): string {
  return [
    result.completed
      ? `Wigwag ${result.version}: CLI and broker replacement verified; installed provider plugins refreshed.`
      : `Wigwag ${result.version}: update incomplete. Pending: ${result.pending.join(', ') || 'progress cleanup'}.`,
    ...(!result.completed
      ? [
          `CLI version: ${result.cli_verified ? 'verified' : 'not verified'}. Provider refresh steps: ${result.pending.some((s) => s === 'plugins' || s === 'claude') ? 'pending' : 'complete'}. Broker replacement step: ${result.pending.includes('broker') ? 'pending' : 'complete (checkpointed)'}.`,
          ...result.failures.map((f) => `${f.step}: ${f.detail}`),
        ]
      : []),
    ...result.next_steps,
  ].join('\n');
}
export async function applyUpdate(
  root: string,
  status: UpdateStatus,
  execute: Run = run,
  hasCli: (name: string) => boolean = (name) => whichBin(name) !== null,
  codexBinary = configuredCodex(),
  options: { repair?: boolean } = {},
): Promise<UpdateResult | null> {
  const home = resolveHome();
  assertNativeAllowed(home, 'updates');
  // No lock or writable bookkeeping for a clean same-version no-op.
  if (
    !options.repair &&
    !readUpdateProgress(home) &&
    !readUpdateOperation(home) &&
    (!status.update_available || !status.available)
  )
    return null;
  const release = lockUpdate(home);
  try {
    const operation = checkUpdateOperation(home);
    return await applyLocked(root, status, execute, hasCli, codexBinary, home, operation, options.repair === true);
  } finally {
    release();
  }
}
async function applyLocked(
  root: string,
  status: UpdateStatus,
  execute: Run,
  hasCli: (name: string) => boolean,
  codexBinary: string,
  home: string,
  operation: UpdateOperation | null,
  repair: boolean,
): Promise<UpdateResult | null> {
  let progress = readUpdateProgress(home);
  if (operation && (!progress || operation.root !== progress.root || operation.target !== progress.target))
    throw new Error('Update operation does not match pending progress; inspect update-operation.json before retrying');
  if (operation?.state === 'failed') {
    clearUpdateOperation(home, operation.id);
    operation = null;
  }
  const resumed = progress !== null;
  if (!progress && !repair && (!status.update_available || !status.available)) return null;
  if (existsSync(join(root, '.git')))
    throw new Error(
      'Development checkout links are not self-updated. Install the published npm CLI and re-register its plugin marketplaces first.',
    );
  const target = progress?.target ?? (repair ? VERSION : (status.available as string));
  if (!/^\d+\.\d+\.\d+$/.test(target) || newer(VERSION, target) || (!progress && !repair && !newer(target, VERSION)))
    throw new Error('Invalid or older release; inspect pending update progress before retrying');
  const globalRoot = await execute('npm', ['root', '--global'], root);
  const installed = join(globalRoot, '@civicfs', 'wigwag');
  if (!existsSync(installed) || realpathSync(installed) !== realpathSync(root))
    throw new Error('This is not a global CLI install; update with your package manager');
  if (lstatSync(installed).isSymbolicLink())
    throw new Error('Linked development installs are not self-updated; use a published npm installation');
  if (progress && progress.root !== realpathSync(root))
    throw new Error('Pending update belongs to a different CLI installation; inspect update-progress.json');
  if (!progress) {
    const providers: UpdateResult['providers'] = [];
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
    progress = {
      format: 1,
      root: realpathSync(root),
      target,
      providers,
      codex_binary: codexBinary,
      pending: [
        ...(repair ? [] : ['package' as const]),
        'plugins',
        ...(providers.includes('claude') ? ['claude' as const] : []),
        'broker',
      ],
    };
    // Persist before npm can replace the running program. A crash always leaves a repair path.
    saveUpdateProgress(home, progress);
  }
  let active: UpdateProgress = progress;
  const result: UpdateResult = {
    version: target,
    providers: active.providers,
    resumed,
    cli_verified: false,
    completed: false,
    pending: [...active.pending],
    failures: [],
    next_steps: [],
  };
  const recordFailure = (step: UpdateStep, e: unknown) =>
    result.failures.push({ step, detail: e instanceof Error ? e.message : 'Operation failed' });
  const finish = () => {
    result.pending = [...active.pending];
    result.next_steps = nextSteps(active.providers, result.pending);
    result.completed = result.pending.length === 0 && result.failures.length === 0;
    return result;
  };
  const done = (step: UpdateStep) => {
    const next: UpdateProgress = { ...active, pending: active.pending.filter((s) => s !== step) };
    saveUpdateProgress(home, next);
    active = next;
    const receipt = readUpdateOperation(home);
    if (receipt?.step === step && receipt.state === 'succeeded') clearUpdateOperation(home, receipt.id);
  };
  const mutate = (step: UpdateStep, bin: string, args: string[]) =>
    execute === run
      ? runUpdateOperation(home, { step, root: active.root, target, bin, args, cwd: root })
      : execute(bin, args, root);
  // A known command failure is retryable. Any surviving receipt after a catch
  // means the command or its progress checkpoint is unresolved; stop this apply.
  const unsettled = () => {
    const receipt = readUpdateOperation(home);
    if (receipt?.state === 'failed') {
      clearUpdateOperation(home, receipt.id);
      return false;
    }
    return receipt !== null;
  };
  // Always execute this installation, never a different wigwag found first on PATH.
  const fresh = (args: string[]) => execute(process.execPath, [join(installed, 'dist', 'main.js'), ...args], root);
  const verify = async () => {
    result.cli_verified = false;
    const actual = await fresh(['--version']);
    if (actual.trim() !== target)
      throw new Error(
        `Installed CLI did not report expected version ${target}; repair the npm installation, then rerun wigwag update --apply`,
      );
    result.cli_verified = true;
  };
  let packageFailed = false;
  if (active.pending.includes('package')) {
    // An interrupted npm invocation can have installed the target before its final checkpoint.
    if (resumed) {
      try {
        await verify();
      } catch {
        /* Still need the exact package installation. */
      }
    }
    if (!result.cli_verified && operation?.step === 'package') {
      recordFailure(
        'package',
        new Error(
          'Completed npm operation did not verify the target CLI; inspect and repair the installation before retrying',
        ),
      );
      return finish();
    }
    if (!result.cli_verified) {
      try {
        await mutate('package', 'npm', ['install', '--global', `${PACKAGE}@${target}`, '--ignore-scripts']);
      } catch (e) {
        packageFailed = true;
        recordFailure('package', e);
        if (unsettled() || e instanceof UpdateOperationPending) return finish();
      }
    }
  }
  try {
    await verify();
    if (!packageFailed && active.pending.includes('package')) done('package');
    if (operation?.step === 'package') {
      if (readUpdateOperation(home)) clearUpdateOperation(home, operation.id);
      operation = null;
    }
  } catch (e) {
    recordFailure('package', e);
    return finish();
  }
  if (operation) {
    try {
      if (operation.step === 'broker') {
        // Receipt proves the earlier command finished; status proves the broker now.
        try {
          await fresh(['broker', 'status', '--expect-version', target]);
        } catch {
          if (!active.pending.includes('broker')) {
            active = { ...active, pending: [...active.pending, 'broker'] };
            saveUpdateProgress(home, active);
          }
          clearUpdateOperation(home, operation.id);
          operation = null;
        }
      }
      if (operation) {
        done(operation.step);
        operation = null;
      }
    } catch (e) {
      recordFailure(operation?.step ?? 'broker', e);
      return finish();
    }
  }
  // A checkpoint proves an earlier replacement, not that this broker is still
  // available or still running the target code when an interrupted apply resumes.
  if (resumed && !active.pending.includes('broker')) {
    try {
      await fresh(['broker', 'status', '--expect-version', target]);
    } catch {
      active = { ...active, pending: [...active.pending, 'broker'] };
      try {
        saveUpdateProgress(home, active);
      } catch (e) {
        recordFailure('broker', e);
        return finish();
      }
    }
  }
  const scope = active.providers.length === 2 ? [] : [`--${active.providers[0]}-only`];
  // Plugin installation calls ensureBroker itself. Establish the target broker
  // first so an incompatible old broker cannot manufacture a provider failure.
  const actions: Array<[UpdateStep, () => Promise<string>]> = [
    [
      'broker',
      () =>
        mutate('broker', process.execPath, [
          join(installed, 'dist', 'main.js'),
          'broker',
          'restart',
          '--expect-version',
          target,
        ]),
    ],
    [
      'plugins',
      () =>
        mutate('plugins', process.execPath, [
          join(installed, 'dist', 'main.js'),
          'install',
          ...scope,
          ...(active.providers.includes('codex') ? ['--codex-binary', active.codex_binary] : []),
        ]),
    ],
    ['claude', () => mutate('claude', 'claude', ['plugin', 'update', 'wigwag@wigwag'])],
  ];
  for (const [step, action] of actions) {
    if (!active.pending.includes(step)) continue;
    try {
      await action();
      done(step);
    } catch (e) {
      recordFailure(step, e);
      if (unsettled() || e instanceof UpdateOperationPending) return finish();
    } // Keep independent provider repair reachable after a known broker failure.
  }
  if (!active.pending.length) {
    try {
      clearUpdateProgress(home);
    } catch {
      recordFailure(
        'broker',
        new Error('Could not clear update progress; rerun wigwag update --apply after checking home permissions'),
      );
    }
  }
  return finish();
}
export function describeUpdate(s: UpdateStatus): string {
  if (s.operation)
    return `Wigwag update operation ${s.operation.id} (${s.operation.step}): ${s.operation.state}. A running receipt may mean an active command or an unknown interrupted outcome. Run wigwag update --apply to check the operation fence and resume safely.`;
  if (s.pending)
    return `Wigwag update ${s.pending.version} has pending repair (${s.pending.pending.join(', ') || 'progress cleanup'}). Run wigwag update --apply to resume; installed agent code still needs reload/restart and readiness verification.`;
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
      if (cache.status.update_available || cache.status.pending)
        process.stderr.write(`${describeUpdate(cache.status)}\n`);
      return;
    }
  } catch {
    /* No valid cache. */
  }
  try {
    const status = await checkUpdate(readLatest);
    writeFileSync(path, JSON.stringify({ version: VERSION, checked_at: Date.now(), status }), { mode: 0o600 });
    if (status.update_available || status.pending) process.stderr.write(`${describeUpdate(status)}\n`);
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
