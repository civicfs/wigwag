import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { codexPushBlock, codexPushLabel } from '../../broker/codex-push.js';
import { sockPath } from '../../client/autospawn.js';
import { Client } from '../../client/client.js';
import { type Config, configPath, loadConfig, resolveHome } from '../../config.js';
import { codexHostWarning } from '../../protocol/codex-hook.js';
import { frameLimit } from '../../protocol/frame.js';
import { HANDSHAKE_VERSIONS, LEGACY_CLIENT_WARNING } from '../../protocol/rpc.js';
import { isLegacySession } from '../../store/compatibility.js';
import { SCHEMA_VERSION } from '../../version.js';
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

/** SQLite may create sidecars even for a read-only WAL connection. Clean closed files can use immutable URI mode. */
export function openDoctorDb(
  file: string,
  opener: (path: string) => DatabaseSync = (path) => new DatabaseSync(path, { readOnly: true }),
): { db: DatabaseSync; fallback: boolean } {
  if (existsSync(`${file}-wal`) || existsSync(`${file}-shm`)) return { db: opener(file), fallback: false };
  const uri = pathToFileURL(file);
  uri.searchParams.set('mode', 'ro');
  uri.searchParams.set('immutable', '1');
  try {
    const db = opener(uri.href);
    if (existsSync(`${file}-wal`) || existsSync(`${file}-shm`)) {
      db.close();
      throw new Error('database became active during immutable inspection; state unknown, retry doctor');
    }
    return { db, fallback: false };
  } catch (e) {
    const error = e as NodeJS.ErrnoException & { errcode?: number };
    if (!['ERR_INVALID_ARG_VALUE', 'ERR_INVALID_ARG_TYPE'].includes(error.code ?? '') && error.errcode !== 14) throw e;
    return { db: opener(file), fallback: true };
  }
}

