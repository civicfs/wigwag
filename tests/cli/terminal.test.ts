import { describe, expect, it, vi } from 'vitest';
import { formatMessage, out } from '../../src/cli/util.js';
import type { MessageRow } from '../../src/store/messages.js';

describe('terminal output', () => {
  it('escapes peer terminal commands while preserving text and line breaks', () => {
    const m = {
      created_at: '',
      id: 'msg-example',
      from_name: 'peer-one',
      to_target: 'owner',
      priority: 'normal',
      kind: 'message',
      reply_to: null,
      attachments: [],
      subject: 'Review\u001b[2J',
      body: 'line one\n\u001b]52;c;YQ==\u0007\rspoof\u009b2J\u202ehidden',
    } as unknown as MessageRow;
    const printed: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      printed.push(String(s));
      return true;
    });
    try {
      out(formatMessage(m));
    } finally {
      spy.mockRestore();
    }
    const text = printed.join('');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: assert controls cannot reach a terminal
    expect(text).not.toMatch(/[\u001b\u0007\r\u009b\u202e]/u);
    expect(text).toContain('line one\n');
    expect(text).toContain('\\u001b]52;c;YQ==');
    expect(text).toContain('\\u202ehidden');
  });
});
