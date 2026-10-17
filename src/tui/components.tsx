/** @jsxImportSource react */
import { Box } from 'ink';
import type { ReactNode } from 'react';
import type { OwnerDelivery } from '../broker/handlers/owner.js';
import type { PublicSession } from '../broker/registry.js';
import type { MessageRow } from '../store/messages.js';
import { clampIndex, detailRows, errorSummary, relativeAge, windowOf, wrapCount } from './layout.js';
import type { Throttle } from './state.js';
import { Text } from './Text.js';
import { deliveryColor, palette, priorityColor, sessionColor } from './theme.js';

const border = (focused: boolean) => (focused ? palette.focus : palette.muted);
export const SESSIONS_WIDTH = 34;
export const DETAIL_WIDTH = 60;
const CHROME = 4; // border (2) + paddingX (2) horizontally; border (2) + title vertically below

type Item = { key: string; height: number; node: ReactNode };

/**
 * A bordered pane holding a list. With `height` and `width` it renders only the items that fit, scrolled so the
 * selected item is visible, plus a position indicator. Without them (tests) it renders every item.
 */
function ListFrame({
  title,
  items,
  selected,
  focused,
  empty,
  width,
  height,
}: {
  title: string;
  items: Item[];
  selected: number;
  focused: boolean;
  empty?: string;
  width?: number;
  height?: number;
}) {
  const inner = width === undefined ? Number.POSITIVE_INFINITY : width - CHROME;
  const windowed = height !== undefined && width !== undefined;
  const n = items.length;
  const titleH = windowed ? Math.max(1, wrapCount(title, inner)) : 1;
  const indH = windowed && n > 0 ? wrapCount(`items ${n}–${n} of ${n} (↑/↓ to scroll) · Enter: full text`, inner) : 0;
  const avail = windowed ? height - 2 - titleH - indH : 0;
  const { start, end } = windowed
    ? windowOf(
        items.map((i) => i.height),
        selected,
        avail,
      )
    : { start: 0, end: n };
  const clipped = windowed && end - start > 0 && items.slice(start, end).some((i) => i.height > avail);
  const indicator =
    windowed && n > 0
      ? `items ${start + 1}–${end} of ${n}${end - start < n ? ' (↑/↓ to scroll)' : ''}${clipped ? ' · Enter: full text' : ''}`
      : null;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={border(focused)}
      paddingX={1}
      width={width}
      height={height}
      flexGrow={width === undefined ? 1 : 0}
      flexShrink={0}
      overflow="hidden"
    >
      <Text bold color={focused ? palette.focus : undefined} wrap="wrap">
        {title}
      </Text>
      {n === 0 && empty ? <Text dimColor>{empty}</Text> : null}
      <Box flexDirection="column" flexGrow={windowed ? 1 : 0} flexShrink={1} overflow={windowed ? 'hidden' : 'visible'}>
        {items.slice(start, end).map((i) => (
          <Box
            key={i.key}
            flexDirection="column"
            flexShrink={0}
            height={windowed && i.height > avail ? Math.max(1, avail) : undefined}
            overflow={windowed && i.height > avail ? 'hidden' : 'visible'}
          >
            <Box flexDirection="column" flexShrink={0}>
              {i.node}
            </Box>
          </Box>
        ))}
      </Box>
      {indicator ? (
        <Text dimColor wrap="wrap">
          {indicator}
        </Text>
      ) : null}
    </Box>
  );
}

const innerOf = (width?: number) => (width === undefined ? Number.POSITIVE_INFINITY : width - CHROME);
const rows = (width: number, ...texts: string[]) => texts.reduce((a, t) => a + wrapCount(t, width), 0);

