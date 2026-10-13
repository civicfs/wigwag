/** @jsxImportSource react */
import { Box, useApp, useInput, useStdout } from 'ink';
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Client } from '../client/client.js';
import { NAME_RE } from '../ids.js';
import { type FeedData, NO_SUBJECT } from '../protocol/rpc.js';
import { Compose, type Draft } from './Compose.js';
import {
  DETAIL_WIDTH,
  DeliveriesPane,
  DetailPane,
  detailLayout,
  FeedPane,
  SESSIONS_WIDTH,
  SessionsPane,
  TablePane,
} from './components.js';
import { type LinkDraft, LinkForm } from './LinkForm.js';
import { clampIndex, wrapCount } from './layout.js';
import { EMPTY, type LinkEntry, reduce, type TuiState } from './state.js';
import { Text } from './Text.js';
import { palette } from './theme.js';

const TABS = ['Feed', 'Deliveries', 'Requests', 'KV', 'Streams', 'Blobs', 'Links'] as const;
type Tab = (typeof TABS)[number];
type TableTab = 'Requests' | 'KV' | 'Streams' | 'Blobs';
const isTableTab = (t: Tab): t is TableTab => t !== 'Feed' && t !== 'Deliveries' && t !== 'Links';

/** One loaded table tab. `items` holds the raw entries so Enter can show every field of the row. */
type Table = { tab: TableTab; rows: string[][]; ids: string[]; items: unknown[]; nextCursor?: string | null };

/** The detail pane sits beside the main pane at this width or wider; narrower, it replaces the whole body. */
export const WIDE_COLUMNS = 120;
const HELP = 'q quit · Tab focus · ↑↓ select · Enter open · c compose · l link · R refresh · Links tab: u unlink';
const DETAIL_HELP = 'q quit · ↑↓ scroll detail · Esc back to the list';
const EMPTY_TABLE: Omit<Table, 'tab'> = { rows: [], ids: [], items: [] };

async function loadTable(client: Client, tab: TableTab, kvCursor?: string): Promise<Table> {
  if (tab === 'Requests') {
    const { requests } = await client.call<{
      requests: Array<{ request_id: string; status: string; from: string; to: string; subject: string }>;
    }>('req.list', {});
    return {
      tab,
      rows: requests.map((r) => [r.status, r.request_id, `${r.from} → ${r.to}`, r.subject]),
      ids: requests.map((r) => r.request_id),
      items: requests,
    };
  }
  if (tab === 'KV') {
    const { entries, next_cursor } = await client.call<{
      entries: Array<{ key: string; version: number; updated_by?: string; value?: unknown; blob_ref?: string }>;
      next_cursor?: string | null;
    }>('kv.list', { cursor: kvCursor });
    return {
      tab,
      rows: entries.map((e) => [
        e.key,
        `v${e.version}`,
        e.updated_by ?? '-',
        e.blob_ref ? `[full entry: ${e.blob_ref}]` : JSON.stringify(e.value),
      ]),
      ids: entries.map((e) => e.key),
      items: entries,
      nextCursor: next_cursor,
    };
  }
  if (tab === 'Streams') {
    const { streams } = await client.call<{
      streams: Array<{ name: string; description: string; created_by: string }>;
    }>('stream.list', {});
    return {
      tab,
      rows: streams.map((s) => [s.name, s.created_by, s.description]),
      ids: streams.map((s) => s.name),
      items: streams,
    };
  }
  const { blobs } = await client.call<{
    blobs: Array<{ ref: string; size: number; media_type: string; name: string | null; created_by: string }>;
  }>('owner.blobs', {});
  return {
    tab,
    rows: blobs.map((b) => [b.ref, `${b.size} B`, b.media_type, b.name ?? '-', b.created_by]),
    ids: blobs.map((b) => b.ref),
    items: blobs,
  };
}

/** Terminal size, kept current on resize. A stream without a size (not a TTY) is treated as 80x24. */
function useTermSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = useCallback(() => {
    const s = stdout as unknown as { columns?: number; rows?: number };
    return { columns: s.columns || 80, rows: s.rows || 24 };
  }, [stdout]);
  const [size, setSize] = useState(read);
  useEffect(() => {
    const on = () => setSize(read());
    stdout.on('resize', on);
    on();
    return () => {
      stdout.off('resize', on);
    };
  }, [stdout, read]);
  return size;
}

