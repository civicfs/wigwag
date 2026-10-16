import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The lines in the last `maxBytes` of a file, oldest first. A line cut by the window start is dropped; a torn last line
 * is returned as is (callers ignore lines that do not parse). Null when the file cannot be read.
 */
export function tailLines(path: string, maxBytes: number): string[] | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n === 0) break;
      off += n;
    }
    const lines = buf.subarray(0, off).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
