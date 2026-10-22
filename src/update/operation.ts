import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { cliEntry } from '../cli/util.js';
import { resolveHome } from '../config.js';
import { INSTALL_OPERATION_TOKEN, INSTALL_OUTCOME_UNKNOWN } from '../install/process.js';
import { assertNativeAllowed } from '../rehearsal.js';
import { lockUpdate, lockUpdateOperation } from './lock.js';
import { UpdateStepSchema } from './progress.js';

const ReceiptSchema = z
  .object({
    format: z.literal(1),
    id: z.string().uuid(),
    root: z.string().refine(isAbsolute),
    target: z.string().regex(/^\d+\.\d+\.\d+$/),
    step: UpdateStepSchema,
    state: z.enum(['running', 'succeeded', 'failed']),
    worker_pid: z.number().int().positive(),
  })
  .strict();
export type UpdateOperation = z.infer<typeof ReceiptSchema>;
const CommandSchema = z
  .object({
    root: z.string().refine(isAbsolute),
    target: z.string().regex(/^\d+\.\d+\.\d+$/),
    step: UpdateStepSchema,
    bin: z.string().min(1),
    args: z.array(z.string()).max(100),
    cwd: z.string().refine(isAbsolute),
  })
  .strict();
type Command = z.infer<typeof CommandSchema>;
const receiptPath = (home: string) => join(home, 'update-operation.json');

function safeLeaf(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe update operation file');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Read-only observation; running means unacknowledged, not proof of process liveness. */
export function readUpdateOperation(home = resolveHome()): UpdateOperation | null {
  const file = receiptPath(home);
  safeLeaf(file);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new Error('Unsafe update operation file');
    const parsed = ReceiptSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!parsed.success) throw new Error('Invalid update-operation.json; inspect it before retrying');
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}

function saveOperation(home: string, operation: UpdateOperation): void {
  const file = receiptPath(home),
    temporary = `${file}.${randomUUID()}.tmp`;
  safeLeaf(file);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(operation));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    safeLeaf(file);
    renameSync(temporary, file);
    const directory = openSync(home, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Preserve the write error. */
    }
  }
}

export class UpdateOperationPending extends Error {}
export function unknownOperation(operation: UpdateOperation): UpdateOperationPending {
  return new UpdateOperationPending(
    `Update operation ${operation.id} (${operation.step}) outcome unknown. Inspect and stop any associated installer/provider command first. Only after confirming it is not running, run: wigwag update --resolve-operation ${operation.id} --not-running. Then retry wigwag update --apply. Pending update progress is preserved.`,
  );
}

/** Caller holds update.mutex. Never infer command death from a worker PID. */
export function checkUpdateOperation(home: string): UpdateOperation | null {
  const release = lockUpdateOperation(home);
  try {
    const operation = readUpdateOperation(home);
    if (operation?.state === 'running') throw unknownOperation(operation);
    return operation;
  } finally {
    release();
  }
}

/** Only after the matching progress checkpoint has been persisted, or a known failure acknowledged. */
export function clearUpdateOperation(home: string, id: string): void {
  const current = readUpdateOperation(home);
  if (!current || current.id !== id) throw new Error('Update operation changed; inspect it before retrying');
  safeLeaf(receiptPath(home));
  unlinkSync(receiptPath(home));
}

export function resolveUpdateOperation(home: string, id: string): void {
  assertNativeAllowed(home, 'update operation recovery');
  const release = lockUpdate(home);
  try {
    const releaseOperation = lockUpdateOperation(home);
    try {
      const operation = readUpdateOperation(home);
      if (!operation || operation.id !== id || operation.state !== 'running')
        throw new Error('No unresolved update operation matches that exact ID');
      clearUpdateOperation(home, id);
    } finally {
      releaseOperation();
    }
  } finally {
    release();
  }
}

