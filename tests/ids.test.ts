import { describe, expect, it } from 'vitest';
import { ID_RE, NAME_RE, newId, RESERVED_NAMES } from '../src/ids.js';

describe('ids', () => {
  it('generates prefixed lowercase ulids that sort by creation', () => {
    const a = newId('msg');
    const b = newId('msg');
    expect(a).toMatch(ID_RE);
    expect(a.startsWith('msg-')).toBe(true);
    expect(a < b).toBe(true);
  });
  it('validates names and reserves owner/all/wigwag', () => {
    expect(NAME_RE.test('codex-merger')).toBe(true);
    expect(NAME_RE.test('Codex')).toBe(false);
    expect(NAME_RE.test('a')).toBe(false);
    expect(NAME_RE.test('9lives')).toBe(false);
    expect([...RESERVED_NAMES].sort()).toEqual(['all', 'owner', 'wigwag']);
  });
});