export function App({ client }: { client: Client }) {
  const { exit } = useApp();
  const { columns, rows: termRows } = useTermSize();
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [tab, setTab] = useState<Tab>('Feed');
  const [focus, setFocus] = useState<'sessions' | 'main'>('main');
  const [sel, setSel] = useState({ sessions: 0, main: 0 });
  const [filter, setFilter] = useState<string | null>(null);
  const [detail, setDetail] = useState<unknown>(null);
  const [detailTop, setDetailTop] = useState(0);
  const [table, setTable] = useState<Table | null>(null);
  const [kvCursors, setKvCursors] = useState<Array<string | undefined>>([undefined]);
  const kvCursor = kvCursors.at(-1);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState<string[]>([]);
  const [composing, setComposing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [pendingUnlink, setPendingUnlink] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    t.unref();
    return () => clearInterval(t);
  }, []);

  const track = useCallback((label: string, work: Promise<unknown>) => {
    setLoading((l) => [...l, label]);
    const done = () =>
      setLoading((l) => {
        const i = l.indexOf(label);
        return i < 0 ? l : [...l.slice(0, i), ...l.slice(i + 1)];
      });
    work.then(done, done);
  }, []);

  const refresh = useCallback(() => {
    setStatus('');
    track(
      'snapshot',
      client
        .call<TuiState>('owner.snapshot', {})
        .then((data) => dispatch({ type: 'snapshot', data }))
        .catch((e: Error) => setStatus(`snapshot failed: ${e.message}`)),
    );
    track(
      'links',
      client
        .call<{ links?: LinkEntry[] }>('owner.links', {})
        .then((r) => {
          if (Array.isArray(r.links)) dispatch({ type: 'links', data: r.links });
        })
        .catch((e: Error) => setStatus(`links failed: ${e.message}`)),
    );
  }, [client, track]);

  useEffect(() => {
    const on = (name: string, data: unknown) => {
      if (name === 'feed') dispatch({ type: 'feed', data: data as FeedData });
    };
    const onClose = () => setStatus('broker connection closed; restart wigwag tui');
    client.on('event', on);
    client.on('close', onClose);
    refresh();
    return () => {
      client.off('event', on);
      client.off('close', onClose);
    };
  }, [client, refresh]);

  // Table tabs: every load takes a generation; a response from an older load (another tab, or an older refresh)
  // is dropped, so a slow Requests answer can never appear under KV.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reload` re-runs the load for the active tab
  useEffect(() => {
    if (!isTableTab(tab)) return;
    const mine = ++generation.current;
    track(
      tab,
      loadTable(client, tab, kvCursor)
        .then((t) => {
          if (mine === generation.current) setTable(t);
        })
        .catch((e: Error) => {
          if (mine === generation.current) setStatus(`${tab} failed: ${e.message}`);
        }),
    );
    return () => {
      generation.current++;
    };
  }, [client, tab, reload, track, kvCursor]);

  const shownTable = table && isTableTab(tab) && table.tab === tab ? table : EMPTY_TABLE;
  const feed = filter
    ? state.feed.filter((m) => [m.from_name, m.to_target].includes(filter) || m.to_target === 'all')
    : state.feed;
  const mainLen =
    tab === 'Feed'
      ? feed.length
      : tab === 'Deliveries'
        ? state.throttles.length + state.deliveries.length
        : tab === 'Links'
          ? state.links.length
          : shownTable.rows.length;
  const selMain = clampIndex(sel.main, mainLen);
  const selSessions = clampIndex(sel.sessions, state.sessions.length);

  const linkKey = (l: LinkEntry) => `${l.a}\u0000${l.b}`;
  const pendingLink = pendingUnlink === null ? undefined : state.links.find((l) => linkKey(l) === pendingUnlink);
  const prompt = pendingLink
    ? `press u again to unlink ${pendingLink.a_label} ↔ ${pendingLink.b_label} (Esc cancels)`
    : '';
  const statusLine = [loading.length ? `loading ${loading.join(', ')}` : '', status, prompt]
    .filter(Boolean)
    .join(' · ');

  // Vertical budget: tab bar and help/status lines are always shown; the body gets what is left. One row stays
  // free below the output because Ink clears the whole terminal when the output is as tall as the terminal.
  const wide = columns >= WIDE_COLUMNS;
  const tabBar = TABS.map((t, i) => ` ${i + 1} ${t} `).join('');
  const live = state.sessions.filter((s) => s.state !== 'offline').length;
  const busy = state.sessions.filter((s) => s.state === 'online-busy').length;
  const unread = state.sessions.reduce((n, s) => n + s.unread, 0);
  const attention = state.deliveries.filter((d) => d.state === 'stuck' || d.state === 'failed').length;
  const activity = `${live} live · ${busy} busy · ${unread} unread`;
  const attentionText = attention ? ` · ${attention} need attention` : '';
  const header = `wigwag / owner console · ${activity}${attentionText}`;
  const help = detail ? DETAIL_HELP : HELP;
  const bodyHeight = Math.max(
    6,
    termRows -
      1 -
      wrapCount(header, columns) -
      wrapCount(tabBar, columns) -
      wrapCount(help, columns) -
      wrapCount(statusLine, columns),
  );
  const mainWidth = Math.max(20, columns - SESSIONS_WIDTH - (detail && wide ? DETAIL_WIDTH : 0));
  const detailWidth = wide ? DETAIL_WIDTH : columns;
  const detailMaxTop = detail ? detailLayout(detail, detailWidth, bodyHeight).maxTop : 0;

  const openDetail = (data: unknown) => {
    setDetailTop(0);
    setDetail(data);
  };
  const show = (id: string) =>
    client
      .call('owner.show', { id })
      .then(openDetail)
      .catch((e: Error) => setStatus(e.message));
  const showDelivery = (messageId: string, recipient: string) => {
    const d = state.deliveries.find((x) => x.message_id === messageId && x.recipient === recipient);
    if (!d) return;
    client
      .call<{ events?: Array<{ recipient: string }> }>('owner.show', { id: messageId })
      .then((r) =>
        openDetail({
          kind: 'delivery',
          delivery: d,
          events: (r.events ?? []).filter((e) => e.recipient === recipient),
        }),
      )
      .catch((e: Error) => {
        openDetail({ kind: 'delivery', delivery: d });
        setStatus(`delivery events unavailable: ${e.message}`);
      });
  };

  useInput(
    (input, key) => {
      if (pendingUnlink !== null && input !== 'u') {
        setPendingUnlink(null);
        if (key.escape) return;
      }
      if (input === 'q') {
        client.close();
        exit();
        return;
      }
      if (key.tab) return setFocus(focus === 'sessions' ? 'main' : 'sessions');
      const n = Number(input);
      if (n >= 1 && n <= TABS.length) {
        setTab(TABS[n - 1]);
        setSel((s) => ({ ...s, main: 0 }));
        setDetail(null);
        return;
      }
      if (key.escape) {
        if (detail) setDetail(null);
        else setFilter(null);
        return;
      }
      if (input === 'R') {
        refresh();
        if (tab === 'KV') setKvCursors([undefined]);
        setReload((r) => r + 1);
        return;
      }
      if (tab === 'KV' && !detail && focus === 'main') {
        if (input === ']' && shownTable.nextCursor) {
          setKvCursors((c) => [...c, shownTable.nextCursor as string]);
          setTable(null);
          setSel((s) => ({ ...s, main: 0 }));
          return;
        }
        if (input === '[' && kvCursors.length > 1) {
          setKvCursors((c) => c.slice(0, -1));
          setTable(null);
          setSel((s) => ({ ...s, main: 0 }));
          return;
        }
      }
      if (input === 'c') return setComposing(true);
      if (input === 'l') return setLinking(true);
      if (input === 'u' && focus === 'main' && tab === 'Links' && !detail) {
        const l = state.links[selMain];
        if (!l) return;
        if (pendingUnlink !== linkKey(l)) return setPendingUnlink(linkKey(l));
        setPendingUnlink(null);
        setStatus('');
        client
          .call<{ links?: LinkEntry[] }>('owner.unlink', { a: l.a, b: l.b })
          .then((r) => {
            if (Array.isArray(r.links)) dispatch({ type: 'links', data: r.links });
            setStatus(`unlinked ${l.a_label} ↔ ${l.b_label}`);
          })
          .catch((e: Error) => setStatus(`unlink failed: ${e.message}`));
        return;
      }
      const up = key.upArrow || input === 'k';
      const down = key.downArrow || input === 'j';
      if (detail && (up || down)) {
        setDetailTop((t) => Math.min(detailMaxTop, Math.max(0, t + (down ? 1 : -1))));
        return;
      }
      const len = focus === 'sessions' ? state.sessions.length : mainLen;
      if (up) return setSel((s) => ({ ...s, [focus]: Math.max(0, clampIndex(s[focus], len) - 1) }));
      if (down)
        return setSel((s) => ({ ...s, [focus]: Math.min(Math.max(0, len - 1), clampIndex(s[focus], len) + 1) }));
      if (key.return) {
        if (focus === 'sessions') {
          setFilter(state.sessions[selSessions]?.name ?? null);
          setTab('Feed');
          setSel((s) => ({ ...s, main: 0 }));
          setDetail(null);
        } else if (tab === 'Feed' && feed[selMain]) void show(feed[selMain].id);
        else if (tab === 'Deliveries' && selMain >= state.throttles.length) {
          const d = state.deliveries[selMain - state.throttles.length];
          if (d) showDelivery(d.message_id, d.recipient);
        } else if ((tab === 'Requests' || tab === 'Blobs') && shownTable.ids[selMain])
          void show(shownTable.ids[selMain]);
        else if ((tab === 'KV' || tab === 'Streams') && shownTable.items[selMain])
          openDetail(shownTable.items[selMain]);
        else if (tab === 'Links' && state.links[selMain]) openDetail(state.links[selMain]);
        return;
      }
      if (input === 'r' && focus === 'main' && tab === 'Deliveries' && !detail) {
        const t = state.throttles[selMain];
        if (t) {
          client
            .call('owner.release_throttle', { from: t.from_name, to: t.to_name })
            .then(() => setStatus(`released ${t.from_name} → ${t.to_name}`))
            .catch((e: Error) => setStatus(e.message));
        }
      }
    },
    { isActive: !composing && !linking },
  );

  const send = (d: Draft) => {
    const attach = d.attach.trim();
    if (attach && !attach.startsWith('/')) {
      setStatus('attach must be an absolute path (starting with /)');
      return;
    }
    setComposing(false);
    client
      .call<{ id: string }>('owner.send', {
        to: d.to,
        subject: d.subject || NO_SUBJECT,
        body: d.body,
        priority: d.priority,
        attach_paths: attach ? [attach] : [],
      })
      .then((r) => setStatus(`sent ${r.id}`))
      .catch((e: Error) => setStatus(`send failed: ${e.message}`));
  };

  // 15b: validated before submitting; the form (and its draft) stays open on a validation or broker error and closes
  // only when the broker accepted the link.
  const linkBusy = useRef(false);
  const link = (d: LinkDraft) => {
    const a = d.a.trim();
    const b = d.b.trim();
    if (!a || !b) {
      setStatus('both A and B are required');
      return;
    }
    for (const [label, v] of [
      ['a', a],
      ['b', b],
    ] as const) {
      if (v.includes('/') && !v.startsWith('/')) {
        setStatus(`${label}: "${v}" must be an absolute path (starting with /) or a session name`);
        return;
      }
      if (!v.includes('/') && !NAME_RE.test(v)) {
        setStatus(`${label}: "${v}" is not a session name (lowercase letters, digits, -) or an absolute path`);
        return;
      }
    }
    if (linkBusy.current) return;
    linkBusy.current = true;
    setStatus(`linking ${a} ↔ ${b}`);
    client
      .call<{ links?: LinkEntry[] }>('owner.link', { a, b })
      .then((r) => {
        if (Array.isArray(r.links)) dispatch({ type: 'links', data: r.links });
        setLinking(false);
        setStatus(`linked ${a} ↔ ${b}`);
      })
      .catch((e: Error) => setStatus(`link failed: ${e.message}`))
      .finally(() => {
        linkBusy.current = false;
      });
  };

  const mainFocused = focus === 'main';
  const main =
    tab === 'Feed' ? (
      <FeedPane
        messages={state.feed}
        selected={selMain}
        focused={mainFocused}
        filter={filter}
        width={mainWidth}
        height={bodyHeight}
      />
    ) : tab === 'Deliveries' ? (
      <DeliveriesPane
        throttles={state.throttles}
        deliveries={state.deliveries}
        selected={selMain}
        focused={mainFocused}
        width={mainWidth}
        height={bodyHeight}
      />
    ) : tab === 'Links' ? (
      <TablePane
        title="Links (l link · u unlink the selected one)"
        rows={state.links.map((l) => [`${l.a_label} ↔ ${l.b_label}`, `since ${l.created_at}`])}
        selected={selMain}
        focused={mainFocused}
        empty={loading.includes('links') ? 'loading links' : 'no links'}
        width={mainWidth}
        height={bodyHeight}
      />
    ) : (
      <TablePane
        title={
          tab === 'KV'
            ? `KV · page ${kvCursors.length}${kvCursors.length > 1 ? ' · [ previous' : ''}${shownTable.nextCursor ? ' · ] next' : ''}`
            : tab
        }
        rows={shownTable.rows}
        selected={selMain}
        focused={mainFocused}
        empty={loading.includes(tab) ? `loading ${tab}` : `no ${tab.toLowerCase()} yet`}
        width={mainWidth}
        height={bodyHeight}
      />
    );

  let body: ReactNode;
  if (composing) {
    body = (
      <Compose
        initialTo={focus === 'sessions' ? (state.sessions[selSessions]?.name ?? '') : ''}
        onSubmit={send}
        onCancel={() => setComposing(false)}
        width={columns}
        height={bodyHeight}
      />
    );
  } else if (linking) {
    body = (
      <LinkForm
        initialA={focus === 'sessions' ? (state.sessions[selSessions]?.name ?? '') : ''}
        onSubmit={link}
        onCancel={() => setLinking(false)}
        width={columns}
        height={bodyHeight}
      />
    );
  } else if (detail && !wide) {
    body = <DetailPane detail={detail} top={detailTop} width={columns} height={bodyHeight} />;
  } else {
    body = (
      <Box>
        <SessionsPane
          sessions={state.sessions}
          selected={selSessions}
          focused={focus === 'sessions'}
          height={bodyHeight}
          now={now}
          throttled={state.throttles.map((t) => t.to_name)}
        />
        {main}
        {detail ? <DetailPane detail={detail} top={detailTop} width={DETAIL_WIDTH} height={bodyHeight} /> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text color={palette.focus} bold>
          wigwag
        </Text>
        <Text dimColor> / owner console · </Text>
        {activity}
        <Text bold color={palette.danger}>
          {attentionText}
        </Text>
      </Text>
      <Text wrap="wrap">
        {TABS.map((t, i) => (
          <Text key={t} inverse={t === tab} bold={t === tab} color={t === tab ? palette.focus : palette.muted}>
            {` ${i + 1} ${t} `}
          </Text>
        ))}
      </Text>
      {body}
      <Text wrap="wrap">
        {help.split(' · ').map((hint, i) => {
          const split = hint.indexOf(' ');
          return (
            <Text key={hint}>
              {i ? <Text dimColor> · </Text> : null}
              <Text color={palette.focus} bold>
                {hint.slice(0, split)}
              </Text>
              <Text dimColor>{hint.slice(split)}</Text>
            </Text>
          );
        })}
      </Text>
      {statusLine ? (
        <Text
          color={
            statusLine.includes('failed') || statusLine.includes('connection closed') ? palette.danger : palette.warning
          }
          wrap="wrap"
        >
          {statusLine}
        </Text>
      ) : null}
    </Box>
  );
}
