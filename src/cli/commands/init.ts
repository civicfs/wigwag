import { execFileSync } from 'node:child_process';
import { initHome, loadConfig, resolveHome } from '../../config.js';
import { out, parseCli } from '../util.js';

export function whichBin(name: string): string | null {
  try {
    const p = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' }).trim();
    return p || null;
  } catch {
    return null;
  }
}

/** `codex` resolved on PATH, else the literal name (resolved again at call time); the caller reports which. */
export function resolveCodexBinary(explicit: string | undefined): { path: string; found: boolean } {
  if (explicit) return { path: explicit, found: true };
  const p = whichBin('codex');
  return p ? { path: p, found: true } : { path: 'codex', found: false };
}

export function cmdInit(args: string[]): void {
  const { values } = parseCli({ args, options: { codex: { type: 'string' } } });
  const codex = resolveCodexBinary(values.codex);
  const home = resolveHome();
  const r = initHome(home, codex.path);
  if (!r.created) {
    // final m-4: "unchanged" for a config that loadConfig rejects sent the owner in a loop ("Run: wigwag init").
    try {
      loadConfig(home);
    } catch (e) {
      process.stderr.write(
        `Exists but is invalid, left unchanged: ${r.path}\n${(e as Error).message.replace(/ Run: wigwag init$/, '')}\nFix it, or move it aside and run wigwag init again.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }
  if (r.created) out(`Created: ${r.path}`);
  else if (r.added.length) out(`Exists, added missing keys (${r.added.join(', ')}); other values unchanged: ${r.path}`);
  else out(`Exists, unchanged: ${r.path}`);
  if (!codex.found)
    out('Note: codex was not found on PATH; codex.binary is set to "codex" and resolved at delivery time.');
}
