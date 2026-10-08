import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentAncestor, pidChain, processChain } from '../../src/proc/ancestors.js';
import { fakeClaude, fakeCommandDir } from '../helpers.js';

describe('pidChain', () => {
  it('starts at the given pid and includes the parent', () => {
    const chain = pidChain(process.pid);
    expect(chain[0]).toBe(process.pid);
    expect(chain[1]).toBe(process.ppid);
    expect(chain).not.toContain(1);
  });
});

describe('processChain and agentAncestor', () => {
  it('reports pids with executable names, starting at the given pid', () => {
    const chain = processChain(process.pid);
    expect(chain.map((x) => x.pid)).toEqual(pidChain(process.pid));
    expect(chain[0].exe).toMatch(/^node/);
  });

  const at = (...exes: string[]) => exes.map((exe, i) => ({ pid: 100 - i, exe }));

  it('is the nearest strict ancestor that is not a shell or launcher, whatever its name, never the hook itself', () => {
    expect(agentAncestor(at('node', 'claude', 'claude'))).toBe(99);
    expect(agentAncestor(at('node', 'sh', '2.1.295', 'claude', 'claude'))).toBe(98);
    expect(agentAncestor(at('node', 'sh', 'node', 'zsh', 'claude'))).toBe(98);
    expect(agentAncestor(at('node', 'timeout', 'bash', 'env', 'dash', 'ksh', 'fish', 'zsh', 'agent'))).toBe(92);
    expect(agentAncestor(at('node', 'wigwag', 'ww', 'sh', 'x'))).toBe(96);
    expect(agentAncestor(at('node', '-zsh', 'x'))).toBe(98);
  });

  it('stops at an unknown wrapper or an unnamed process and never skips past it', () => {
    expect(agentAncestor(at('node', 'sh', 'nice', 'claude'))).toBe(98);
    expect(agentAncestor(at('node', '', 'claude'))).toBe(99);
    // `node` is an agent name (npm-installed Claude Code), never looked through.
    expect(agentAncestor(at('node', 'node', 'claude'))).toBe(99);
  });

  it('is null when only shells and launchers are above the hook', () => {
    expect(agentAncestor(at('node'))).toBeNull();
    expect(agentAncestor(at('node', 'sh', 'env'))).toBeNull();
  });

  it('reads a live nested fake claude tree: the agent of a process under the inner claude is the inner one', async () => {
    const outer = await fakeClaude();
    try {
      const inner = await outer.nest();
      const innermost = await inner.nest(); // stands in for a hook process under the inner claude
      const chain = processChain(innermost.pid);
      expect(chain.slice(0, 4)).toEqual([
        { pid: innermost.pid, exe: 'claude' },
        { pid: inner.pid, exe: 'claude' },
        { pid: outer.pid, exe: 'claude' },
        { pid: process.pid, exe: expect.stringMatching(/^node/) },
      ]);
      expect(agentAncestor(chain)).toBe(inner.pid);
    } finally {
      await outer.stop();
    }
  });

  it('reads a live --bg tree through a shell and a launcher: the agent is the version-named process', async () => {
    const daemon = await fakeClaude();
    try {
      const session = await (await daemon.nest()).nest('2.1.295');
      const hook = await (await (await session.nest('sh')).nest('timeout')).nest('node');
      expect(agentAncestor(processChain(hook.pid))).toBe(session.pid);
      const nice = await session.nest('nice');
      expect(agentAncestor(processChain((await nice.nest('node')).pid))).toBe(nice.pid);
    } finally {
      await daemon.stop();
    }
  });
});

describe('processChain cost', () => {
  const PATH = process.env.PATH;
  afterEach(() => {
    process.env.PATH = PATH;
  });

  it('spawns ps once however deep the ancestor chain is (each spawn is a load-sensitive serial wait)', async () => {
    const count = join(mkdtempSync(join(tmpdir(), 'ww-c-')), 'count');
    const outer = await fakeClaude();
    try {
      const inner = await outer.nest();
      const innermost = await inner.nest();
      process.env.PATH = `${fakeCommandDir('ps', `echo x >> '${count}'; exec /bin/ps "$@"`)}:${PATH}`;
      const chain = processChain(innermost.pid);
      expect(chain.length).toBeGreaterThanOrEqual(4);
      expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      await outer.stop();
    }
  });
});
