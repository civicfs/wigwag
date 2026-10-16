import { createConnection } from 'node:net';
import { WigwagError } from '../errors.js';
import { encode, LineDecoder } from '../protocol/frame.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Version-agnostic read-only escape hatch for stop/restart PID verification. Never exposes a general RPC client. */
export function readBrokerStatus(
  path: string,
  maxFrameBytes: number,
  signal: AbortSignal,
  expected?: unknown,
): Promise<{ pid: number; version?: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WigwagError('transport', 'broker status cancelled'));
      return;
    }
    const socket = createConnection(path),
      decoder = new LineDecoder(maxFrameBytes);
    socket.setEncoding('utf8');
    let settled = false;
    const done = (error: Error | null, result?: { pid: number; version?: string }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const abort = () => done(new WigwagError('transport', 'broker status cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', (e) => done(e));
    socket.on('close', () => done(new WigwagError('transport', 'broker status connection closed')));
    socket.on('data', (data) => {
      try {
        for (const f of decoder.push(data.toString())) {
          if (!object(f)) throw new Error('invalid broker status frame');
          if (f.error) throw new Error('broker refused read-only status');
          if (f.id === 1) {
            if (!object(f.result) || f.result.role !== 'owner') throw new Error('invalid status hello');
            socket.write(encode({ id: 2, method: 'sys.ping', params: {} }));
          } else if (f.id === 2) {
            const r = f.result;
            if (!object(r) || !Number.isSafeInteger(r.pid) || (r.pid as number) <= 1)
              throw new Error('invalid broker pid');
            done(null, { pid: r.pid as number, ...(typeof r.version === 'string' ? { version: r.version } : {}) });
          }
        }
      } catch (e) {
        done(e instanceof Error ? e : new Error(String(e)));
      }
    });
    const versions = object(expected)
      ? { protocol: expected.protocol, schema_version: expected.schema_version, version: expected.version }
      : { protocol: 1 };
    socket.write(encode({ id: 1, method: 'hello', params: { ...versions, role: 'owner' } }));
  });
}