/** Never calls openDb: diagnostics may inspect old schemas but must never migrate or create them. */
function inspectState(
  home: string,
  add: (ok: boolean, name: string, detail: string) => void,
  warn: (name: string, detail: string) => void,
): void {
  const file = join(home, 'state.db');
  for (const version of [3, 4]) {
    const backup = `${file}.pre-v${version}.bak`;
    try {
      const stat = lstatSync(backup),
        mode = (stat.mode & 0o777).toString(8).padStart(4, '0');
      add(
        stat.isFile() && mode === '0600',
        `backup pre-v${version}`,
        `${backup}: mode ${mode}${stat.isFile() && mode === '0600' ? '' : '; expected 0600 regular file'}`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') add(true, `backup pre-v${version}`, `${backup}: absent`);
      else add(false, `backup pre-v${version}`, (e as Error).message);
    }
  }
  if (!existsSync(file)) {
    warn('schema version', 'state.db absent; no database was created');
    return;
  }
  let db: DatabaseSync | undefined;
  try {
    if (!lstatSync(file).isFile()) throw new Error('state.db is not a regular file; not opened');
    const opened = openDoctorDb(file);
    db = opened.db;
    if (opened.fallback)
      warn(
        'SQLite read-only bookkeeping',
        'immutable URI unavailable; SQLite may create empty -wal/-shm files; database content is not changed',
      );
    const version = (db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number }).v;
    add(
      version === SCHEMA_VERSION,
      'schema version',
      `${version} (client requires ${SCHEMA_VERSION}); read-only inspection`,
    );
    if (version < 1 || version > SCHEMA_VERSION) return;
    const count = (sql: string) => (opened.db.prepare(sql).get() as { n: number }).n;
    const report = (name: string, n: number, detail: string) =>
      n ? warn(name, `${n} session(s); ${detail}`) : add(true, name, `0 session(s); ${detail}`);
    if (version >= 3) {
      const legacyCount = (
        db.prepare('SELECT id FROM sessions WHERE retired_at IS NULL').all() as Array<{ id: string }>
      ).filter((s) => isLegacySession(opened.db, s.id)).length;
      if (legacyCount) warn('legacy clients', `${legacyCount} session(s); ${LEGACY_CLIENT_WARNING}`);
      const live = "state<>'offline' AND retired_at IS NULL";
      report(
        'MCP disconnected',
        count(`SELECT count(*) AS n FROM sessions WHERE ${live} AND link='disconnected'`),
        'parent status is separate from the MCP link',
      );
      report(
        'parent unknown',
        count(`SELECT count(*) AS n FROM sessions WHERE ${live} AND parent_state='unknown'`),
        'liveness is not verified',
      );
      report(
        'process identity',
        count(
          `SELECT count(*) AS n FROM sessions WHERE ${live} AND agent='claude' AND (agent_pid IS NULL OR agent_start IS NULL OR agent_start='')`,
        ),
        'Claude pid/start identity missing',
      );
      const flags = count("SELECT count(*) AS n FROM session_lineage WHERE outcome='flagged' AND resolved_at IS NULL");
      if (flags) warn('unresolved recovery', `${flags} flag(s); inspect wigwag recovery`);
      else add(true, 'unresolved recovery', '0 flags');
    }
    const groups = db
      .prepare(
        `SELECT count(*) AS n FROM sessions WHERE agent_session_id IS NOT NULL ${version >= 3 ? 'AND retired_at IS NULL' : ''} GROUP BY agent,agent_session_id,workspace HAVING count(*)>1`,
      )
      .all() as Array<{ n: number }>;
    const slots = groups.reduce((n, g) => n + g.n, 0);
    if (groups.length)
      warn('duplicate slots', `${groups.length} native ID group(s), ${slots} slots; inspect wigwag recovery`);
    else add(true, 'duplicate slots', '0 duplicate native IDs');
    if (version >= 4) {
      const origins = db
        .prepare(
          "SELECT id,name,bind_origin,host_client_name,host_client_version FROM sessions WHERE agent='codex' AND retired_at IS NULL",
        )
        .all() as unknown as Array<
        Pick<
          import('../../store/sessions.js').SessionRow,
          'id' | 'name' | 'bind_origin' | 'host_client_name' | 'host_client_version'
        >
      >;
      for (const s of origins) {
        const warning = codexHostWarning(s);
        const detail = `${s.name ?? s.id}: bind_origin=${s.bind_origin}; host_client_name=${s.host_client_name ?? 'unknown'}; host_client_version=${s.host_client_version ?? 'unknown'}${warning ? `; ${warning}` : ''}`;
        if (warning) warn('Codex bind origin', detail);
        else add(true, 'Codex bind origin', detail);
      }
      const untrusted = db
        .prepare(
          "SELECT id,name,state,link,codex_push_reason,bind_origin FROM sessions WHERE agent='codex' AND retired_at IS NULL AND agent_session_id IS NOT NULL AND (codex_push_reason IS NOT NULL OR link='disconnected' OR bind_origin='unverified')",
        )
        .all() as Array<{
        id: string;
        name: string | null;
        state: import('../../store/sessions.js').SessionState;
        link: import('../../store/sessions.js').Link;
        codex_push_reason: import('../../store/sessions.js').CodexPushReason | null;
        bind_origin: import('../../store/sessions.js').SessionRow['bind_origin'];
      }>;
      if (untrusted.length)
        warn(
          'Codex push untrusted',
          `${untrusted.length} session(s); ${untrusted.map((s) => `${s.name ?? s.id}: ${codexPushLabel(codexPushBlock(s) ?? 'app-server-unavailable')}`).join('; ')}`,
        );
      else add(true, 'Codex push untrusted', '0 sessions');
    }
  } catch (e) {
    add(false, 'state database', (e as Error).message);
  } finally {
    db?.close();
  }
}

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
  const warn = (name: string, detail: string) => rows.push(['WARN', name, detail]);
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
  inspectState(home, add, warn);
  let config: Config | null = null;
  try {
    config = loadConfig(home);
    add(true, 'config', configPath(home));
  } catch (e) {
    add(false, 'config', (e as Error).message);
  }
  if (config) {
    try {
      const signal = AbortSignal.timeout(config.broker.start_timeout_ms);
      const { client } = await Client.connect(
        sockPath(home),
        { protocol: HANDSHAKE_VERSIONS.protocol, role: 'owner' },
        frameLimit(config),
        undefined,
        signal,
      );
      const abort = () => client.destroy();
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw new Error('broker probe timed out');
        const ping = await client.call<{ version_warnings?: string[] }>('sys.ping');
        add(true, 'broker', sockPath(home));
        add(
          true,
          'broker/client versions',
          `version ${HANDSHAKE_VERSIONS.version}, protocol ${HANDSHAKE_VERSIONS.protocol}, schema ${HANDSHAKE_VERSIONS.schema_version}`,
        );
        if (ping.version_warnings?.length) warn('recent version skew', ping.version_warnings.join('; '));
        if (client.versionWarning) warn('broker/client package versions', client.versionWarning);
      } finally {
        signal.removeEventListener('abort', abort);
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
