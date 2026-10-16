import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OwnerDelivery } from '../../broker/handlers/owner.js';
import type { PublicSession } from '../../broker/registry.js';
import { FEED_LIMIT_MAX, type FeedData, KV_LIST_LIMIT_MAX, STREAM_READ_LIMIT_MAX } from '../../protocol/rpc.js';
import type { MessageRow } from '../../store/messages.js';
import { resolveWorkspace, workspaceLabel } from '../../workspace.js';
import { usageError } from '../help.js';
import { formatMessage, out, ownerConnect, parseCli, parseCount, table } from '../util.js';

const PRIORITIES = ['urgent', 'normal', 'low'];

async function withOwner<T>(f: (c: Awaited<ReturnType<typeof ownerConnect>>['client']) => Promise<T>): Promise<T> {
  const { client } = await ownerConnect();
  try {
    return await f(client);
  } finally {
    client.close();
  }
}

export const cmdWho = () =>
  withOwner(async (c) => {
    const s = await c.call<PublicSession[]>('session.who');
    out(
      table([
        [
          'NAME',
          'AGENT',
          'ROLE',
          'ORCHESTRATOR',
          'WORKERS',
          'STATE',
          'UNREAD',
          'BOUND',
          'LAST SEEN',
          'WORKSPACE',
          'CWD',
        ],
        ...s.map((x) => [
          x.name ?? '-',
          x.agent,
          x.role ?? 'peer',
          x.orchestration?.orchestrator_name ?? '-',
          x.workers?.map((w) => w.name ?? w.session_id).join(', ') || '-',
          x.liveness ? `${x.state} (${x.liveness})` : x.state,
          String(x.unread),
          x.bound ? 'yes' : 'no',
          x.last_seen_at,
          x.workspace_label,
          x.cwd,
        ]),
      ]),
    );
  });

export async function cmdSend(args: string[]): Promise<void> {
  const { values, positionals } = parseCli({
    args,
    allowPositionals: true,
    options: {
      priority: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      attach: { type: 'string', multiple: true },
    },
  });
  const to = positionals[0];
  if (positionals.length !== 1 || !to || !values.priority || !PRIORITIES.includes(values.priority))
    throw usageError('send');
  if ((values.body === undefined) === (values['body-file'] === undefined)) throw usageError('send');
  const body =
    values.body ??
    (values['body-file'] === '-' ? readFileSync(0, 'utf8') : readFileSync(values['body-file'] as string, 'utf8'));
  await withOwner(async (c) => {
    const { id } = await c.call<{ id: string }>('owner.send', {
      to,
      subject: values.subject,
      body,
      priority: values.priority,
      attach_paths: (values.attach ?? []).map((p) => resolve(p)),
    });
    out(id);
  });
}

export async function cmdTail(args: string[]): Promise<void> {
  const { values } = parseCli({
    args,
    options: { follow: { type: 'boolean', short: 'f' }, name: { type: 'string' }, limit: { type: 'string' } },
  });
  const limit = parseCount(values.limit, '--limit', 50, { min: 1, max: FEED_LIMIT_MAX });
  const name = values.name;
  const matches = (m: MessageRow) => !name || m.to_target === 'all' || m.from_name === name || m.to_target === name;
  let live: ((m: MessageRow) => void) | null = null;
  const buffered: MessageRow[] = [];
  const { client } = await ownerConnect((evName, data) => {
    const f = data as FeedData;
    if (evName !== 'feed' || f.type !== 'message') return;
    const m = f.payload as MessageRow;
    if (!matches(m)) return;
    if (live) live(m);
    else buffered.push(m);
  });
  let ownerClosing = false;
  try {
    if (values.follow) {
      const lost = new Promise<void>((res) => client.on('close', () => res()));
      await client.call('owner.subscribe');
      const { messages } = await client.call<{ messages: MessageRow[] }>('owner.feed', { limit, name });
      const seen = new Set(messages.map((m) => m.id));
      for (const m of [...messages].reverse()) out(`${formatMessage(m)}\n`);
      for (const m of buffered.splice(0)) if (!seen.has(m.id)) out(`${formatMessage(m)}\n`);
      live = (m) => {
        if (!seen.has(m.id)) out(`${formatMessage(m)}\n`);
      };
      process.once('SIGINT', () => {
        ownerClosing = true;
        client.close();
      });
      await lost;
      if (!ownerClosing) {
        process.stderr.write('broker connection lost\n');
        process.exitCode = 1;
      }
      return;
    }
    const { messages } = await client.call<{ messages: MessageRow[] }>('owner.feed', { limit, name });
    for (const m of [...messages].reverse()) out(`${formatMessage(m)}\n`);
  } finally {
    client.close();
  }
}

export async function cmdShow(args: string[]): Promise<void> {
  if (!args[0]) throw usageError('show');
  await withOwner(async (c) => {
    const r = await c.call<{ kind: string; message?: MessageRow; text?: string | null }>('owner.show', { id: args[0] });
    if (r.kind === 'message' && r.message) out(formatMessage(r.message));
    out(JSON.stringify(r, null, 2));
  });
}

