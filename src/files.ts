import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { WigwagError } from './errors.js';

/** Open once, reject special files without blocking on FIFOs, and never read beyond the configured bound. */
export function readBoundedFile(path: string, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new WigwagError('not_found', `No such file: ${path}`);
    throw e;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new WigwagError('bad_request', `Upload source must be a regular file: ${path}`);
    if (stat.size > maxBytes)
      throw new WigwagError('limit', `File is ${stat.size} bytes; limit is ${maxBytes} (limits.max_blob_bytes)`);
    // One extra byte detects a growing source without ever reading it to exhaustion.
    const data = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < data.length) {
      const n = readSync(fd, data, bytes, data.length - bytes, null);
      if (n === 0) break;
      bytes += n;
    }
    if (bytes > maxBytes) throw new WigwagError('limit', `File exceeds ${maxBytes} bytes (limits.max_blob_bytes)`);
    if (bytes !== stat.size || fstatSync(fd).size !== stat.size)
      throw new WigwagError('bad_request', `File changed size while reading: ${path}`);
    return data.subarray(0, bytes);
  } finally {
    closeSync(fd);
  }
}
