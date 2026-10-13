import { createHash } from 'node:crypto';
import { z } from 'zod';
import { WigwagError } from '../../errors.js';
import type { Scope } from '../../store/links.js';

/** Includes indentation and JSON escaping used by the MCP text formatter. */
export const DATA_PAGE_BYTES = 12000;
const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2)) <= DATA_PAGE_BYTES;

/**
 * Consumers supply at most limit+1 lazily decoded rows. The first unreturned row never advances the cursor.
 * An item too big for a page by itself becomes an explicit, lossless reference, never a truncated value.
 */
export function dataPage<T, R, P>(
  rows: Iterable<T>,
  limit: number,
  response: (items: Array<T | R>, last: T | undefined, hasMore: boolean) => P,
  reference: (row: T) => R,
): P {
  const items: Array<T | R> = [];
  let last: T | undefined;
  // The final envelope can be larger (e.g. sequence 1 becomes null). Reserve room for either result.
  const fitsPage = (candidate: Array<T | R>, tail: T) =>
    fits(response(candidate, tail, true)) && fits(response(candidate, tail, false));
  for (const row of rows) {
    if (items.length === limit) return response(items, last, true);
    if (!fitsPage([...items, row], row)) {
      if (items.length > 0) return response(items, last, true);
      const ref = reference(row);
      if (!fitsPage([ref], row)) {
        throw new WigwagError('limit', 'Data page metadata exceeds the 12000-byte response budget');
      }
      items.push(ref);
    } else items.push(row);
    last = row;
  }
  return response(items, last, false);
}

const CursorZ = z
  .object({ v: z.literal(1), context: z.string(), key: z.string().max(200), workspace: z.string() })
  .strict();

/** A cursor is a position, not an authorization token. Every query still enforces the caller's current scope. */
export function kvCursorContext(scope: Scope, prefix: string): string {
  return createHash('sha256')
    .update(JSON.stringify([prefix, scope.members === null ? null : [...scope.members].sort()]))
    .digest('hex');
}

export function encodeKvCursor(row: { key: string; workspace: string }, context: string): string {
  const cursor = Buffer.from(JSON.stringify({ v: 1, context, key: row.key, workspace: row.workspace })).toString(
    'base64url',
  );
  if (cursor.length > 8192) throw new WigwagError('limit', 'KV cursor metadata exceeds the 8192-character limit');
  return cursor;
}

export function decodeKvCursor(
  cursor: string | undefined,
  context: string,
): { key: string; workspace: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(cursor)) throw new Error();
    const value = CursorZ.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (value.context !== context) throw new Error();
    return { key: value.key, workspace: value.workspace };
  } catch {
    throw new WigwagError('bad_request', 'Invalid KV cursor or changed prefix/workspace scope; restart pagination');
  }
}
