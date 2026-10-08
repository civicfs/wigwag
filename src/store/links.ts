import { WigwagError } from '../errors.js';
import { workspaceLabel } from '../workspace.js';
import { type Db, nowIso, tx } from './db.js';

/**
 * The set of workspaces a caller can reach (spec §17). `members === null` is the owner/system scope: every workspace.
 * `workspace` is where the caller's new items are created (null for the owner, who cannot create scoped items).
 */
export type Scope = { workspace: string; members: ReadonlySet<string> } | { workspace: null; members: null };

export interface LinkRow {
  a: string;
  b: string;
  created_at: string;
}

/** Order the pair the way SQLite's BINARY collation does (UTF-8 bytes), matching the `a < b` CHECK. */
function normalize(x: string, y: string): [string, string] {
  if (x === y) throw new WigwagError('bad_request', `Cannot link workspace ${workspaceLabel(x)} to itself`);
  return Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')) < 0 ? [x, y] : [y, x];
}

export const activeLinks = (db: Db): LinkRow[] =>
  db
    .prepare('SELECT a, b, created_at FROM workspace_links WHERE removed_at IS NULL ORDER BY a, b')
    .all() as unknown as LinkRow[];

/** The connected component containing `ws` in the undirected graph of active links (always includes `ws`). */
export function scopeOf(db: Db, ws: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const { a, b } of activeLinks(db)) {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const list = adj.get(from);
      if (list) list.push(to);
      else adj.set(from, [to]);
    }
  }
  const seen = new Set([ws]);
  const todo = [ws];
  for (let cur = todo.pop(); cur !== undefined; cur = todo.pop()) {
    for (const n of adj.get(cur) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        todo.push(n);
      }
    }
  }
  return seen;
}

/** Scope of a caller in workspace `ws`; `null` (owner, `wigwag`) is unscoped. */
export const scopeFor = (db: Db, ws: string | null): Scope =>
  ws === null ? { workspace: null, members: null } : { workspace: ws, members: scopeOf(db, ws) };

export const inScope = (scope: Scope, ws: string): boolean => scope.members === null || scope.members.has(ws);

/** Returns false when the pair is already linked. */
export function addLink(db: Db, x: string, y: string): boolean {
  const [a, b] = normalize(x, y);
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM workspace_links WHERE a = ? AND b = ? AND removed_at IS NULL').get(a, b))
      return false;
    const at = nowIso();
    db.prepare('INSERT INTO workspace_links (a, b, created_at, removed_at) VALUES (?, ?, ?, NULL)').run(a, b, at);
    db.prepare(`INSERT INTO workspace_link_events (a, b, action, at) VALUES (?, ?, 'link', ?)`).run(a, b, at);
    return true;
  });
}

/** Returns false when the pair was not linked. */
export function removeLink(db: Db, x: string, y: string): boolean {
  const [a, b] = normalize(x, y);
  return tx(db, () => {
    const at = nowIso();
    const r = db
      .prepare('UPDATE workspace_links SET removed_at = ? WHERE a = ? AND b = ? AND removed_at IS NULL')
      .run(at, a, b);
    if (r.changes === 0) return false;
    db.prepare(`INSERT INTO workspace_link_events (a, b, action, at) VALUES (?, ?, 'unlink', ?)`).run(a, b, at);
    return true;
  });
}

/** `labelA, labelB and labelC` for error messages. */
export const labelList = (workspaces: Iterable<string>): string => {
  const l = [...workspaces].map(workspaceLabel);
  return l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
};
