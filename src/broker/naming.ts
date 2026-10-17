import { randomInt } from 'node:crypto';
import { NAME_RE, RESERVED_NAMES } from '../ids.js';
import {
  type Agent,
  getSession,
  holderOf,
  type NameSource,
  type SessionRow,
  setNameSource,
  setNativeName,
} from '../store/sessions.js';
import { afterRename, claimSessionName } from './rename.js';
import type { Broker } from './server.js';

/** Leaves room for a collision suffix ("-9" or "-abcd") inside NAME_RE's 48 characters. */
export const NATIVE_BASE_MAX = 43;
export type NativeOrigin =
  | 'claude-hook'
  | 'claude-sidecar'
  | 'claude-transcript'
  | 'codex-api'
  | 'codex-index'
  | 'revert';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const rand4 = () => Array.from({ length: 4 }, () => B32[randomInt(32)]).join('');

/** A native display name as a NAME_RE base, or null when nothing usable is left (the caller keeps its name). */
export function sanitizeNativeName(raw: unknown, agent: Agent): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s) return null;
  if (!/^[a-z]/.test(s)) s = `${agent}-${s}`;
  s = s.slice(0, NATIVE_BASE_MAX).replace(/-+$/, '');
  return NAME_RE.test(s) ? s : null;
}

/** Names tried in order: the base unless reserved, base-2 … base-9, then five random suffixes. */
export function nameCandidates(base: string, rand: () => string = rand4): string[] {
  const out = RESERVED_NAMES.has(base) ? [] : [base];
  for (let i = 2; i <= 9; i++) out.push(`${base}-${i}`);
  for (let i = 0; i < 5; i++) out.push(`${base}-${rand()}`);
  return out;
}

const derivedFrom = (name: string, base: string): boolean =>
  name === base || (name.startsWith(`${base}-`) && /^(?:[2-9]|[a-z2-7]{4})$/.test(name.slice(base.length + 1)));

export interface NameService {
  adoptNative(
    sessionId: string,
    raw: string | null | undefined,
    origin: NativeOrigin,
  ): { changed: boolean; name: string | null };
  revertToNative(sessionId: string): { name: string | null; name_source: NameSource };
}

/**
 * W2: native names. The raw title is always recorded (native_name); it becomes the wigwag name only while the name is
 * provisional or native. A custom name wins until `register` with native=true. A candidate held by any other session,
 * live or offline, is skipped (an offline holder's backlog belongs to that conversation), so adoption never fails: it
 * suffixes, or keeps the current name.
 */
export function installNaming(broker: Broker): NameService {
  const db = broker.db;
  const adoptNative: NameService['adoptNative'] = (sessionId, raw, origin) => {
    const s = getSession(db, sessionId);
    if (!s || s.state === 'offline' || s.retired_at) return { changed: false, name: s?.name ?? null };
    if (typeof raw !== 'string') return { changed: false, name: s.name };
    const display = raw
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 200);
    const base = sanitizeNativeName(display, s.agent);
    if (!base) return { changed: false, name: s.name };
    if (display !== s.native_name) setNativeName(db, s.id, display);
    if (s.name_source === 'custom') return { changed: false, name: s.name };
    if (
      s.name_source === 'native' &&
      s.name &&
      sanitizeNativeName(s.native_name, s.agent) === base &&
      derivedFrom(s.name, base)
    )
      return { changed: false, name: s.name };
    for (const candidate of nameCandidates(base)) {
      const holder = holderOf(db, candidate);
      if (holder && holder.id !== s.id) continue;
      if (!claimSessionName(broker, s.id, candidate, 'native').ok) continue;
      afterRename(broker, s.id, s.name, s.name_source, 'native');
      broker.log(`native name (${origin}) for ${s.id}: ${s.name ?? '(none)'} -> ${candidate}`);
      broker.announce(s.id);
      return { changed: true, name: candidate };
    }
    broker.log(`native name (${origin}) for ${s.id}: every candidate for "${base}" is taken; keeping ${s.name}`);
    return { changed: false, name: s.name };
  };
  const revertToNative: NameService['revertToNative'] = (sessionId) => {
    const s = getSession(db, sessionId) as SessionRow;
    setNameSource(db, s.id, s.native_name ? 'native' : 'provisional');
    if (s.native_name) adoptNative(s.id, s.native_name, 'revert');
    const fresh = getSession(db, s.id) as SessionRow;
    return { name: fresh.name, name_source: fresh.name_source };
  };
  const service: NameService = { adoptNative, revertToNative };
  broker.naming = service;
  return service;
}