/** Mutating commands only: output is intentionally discarded and cannot overflow a buffer. */
export function runUpdateOperation(
  home: string,
  command: Command,
  options: { entry?: string; timeoutMs?: number } = {},
): Promise<string> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [options.entry ?? cliEntry(), '__update-worker'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, WIGWAG_HOME: home },
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker.connected) worker.disconnect();
      worker.unref();
      if (error) reject(error);
      else resolve('');
    };
    const outcome = () => {
      try {
        const receipt = readUpdateOperation(home);
        if (!receipt || receipt.id !== id)
          return finish(new Error('Update command worker exited before recording its result'));
        if (receipt.state === 'running') return finish(unknownOperation(receipt));
        finish(
          receipt.state === 'failed'
            ? new Error(`${command.step} command failed; inspect the installation locally`)
            : undefined,
        );
      } catch (e) {
        finish(e instanceof Error ? e : new Error('Cannot read update command result'));
      }
    };
    // A deadline stops waiting, never supervision. The worker keeps its lock and drains the command.
    const timer = setTimeout(
      () =>
        finish(
          new UpdateOperationPending(
            'Update operation still running; wait for it to finish, then retry wigwag update --apply',
          ),
        ),
      options.timeoutMs ?? 120000,
    );
    const send = (message: unknown) =>
      worker.send(message as object, (error) => {
        if (error) finish(error);
      });
    worker.on('message', (message: unknown) => {
      if (settled || !message || typeof message !== 'object') return;
      const kind = (message as { kind?: string }).kind;
      if (kind === 'ready') send({ kind: 'go', id });
      else if (kind === 'done') outcome();
      else if (kind === 'error')
        finish(new Error('Update command worker could not start; inspect pending update state'));
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', outcome);
    send({ kind: 'prepare', id, command });
  });
}

/** Internal IPC entry; detached from the updater's terminal and lifetime. */
export async function runUpdateWorker(): Promise<void> {
  if (!process.send) throw new Error('Update worker requires an IPC parent');
  const home = resolveHome();
  assertNativeAllowed(home, 'updates');
  let release: (() => void) | undefined;
  let command: Command | undefined;
  let operation: UpdateOperation | undefined;
  let started = false;
  const send = (kind: string) => {
    if (process.connected) process.send?.({ kind }, () => {});
  };
  const close = () => {
    release?.();
    release = undefined;
    if (process.connected) process.disconnect?.();
  };
  process.on('disconnect', () => {
    if (!started) close();
  });
  process.on('message', (message: unknown) => {
    try {
      if (!message || typeof message !== 'object') throw new Error('Invalid worker message');
      const msg = message as { kind?: string; id?: string; command?: unknown };
      if (msg.kind === 'prepare' && !operation) {
        const id = z.string().uuid().parse(msg.id);
        command = CommandSchema.parse(msg.command);
        release = lockUpdateOperation(home);
        if (readUpdateOperation(home)) throw new Error('Unacknowledged update operation');
        operation = {
          format: 1,
          id,
          root: command.root,
          target: command.target,
          step: command.step,
          state: 'running',
          worker_pid: process.pid,
        };
        send('ready');
      } else if (msg.kind === 'go' && release && operation && command && msg.id === operation.id && !started) {
        // A queued GO is safe after parent death because this worker already owns the fence.
        saveOperation(home, operation);
        started = true;
        const startedOperation = operation;
        // Only the direct plugin installer can report an uncertain nested provider outcome.
        const nestedInstaller = command.step === 'plugins';
        const env = { ...process.env };
        delete env[INSTALL_OPERATION_TOKEN];
        if (nestedInstaller) env[INSTALL_OPERATION_TOKEN] = operation.id;
        const child = spawn(command.bin, command.args, {
          cwd: command.cwd,
          stdio: nestedInstaller ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore',
          env,
        });
        let childStarted = false;
        let nestedUnknown = false;
        child.on('spawn', () => {
          childStarted = true;
        });
        child.on('message', (message: unknown) => {
          if (!nestedInstaller || !message || typeof message !== 'object') return;
          const report = message as { kind?: unknown; token?: unknown };
          if (report.kind === INSTALL_OUTCOME_UNKNOWN && report.token === startedOperation.id) nestedUnknown = true;
        });
        let finished = false;
        const complete = (state: UpdateOperation['state']) => {
          if (finished) return;
          finished = true;
          try {
            saveOperation(home, { ...startedOperation, state });
          } catch {
            /* Running receipt fails closed. */
          }
          release?.();
          release = undefined;
          send('done');
          if (process.connected) process.disconnect?.();
        };
        child.on('error', () => complete(childStarted ? 'running' : 'failed'));
        child.on('close', (code, signal) =>
          complete(nestedUnknown || signal || code === null ? 'running' : code === 0 ? 'succeeded' : 'failed'),
        );
      } else throw new Error('Invalid worker transition');
    } catch {
      send('error');
      // Do not drop supervision because of a malformed subsequent IPC message.
      if (!started) close();
    }
  });
}
