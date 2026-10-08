import { Ajv, type ValidateFunction } from 'ajv';
import { WigwagError } from '../errors.js';
import { type Db, nowIso, tx } from './db.js';
import { scopeClause } from './kv.js';
import { labelList, type Scope } from './links.js';

/** Validators per (Db, workspace, name): the same stream name in two workspaces is two streams (spec §17). */
const validators = new WeakMap<Db, Map<string, ValidateFunction | null>>();

function cacheFor(db: Db): Map<string, ValidateFunction | null> {
  let m = validators.get(db);
  if (!m) {
    m = new Map();
    validators.set(db, m);
  }
  return m;
}
const cacheKey = (workspace: string, name: string) => `${workspace}\u0000${name}`;

function compileSchema(schema: unknown): ValidateFunction {
  if (typeof schema === 'object' && schema !== null && (schema as { $async?: unknown }).$async) {
    throw new WigwagError('schema', 'Invalid JSON schema: async schemas are not supported');
  }
  const v = new Ajv({ allErrors: true, strict: false }).compile(schema as object);
  return v;
}

export const STREAM_RE = /^[a-z][a-z0-9-]{1,63}$/;

export interface StreamRow {
  /** Workspace that created the stream (spec §17). */
  workspace: string;
  name: string;
  json_schema: unknown | null;
  description: string;
  created_by: string;
  created_at: string;
}

type Raw = Omit<StreamRow, 'json_schema'> & { json_schema: string | null };
const toRow = (r: Raw): StreamRow => ({ ...r, json_schema: r.json_schema === null ? null : JSON.parse(r.json_schema) });

const inScope = (db: Db, scope: Scope, name: string): StreamRow[] => {
  const c = scopeClause(scope);
  return (
    db.prepare(`SELECT * FROM streams WHERE name = ?${c.sql} ORDER BY workspace`).all(name, ...c.args) as Raw[]
  ).map(toRow);
};

const conflict = (name: string, rows: StreamRow[]) =>
  new WigwagError(
    'conflict',
    `Stream "${name}" exists in linked workspaces ${labelList(rows.map((r) => r.workspace))}; unlink one`,
    { workspaces: rows.map((r) => r.workspace) },
  );

export function createStream(
  db: Db,
  scope: Scope,
  s: { name: string; json_schema: unknown | null; description: string; created_by: string },
): StreamRow {
  if (!STREAM_RE.test(s.name)) throw new WigwagError('bad_request', `Invalid stream name "${s.name}"`);
  if (scope.workspace === null) throw new WigwagError('bad_request', 'Creating a stream needs a session workspace');
  const workspace = scope.workspace;
  const existing = inScope(db, scope, s.name);
  // R42-F / R46-7 / final m-1: the name exists in another workspace of the scope → the multi-workspace conflict,
  // listing every workspace that has the name (the caller's included when it has one too).
  if (existing.some((r) => r.workspace !== workspace)) throw conflict(s.name, existing);
  if (existing.length) {
    throw new WigwagError('conflict', `Stream "${s.name}" already exists (schemas are immutable; use a new name)`);
  }
  let validate: ValidateFunction | null = null;
  if (s.json_schema !== null) {
    try {
      validate = compileSchema(s.json_schema);
    } catch (e) {
      if (e instanceof WigwagError) throw e;
      throw new WigwagError('schema', `Invalid JSON schema: ${(e as Error).message}`);
    }
  }
  db.prepare(
    'INSERT INTO streams (workspace, name, json_schema, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    workspace,
    s.name,
    s.json_schema === null ? null : JSON.stringify(s.json_schema),
    s.description,
    s.created_by,
    nowIso(),
  );
  cacheFor(db).set(cacheKey(workspace, s.name), validate);
  return inScope(db, { workspace, members: new Set([workspace]) }, s.name)[0];
}

/** The one stream named `name` in scope; undefined when none; conflict when several workspaces have one. */
export function getStream(db: Db, scope: Scope, name: string): StreamRow | undefined {
  const rows = inScope(db, scope, name);
  if (rows.length > 1) throw conflict(name, rows);
  return rows[0];
}

const mustGet = (db: Db, scope: Scope, name: string): StreamRow => {
  const s = getStream(db, scope, name);
  if (!s) throw new WigwagError('not_found', `Stream not found: ${name}`);
  return s;
};

/** Streams from every workspace in scope; a name owned by several workspaces appears once per workspace. */
export function listStreams(db: Db, scope: Scope): StreamRow[] {
  const c = scopeClause(scope);
  return (db.prepare(`SELECT * FROM streams WHERE 1 = 1${c.sql} ORDER BY name, workspace`).all(...c.args) as Raw[]).map(
    toRow,
  );
}

function validatorFor(db: Db, s: StreamRow): ValidateFunction | null {
  const cache = cacheFor(db);
  const k = cacheKey(s.workspace, s.name);
  if (cache.has(k)) return cache.get(k) ?? null;
  const v = s.json_schema === null ? null : compileSchema(s.json_schema);
  cache.set(k, v);
  return v;
}

export function appendRecord(db: Db, scope: Scope, name: string, record: unknown, by: string): { seq: number } {
  const s = mustGet(db, scope, name);
  const v = validatorFor(db, s);
  if (v && !v(record)) {
    throw new WigwagError(
      'schema',
      `Record does not match schema of "${name}": ${new Ajv().errorsText(v.errors)}`,
      v.errors,
    );
  }
  return tx(db, () => {
    const { m } = db
      .prepare('SELECT coalesce(max(seq), 0) AS m FROM stream_records WHERE workspace = ? AND stream = ?')
      .get(s.workspace, name) as { m: number };
    const seq = m + 1;
    db.prepare(
      'INSERT INTO stream_records (workspace, stream, seq, record_json, appended_by, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(s.workspace, name, seq, JSON.stringify(record), by, nowIso());
    return { seq };
  });
}

export function readRecords(
  db: Db,
  scope: Scope,
  name: string,
  afterSeq: number,
  limit: number,
): Array<{ seq: number; record: unknown; appended_by: string; at: string }> {
  const s = mustGet(db, scope, name);
  return (
    db
      .prepare('SELECT * FROM stream_records WHERE workspace = ? AND stream = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(s.workspace, name, afterSeq, limit) as Array<{
      seq: number;
      record_json: string;
      appended_by: string;
      at: string;
    }>
  ).map((r) => ({ seq: r.seq, record: JSON.parse(r.record_json), appended_by: r.appended_by, at: r.at }));
}
