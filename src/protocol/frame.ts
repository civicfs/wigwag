import type { Config } from '../config.js';
import { WigwagError } from '../errors.js';

export const encode = (v: unknown): string => `${JSON.stringify(v)}\n`;

/** Largest frame: a text blob at the blob limit plus envelope overhead. */
export const frameLimit = (config: Config): number => config.limits.max_blob_bytes + 1048576;

export class LineDecoder {
  private buf = '';
  constructor(private readonly maxBytes: number) {}

  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (Buffer.byteLength(line, 'utf8') > this.maxBytes) {
        throw new WigwagError('limit', `Frame exceeds limit of ${this.maxBytes} bytes`);
      }
      if (line.trim()) {
        try {
          out.push(JSON.parse(line));
        } catch (e) {
          throw new WigwagError('bad_request', `Invalid JSON frame: ${(e as Error).message}`);
        }
      }
      nl = this.buf.indexOf('\n');
    }
    if (Buffer.byteLength(this.buf, 'utf8') > this.maxBytes) {
      throw new WigwagError('limit', `Frame exceeds limit of ${this.maxBytes} bytes`);
    }
    return out;
  }
}
