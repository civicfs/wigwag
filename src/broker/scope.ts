import { WigwagError } from '../errors.js';
import type { Db } from '../store/db.js';
import { type Scope, scopeFor, scopeOf } from '../store/links.js';
import { deliveriesFor, type MessageRow } from '../store/messages.js';
import { getSession, holderOf } from '../store/sessions.js';
import { workspaceLabel } from '../workspace.js';
import type { Connection } from './connection.js';

/** Senders that may reach every workspace (spec §17). */
export const UNSCOPED_SENDERS: ReadonlySet<string> = new Set(['owner', 'wigwag']);

/** Workspace of a sender name: null for `owner`/`wigwag`, else its current or last holder's workspace. */
export function senderWorkspace(db: Db, from: string): string | null {
  if (UNSCOPED_SENDERS.has(from)) return null;
  return holderOf(db, from)?.workspace ?? null;
}

/** The caller's scope: the owner sees every workspace; an agent sees the connected component of its workspace. */
export function connScope(db: Db, conn: Connection): Scope {
  if (conn.role === 'owner') return scopeFor(db, null);
  const s = conn.sessionId ? getSession(db, conn.sessionId) : undefined;
  if (!s) throw new WigwagError('not_registered', 'This connection has no session');
  return scopeFor(db, s.workspace);
}

/** R42-A: refusing an offline name whose previous holder is in a workspace outside the claimant's scope. */
export const takeoverText = (name: string, holderWs: string): string =>
  `Name "${name}" belongs to an offline session in workspace ${workspaceLabel(holderWs)}; ` +
  'the owner can link workspaces or you can pick another name';

export const forbiddenText = (name: string, recipientWs: string, senderWs: string): string => {
  const a = workspaceLabel(senderWs);
  const b = workspaceLabel(recipientWs);
  return `Session "${name}" is in workspace ${b}, not linked to ${a}. The owner can run: wigwag link ${a} ${b}`;
};

/**
 * Why a message from `fromWorkspace` may not reach `recipient`, or null when it may: unscoped senders and names
 * never held by any session are allowed (the latter stay held until a holder registers).
 */
export function scopeViolation(db: Db, fromWorkspace: string | null, recipient: string): string | null {
  if (fromWorkspace === null) return null;
  const holder = holderOf(db, recipient);
  if (!holder || scopeOf(db, fromWorkspace).has(holder.workspace)) return null;
  return forbiddenText(recipient, holder.workspace, fromWorkspace);
}

/**
 * R42-B, the single read authorization for agents: a message is visible to a session in `sessionWorkspace` when it is
 * a genuine owner/system message (no provenance) or its provenance workspace is in the session's scope. Names can
 * move between sessions, so being addressed by name is never enough.
 */
export function canSee(db: Db, sessionWorkspace: string, m: MessageRow): boolean {
  if (m.from_workspace === null) return UNSCOPED_SENDERS.has(m.from_name);
  return scopeOf(db, sessionWorkspace).has(m.from_workspace);
}

/** canSee for a connection: the owner sees everything. */
export function connCanSee(db: Db, conn: Connection, m: MessageRow): boolean {
  if (conn.role === 'owner') return true;
  const s = conn.sessionId ? getSession(db, conn.sessionId) : undefined;
  return s !== undefined && canSee(db, s.workspace, m);
}

/**
 * R46-N5: unread deliveries for `name` that its current holder can see (canSee against the holder's workspace).
 * A name with no holder counts every unread delivery (only the owner sees that number).
 */
export function visibleUnreadCount(db: Db, name: string): number {
  const holder = holderOf(db, name);
  const rows = deliveriesFor(db, name, ['pending', 'held', 'pushed', 'failed', 'stuck']);
  return holder ? rows.filter((r) => canSee(db, holder.workspace, r.message)).length : rows.length;
}
