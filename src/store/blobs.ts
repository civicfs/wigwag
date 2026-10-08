import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WigwagError } from '../errors.js';
import { BLOB_REF_RE } from '../ids.js';
import { type Db, nowIso } from './db.js';
import type { Scope } from './links.js';

export interface BlobRow {
  ref: string;
  size: number;
  media_type: string;
  name: string | null;
  created_by: string;
  created_at: string;
}

export function blobPath(home: string, ref: string): string {
  if (!BLOB_REF_RE.test(ref)) throw new WigwagError('bad_request', `Invalid blob ref: ${ref}`);
  const hex = ref.slice('sha256:'.length);
  return join(home, 'blobs', 'sha256', hex.slice(0, 2), hex.slice(2));
}

export function putBlob(
  db: Db,
  home: string,
  data: Buffer,
  meta: { media_type: string; name?: string; created_by: string },
  maxBytes: number,
): BlobRow {
  if (data.length > maxBytes) {
    throw new WigwagError('limit', `Blob is ${data.length} bytes; limit is ${maxBytes} (limits.max_blob_bytes)`);
  }
  const ref = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  const path = blobPath(home, ref);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  }
  db.prepare(
    'INSERT OR IGNORE INTO blobs (ref, size, media_type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(ref, data.length, meta.media_type, meta.name ?? null, meta.created_by, nowIso());
  return getBlobMeta(db, ref) as BlobRow;
}

export const getBlobMeta = (db: Db, ref: string) =>
  db.prepare('SELECT * FROM blobs WHERE ref = ?').get(ref) as BlobRow | undefined;

export function readBlob(home: string, ref: string): Buffer {
  const path = blobPath(home, ref);
  if (!existsSync(path)) throw new WigwagError('not_found', `Blob not found: ${ref}`);
  const data = readFileSync(path);
  const actual = `sha256:${createHash('sha256').update(data).digest('hex')}`;
  if (actual !== ref) throw new WigwagError('integrity', `Blob integrity check failed for ${ref} (got ${actual})`);
  return data;
}

/** Spec §17: record that `workspace` stored or received `ref`. Append-only, so a repeat is ignored (never REPLACE). */
export function addBlobScope(db: Db, ref: string, workspace: string): void {
  db.prepare('INSERT OR IGNORE INTO blob_scopes (ref, workspace, at) VALUES (?, ?, ?)').run(ref, workspace, nowIso());
}

/** Whether `ref` was stored or attached from a workspace in `scope` (always true for the owner scope). */
export function blobInScope(db: Db, ref: string, scope: Scope): boolean {
  if (scope.members === null) return getBlobMeta(db, ref) !== undefined;
  const ws = [...scope.members];
  return Boolean(
    db
      .prepare(`SELECT 1 FROM blob_scopes WHERE ref = ? AND workspace IN (${ws.map(() => '?').join(', ')})`)
      .get(ref, ...ws),
  );
}
