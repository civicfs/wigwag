import { WigwagError } from '../errors.js';
import { type Db, nowIso, tx } from './db.js';
import { labelList, type Scope } from './links.js';

export const KEY_RE = /^[a-z0-9][a-z0-9._/-]{0,199}$/;

export interface KvRow {
  /** Workspace that owns this key (spec §17). */
  workspace: string;
  key: string;
  version: number;
  value: unknown | null;
  updated_by: string;
  updated_at: string;
}

type Raw = {
  workspace: string;
  key: string;
  version: number;
  value_json: string | null;
  updated_by: string;
  updated_at?: string;
  at?: string;
};
const toRow = (r: Raw): KvRow => ({
  workspace: r.workspace,
  key: r.key,
  version: r.version,
  value: r.value_json === null ? null : JSON.parse(r.value_json),
  updated_by: r.updated_by,
  updated_at: (r.updated_at ?? r.at) as string,
});

/** `AND workspace IN (...)` for a scoped caller; nothing for the owner. */
export function scopeClause(scope: Scope): { sql: string; args: string[] } {
  if (scope.members === null) return { sql: '', args: [] };
  const args = [...scope.members];
  return { sql: ` AND workspace IN (${args.map(() => '?').join(', ')})`, args };
}

const conflict = (key: string, rows: KvRow[]) => {
  const workspaces = rows.map((r) => r.workspace).sort();
  return new WigwagError(
    'conflict',
    `Key "${key}" exists in linked workspaces ${labelList(workspaces)}; unlink or delete one`,
    { workspaces },
  );
};

/**
 * Which row an operation on `key` uses (spec §17).
 * - Read: one live row in scope → it; several → conflict; none → the caller's own tombstone, else the newest one.
 * - Delete: the caller's own live copy if it has one, so "one side deletes" can settle a conflict.
 * - Otherwise (writes, R42-E): the key may exist, live or tombstone, in at most one workspace of the scope, else
 *   conflict; none → null (the write creates it in the caller's workspace).
 */
function resolveKey(db: Db, scope: Scope, key: string, op: 'read' | 'write' | 'delete'): KvRow | null {
  const c = scopeClause(scope);
  const rows = (
    db.prepare(`SELECT * FROM kv WHERE key = ?${c.sql} ORDER BY updated_at DESC`).all(key, ...c.args) as Raw[]
  ).map(toRow);
  const live = rows.filter((r) => r.value !== null);
  if (op === 'read') {
    if (live.length > 1) throw conflict(key, live);
    return live[0] ?? rows.find((r) => r.workspace === scope.workspace) ?? rows[0] ?? null;
  }
  if (op === 'delete') {
    const own = live.find((r) => r.workspace === scope.workspace);
    if (own) return own;
  }
  if (rows.length > 1) throw conflict(key, rows);
  return rows[0] ?? null;
}

export const kvGet = (db: Db, scope: Scope, key: string): KvRow | null => resolveKey(db, scope, key, 'read');

/** Live keys under `prefix` from every workspace in scope; a name owned by several workspaces appears once per workspace. */
export function kvList(db: Db, scope: Scope, prefix: string): KvRow[] {
  const c = scopeClause(scope);
  return (
    db
      .prepare(
        `SELECT * FROM kv WHERE substr(key, 1, ?) = ? AND value_json IS NOT NULL${c.sql} ORDER BY key, workspace`,
      )
      .all(prefix.length, prefix, ...c.args) as Raw[]
  ).map(toRow);
}

export function kvHistory(db: Db, scope: Scope, key: string): KvRow[] {
  const cur = resolveKey(db, scope, key, 'read');
  if (!cur) return [];
  return (
    db
      .prepare('SELECT * FROM kv_history WHERE workspace = ? AND key = ? ORDER BY version')
      .all(cur.workspace, key) as Raw[]
  ).map(toRow);
}

export function kvCas(
  db: Db,
  scope: Scope,
  key: string,
  expected: number | null,
  value: unknown | null,
  by: string,
  maxBytes: number,
): { ok: true; version: number; workspace: string } | { ok: false; current: KvRow | null } {
  if (!KEY_RE.test(key)) throw new WigwagError('bad_request', `Invalid key "${key}" (must match ${KEY_RE})`);
  const json = value === null ? null : JSON.stringify(value);
  if (json !== null && Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new WigwagError('limit', `Value is ${Buffer.byteLength(json, 'utf8')} bytes; limit is ${maxBytes}`);
  }
  return tx(db, () => {
    const cur = resolveKey(db, scope, key, value === null ? 'delete' : 'write');
    const live = cur !== null && cur.value !== null;
    const matches = expected === null ? !live : cur !== null && cur.version === expected;
    if (!matches) return { ok: false as const, current: cur };
    if (expected === null && value === null) throw new WigwagError('bad_request', 'Cannot create a key with null');
    const workspace = cur?.workspace ?? scope.workspace;
    if (workspace === null) throw new WigwagError('bad_request', 'KV writes need a session workspace');
    const version = (cur?.version ?? 0) + 1;
    const at = nowIso();
    db.prepare(
      `INSERT INTO kv (workspace, key, version, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace, key) DO UPDATE SET version = excluded.version, value_json = excluded.value_json,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(workspace, key, version, json, by, at);
    db.prepare(
      'INSERT INTO kv_history (workspace, key, version, value_json, updated_by, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(workspace, key, version, json, by, at);
    return { ok: true as const, version, workspace };
  });
}
