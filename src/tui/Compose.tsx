/** @jsxImportSource react */
import { Box, useInput } from 'ink';
import { useState } from 'react';
import { windowOf, wrapCount, wrapRows } from './layout.js';
import { Text } from './Text.js';
import { palette, priorityColor } from './theme.js';

type Field = 'to' | 'priority' | 'subject' | 'attach' | 'body';
const FIELDS: Field[] = ['to', 'priority', 'subject', 'attach', 'body'];
const PRIORITIES = ['urgent', 'normal', 'low'] as const;
export type Draft = {
  to: string;
  priority: (typeof PRIORITIES)[number];
  subject: string;
  /** Optional absolute path of one file to attach. */
  attach: string;
  body: string;
};

const TITLE = 'Send as owner (Tab/Enter next field · ←/→ priority · Enter on body sends · Esc cancels)';
const HINT = 'attach: one absolute file path, optional. Longer bodies: wigwag send --body-file';

/**
 * With `width` and `height` the editor is bounded: the title and hint stay visible, and the field rows scroll so
 * the line being edited is always in view (with a position indicator). Without them everything is shown.
 */
export function Compose({
  initialTo,
  onSubmit,
  onCancel,
  width,
  height,
}: {
  initialTo: string;
  onSubmit: (d: Draft) => void;
  onCancel: () => void;
  width?: number;
  height?: number;
}) {
  const [field, setField] = useState<Field>('to');
  const [d, setD] = useState<Draft>({ to: initialTo, priority: 'normal', subject: '', attach: '', body: '' });
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab || (key.return && field !== 'body'))
      return setField(FIELDS[(FIELDS.indexOf(field) + 1) % FIELDS.length]);
    if (key.return) return onSubmit(d);
    if (field === 'priority') {
      if (key.leftArrow || key.rightArrow || input === ' ') {
        const i = PRIORITIES.indexOf(d.priority);
        setD({ ...d, priority: PRIORITIES[(i + (key.leftArrow ? 2 : 1)) % 3] });
      }
      return;
    }
    if (key.backspace || key.delete) return setD({ ...d, [field]: [...d[field]].slice(0, -1).join('') });
    if (input && !key.ctrl && !key.meta) setD({ ...d, [field]: d[field] + input });
  });

  const inner = width === undefined ? Number.POSITIVE_INFINITY : width - 4;
  const lines = FIELDS.flatMap((f) =>
    wrapRows(`${field === f ? '› ' : '  '}${f}: ${d[f]}`, inner).map((text) => ({ f, text })),
  );
  const windowed = width !== undefined && height !== undefined;
  const n = lines.length;
  const indText = `rows ${n}–${n} of ${n} · editing ${field}`;
  const reserved = windowed ? 2 + wrapCount(TITLE, inner) + wrapCount(HINT, inner) + wrapCount(indText, inner) : 0;
  const avail = windowed ? Math.max(1, height - reserved) : n;
  const lastActive = lines.reduce((acc, l, i) => (l.f === field ? i : acc), 0);
  const { start, end } = windowed
    ? windowOf(
        lines.map(() => 1),
        lastActive,
        avail,
      )
    : { start: 0, end: n };
  const indicator = windowed ? `rows ${start + 1}–${end} of ${n} · editing ${field}` : null;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.focus}
      paddingX={1}
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
    >
      <Text bold color={palette.focus} wrap="wrap">
        {TITLE}
      </Text>
      <Box flexDirection="column" flexGrow={windowed ? 1 : 0} flexShrink={1} overflow="hidden">
        {lines.slice(start, end).map((l, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: wrapped rows are positional and may repeat
            key={start + i}
            bold={l.f === field}
            color={l.f === field ? palette.focus : l.f === 'priority' ? priorityColor[d.priority] : undefined}
            wrap="wrap"
          >
            {l.text}
          </Text>
        ))}
      </Box>
      {indicator ? (
        <Text dimColor wrap="wrap">
          {indicator}
        </Text>
      ) : null}
      <Text dimColor wrap="wrap">
        {HINT}
      </Text>
    </Box>
  );
}
