import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { WigwagError } from './errors.js';

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WIGWAG_HOME) return env.WIGWAG_HOME;
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'wigwag');
  return join(homedir(), '.wigwag');
}

const pos = z.number().int().positive();

export const ConfigSchema = z
  .object({
    limits: z
      .object({
        inline_body_bytes: pos,
        inline_blob_bytes: pos,
        max_blob_bytes: pos,
        max_kv_value_bytes: pos,
        max_await_s: pos,
      })
      .strict(),
    retry: z.object({ base_ms: pos, max_attempts: pos }).strict(),
    rate: z.object({ wake_pushes: pos, window_s: pos }).strict(),
    codex: z.object({ binary: z.string().min(1), queue_timeout_ms: pos, name_wait_ms: pos }).strict(),
    broker: z.object({ start_timeout_ms: pos }).strict(),
    hooks: z.object({ deadline_ms: pos, max_stdin_bytes: pos }).strict(),
    questions: z
      .object({
        wait_ms: pos.max(590000),
        poll_ms: pos,
        app_server_timeout_ms: pos,
        app_server_socket: z.string().startsWith('/'),
      })
      .strict(),
    spawn: z.object({ enabled: z.literal(false) }).strict(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/** Written to disk once by `wigwag init`; never read as a fallback. */
export const INIT_VALUES: Omit<Config, 'codex'> & { codex: Omit<Config['codex'], 'binary'> } = {
  limits: {
    inline_body_bytes: 16384,
    inline_blob_bytes: 65536,
    max_blob_bytes: 104857600,
    max_kv_value_bytes: 65536,
    // Codex MCP tool calls time out at 60s by default; keep awaits under that.
    max_await_s: 50,
  },
  retry: { base_ms: 2000, max_attempts: 8 },
  rate: { wake_pushes: 6, window_s: 300 },
  // name_wait_ms: how long a `wigwag codex --as <name>` relaunch waits for the previous holder of <name> to end (spec
  // §4). Codex's shared daemon unloads a thread, and with it the thread's MCP server, 60 s after its last TUI left.
  codex: { queue_timeout_ms: 30000, name_wait_ms: 120000 },
  broker: { start_timeout_ms: 10000 },
  // deadline_ms stays under the 10 s hook timeout in plugins/claude/hooks/hooks.json.
  hooks: { deadline_ms: 5000, max_stdin_bytes: 1048576 },
  questions: {
    wait_ms: 300000,
    poll_ms: 250,
    app_server_timeout_ms: 10000,
    app_server_socket: join(
      process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      'app-server-control',
      'app-server-control.sock',
    ),
  },
  spawn: { enabled: false },
};

export const configPath = (home: string) => join(home, 'config.json');

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Adds to `existing`, in place, every key of `defaults` it lacks; returns their dotted paths. Existing values stay. */
function fillMissing(existing: Record<string, unknown>, defaults: Record<string, unknown>, prefix = ''): string[] {
  const added: string[] = [];
  for (const [k, v] of Object.entries(defaults)) {
    const have = existing[k];
    if (have === undefined) {
      existing[k] = v;
      added.push(`${prefix}${k}`);
    } else if (isPlain(v) && isPlain(have)) {
      added.push(...fillMissing(have, v, `${prefix}${k}.`));
    }
  }
  return added;
}

/** Temp file + rename, mode 0600. */
function writeConfigAtomic(path: string, cfg: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp); // never leave the temp file behind
    } catch {
      // it was never created
    }
    throw e;
  }
}

/**
 * Creates the home and its config once. An existing config keeps every value it has: only keys a newer wigwag added
 * (`added`, dotted paths) are filled in from INIT_VALUES, so an upgrade needs one `wigwag init`, not a hand edit. A file
 * that is not a JSON object is left untouched (loadConfig reports it).
 */
export function initHome(home: string, codexBinary: string): { path: string; created: boolean; added: string[] } {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
  const path = configPath(home);
  const cfg: Config = { ...INIT_VALUES, codex: { ...INIT_VALUES.codex, binary: codexBinary } };
  try {
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return { path, created: true, added: [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    chmodSync(path, 0o600);
    let existing: unknown;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { path, created: false, added: [] };
    }
    if (!isPlain(existing)) return { path, created: false, added: [] };
    const added = fillMissing(existing, INIT_VALUES as unknown as Record<string, unknown>);
    if (added.length) writeConfigAtomic(path, existing);
    return { path, created: false, added };
  }
}

/** Set codex.binary in an existing config, atomically (temp file + rename), mode 0600. */
export function setCodexBinary(home: string, binary: string): void {
  const cfg = loadConfig(home);
  cfg.codex.binary = binary;
  writeConfigAtomic(configPath(home), cfg);
}

export function loadConfig(home: string): Config {
  const path = configPath(home);
  if (!existsSync(path)) throw new WigwagError('config', `No config at ${path}. Run: wigwag init`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new WigwagError('config', `Cannot read ${path}: ${(e as Error).message}. Run: wigwag init`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new WigwagError('config', `Invalid JSON in ${path}: ${(e as Error).message}. Run: wigwag init`);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success)
    throw new WigwagError('config', `Invalid config ${path}:\n${z.prettifyError(r.error)}\nRun: wigwag init`);
  return r.data;
}
