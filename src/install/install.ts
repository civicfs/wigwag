import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveCodexBinary, whichBin } from '../cli/commands/init.js';
import { cliEntry } from '../cli/util.js';
import { ensureBroker } from '../client/autospawn.js';
import { configPath, initHome, loadConfig, resolveHome, setCodexBinary } from '../config.js';

export type Step = { target: 'wigwag' | 'claude' | 'codex'; action: string; ok: boolean; detail: string };

/** dist/main.js → package root. `npm install -g .` symlinks the repo, so this is the checkout. */
export const packageRoot = (): string => resolve(dirname(realpathSync(cliEntry())), '..');

const exec = (bin: string, args: string[]): { ok: boolean; text: string } => {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.error) return { ok: false, text: r.error.message };
  return { ok: r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

const mentionsTarget = (text: string, extra: string[] = []): boolean =>
  /\bwigwag(@wigwag)?\b/.test(text) || extra.some((x) => text.includes(x));

/** Run `add`; if the CLI says it already exists, run `onAlready` instead (or accept). */
function addOrUpdate(
  steps: Step[],
  root: string,
  target: Step['target'],
  action: string,
  bin: string,
  add: string[],
  onAlready: string[] | null,
): void {
  const r = exec(bin, add);
  if (r.ok) {
    steps.push({ target, action, ok: true, detail: `${bin} ${add.join(' ')}` });
    return;
  }
  if (mentionsTarget(r.text, [root]) && /\b(already|exists)\b/i.test(r.text)) {
    if (!onAlready) {
      steps.push({ target, action, ok: true, detail: 'already present' });
      return;
    }
    const u = exec(bin, onAlready);
    steps.push({
      target,
      action: `${action} (update)`,
      ok: u.ok,
      detail: u.ok ? `${bin} ${onAlready.join(' ')}` : u.text,
    });
    return;
  }
  steps.push({ target, action, ok: false, detail: r.text || `${bin} ${add.join(' ')} failed` });
}

export async function install(opts: { claude: boolean; codex: boolean; codexBinary?: string }): Promise<Step[]> {
  const steps: Step[] = [];
  const root = packageRoot();
  const home = resolveHome();

  const codex = resolveCodexBinary(opts.codexBinary);
  const created = !existsSync(configPath(home));
  initHome(home, codex.path);
  steps.push({
    target: 'wigwag',
    action: 'config',
    ok: true,
    detail: `${created ? 'created' : 'kept'} ${configPath(home)}`,
  });
  if (opts.codexBinary && !created) {
    try {
      setCodexBinary(home, codex.path);
      steps.push({ target: 'wigwag', action: 'config', ok: true, detail: `codex.binary set to ${codex.path}` });
    } catch (e) {
      steps.push({ target: 'wigwag', action: 'config', ok: false, detail: (e as Error).message });
    }
  }
  const config = loadConfig(home);

  try {
    await ensureBroker(home, config, cliEntry());
    steps.push({ target: 'wigwag', action: 'broker', ok: true, detail: 'running' });
  } catch (e) {
    steps.push({ target: 'wigwag', action: 'broker', ok: false, detail: (e as Error).message });
  }

  if (opts.claude) {
    if (!whichBin('claude'))
      steps.push({ target: 'claude', action: 'cli', ok: false, detail: 'claude not found on PATH' });
    else {
      const v = exec('claude', ['plugin', 'validate', root]);
      steps.push({ target: 'claude', action: 'validate', ok: v.ok, detail: v.ok ? root : v.text });
      if (v.ok) {
        addOrUpdate(
          steps,
          root,
          'claude',
          'marketplace',
          'claude',
          ['plugin', 'marketplace', 'add', root],
          ['plugin', 'marketplace', 'update', 'wigwag'],
        );
        addOrUpdate(
          steps,
          root,
          'claude',
          'plugin',
          'claude',
          ['plugin', 'install', 'wigwag@wigwag'],
          ['plugin', 'update', 'wigwag@wigwag'],
        );
      }
    }
  }

  if (opts.codex) {
    // R40: an explicit --codex-binary is what this run uses, even when saving it to the config failed (a FAIL above).
    const bin = opts.codexBinary ? codex.path : config.codex.binary;
    const present = bin.includes('/') ? existsSync(bin) : whichBin(bin) !== null;
    if (!present) steps.push({ target: 'codex', action: 'cli', ok: false, detail: `${bin} not found` });
    else {
      addOrUpdate(steps, root, 'codex', 'marketplace', bin, ['plugin', 'marketplace', 'add', root], null);
      addOrUpdate(steps, root, 'codex', 'plugin', bin, ['plugin', 'add', 'wigwag@wigwag'], null);
    }
  }
  return steps;
}

// Real wording of an absent target (claude 2.1.294 / codex-cli 0.160.1, observed in the e2e run):
//   claude plugin uninstall:     Plugin "wigwag@wigwag" not found in installed plugins
//   claude marketplace remove:   Marketplace 'wigwag' not found
//   codex marketplace remove:    marketplace `wigwag` is not configured or installed
// (codex plugin remove exits 0 when the plugin is absent.) The match also requires the output to name wigwag.
const ABSENT = /not (installed|found|configured)/i;

export function uninstall(opts: { claude: boolean; codex: boolean }): Step[] {
  const steps: Step[] = [];
  const rm = (target: Step['target'], action: string, bin: string, args: string[]) => {
    const r = exec(bin, args);
    const absent = !r.ok && mentionsTarget(r.text) && ABSENT.test(r.text);
    steps.push({
      target,
      action,
      ok: r.ok || absent,
      detail: r.ok ? `${bin} ${args.join(' ')}` : absent ? 'was not installed' : r.text,
    });
  };
  if (opts.claude) {
    if (!whichBin('claude'))
      steps.push({ target: 'claude', action: 'cli', ok: false, detail: 'claude not found on PATH' });
    else {
      rm('claude', 'plugin', 'claude', ['plugin', 'uninstall', 'wigwag@wigwag']);
      rm('claude', 'marketplace', 'claude', ['plugin', 'marketplace', 'remove', 'wigwag']);
    }
  }
  if (opts.codex) {
    const bin = loadConfig(resolveHome()).codex.binary;
    const present = bin.includes('/') ? existsSync(bin) : whichBin(bin) !== null;
    if (!present) steps.push({ target: 'codex', action: 'cli', ok: false, detail: `${bin} not found` });
    else {
      rm('codex', 'plugin', bin, ['plugin', 'remove', 'wigwag@wigwag']);
      rm('codex', 'marketplace', bin, ['plugin', 'marketplace', 'remove', 'wigwag']);
    }
  }
  return steps;
}