export function SessionsPane({
  sessions,
  selected,
  focused,
  width = SESSIONS_WIDTH,
  height,
  now = Date.now(),
  throttled = [],
}: {
  sessions: PublicSession[];
  selected: number;
  focused: boolean;
  width?: number;
  height?: number;
  now?: number;
  /** Names of sessions that are the recipient of an active throttle. */
  throttled?: string[];
}) {
  const w = innerOf(width);
  const items: Item[] = sessions.map((s, i) => {
    const line1 = `${s.name ?? s.id} ${s.state.replace('online-', '')}${s.unread > 0 ? ` ${s.unread} unread` : ''}`;
    const isThrottled = s.name !== null && throttled.includes(s.name);
    const role =
      s.role === 'orchestrator' ? 'lead' : s.role === 'orchestrator-worker' ? 'lead + worker' : (s.role ?? 'peer');
    const lead = s.orchestration?.orchestrator_name ?? s.orchestration?.orchestrator_session_id;
    const roleText = `${role}${lead ? ` ← ${lead}` : ''}`;
    const line2 = `${s.agent} · ${roleText}${s.bound ? '' : ' · unbound'}`;
    const wsLine = s.workspace_label ?? '';
    const line3 = `seen ${relativeAge(s.last_seen_at, now)}${isThrottled ? ' · throttled' : ''}${s.liveness ? ` · ${s.liveness}` : ''}${s.codex_push ? ` · ${s.codex_push}` : ''}${s.compatibility_warning ? ` · ${s.compatibility_warning}` : ''}`;
    const active = focused && i === clampIndex(selected, sessions.length);
    return {
      key: s.id,
      height: rows(w, line1, wsLine, line2, line3),
      node: (
        <>
          <Text inverse={active} color={active ? palette.focus : undefined} bold wrap="wrap">
            {s.name ?? s.id}{' '}
            <Text color={active ? undefined : sessionColor[s.state]}>{s.state.replace('online-', '')}</Text>
            {s.unread > 0 ? <Text color={active ? undefined : palette.focus}> {s.unread} unread</Text> : null}
          </Text>
          {wsLine ? (
            <Text dimColor wrap="wrap">
              {wsLine}
            </Text>
          ) : null}
          <Text wrap="wrap">
            <Text dimColor>{s.agent} · </Text>
            <Text color={palette.role}>{roleText}</Text>
            {s.bound ? null : <Text color={palette.warning}> · unbound</Text>}
          </Text>
          <Text dimColor wrap="wrap">
            seen {relativeAge(s.last_seen_at, now)}
            {isThrottled ? <Text color={palette.warning}> · throttled</Text> : null}
            {s.liveness ? <Text color={palette.warning}> · {s.liveness}</Text> : null}
            {s.codex_push ? <Text color={palette.warning}> · {s.codex_push}</Text> : null}
            {s.compatibility_warning ? <Text color={palette.warning}> · {s.compatibility_warning}</Text> : null}
          </Text>
        </>
      ),
    };
  });
  return (
    <ListFrame
      title="Sessions"
      items={items}
      selected={selected}
      focused={focused}
      empty="no sessions yet"
      width={width}
      height={height}
    />
  );
}

export function FeedPane({
  messages,
  selected,
  focused,
  filter,
  width,
  height,
}: {
  messages: MessageRow[];
  selected: number;
  focused: boolean;
  filter: string | null;
  width?: number;
  height?: number;
}) {
  const shown = filter
    ? messages.filter((m) => [m.from_name, m.to_target].includes(filter) || m.to_target === 'all')
    : messages;
  const w = innerOf(width);
  const items: Item[] = shown.map((m, i) => {
    const head = `[${m.priority}] ${m.from_name} → ${m.to_target} · ${m.subject}`;
    const foot = `${m.id} · ${m.created_at}`;
    const active = focused && i === clampIndex(selected, shown.length);
    return {
      key: m.id,
      height: rows(w, head, m.body, foot) + 1,
      node: (
        <Box flexDirection="column" marginBottom={1}>
          <Text inverse={active} color={active ? palette.focus : undefined} wrap="wrap">
            <Text bold color={active ? undefined : priorityColor[m.priority]}>
              [{m.priority}]
            </Text>{' '}
            <Text color={active ? undefined : palette.focus}>
              {m.from_name} → {m.to_target}
            </Text>{' '}
            · <Text bold>{m.subject}</Text>
          </Text>
          <Text wrap="wrap">{m.body}</Text>
          <Text dimColor wrap="wrap">
            {foot}
          </Text>
        </Box>
      ),
    };
  });
  return (
    <ListFrame
      title={`Feed${filter ? ` · ${filter} (Esc clears)` : ''}`}
      items={items}
      selected={selected}
      focused={focused}
      empty="no messages yet"
      width={width}
      height={height}
    />
  );
}

export const FULL_ERROR_HINT = ' — Enter: full error';

