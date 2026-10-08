import { type Db, nowIso } from './db.js';
import type { Priority } from './messages.js';

export function addSubscription(
  db: Db,
  name: string,
  target: string,
  priority: Priority,
  filter: Record<string, unknown> | null,
): void {
  removeSubscription(db, name, target);
  db.prepare(
    'INSERT INTO subscriptions (session_name, target, priority, filter_json, created_at, removed_at) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(name, target, priority, filter === null ? null : JSON.stringify(filter), nowIso());
}

export function removeSubscription(db: Db, name: string, target: string): void {
  db.prepare(
    'UPDATE subscriptions SET removed_at = ? WHERE session_name = ? AND target = ? AND removed_at IS NULL',
  ).run(nowIso(), name, target);
}

export function subscribersFor(
  db: Db,
  t: { kind: 'stream'; stream: string } | { kind: 'kv'; key: string },
): Array<{ session_name: string; priority: Priority; filter: Record<string, unknown> | null }> {
  const rows = db
    .prepare(
      'SELECT session_name, target, priority, filter_json FROM subscriptions WHERE removed_at IS NULL ORDER BY rowid',
    )
    .all() as Array<{ session_name: string; target: string; priority: Priority; filter_json: string | null }>;
  return rows
    .filter((r) =>
      t.kind === 'stream'
        ? r.target === `stream:${t.stream}`
        : r.target.startsWith('kv:') && t.key.startsWith(r.target.slice(3)),
    )
    .map((r) => ({
      session_name: r.session_name,
      priority: r.priority,
      filter: r.filter_json === null ? null : (JSON.parse(r.filter_json) as Record<string, unknown>),
    }));
}

export function addMute(db: Db, name: string, target: string): void {
  removeMute(db, name, target);
  db.prepare('INSERT INTO mutes (session_name, target, created_at, removed_at) VALUES (?, ?, ?, NULL)').run(
    name,
    target,
    nowIso(),
  );
}

export function removeMute(db: Db, name: string, target: string): void {
  db.prepare('UPDATE mutes SET removed_at = ? WHERE session_name = ? AND target = ? AND removed_at IS NULL').run(
    nowIso(),
    name,
    target,
  );
}

export function isMuted(db: Db, recipient: string, sender: string, stream?: string): boolean {
  const targets = [`sender:${sender}`, ...(stream ? [`stream:${stream}`] : [])];
  const r = db
    .prepare(
      `SELECT 1 FROM mutes WHERE session_name = ? AND removed_at IS NULL AND target IN (${targets.map(() => '?').join(', ')})`,
    )
    .get(recipient, ...targets);
  return Boolean(r);
}

export function addThrottle(db: Db, from: string, to: string): void {
  if (isThrottled(db, from, to)) return;
  db.prepare('INSERT INTO throttles (from_name, to_name, created_at, released_at) VALUES (?, ?, ?, NULL)').run(
    from,
    to,
    nowIso(),
  );
}

export const isThrottled = (db: Db, from: string, to: string): boolean =>
  Boolean(
    db.prepare('SELECT 1 FROM throttles WHERE from_name = ? AND to_name = ? AND released_at IS NULL').get(from, to),
  );

export function releaseThrottle(db: Db, from: string, to: string): void {
  db.prepare('UPDATE throttles SET released_at = ? WHERE from_name = ? AND to_name = ? AND released_at IS NULL').run(
    nowIso(),
    from,
    to,
  );
}

export const activeThrottles = (db: Db) =>
  db
    .prepare('SELECT from_name, to_name, created_at FROM throttles WHERE released_at IS NULL ORDER BY created_at')
    .all() as Array<{
    from_name: string;
    to_name: string;
    created_at: string;
  }>;
