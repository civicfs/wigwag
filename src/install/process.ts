import { spawn } from 'node:child_process';

/** Private worker -> direct installer protocol. Never forwarded to provider children. */
export const INSTALL_OPERATION_TOKEN = 'WIGWAG_INSTALL_OPERATION_TOKEN';
export const INSTALL_OUTCOME_UNKNOWN = 'wigwag-install-outcome-unknown';
const DIAGNOSTIC_BYTES = 65536;

async function unknownOutcome(bin: string, reason: string): Promise<never> {
  const token = process.env[INSTALL_OPERATION_TOKEN];
  if (token && process.send && process.connected) {
    await new Promise<void>((resolve) => {
      process.send?.({ kind: INSTALL_OUTCOME_UNKNOWN, token }, () => resolve());
    });
  }
  throw new Error(
    `${bin} outcome unknown (${reason}); inspect and stop any associated provider commands before retrying`,
  );
}

/** Drain without a timeout or volume limit; retain only a bounded diagnostic tail. */
export async function runInstaller(bin: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  const env = { ...process.env };
  delete env[INSTALL_OPERATION_TOKEN];
  const result = await new Promise<{
    code: number | null;
    signal: string | null;
    error?: Error;
    started: boolean;
    text: string;
  }>((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let tail = Buffer.alloc(0);
    let started = false;
    let error: Error | undefined;
    const retain = (chunk: Buffer) => {
      tail =
        chunk.length >= DIAGNOSTIC_BYTES
          ? Buffer.from(chunk.subarray(chunk.length - DIAGNOSTIC_BYTES))
          : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.length - DIAGNOSTIC_BYTES)), chunk]);
    };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    child.on('spawn', () => {
      started = true;
    });
    const recordError = (cause: Error) => {
      error = cause;
    };
    child.on('error', recordError);
    child.stdout.on('error', recordError);
    child.stderr.on('error', recordError);
    child.on('close', (code, signal) => resolve({ code, signal, error, started, text: tail.toString('utf8').trim() }));
  });
  if (result.error && !result.started) return { ok: false, text: result.error.message };
  if (result.signal || result.error || result.code === null)
    return unknownOutcome(bin, result.signal ?? result.error?.message ?? 'no exit status');
  return { ok: result.code === 0, text: result.text };
}
