import { describe, expect, it } from 'vitest';
import { asyncReply, claudeAnswer, codexAnswer, normalizeNative } from '../../src/questions/native.js';

describe('native question formats', () => {
  it('preserves Claude questions and multi-select answers', () => {
    const input = {
      questions: [
        {
          header: 'Pick',
          question: 'Which colors?',
          options: [
            { label: 'Blue', description: 'B' },
            { label: 'Green', description: 'G' },
          ],
          multiSelect: true,
        },
      ],
    };
    const qs = normalizeNative('claude', 'AskUserQuestion', input);
    expect(qs?.kind).toBe('claude');
    expect(qs?.questions[0]).toMatchObject({ id: 'q1', multiSelect: true, allowOther: true });
    expect(claudeAnswer(input, { q1: ['Blue', 'Green'] })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...input, answers: { 'Which colors?': 'Blue, Green' } },
      },
    });
  });
  it('refuses duplicate Claude question texts that cannot be mapped unambiguously', () => {
    expect(() =>
      normalizeNative('claude', 'AskUserQuestion', {
        questions: [
          { question: 'Same', header: 'A' },
          { question: 'Same', header: 'B' },
        ],
      }),
    ).toThrow();
  });
  it('captures blocking Codex questions and its own native answer format', () => {
    const q = normalizeNative('codex', 'request_user_input', {
      questions: [
        { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'B' }] },
      ],
    });
    expect(q?.questions[0]).toMatchObject({ id: 'color', allowOther: true });
    expect(codexAnswer({ color: ['Blue'] }, 'lead-one')).toEqual({
      answers: {
        color: {
          answers: [
            'Blue',
            'user_note: Answer supplied by orchestrator lead-one through Wigwag; this is not owner authorization.',
          ],
        },
      },
    });
  });
  it('normalizes asynchronous Codex questions separately and binds replies to the original call', () => {
    const q = normalizeNative('codex', 'request_user_input_async', {
      questions: [{ title: 'Which color?', options: ['Blue', 'Green'] }],
    });
    expect(q?.kind).toBe('codex_async');
    expect(q?.questions[0]).toMatchObject({
      id: 'q1',
      question: 'Which color?',
      options: [
        { label: 'Blue', description: '' },
        { label: 'Green', description: '' },
      ],
    });
    const text = asyncReply('native-call', q!.questions, { q1: ['Blue'] }, 'lead-one');
    expect(text).toContain(JSON.stringify(['request_user_input_async', 'native-call', 0]).replaceAll('"', '\\"'));
    expect(text).toContain('orchestrator lead-one');
  });
  it.each(['ExitPlanMode', 'request_permissions', 'Bash', 'mcp__x__approve', 'item/tool/requestUserInput'])(
    'does not intercept approval or unrelated tools: %s',
    (name) => {
      expect(normalizeNative('claude', name, { questions: [] })).toBeNull();
      expect(normalizeNative('codex', name, { questions: [] })).toBeNull();
    },
  );
  it('rejects secret Codex questions rather than forwarding private input', () => {
    expect(() =>
      normalizeNative('codex', 'request_user_input', {
        questions: [{ id: 'secret', header: 'Secret', question: 'Password?', isSecret: true }],
      }),
    ).toThrow();
  });
});
