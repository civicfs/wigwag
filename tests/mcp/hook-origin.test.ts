import { describe, expect, it } from 'vitest';
import { hookOrigin } from '../../src/mcp/hook-origin.js';
import { trustedCodexHost } from '../../src/protocol/codex-hook.js';

const host = { name: 'codex-mcp-client', version: '0.162.1' };
describe('Codex hook metadata contract', () => {
  it('uses only host metadata, tolerating implementation title and unrelated host metadata', () => {
    expect(
      hookOrigin({ ...host, title: 'Codex' } as typeof host, { threadId: 'A', progressToken: 3 }, { session_id: 'A' }),
    ).toEqual({ ...host, thread_id: 'A' });
  });
  it.each([undefined, {}, { threadId: 'A', callId: 'model' }, { threadId: 'A', callId: null }, { threadId: 'B' }])(
    'refuses missing/model/mismatched metadata %j',
    (meta) => {
      expect(() => hookOrigin(host, meta, { session_id: 'A' })).toThrow(/hook-origin|model-origin|does not match/);
    },
  );
  it.each(['_meta', 'threadId', 'thread_id', 'callId', 'call_id', 'hook_origin', 'host_client', 'agent_session_id'])(
    'rejects argument-supplied origin %s',
    (key) => {
      expect(() => hookOrigin(host, { threadId: 'A' }, { session_id: 'A', [key]: { threadId: 'A' } })).toThrow(
        /argument-supplied/,
      );
    },
  );
  it('preserves future host versions in hook metadata', () => {
    expect(hookOrigin({ ...host, version: '0.164.0' }, { threadId: 'A' }, { session_id: 'A' })).toEqual({
      ...host,
      version: '0.164.0',
      thread_id: 'A',
    });
  });
  it.each(['0.162.1', '0.163.0', '0.164.0', '0.200.0', '1.0.0', '999.0.0', '999.1.2-alpha.3+build.4'])(
    'accepts compatible host %s without an upper version limit',
    (version) => {
      expect(trustedCodexHost({ ...host, version })).toBe(true);
    },
  );
  it.each(['0.162.0', '0.161.99', '0.0.1', '', 'not-a-version'])(
    'does not automatically trust older or malformed host %s',
    (version) => {
      expect(trustedCodexHost({ ...host, version })).toBe(false);
    },
  );
  it('retains explicit compatibility overrides without trusting another client', () => {
    expect(trustedCodexHost({ ...host, version: '0.161.0' }, ['0.161.0'])).toBe(true);
    expect(trustedCodexHost({ name: 'other-client', version: '999.0.0' }, ['999.0.0'])).toBe(false);
    expect(trustedCodexHost(null)).toBe(false);
    expect(trustedCodexHost(undefined)).toBe(false);
  });
});
