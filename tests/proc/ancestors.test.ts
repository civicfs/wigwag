import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nearestAncestor, pidChain, processChain } from '../../src/proc/ancestors.js';
import { fakeClaude, fakeCommandDir } from '../helpers.js';

describe('pidChain', () => {
  it('starts at the given pid and includes the parent', () => {
    const chain = pidChain(process.pid);
    expect(chain[0]).toBe(process.pid);
    expect(chain[1]).toBe(process.ppid);
    expect(chain).not.toContain(1);
  });
});

describe('processChain and nearestAncestor', () => {
  it('reports pids with executable names, starting at the given pid', () => {
    const chain = processChain(process.pid);
    expect(chain.map((x) => x.pid)).toEqual(pidChain(process.pid));
    expect(chain[0].exe).toMatch(/^node/);
  });

  it('finds the nearest strict ancestor by executable name and never the process itself', () => {
    const chain = [
      { pid: 10, exe: 'claude' },
      { pid: 9, exe: 'sh' },
      { pid: 8, exe: 'claude' },
      { pid: 7, exe: 'claude' },
    ];
    expect(nearestAncestor(chain, 'claude')).toBe(8);
    expect(nearestAncestor(chain, 'tmux')).toBeNull();
  });

  it('reads a live nested fake claude tree: the nearest claude ancestor is the inner one', async () => {
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
      expect(nearestAncestor(chain, 'claude')).toBe(inner.pid);
    } finally {
      await outer.stop();
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
