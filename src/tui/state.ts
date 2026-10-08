import type { OwnerDelivery } from '../broker/handlers/owner.js';
import type { PublicSession } from '../broker/registry.js';
import type { FeedData } from '../protocol/rpc.js';
import type { DeliveryRow, MessageRow } from '../store/messages.js';
import { workspaceLabel } from '../workspace.js';

export type Throttle = { from_name: string; to_name: string; created_at: string };

export type LinkEntry = { a: string; b: string; a_label: string; b_label: string; created_at: string };

export interface TuiState {
  sessions: PublicSession[];
  feed: MessageRow[];
  deliveries: OwnerDelivery[];
  throttles: Throttle[];
  links: LinkEntry[];
}

export const EMPTY: TuiState = { sessions: [], feed: [], deliveries: [], throttles: [], links: [] };

const OPEN = new Set(['pending', 'held', 'failed', 'stuck']);
const rank = (s: PublicSession) => (s.state === 'online-busy' ? 0 : s.state === 'online-idle' ? 1 : 2);
const order = (a: PublicSession, b: PublicSession) => rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? '');

/** The broker snapshot carries no links; they are loaded with owner.links and kept up to date by 'link' events. */
export type Action =
  | { type: 'snapshot'; data: Omit<TuiState, 'links'> & { links?: LinkEntry[] } }
  | { type: 'links'; data: LinkEntry[] }
  | { type: 'feed'; data: FeedData };

export function reduce(s: TuiState, a: Action): TuiState {
  if (a.type === 'snapshot')
    return { ...a.data, links: a.data.links ?? s.links, sessions: [...a.data.sessions].sort(order) };
  if (a.type === 'links') return { ...s, links: a.data };
  const { type, payload } = a.data;
  if (type === 'message') {
    const m = payload as MessageRow;
    return s.feed.some((x) => x.id === m.id) ? s : { ...s, feed: [m, ...s.feed] };
  }
  if (type === 'session') {
    const p = payload as PublicSession;
    return { ...s, sessions: [p, ...s.sessions.filter((x) => x.id !== p.id)].sort(order) };
  }
  if (type === 'delivery') {
    const d = payload as DeliveryRow & { recipient_unread?: number };
    const rest = s.deliveries.filter((x) => !(x.message_id === d.message_id && x.recipient === d.recipient));
    const sessions =
      d.recipient_unread === undefined
        ? s.sessions
        : s.sessions.map((x) => (x.name === d.recipient ? { ...x, unread: d.recipient_unread as number } : x));
    if (!OPEN.has(d.state)) return { ...s, sessions, deliveries: rest };
    // The snapshot feed is bounded, so the message may be unknown here: keep what an earlier update recorded.
    const m = s.feed.find((x) => x.id === d.message_id);
    const prev = s.deliveries.find((x) => x.message_id === d.message_id && x.recipient === d.recipient);
    const { recipient_unread: _u, ...row } = d;
    return {
      ...s,
      sessions,
      deliveries: [
        ...rest,
        {
          ...row,
          subject: m?.subject ?? prev?.subject ?? '',
          from_name: m?.from_name ?? prev?.from_name ?? '',
          priority: m?.priority ?? prev?.priority ?? 'normal',
        },
      ],
    };
  }
  if (type === 'link') {
    const l = payload as { a: string; b: string; active: boolean };
    const same = (x: LinkEntry) => (x.a === l.a && x.b === l.b) || (x.a === l.b && x.b === l.a);
    if (!l.active) return { ...s, links: s.links.filter((x) => !same(x)) };
    if (s.links.some(same)) return s;
    const entry = {
      a: l.a,
      b: l.b,
      a_label: workspaceLabel(l.a),
      b_label: workspaceLabel(l.b),
      created_at: new Date().toISOString(),
    };
    return { ...s, links: [...s.links, entry] };
  }
  const t = payload as { from: string; to: string; active: boolean };
  const rest = s.throttles.filter((x) => !(x.from_name === t.from && x.to_name === t.to));
  return {
    ...s,
    throttles: t.active ? [...rest, { from_name: t.from, to_name: t.to, created_at: new Date().toISOString() }] : rest,
  };
}
