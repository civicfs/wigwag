import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentAncestor, processChain } from '../../src/proc/ancestors.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
  vi.resetAllMocks();
});
describe('Linux process names', () => {
  it('uses argv[0] rather than a Node thread title to look through launchers, including paths with spaces', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.mocked(execFileSync).mockReturnValue('80 70 MainThread\n70 60 MainThread\n60 50 MainThread\n50 1 MainThread\n');
    const args: Record<string, string> = {
      '/proc/80/cmdline': '/tmp/node\0hook\0',
      '/proc/70/cmdline': '/tmp/fake runner/timeout\0wrapper\0',
      '/proc/60/cmdline': '/tmp/fake runner/sh\0wrapper\0',
      '/proc/50/cmdline': '/tmp/claude\0--synthetic-option\0',
    };
    vi.mocked(readFileSync).mockImplementation((path) => Buffer.from(args[String(path)] ?? ''));
    const chain = processChain(80);
    expect(chain.map((p) => p.exe)).toEqual(['node', 'timeout', 'sh', 'claude']);
    expect(agentAncestor(chain)).toBe(50);
  });
  it('stops at an unknown process when Linux command metadata is unavailable', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.mocked(execFileSync).mockReturnValue('80 70 node\n70 50 sh\n50 1 claude\n');
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('process exited');
    });
    expect(agentAncestor(processChain(80))).toBe(70);
  });
});
