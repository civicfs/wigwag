import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { addLink, scopeFor } from '../../src/store/links.js';
import { appendRecord, createStream, listStreams, readRecords } from '../../src/store/streams.js';
import { tmpHome } from '../helpers.js';

const WS = '/w/a';

describe('streams', () => {
  it('validates records against the schema and assigns monotonic seq', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    createStream(db, scopeFor(db, WS), {
      name: 'ci-results',
      json_schema: {
        type: 'object',
        required: ['pr', 'ok'],
        properties: { pr: { type: 'integer' }, ok: { type: 'boolean' } },
        additionalProperties: false,
      },
      description: 'CI verdicts',
      created_by: 'x-a',
    });
    expect(appendRecord(db, scopeFor(db, WS), 'ci-results', { pr: 4331, ok: true }, 'x-a')).toEqual({ seq: 1 });
    expect(appendRecord(db, scopeFor(db, WS), 'ci-results', { pr: 4332, ok: false }, 'x-b')).toEqual({ seq: 2 });
    expect(() => appendRecord(db, scopeFor(db, WS), 'ci-results', { pr: 'x' }, 'x-a')).toThrow(/schema/);
    expect(readRecords(db, scopeFor(db, WS), 'ci-results', 1, 10).map((r) => r.record)).toEqual([
      { pr: 4332, ok: false },
    ]);
    expect(listStreams(db, scopeFor(db, WS)).map((s) => s.name)).toEqual(['ci-results']);
  });
  it('rejects an invalid schema, a duplicate name, and appends to a missing stream', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    expect(() =>
      createStream(db, scopeFor(db, WS), {
        name: 's-1',
        json_schema: { type: 'nope' },
        description: 'd',
        created_by: 'x-a',
      }),
    ).toThrow(/schema/);
    createStream(db, scopeFor(db, WS), { name: 's-2', json_schema: null, description: 'd', created_by: 'x-a' });
    expect(() =>
      createStream(db, scopeFor(db, WS), { name: 's-2', json_schema: null, description: 'd', created_by: 'x-a' }),
    ).toThrow(/exists/);
    expect(() => appendRecord(db, scopeFor(db, WS), 'missing', {}, 'x-a')).toThrow(/not found/i);
  });
});

describe('streams validator isolation', () => {
  const schema = (t: string) => ({ type: 'object', properties: { v: { type: t } }, required: ['v'] });
  it('scopes validators per db', () => {
    const a = openDb(join(tmpHome(), 'state.db'));
    const b = openDb(join(tmpHome(), 'state.db'));
    createStream(a, scopeFor(a, WS), {
      name: 's-x',
      json_schema: schema('integer'),
      description: 'd',
      created_by: 'x-a',
    });
    createStream(b, scopeFor(b, WS), {
      name: 's-x',
      json_schema: schema('string'),
      description: 'd',
      created_by: 'x-a',
    });
    expect(appendRecord(a, scopeFor(a, WS), 's-x', { v: 1 }, 'x-a')).toEqual({ seq: 1 });
    expect(() => appendRecord(a, scopeFor(a, WS), 's-x', { v: 'q' }, 'x-a')).toThrow(/schema/);
    expect(appendRecord(b, scopeFor(b, WS), 's-x', { v: 'q' }, 'x-a')).toEqual({ seq: 1 });
    expect(() => appendRecord(b, scopeFor(b, WS), 's-x', { v: 1 }, 'x-a')).toThrow(/schema/);
  });
  it('recreating a typed stream is a conflict; shared $id is fine; async rejected', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    const s = { ...schema('integer'), $id: 'https://example.test/s' };
    createStream(db, scopeFor(db, WS), { name: 's-1', json_schema: s, description: 'd', created_by: 'x-a' });
    expect(() =>
      createStream(db, scopeFor(db, WS), { name: 's-1', json_schema: s, description: 'd', created_by: 'x-a' }),
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
    createStream(db, scopeFor(db, WS), { name: 's-2', json_schema: s, description: 'd', created_by: 'x-a' });
    expect(() =>
      createStream(db, scopeFor(db, WS), {
        name: 's-3',
        json_schema: { $async: true, type: 'object' },
        description: 'd',
        created_by: 'x-a',
      }),
    ).toThrow(/async/);
  });
});