export function DeliveriesPane({
  throttles,
  deliveries,
  selected,
  focused,
  width,
  height,
}: {
  throttles: Throttle[];
  deliveries: OwnerDelivery[];
  selected: number;
  focused: boolean;
  width?: number;
  height?: number;
}) {
  const w = innerOf(width);
  const total = throttles.length + deliveries.length;
  const sel = clampIndex(selected, total);
  const items: Item[] = [
    ...throttles.map((t, i): Item => {
      const text = `THROTTLED ${t.from_name} → ${t.to_name} since ${t.created_at}: press r to release`;
      return {
        key: `t:${t.from_name}>${t.to_name}`,
        height: rows(w, text),
        node: (
          <Text inverse={focused && i === sel} bold color={palette.warning} wrap="wrap">
            {text}
          </Text>
        ),
      };
    }),
    ...deliveries.map((d, j): Item => {
      const head = `${d.state.toUpperCase()} ${d.hold_reason ? `(${d.hold_reason}) ` : ''}${d.message_id} ${d.from_name} → ${d.recipient} · ${d.subject} · attempts ${d.attempts}`;
      const err = d.last_error ? errorSummary(d.last_error, w) : null;
      const errText = err ? `  ${err.first}${err.more ? FULL_ERROR_HINT : ''}` : '';
      const active = focused && throttles.length + j === sel;
      return {
        key: `d:${d.message_id}>${d.recipient}`,
        height: rows(w, head, errText),
        node: (
          <>
            <Text inverse={active} color={active ? palette.focus : undefined} wrap="wrap">
              <Text bold color={active ? undefined : deliveryColor[d.state]}>
                {d.state.toUpperCase()}
              </Text>
              {head.slice(d.state.length)}
            </Text>
            {err ? (
              <Text color={palette.danger} wrap="wrap">
                {errText}
              </Text>
            ) : null}
          </>
        ),
      };
    }),
  ];
  return (
    <ListFrame
      title="Deliveries"
      items={items}
      selected={sel}
      focused={focused}
      empty="nothing held, failed or stuck"
      width={width}
      height={height}
    />
  );
}

export function TablePane({
  title,
  rows: tableRows,
  selected,
  focused,
  empty,
  width,
  height,
}: {
  title: string;
  rows: string[][];
  selected: number;
  focused: boolean;
  empty: string;
  width?: number;
  height?: number;
}) {
  const w = innerOf(width);
  const items: Item[] = tableRows.map((r, i) => {
    const text = r.join('  ·  ');
    const active = focused && i === clampIndex(selected, tableRows.length);
    return {
      key: `${i}:${r.join('|')}`,
      height: rows(w, text),
      node: (
        <Text inverse={active} color={active ? palette.focus : undefined} wrap="wrap">
          <Text bold color={active ? undefined : (deliveryColor[r[0]] ?? palette.focus)}>
            {r[0]}
          </Text>
          {r.length > 1 ? `  ·  ${r.slice(1).join('  ·  ')}` : ''}
        </Text>
      ),
    };
  });
  return (
    <ListFrame
      title={title}
      items={items}
      selected={selected}
      focused={focused}
      empty={empty}
      width={width}
      height={height}
    />
  );
}

/** The detail wrapped into physical display rows for a pane of this size; scrolling is by these rows. */
export function detailLayout(detail: unknown, width: number | undefined, height: number | undefined) {
  const rowsOfText = detailRows(detail, innerOf(width));
  if (width === undefined || height === undefined) {
    return { rows: rowsOfText, avail: Number.POSITIVE_INFINITY, maxTop: 0 };
  }
  const n = rowsOfText.length;
  const indH = n > 0 ? wrapCount(`rows ${n}–${n} of ${n} (↑/↓ to scroll, Esc closes)`, innerOf(width)) : 0;
  const avail = Math.max(1, height - 2 - 1 - indH);
  return { rows: rowsOfText, avail, maxTop: Math.max(0, n - avail) };
}

export function DetailPane({
  detail,
  top = 0,
  width = DETAIL_WIDTH,
  height,
}: {
  detail: unknown;
  top?: number;
  width?: number;
  height?: number;
}) {
  if (!detail) return null;
  const { rows: all, avail, maxTop } = detailLayout(detail, width, height);
  const start = Math.min(Math.max(top, 0), maxTop);
  const end = height === undefined ? all.length : Math.min(all.length, start + avail);
  const indicator =
    height === undefined
      ? 'Esc closes'
      : `rows ${start + 1}–${end} of ${all.length}${end - start < all.length ? ' (↑/↓ to scroll, Esc closes)' : ' (Esc closes)'}`;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.role}
      width={width}
      height={height}
      paddingX={1}
      flexShrink={0}
      overflow="hidden"
    >
      <Text bold color={palette.role}>
        Detail
      </Text>
      <Box flexDirection="column" flexGrow={height === undefined ? 0 : 1} flexShrink={1} overflow="hidden">
        {all.slice(start, end).map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and may repeat
          <Text key={start + i} wrap="wrap">
            {l === '' ? ' ' : l}
          </Text>
        ))}
      </Box>
      <Text dimColor wrap="wrap">
        {indicator}
      </Text>
    </Box>
  );
}
