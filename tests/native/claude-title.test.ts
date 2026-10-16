import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readSidecarTitle,
  readTranscriptTitle,
  resolveClaudeTitle,
  SIDECAR_MAX_BYTES,
  validTranscriptPath,
} from '../../src/native/claude-title.js';

const SID = '5d7c100a-7597-483c-bc8c-88a81970184d';
const project = () => mkdtempSync(join(tmpdir(), 'ww-ct-'));
const transcript = (dir: string, lines: unknown[]) => {
  const p = join(dir, `${SID}.jsonl`);
  writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return p;
};
const sidecar = (dir: string, body: string) => {
  mkdirSync(join(dir, SID), { recursive: true });
  writeFileSync(join(dir, SID, 'custom-title.json'), body);
};

describe('claude title sources', () => {
  it('validTranscriptPath requires an absolute <session_id>.jsonl path', () => {
    expect(validTranscriptPath(`/p/${SID}.jsonl`, SID)).toBe(true);
    expect(validTranscriptPath(`p/${SID}.jsonl`, SID)).toBe(false);
    expect(validTranscriptPath('/p/other.jsonl', SID)).toBe(false);
    expect(validTranscriptPath(undefined, SID)).toBe(false);
  });

  it('reads the sidecar title; ignores invalid, empty and oversized sidecars', () => {
    const dir = project();
    const t = transcript(dir, [{ type: 'user', sessionId: SID }]);
    expect(readSidecarTitle(t, SID)).toBeNull();
    sidecar(dir, JSON.stringify({ customTitle: '  Node refactor ' }));
    expect(readSidecarTitle(t, SID)).toBe('Node refactor');
    sidecar(dir, '{"customTitle":');
    expect(readSidecarTitle(t, SID)).toBeNull();
    sidecar(dir, JSON.stringify({ customTitle: '' }));
    expect(readSidecarTitle(t, SID)).toBeNull();
    sidecar(dir, JSON.stringify({ customTitle: 'x'.repeat(SIDECAR_MAX_BYTES) }));
    expect(readSidecarTitle(t, SID)).toBeNull();
  });

  it('scans the transcript tail newest first, for this session only, skipping a torn last line', () => {
    const dir = project();
    const t = transcript(dir, [
      { type: 'custom-title', sessionId: SID, customTitle: 'Old title' },
      { type: 'custom-title', sessionId: 'someone-else', customTitle: 'Not mine' },
      { type: 'custom-title', sessionId: SID, customTitle: 'New title' },
      { type: 'custom-title', sessionId: 'someone-else', customTitle: 'Also not mine' },
      '{"type":"custom-title","sessionId":"5d7c',
    ]);
    expect(readTranscriptTitle(t, SID)).toBe('New title');
  });

  it('is bounded: a record outside the tail window is not found', () => {
    const dir = project();
    const t = transcript(dir, [{ type: 'custom-title', sessionId: SID, customTitle: 'Far back' }]);
    appendFileSync(t, `\n${JSON.stringify({ type: 'user', sessionId: SID, pad: 'x'.repeat(4096) })}\n`);
    expect(readTranscriptTitle(t, SID, 1024)).toBeNull();
    expect(readTranscriptTitle(t, SID)).toBe('Far back');
  });

  it('resolves hook title, then sidecar, then transcript (only when scanning)', () => {
    const dir = project();
    const t = transcript(dir, [{ type: 'custom-title', sessionId: SID, customTitle: 'From transcript' }]);
    const base = { transcriptPath: t, sessionId: SID };
    expect(resolveClaudeTitle({ ...base, hookTitle: ' Hook ', scanTranscript: true })).toEqual({
      title: 'Hook',
      origin: 'claude-hook',
    });
    expect(resolveClaudeTitle({ ...base, hookTitle: null, scanTranscript: false })).toBeNull();
    expect(resolveClaudeTitle({ ...base, hookTitle: null, scanTranscript: true })).toEqual({
      title: 'From transcript',
      origin: 'claude-transcript',
    });
    sidecar(dir, JSON.stringify({ customTitle: 'From sidecar' }));
    expect(resolveClaudeTitle({ ...base, hookTitle: null, scanTranscript: false })).toEqual({
      title: 'From sidecar',
      origin: 'claude-sidecar',
    });
    expect(
      resolveClaudeTitle({
        hookTitle: null,
        transcriptPath: '/elsewhere/x.jsonl',
        sessionId: SID,
        scanTranscript: true,
      }),
    ).toBeNull();
  });
});
