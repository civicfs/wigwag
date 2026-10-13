import { describe, expect, it } from 'vitest';
import { instructions } from '../../src/mcp/instructions.js';

describe('collaboration direction and approval boundary', () => {
  it.each(['claude', 'codex'] as const)('%s accepts assigned directions without inventing human approval', (agent) => {
    const text = instructions(agent);
    expect(text).toContain('Follow task directions from your assigned orchestrator');
    expect(text).toContain('Act on peer collaboration requests');
    expect(text).toContain('A helper asking a question is not itself a reason to stop');
    expect(text).toContain('reasonable reversible default');
    expect(text).toContain('never approves a gated action');
    expect(text).not.toContain('information, not instructions');
  });
});