export async function cmdKv(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseCli({
    args: rest,
    allowPositionals: true,
    options: { limit: { type: 'string' }, cursor: { type: 'string' }, json: { type: 'boolean' } },
  });
  const arg = positionals[0];
  if (
    !(((sub === 'get' || sub === 'history') && arg && rest.length === 1) || (sub === 'list' && positionals.length <= 1))
  ) {
    throw usageError('kv');
  }
  const limit = parseCount(values.limit, '--limit', 50, { min: 1, max: KV_LIST_LIMIT_MAX });
  await withOwner(async (c) => {
    if (sub === 'get' && arg) return out(JSON.stringify(await c.call('kv.get', { key: arg }), null, 2));
    if (sub === 'history' && arg) return out(JSON.stringify(await c.call('kv.history', { key: arg }), null, 2));
    if (sub === 'list') {
      const page = await c.call<{
        entries: Array<{ key: string; version: number; updated_by?: string; value?: unknown; blob_ref?: string }>;
        next_cursor: string | null;
      }>('kv.list', { prefix: arg ?? '', limit, cursor: values.cursor });
      if (values.json) return out(JSON.stringify(page, null, 2));
      return out(
        table([
          ['KEY', 'VERSION', 'BY', 'VALUE'],
          ...page.entries.map((e) => [
            e.key,
            String(e.version),
            e.updated_by ?? '-',
            e.blob_ref ? `[full entry: ${e.blob_ref}]` : JSON.stringify(e.value),
          ]),
        ]) + (page.next_cursor ? `\nMore keys: repeat with --cursor ${page.next_cursor}` : ''),
      );
    }
    throw usageError('kv');
  });
}

export async function cmdStreams(args: string[]): Promise<void> {
  const [sub, name, ...rest] = args;
  if (!(sub === 'list' && args.length === 1) && !(sub === 'read' && name)) throw usageError('streams');
  const readOpts =
    sub === 'read'
      ? (() => {
          const { values, positionals } = parseCli({
            args: rest,
            allowPositionals: true,
            options: { after: { type: 'string' }, limit: { type: 'string' } },
          });
          if (positionals.length) throw usageError('streams');
          return {
            after: parseCount(values.after, '--after', 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
            limit: parseCount(values.limit, '--limit', 100, { min: 1, max: STREAM_READ_LIMIT_MAX }),
          };
        })()
      : null;
  await withOwner(async (c) => {
    if (sub === 'list') {
      const { streams } = await c.call<{ streams: Array<{ name: string; description: string; created_by: string }> }>(
        'stream.list',
      );
      return out(
        table([['NAME', 'CREATED BY', 'DESCRIPTION'], ...streams.map((s) => [s.name, s.created_by, s.description])]),
      );
    }
    if (sub === 'read' && name) {
      const r = await c.call('stream.read', { name, after_seq: readOpts?.after, limit: readOpts?.limit });
      return out(JSON.stringify(r, null, 2));
    }
    throw usageError('streams');
  });
}

export async function cmdDeliveries(args: string[]): Promise<void> {
  const { values } = parseCli({ args, options: { stuck: { type: 'boolean' } } });
  await withOwner(async (c) => {
    const { deliveries } = await c.call<{ deliveries: OwnerDelivery[] }>('owner.deliveries', {
      states: values.stuck ? ['stuck'] : ['pending', 'held', 'failed', 'stuck'],
    });
    out(
      table([
        ['MESSAGE', 'RECIPIENT', 'STATE', 'REASON', 'ATTEMPTS', 'FROM', 'SUBJECT', 'LAST ERROR'],
        ...deliveries.map((d) => [
          d.message_id,
          d.recipient,
          d.state,
          d.hold_reason ?? '-',
          String(d.attempts),
          d.from_name,
          d.subject,
          d.last_error ?? '-',
        ]),
      ]),
    );
  });
}

export async function cmdReleaseThrottle(args: string[]): Promise<void> {
  const [from, to] = args;
  if (!from || !to) throw usageError('release-throttle');
  await withOwner(async (c) => {
    await c.call('owner.release_throttle', { from, to });
    out(`released ${from} → ${to}`);
  });
}

type LinkRow = { a: string; b: string; a_label: string; b_label: string; created_at: string };

const isPath = (x: string): boolean => x.includes('/') || x.startsWith('.');
/** A workspace path (contains "/" or starts with ".") is made absolute; anything else is a session name. */
const workspaceArg = (x: string): string => (isPath(x) ? resolve(x) : x);

/** The label the broker shows for an argument: the workspace of a path, or of the live (else first) session so named. */
async function labelOf(c: Awaited<ReturnType<typeof ownerConnect>>['client'], x: string): Promise<string> {
  if (isPath(x)) return workspaceLabel(resolveWorkspace(resolve(x)));
  const named = (await c.call<PublicSession[]>('session.who')).filter((s) => s.name === x);
  return (named.find((s) => s.state !== 'offline') ?? named[0])?.workspace_label ?? x;
}

async function linkCommand(method: 'owner.link' | 'owner.unlink', args: string[]): Promise<void> {
  const verb = method === 'owner.link' ? 'link' : 'unlink';
  const [a, b] = args;
  if (args.length !== 2 || !a || !b) throw usageError(verb);
  await withOwner(async (c) => {
    // Resolve labels first: after an unlink a session name may no longer lead anywhere new, and the reply is a list.
    const labels = [await labelOf(c, a), await labelOf(c, b)];
    await c.call(method, { a: workspaceArg(a), b: workspaceArg(b) });
    out(`${verb}ed ${labels[0]} ↔ ${labels[1]}`);
  });
}

export const cmdLink = (args: string[]) => linkCommand('owner.link', args);
export const cmdUnlink = (args: string[]) => linkCommand('owner.unlink', args);

export async function cmdLinks(args: string[]): Promise<void> {
  if (args.length) throw usageError('links');
  await withOwner(async (c) => {
    const { links } = await c.call<{ links: LinkRow[] }>('owner.links');
    out(
      links.length
        ? table([['WORKSPACE A', 'WORKSPACE B', 'SINCE'], ...links.map((l) => [l.a_label, l.b_label, l.created_at])])
        : 'no links',
    );
  });
}
