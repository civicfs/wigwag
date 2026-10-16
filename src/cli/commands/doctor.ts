import { execFileSync } from 'node:child_process';
import { sockPath } from '../../client/autospawn.js';
import { Client } from '../../client/client.js';
import { type Config, configPath, loadConfig, resolveHome } from '../../config.js';
import { frameLimit } from '../../protocol/frame.js';
import { HANDSHAKE_VERSIONS } from '../../protocol/rpc.js';
import { out, parseCli, table, UsageError } from '../util.js';
import { whichBin } from './init.js';

const run = (bin: string, args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch {
    return { ok: false, out: '' };
  }
};

const atLeast = (v: string, min: [number, number, number]): boolean => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (got[i] !== min[i]) return got[i] > min[i];
  return true;
};

export const CLAUDE_LAUNCH = 'claude --dangerously-load-development-channels plugin:wigwag@wigwag';

export async function cmdDoctor(args: string[] = []): Promise<void> {
  // --codex-binary is accepted (install.sh forwards its arguments) and ignored.
  const { values } = parseCli({
    args,
    options: {
      'claude-only': { type: 'boolean' },
      'codex-only': { type: 'boolean' },
      'codex-binary': { type: 'string' },
    },
  });
  if (values['claude-only'] && values['codex-only'])
    throw new UsageError('--claude-only and --codex-only are exclusive');
  const checkClaude = !values['codex-only'];
  const checkCodex = !values['claude-only'];
  const rows: string[][] = [['STATUS', 'CHECK', 'DETAIL']];
  let allOk = true;
  const add = (ok: boolean, name: string, detail: string) => {
    allOk &&= ok;
    rows.push([ok ? 'PASS' : 'FAIL', name, detail]);
  };
  add(Number(process.versions.node.split('.')[0]) >= 24, 'node >= 24', process.versions.node);
  // Final review I-5: a broker started from this environment inherits this PATH; without git every directory
  // becomes its own workspace and worktrees of one repo stop reaching each other.
  const git = run('git', ['--version']);
  add(
    git.ok,
    'git (workspace ids)',
    git.out.trim() || 'git not found on PATH: each directory becomes its own workspace',
  );
  const home = resolveHome();
  let config: Config | null = null;
  try {
    config = loadConfig(home);
    add(true, 'config', configPath(home));
  } catch (e) {
    add(false, 'config', (e as Error).message);
  }
  if (config) {
    try {
      const { client } = await Client.connect(
        sockPath(home),
        { protocol: HANDSHAKE_VERSIONS.protocol, role: 'owner' },
        frameLimit(config),
        undefined,
        AbortSignal.timeout(config.broker.start_timeout_ms),
      );
      try {
        const ping = await client.call<{ version_warnings?: string[] }>('sys.ping');
        add(true, 'broker', sockPath(home));
        add(
          true,
          'broker/client versions',
          `version ${HANDSHAKE_VERSIONS.version}, protocol ${HANDSHAKE_VERSIONS.protocol}, schema ${HANDSHAKE_VERSIONS.schema_version}`,
        );
        if (ping.version_warnings?.length) add(false, 'version skew', ping.version_warnings.join('; '));
      } finally {
        client.destroy();
      }
    } catch (e) {
      add(false, 'broker', (e as Error).message);
    }
    if (checkCodex) {
      const features = run(config.codex.binary, ['features', 'list']);
      add(features.ok, 'codex binary', config.codex.binary);
      add(
        /daemon_auto_start\s+\S+\s+true/.test(features.out),
        'codex daemon_auto_start',
        'required for codex queue delivery',
      );
    }
  }
  if (checkClaude) {
    const claude = run('claude', ['--version']);
    add(
      claude.ok && atLeast(claude.out, [2, 1, 80]),
      'claude >= 2.1.80 (channels)',
      claude.out.trim() || 'claude not found',
    );
  }
  const ww = whichBin('wigwag');
  add(ww !== null, 'wigwag on PATH', ww ?? 'not found: run ./install.sh in the repo');
  out(table(rows));
  out(`\nStart Claude with push delivery:  wigwag claude --as <name>   (runs: ${CLAUDE_LAUNCH})`);
  out('Start Codex:                      wigwag codex --as <name>');
  process.exitCode = allOk ? 0 : 1;
}
