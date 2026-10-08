import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBlobMeta, putBlob, readBlob } from '../../src/store/blobs.js';
import { openDb } from '../../src/store/db.js';
import { tmpHome } from '../helpers.js';

describe('blobs', () => {
  it('stores content-addressed, dedups, verifies on read', () => {
    const home = tmpHome();
    const db = openDb(join(home, 'state.db'));
    const a = putBlob(db, home, Buffer.from('héllo'), { media_type: 'text/plain', created_by: 'x-a' }, 1000);
    expect(a.ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.size).toBe(6);
    const b = putBlob(db, home, Buffer.from('héllo'), { media_type: 'text/plain', created_by: 'x-b' }, 1000);
    expect(b.ref).toBe(a.ref);
    expect(getBlobMeta(db, a.ref)?.created_by).toBe('x-a');
    expect(readBlob(home, a.ref).toString()).toBe('héllo');
    const hex = a.ref.slice(7);
    writeFileSync(join(home, 'blobs', 'sha256', hex.slice(0, 2), hex.slice(2)), 'tampered');
    expect(() => readBlob(home, a.ref)).toThrow(/integrity/i);
  });
  it('rejects blobs over the limit', () => {
    const home = tmpHome();
    const db = openDb(join(home, 'state.db'));
    expect(() => putBlob(db, home, Buffer.alloc(11), { media_type: 'x/y', created_by: 'a-b' }, 10)).toThrow(/limit/);
  });
});
