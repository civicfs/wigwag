import { constants, fstatSync, mkdtempSync, openSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBoundedFile } from '../src/files.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), fstatSync: vi.fn(fs.fstatSync) };
});
afterEach(() => vi.clearAllMocks());
const file = (body: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'ww-file-')), 'input');
  writeFileSync(path, body);
  return path;
};

describe('bounded file reads', () => {
  it('reads a regular file at the limit, including through a symlink', () => {
    const path = file('hello');
    const link = `${path}-link`;
    symlinkSync(path, link);
    expect(readBoundedFile(link, 5).toString()).toBe('hello');
    expect(readBoundedFile(file(''), 5).length).toBe(0);
  });
  it('rejects oversized files before reading them', () => {
    expect(() => readBoundedFile(file('hello!'), 5)).toThrow(/limit/);
  });
  it('opens nonblocking and rejects devices, so special sources cannot exhaust reads', () => {
    expect(() => readBoundedFile('/dev/null', 5)).toThrow(/regular file/);
    expect(vi.mocked(openSync).mock.calls[0][1]).toBe(constants.O_RDONLY | constants.O_NONBLOCK);
    const fd = vi.mocked(fstatSync).mock.calls[0][0];
    expect(() => fstatSync(fd)).toThrow(/bad file descriptor/);
  });
  it('detects growth beyond the bound and closes the opened descriptor', () => {
    const path = file('ab');
    vi.mocked(fstatSync).mockImplementationOnce(() => Object.assign(statSync(path), { size: 1 }));
    expect(() => readBoundedFile(path, 1)).toThrow(/exceeds/);
    const fd = vi.mocked(fstatSync).mock.calls[0][0];
    expect(() => fstatSync(fd)).toThrow(/bad file descriptor/);
  });
  it('rejects size changes even below the configured maximum', () => {
    const path = file('ab');
    vi.mocked(fstatSync).mockImplementationOnce(() => Object.assign(statSync(path), { size: 1 }));
    expect(() => readBoundedFile(path, 10)).toThrow(/changed size/);
  });
});
