import { describe, expect, it } from 'vitest';
import { loadsWigwagChannel } from '../../src/proc/channel-flag.js';

describe('loadsWigwagChannel (E-3: the parent claude was started with the wigwag channel)', () => {
  it.each([
    ['claude --dangerously-load-development-channels plugin:wigwag@wigwag', true],
    ['/Users/m/.local/bin/claude --model sonnet --dangerously-load-development-channels plugin:wigwag@wigwag', true],
    ['claude --dangerously-load-development-channels=plugin:wigwag@wigwag', true],
    ['claude --channels plugin:wigwag@wigwag', true],
    ['claude --dangerously-load-development-channels server:other plugin:wigwag@wigwag --model sonnet', true],
    ['claude --dangerously-load-development-channels server:wigwag', true],
    ['claude --model sonnet', false],
    ['claude', false],
    ['claude --dangerously-load-development-channels plugin:other@wigwag', false],
    ['claude --dangerously-load-development-channels plugin:wigwag-x@wigwag', false],
    ['claude --dangerously-load-development-channels --model plugin:wigwag@wigwag', false],
    ['claude --append-system-prompt plugin:wigwag@wigwag', false],
    ['', false],
  ])('%j -> %s', (args, expected) => {
    expect(loadsWigwagChannel(args)).toBe(expected);
  });
});
