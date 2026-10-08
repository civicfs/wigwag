import { describe, expect, it } from 'vitest';
import { HelloZ, METHODS } from '../../src/protocol/rpc.js';

describe('rpc schemas', () => {
  it('hello requires protocol 1 and a known role', () => {
    expect(HelloZ.safeParse({ protocol: 1, role: 'owner' }).success).toBe(true);
    expect(HelloZ.safeParse({ protocol: 2, role: 'owner' }).success).toBe(false);
    expect(HelloZ.safeParse({ protocol: 1, role: 'owner', extra: 1 }).success).toBe(false);
    // final m-2: the workspace is computed from cwd, which must be absolute (a relative one resolves in the broker)
    expect(HelloZ.safeParse({ protocol: 1, role: 'mcp', cwd: 'rel/dir' }).success).toBe(false);
    expect(HelloZ.safeParse({ protocol: 1, role: 'mcp', cwd: '/abs/dir' }).success).toBe(true);
  });
  it('msg.send validates names, priority, blob refs and defaults attachments', () => {
    const p = METHODS['msg.send'].params;
    expect(p.parse({ to: 'codex-merger', subject: 's', body: 'b', priority: 'low' }).attachments).toEqual([]);
    expect(p.safeParse({ to: 'Bad', subject: 's', body: 'b', priority: 'low' }).success).toBe(false);
    expect(p.safeParse({ to: 'all', subject: 's', body: 'b', priority: 'loud' }).success).toBe(false);
    expect(
      p.safeParse({ to: 'a-b', subject: 's', body: 'b', priority: 'low', attachments: ['sha256:xyz'] }).success,
    ).toBe(false);
  });
  it('blob.put needs exactly one of path or text', () => {
    const p = METHODS['blob.put'].params;
    expect(p.safeParse({ media_type: 'text/plain', text: 'x' }).success).toBe(true);
    expect(p.safeParse({ media_type: 'text/plain' }).success).toBe(false);
    expect(p.safeParse({ media_type: 'text/plain', text: 'x', path: '/p' }).success).toBe(false);
  });
  it('reserves session.spawn and session.stop (P3)', () => {
    expect(METHODS['session.spawn']).toBeDefined();
    expect(METHODS['session.stop']).toBeDefined();
  });
});
