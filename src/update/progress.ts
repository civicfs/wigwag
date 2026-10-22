import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { resolveHome } from '../config.js';

export const UpdateStepSchema = z.enum(['package', 'plugins', 'claude', 'broker']);
export type UpdateStep = z.infer<typeof UpdateStepSchema>;
const ProgressSchema = z
  .object({
    format: z.literal(1),
    root: z.string().refine(isAbsolute),
    target: z.string().regex(/^\d+\.\d+\.\d+$/),
    providers: z
      .array(z.enum(['claude', 'codex']))
      .min(1)
      .max(2),
    codex_binary: z.string().min(1),
    pending: z.array(UpdateStepSchema).max(4),
  })
  .strict()
  .refine(
    (p) =>
      new Set(p.providers).size === p.providers.length &&
      new Set(p.pending).size === p.pending.length &&
      (p.providers.includes('claude') || !p.pending.includes('claude')),
  );
export type UpdateProgress = z.infer<typeof ProgressSchema>;
const path = (home: string) => join(home, 'update-progress.json');
function safeLeaf(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error('Unsafe update progress file: symlinks, hard links and non-regular files are refused');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
/** Reads only; a pending repair is useful even when npm has no newer release. */
export function readUpdateProgress(home = resolveHome()): UpdateProgress | null {
  const file = path(home);
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
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new Error('Unsafe update progress file');
    const parsed = ProgressSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!parsed.success) throw new Error('Invalid update progress file; inspect update-progress.json before retrying');
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}
export function saveUpdateProgress(home: string, progress: UpdateProgress): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path(home);
  safeLeaf(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(progress));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    safeLeaf(file);
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write error; abandoned private temp files are never resumed.
    }
  }
}
export function clearUpdateProgress(home: string): void {
  safeLeaf(path(home));
  unlinkSync(path(home));
}
