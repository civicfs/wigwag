/** @jsxImportSource react */
import { Box, useInput } from 'ink';
import { useState } from 'react';
import { windowOf, wrapCount, wrapRows } from './layout.js';
import { Text } from './Text.js';
import { palette } from './theme.js';

type Field = 'a' | 'b';
const FIELDS: Field[] = ['a', 'b'];
export type LinkDraft = { a: string; b: string };

const TITLE = 'Link two workspaces (Tab/Enter next field · Enter on b links · Esc cancels)';
const HINT = 'a and b: each a session name or an absolute workspace path';

/** Same bounded behavior as Compose: title and hint stay visible; the field rows scroll to keep the edited line in view. */
export function LinkForm({
  initialA,
  onSubmit,
  onCancel,
  width,
  height,
}: {
  initialA: string;
  onSubmit: (d: LinkDraft) => void;
  onCancel: () => void;
  width?: number;
  height?: number;
}) {
  const [field, setField] = useState<Field>(initialA ? 'b' : 'a');
  const [d, setD] = useState<LinkDraft>({ a: initialA, b: '' });
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab || (key.return && field !== 'b')) return setField(FIELDS[(FIELDS.indexOf(field) + 1) % FIELDS.length]);
    if (key.return) return onSubmit(d);
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
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and may repeat
          <Text key={start + i} bold={l.f === field} color={l.f === field ? palette.focus : undefined} wrap="wrap">
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