describe('streams per workspace', () => {
  it('same name in two workspaces is two streams; after linking, the name is a conflict', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    const A = () => scopeFor(db, '/w/a');
    const B = () => scopeFor(db, '/w/b');
    const mk = (s: ReturnType<typeof A>) =>
      createStream(db, s, { name: 'ci', json_schema: null, description: 'd', created_by: 'x' });
    expect(mk(A()).workspace).toBe('/w/a');
    expect(mk(B()).workspace).toBe('/w/b');
    expect(appendRecord(db, A(), 'ci', { n: 1 }, 'x')).toEqual({ seq: 1 });
    expect(appendRecord(db, A(), 'ci', { n: 2 }, 'x')).toEqual({ seq: 2 });
    expect(appendRecord(db, B(), 'ci', { n: 9 }, 'x')).toEqual({ seq: 1 });
    expect(readRecords(db, B(), 'ci', 0, 10).map((r) => r.record)).toEqual([{ n: 9 }]);
    expect(listStreams(db, scopeFor(db, '/w/c'))).toEqual([]);
    addLink(db, '/w/a', '/w/b');
    expect(() => appendRecord(db, A(), 'ci', {}, 'x')).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(() => readRecords(db, B(), 'ci', 0, 10)).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(listStreams(db, A()).map((s) => [s.name, s.workspace])).toEqual([
      ['ci', '/w/a'],
      ['ci', '/w/b'],
    ]);
    createStream(db, A(), { name: 'only-a', json_schema: null, description: 'd', created_by: 'x' });
    expect(() =>
      createStream(db, B(), { name: 'only-a', json_schema: null, description: 'd', created_by: 'x' }),
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
    expect(appendRecord(db, B(), 'only-a', { from: 'b' }, 'x')).toEqual({ seq: 1 });
  });
});

describe('stream create conflict (R46-7)', () => {
  it('lists every workspace where the name exists, not the caller', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    const mk = (ws: string) =>
      createStream(db, scopeFor(db, ws), { name: 'ci', json_schema: null, description: 'd', created_by: 'x' });
    mk('/w/a');
    mk('/w/b');
    addLink(db, '/w/a', '/w/b');
    addLink(db, '/w/b', '/w/c');
    let err: Error | undefined;
    try {
      mk('/w/c');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toMatchObject({ code: 'conflict', data: { workspaces: ['/w/a', '/w/b'] } });
    expect(err?.message).toContain('/w/a and /w/b');
    expect(err?.message).not.toContain('/w/c');
  });

  it('own and a linked workspace both have the name: the conflict lists both, own included (final m-1)', () => {
    const db = openDb(join(tmpHome(), 'state.db'));
    const mk = (ws: string) =>
      createStream(db, scopeFor(db, ws), { name: 'ci', json_schema: null, description: 'd', created_by: 'x' });
    mk('/w/a');
    mk('/w/b');
    addLink(db, '/w/a', '/w/b');
    let err: Error | undefined;
    try {
      mk('/w/a');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toMatchObject({ code: 'conflict', data: { workspaces: ['/w/a', '/w/b'] } });
    expect(err?.message).toContain('/w/a and /w/b');
    // Own workspace only: still the plain "already exists".
    expect(() => mk('/w/b')).toThrow(expect.objectContaining({ code: 'conflict' }));
    const db2 = openDb(join(tmpHome(), 'state.db'));
    createStream(db2, scopeFor(db2, '/w/a'), { name: 'ci', json_schema: null, description: 'd', created_by: 'x' });
    expect(() =>
      createStream(db2, scopeFor(db2, '/w/a'), { name: 'ci', json_schema: null, description: 'd', created_by: 'x' }),
    ).toThrow(/already exists/);
  });
});
