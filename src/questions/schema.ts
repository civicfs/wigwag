import { z } from 'zod';

export const QuestionZ = z
  .object({
    id: z.string().min(1).max(500),
    header: z.string().max(200),
    question: z.string().min(1).max(8000),
    options: z
      .array(z.object({ label: z.string().min(1).max(2000), description: z.string().max(4000) }))
      .max(30)
      .default([]),
    multiSelect: z.boolean().default(false),
    allowOther: z.boolean().default(true),
  })
  .strict();
export const QuestionsZ = z
  .array(QuestionZ)
  .min(1)
  .max(4)
  .superRefine((qs, ctx) => {
    if (new Set(qs.map((q) => q.id)).size !== qs.length)
      ctx.addIssue({ code: 'custom', message: 'Question IDs must be unique' });
    for (const q of qs)
      if (new Set(q.options.map((o) => o.label)).size !== q.options.length)
        ctx.addIssue({ code: 'custom', message: 'Option labels must be unique' });
    if (Buffer.byteLength(JSON.stringify(qs)) > 65536)
      ctx.addIssue({ code: 'custom', message: 'Question batch exceeds 65536 bytes' });
  });
export const AnswersZ = z.record(z.string(), z.array(z.string().min(1).max(8000)).min(1).max(30));
export type Question = z.infer<typeof QuestionZ>;
export type Answers = z.infer<typeof AnswersZ>;
export type NativeKind = 'claude' | 'codex' | 'codex_async';
export interface Capture {
  native_session_id: string;
  turn_id: string;
  tool_use_id: string;
  kind: NativeKind;
  questions: Question[];
}

export function validateAnswers(questions: Question[], answers: Answers): boolean {
  if (Object.keys(answers).length !== questions.length || questions.some((q) => !Object.hasOwn(answers, q.id)))
    return false;
  return questions.every((q) => {
    const values = answers[q.id];
    if (!values?.length || new Set(values).size !== values.length || values.some((v) => !v.trim())) return false;
    if (!q.multiSelect && values.length !== 1) return false;
    return q.allowOther || !q.options.length || values.every((v) => q.options.some((o) => o.label === v));
  });
}
