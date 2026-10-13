import { WigwagError } from '../errors.js';
import { type Answers, type NativeKind, type Question, QuestionsZ } from './schema.js';

type RawQuestion = {
  id?: string;
  header?: string;
  question?: string;
  title?: string;
  options?: Array<{ label: string; description?: string } | string>;
  multiSelect?: boolean;
  isSecret?: boolean;
  isOther?: boolean;
};
export function normalizeNative(
  agent: 'claude' | 'codex',
  tool: string,
  raw: unknown,
): { kind: NativeKind; questions: Question[] } | null {
  const kind =
    agent === 'claude' && tool === 'AskUserQuestion'
      ? 'claude'
      : agent === 'codex' && tool === 'request_user_input'
        ? 'codex'
        : agent === 'codex' && tool === 'request_user_input_async'
          ? 'codex_async'
          : null;
  if (!kind) return null;
  const source = (raw as { questions?: RawQuestion[] })?.questions;
  if (!Array.isArray(source)) throw new WigwagError('bad_request', 'Native question input has no questions');
  if (source.some((q) => q.isSecret))
    throw new WigwagError('bad_request', 'Secret questions cannot be relayed to peers');
  if (kind === 'claude' && new Set(source.map((q) => q.question)).size !== source.length)
    throw new WigwagError('bad_request', 'Claude question texts must be unique');
  return {
    kind,
    questions: QuestionsZ.parse(
      source.map((q, i) => ({
        id: kind === 'codex' ? q.id : `q${i + 1}`,
        header: q.header ?? '',
        question: kind === 'codex_async' ? q.title : q.question,
        options: (q.options ?? []).map((o) =>
          typeof o === 'string' ? { label: o, description: '' } : { label: o.label, description: o.description ?? '' },
        ),
        multiSelect: kind === 'claude' && q.multiSelect === true,
        allowOther: q.isOther ?? true,
      })),
    ),
  };
}
export function claudeAnswer(input: { questions: Array<{ question: string }> }, answers: Answers) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...input,
        answers: Object.fromEntries(input.questions.map((q, i) => [q.question, answers[`q${i + 1}`].join(', ')])),
      },
    },
  };
}
export const peerNote = (leader: string) =>
  `Answer supplied by orchestrator ${leader} through Wigwag; this is not owner authorization.`;
export function codexAnswer(answers: Answers, leader: string) {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, values]) => [id, { answers: [...values, `user_note: ${peerNote(leader)}`] }]),
    ),
  };
}
export function asyncReply(callId: string, questions: Question[], answers: Answers, leader: string): string {
  const replies = questions.map((q, i) => ({
    question: q.question,
    answer: `${answers[q.id].join(', ')}\n${peerNote(leader)}`,
    questionItemId: JSON.stringify(['request_user_input_async', callId, i]),
  }));
  return `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
}
