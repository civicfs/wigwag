import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tailLines } from './tail.js';

export const SIDECAR_MAX_BYTES = 65536;
export const TRANSCRIPT_TAIL_BYTES = 262144;
export type ClaudeTitleOrigin = 'claude-hook' | 'claude-sidecar' | 'claude-transcript';

/** S-B: the hook's transcript path must be `<dir>/<session_id>.jsonl`; anything else is not this session's transcript. */
export function validTranscriptPath(path: unknown, sessionId: string): path is string {
  return typeof path === 'string' && isAbsolute(path) && basename(path) === `${sessionId}.jsonl`;
}

/** Claude 2.1.300 writes `join(dirname(transcriptPath), sessionId, "custom-title.json")` on /rename (S-B). */
export const sidecarPath = (transcriptPath: string, sessionId: string): string =>
  join(dirname(transcriptPath), sessionId, 'custom-title.json');

const title = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function readSidecarTitle(transcriptPath: string, sessionId: string): string | null {
  try {
    const p = sidecarPath(transcriptPath, sessionId);
    if (statSync(p).size > SIDECAR_MAX_BYTES) return null;
    return title((JSON.parse(readFileSync(p, 'utf8')) as { customTitle?: unknown }).customTitle);
  } catch {
    return null;
  }
}

/** Newest `custom-title` record for this session in the transcript's last `maxBytes`; never reads the whole file. */
export function readTranscriptTitle(
  transcriptPath: string,
  sessionId: string,
  maxBytes = TRANSCRIPT_TAIL_BYTES,
): string | null {
  const lines = tailLines(transcriptPath, maxBytes);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"custom-title"')) continue;
    try {
      const r = JSON.parse(line) as { type?: unknown; sessionId?: unknown; customTitle?: unknown };
      const t = r.type === 'custom-title' && r.sessionId === sessionId ? title(r.customTitle) : null;
      if (t) return t;
    } catch {
      // a torn or partial write
    }
  }
  return null;
}

/** Precedence (S-B, S-E): the hook's session_title, then the sidecar, then (when allowed) the transcript tail. */
export function resolveClaudeTitle(x: {
  hookTitle: string | null;
  transcriptPath: string | null;
  sessionId: string;
  scanTranscript: boolean;
}): { title: string; origin: ClaudeTitleOrigin } | null {
  const hook = title(x.hookTitle);
  if (hook) return { title: hook, origin: 'claude-hook' };
  if (!validTranscriptPath(x.transcriptPath, x.sessionId)) return null;
  const side = readSidecarTitle(x.transcriptPath, x.sessionId);
  if (side) return { title: side, origin: 'claude-sidecar' };
  const tail = x.scanTranscript ? readTranscriptTitle(x.transcriptPath, x.sessionId) : null;
  return tail ? { title: tail, origin: 'claude-transcript' } : null;
}
