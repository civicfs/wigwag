import { describe, expect, it } from 'vitest';
import { encode, LineDecoder } from '../../src/protocol/frame.js';

describe('frame', () => {
  it('splits NDJSON across arbitrary chunk boundaries, including multi-byte chars', () => {
    const d = new LineDecoder(1000);
    const wire = encode({ a: 'é' }) + encode({ b: 2 });
    const out: unknown[] = [];
    for (const ch of wire) out.push(...d.push(ch));
    expect(out).toEqual([{ a: 'é' }, { b: 2 }]);
  });
  it('ignores blank lines, rejects bad JSON and oversized frames', () => {
    expect(new LineDecoder(100).push('\n\n')).toEqual([]);
    expect(() => new LineDecoder(100).push('{nope}\n')).toThrow(/invalid JSON/i);
    expect(() => new LineDecoder(10).push('x'.repeat(11))).toThrow(/limit/);
  });
  it('enforces the byte limit on terminated multibyte frames regardless of chunking', () => {
    const wire = `${JSON.stringify('éééééé')}\n`; // 14 bytes plus newline
    expect(() => new LineDecoder(10).push(wire)).toThrow(/limit/);
    const d = new LineDecoder(10);
    expect(() => {
      d.push(wire.slice(0, 4));
      d.push(wire.slice(4));
    }).toThrow(/limit/);
  });
  it('accepts a multibyte frame of exactly maxBytes bytes', () => {
    expect(new LineDecoder(14).push(`${JSON.stringify('éééééé')}\n`)).toEqual(['éééééé']);
  });
});
