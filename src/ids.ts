import { monotonicFactory } from 'ulid';

const next = monotonicFactory();

export type IdPrefix = 'msg' | 'req' | 'ses';
export const ID_RE = /^(msg|req|ses)-[0-9a-hjkmnp-tv-z]{26}$/;
export const BLOB_REF_RE = /^sha256:[0-9a-f]{64}$/;
export const NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['owner', 'all', 'wigwag']);

export function newId(prefix: IdPrefix): string {
  return `${prefix}-${next().toLowerCase()}`;
}
