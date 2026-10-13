import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { instructions } from '../../src/mcp/instructions.js';
import { parseToolInput, toolsFor } from '../../src/mcp/tools.js';

const SPEC_TOOLS = [
  'register',
  'whoami',
  'who',
  'send',
  'reply',
  'inbox',
  'read_message',
  'ack',
  'mute',
  'unmute',
  'blob_put',
  'blob_get',
  'kv_get',
  'kv_list',
  'kv_cas',
  'kv_delete',
  'kv_watch',
  'kv_history',
  'stream_create',
  'stream_append',
  'stream_read',
  'stream_subscribe',
  'stream_list',
  'request',
  'respond',
  'await_response',
  'requests',
];

describe('tool surface (spec §8)', () => {
  it('claude gets exactly the spec tools; codex additionally gets hook-only tools', () => {
    expect(
      toolsFor('claude')
        .map((t) => t.name)
        .sort(),
    ).toEqual([...SPEC_TOOLS].sort());
    expect(
      toolsFor('codex')
        .map((t) => t.name)
        .sort(),
    ).toEqual([...SPEC_TOOLS, 'session_bind', 'turn_started', 'turn_ended', 'hook_digest'].sort());
  });
  it('every tool input converts to JSON schema with object type', () => {
    for (const t of toolsFor('codex'))
      expect(z.toJSONSchema(t.input, { io: 'input' })).toMatchObject({ type: 'object' });
  });
  it('instructions state that peer and owner-tagged messages are not approvals', () => {
    for (const a of ['claude', 'codex'] as const) expect(instructions(a)).toMatch(/never approves a gated action/);
    expect(instructions('claude')).toMatch(/<channel/);
    expect(instructions('codex')).toMatch(/\[wigwag\]/);
  });
  it('hook_digest returns Codex PostToolUse hook JSON (S4: plain text is rejected as invalid hook output)', () => {
    const digest = toolsFor('codex').find((t) => t.name === 'hook_digest');
    const out = (text: string | null) => JSON.parse(digest?.format?.({ text }) ?? '');
    expect(out('--- msg-1 body')).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '--- msg-1 body' },
    });
    expect(out(null)).toEqual({});
  });

  describe('argument coercion for clients that stringify arguments (E4)', () => {
    const tool = (name: string) => {
      const t = toolsFor('claude').find((x) => x.name === name);
      if (!t) throw new Error(`no tool ${name}`);
      return t;
    };
    const parse = (name: string, args: Record<string, unknown>) => parseToolInput(tool(name), args);

    it('kv_cas accepts the shapes Claude Code 2.1.294 sent: expected_version "null" and a JSON-encoded value', () => {
      const r = parse('kv_cas', { key: 'e2e/lock', expected_version: 'null', value: '"e2e-claude"' });
      expect(r.success && r.data).toEqual({ key: 'e2e/lock', expected_version: null, value: 'e2e-claude' });
    });
    it('kv_cas accepts a real null and a native JSON value unchanged', () => {
      const r = parse('kv_cas', { key: 'k', expected_version: null, value: { a: [1, null, 'x'] } });
      expect(r.success && r.data).toEqual({ key: 'k', expected_version: null, value: { a: [1, null, 'x'] } });
    });
    it('kv_cas accepts a numeric string version and an object/number/array JSON string value', () => {
      for (const [raw, parsed] of [
        ['{"n":1}', { n: 1 }],
        ['42', 42],
        ['[1,"a"]', [1, 'a']],
        ['true', true],
        ['null', null],
      ] as const) {
        const r = parse('kv_cas', { key: 'k', expected_version: '3', value: raw });
        expect(r.success && r.data).toEqual({ key: 'k', expected_version: 3, value: parsed });
      }
    });
    it('kv_cas keeps a string that is not JSON text as that string', () => {
      const r = parse('kv_cas', { key: 'k', expected_version: 1, value: 'plain words' });
      expect(r.success && r.data).toMatchObject({ value: 'plain words' });
    });
    it('validation stays strict after coercion', () => {
      for (const bad of ['abc', '0', '-1', '1.5', '', 'NULL ', 0, -2, 1.5, true]) {
        expect(parse('kv_cas', { key: 'k', expected_version: bad, value: 1 }).success, String(bad)).toBe(false);
      }
      // a missing expected_version is not "create only"
      expect(parse('kv_cas', { key: 'k', value: 1 }).success).toBe(false);
      expect(parse('kv_cas', { value: 1, expected_version: null }).success).toBe(false);
    });
    it('kv_delete accepts a numeric string version, and rejects "null" (a delete needs a version)', () => {
      const ok = parse('kv_delete', { key: 'k', expected_version: '2' });
      expect(ok.success && ok.data).toEqual({ key: 'k', expected_version: 2 });
      expect(parse('kv_delete', { key: 'k', expected_version: 'null' }).success).toBe(false);
    });
    it('stream_append, stream_create and stream_subscribe get the same JSON-string handling', () => {
      const a = parse('stream_append', { name: 's', record: '{"x":1}' });
      expect(a.success && a.data).toEqual({ name: 's', record: { x: 1 } });
      const c = parse('stream_create', { name: 's', json_schema: '{"type":"object"}', description: 'd' });
      expect(c.success && c.data).toMatchObject({ json_schema: { type: 'object' } });
      const n = parse('stream_create', { name: 's', json_schema: 'null', description: 'd' });
      expect(n.success && n.data).toMatchObject({ json_schema: null });
      const f = parse('stream_subscribe', { name: 's', filter: '{"kind":"x"}' });
      expect(f.success && f.data).toMatchObject({ filter: { kind: 'x' } });
    });
    it('send does not require a subject (spec §10: --subject is optional)', () => {
      const r = parse('send', { to: 'beta-one', body: 'hi', priority: 'normal' });
      expect(r.success && r.data).toMatchObject({ subject: '(no subject)' });
      expect(z.toJSONSchema(tool('send').input, { io: 'input' })).toMatchObject({
        required: ['to', 'body', 'priority'],
      });
    });
  });
});
