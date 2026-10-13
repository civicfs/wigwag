import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { WigwagError } from '../../errors.js';
import { readBoundedFile } from '../../files.js';
import { isTextual } from '../../mime.js';
import { addBlobScope, blobInScope, getBlobMeta, putBlob, readBlob } from '../../store/blobs.js';
import { kvCas, kvGet, kvHistory, kvList } from '../../store/kv.js';
import { inScope, type Scope } from '../../store/links.js';
import { getMessage } from '../../store/messages.js';
import { getSession, holderOf, type SessionRow } from '../../store/sessions.js';
import { appendRecord, createStream, getStream, listStreams, readRecords } from '../../store/streams.js';
import { addSubscription, subscribersFor } from '../../store/subs.js';
import type { Connection } from '../connection.js';
import { canSee, connScope } from '../scope.js';
import type { Broker } from '../server.js';
import { myName, prepareBody } from './messages.js';

const requireAbsolute = (p: string) => {
  if (!isAbsolute(p)) throw new WigwagError('bad_request', `Path must be absolute: ${p}`);
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
};

const matchesFilter = (record: unknown, filter: Record<string, unknown> | null): boolean => {
  if (!filter) return true;
  if (typeof record !== 'object' || record === null) return false;
  return Object.entries(filter).every(([k, v]) => deepEqual((record as Record<string, unknown>)[k], v));
};

export function installData(broker: Broker): void {
  const db = broker.db;
  const limits = broker.config.limits;

  const scopeOf = (conn: Connection): Scope => connScope(db, conn);
  const myWorkspace = (conn: Connection): string => (getSession(db, conn.sessionId as string) as SessionRow).workspace;

  /**
   * Spec §17 / R42-B: a blob attached to a delivery addressed to `name` is readable by the session in `workspace` only
   * when that delivery is not stuck and its message passes canSee for the session.
   */
  const attachedTo = (name: string, workspace: string, ref: string): boolean =>
    (
      db
        .prepare(
          `SELECT DISTINCT m.id FROM deliveries d JOIN messages m ON m.id = d.message_id, json_each(m.attachments) j
           WHERE d.recipient = ? AND d.state <> 'stuck' AND j.value = ?`,
        )
        .all(name, ref) as Array<{ id: string }>
    ).some(({ id }) => {
      const m = getMessage(db, id);
      return m !== undefined && canSee(db, workspace, m);
    });

  async function fanOutUnchecked(
    target: { kind: 'stream'; stream: string } | { kind: 'kv'; key: string },
    writer: string,
    writerScope: Scope,
    itemWorkspace: string,
    subject: string,
    payload: unknown,
    record?: unknown,
  ): Promise<void> {
    const text = JSON.stringify(payload, null, 2);
    for (const sub of subscribersFor(db, target)) {
      if (sub.session_name === writer) continue;
      const holder = holderOf(db, sub.session_name);
      if (!holder || !inScope(writerScope, holder.workspace)) continue; // spec §17: only watchers in scope
      if (target.kind === 'stream' && !matchesFilter(record, sub.filter)) continue;
      const { body, attachments } = prepareBody(broker, 'wigwag', text, []);
      // Final review I-7: every notice is committed in this tick; its push runs detached.
      broker.engine
        ?.notice(sub.session_name, subject, body, {
          priority: sub.priority,
          stream: target.kind === 'stream' ? target.stream : undefined,
          attachments,
          from_workspace: itemWorkspace, // R42-C: provenance of the data item, so scope checks apply at delivery/read
        })
        .catch((e) => broker.log(`fan-out notice to ${sub.session_name} failed: ${(e as Error).message}`));
    }
  }

  /** Runs after the mutation committed: a failure here is logged, never surfaced as a failed write. */
  async function fanOut(...args: Parameters<typeof fanOutUnchecked>): Promise<void> {
    try {
      await fanOutUnchecked(...args);
    } catch (e) {
      const t = args[0];
      broker.log(
        `fan-out failed for ${t.kind === 'kv' ? `kv:${t.key}` : `stream:${t.stream}`}: ${(e as Error).message}`,
      );
    }
  }

  broker.handle('blob.put', ({ conn }, p) => {
    const me = myName(broker, conn);
    let data: Buffer;
    if (p.path !== undefined) {
      requireAbsolute(p.path);
      data = readBoundedFile(p.path, limits.max_blob_bytes);
    } else data = Buffer.from(p.text as string, 'utf8');
    const row = putBlob(
      db,
      broker.home,
      data,
      { media_type: p.media_type, name: p.name, created_by: me },
      limits.max_blob_bytes,
    );
    addBlobScope(db, row.ref, myWorkspace(conn)); // also when deduplicated: storing it proves the caller has it
    return row;
  });

  broker.handle('blob.get', ({ conn }, p) => {
    const meta = getBlobMeta(db, p.ref);
    if (!meta) throw new WigwagError('not_found', `Blob not found: ${p.ref}`);
    if (conn.role !== 'owner' && !blobInScope(db, p.ref, scopeOf(conn))) {
      // A message addressed to this name carried it (e.g. sent before the name had a holder): record and allow.
      if (!attachedTo(myName(broker, conn), myWorkspace(conn), p.ref)) {
        throw new WigwagError('not_found', `Blob not found: ${p.ref}`);
      }
      addBlobScope(db, p.ref, myWorkspace(conn));
    }
    const data = readBlob(broker.home, p.ref);
    if (p.dest_path !== undefined) {
      requireAbsolute(p.dest_path);
      if (existsSync(p.dest_path)) throw new WigwagError('conflict', `Refusing to overwrite ${p.dest_path}`);
      try {
        writeFileSync(p.dest_path, data, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new WigwagError('conflict', `Refusing to overwrite ${p.dest_path}`);
        }
        throw e;
      }
      return { meta, written_to: p.dest_path };
    }
    if (meta.size > limits.inline_blob_bytes || !isTextual(meta.media_type)) {
      throw new WigwagError(
        'bad_request',
        `Blob ${p.ref} is ${meta.size} bytes (${meta.media_type}); inline limit is ${limits.inline_blob_bytes} bytes of text. Pass dest_path.`,
      );
    }
    return { meta, text: data.toString('utf8') };
  });

  broker.handle('kv.get', ({ conn }, p) => ({ entry: kvGet(db, scopeOf(conn), p.key) }));
  broker.handle('kv.list', ({ conn }, p) => ({ entries: kvList(db, scopeOf(conn), p.prefix) }));
  broker.handle('kv.history', ({ conn }, p) => ({ versions: kvHistory(db, scopeOf(conn), p.key) }));

  broker.handle('kv.cas', async ({ conn }, p) => {
    if (p.value === null) throw new WigwagError('bad_request', 'Use kv.delete to remove a key');
    const me = myName(broker, conn);
    const scope = scopeOf(conn);
    const r = kvCas(db, scope, p.key, p.expected_version, p.value, me, limits.max_kv_value_bytes);
    if (r.ok)
      await fanOut({ kind: 'kv', key: p.key }, me, scope, r.workspace, `kv ${p.key} v${r.version}`, {
        key: p.key,
        version: r.version,
        value: p.value,
        updated_by: me,
      });
    return r;
  });

  broker.handle('kv.delete', async ({ conn }, p) => {
    const me = myName(broker, conn);
    const scope = scopeOf(conn);
    const r = kvCas(db, scope, p.key, p.expected_version, null, me, limits.max_kv_value_bytes);
    if (r.ok)
      await fanOut({ kind: 'kv', key: p.key }, me, scope, r.workspace, `kv ${p.key} deleted (v${r.version})`, {
        key: p.key,
        version: r.version,
        value: null,
        updated_by: me,
      });
    return r;
  });

  broker.handle('kv.watch', ({ conn }, p) => {
    addSubscription(db, myName(broker, conn), `kv:${p.prefix}`, p.priority, null);
    return {};
  });

  broker.handle('stream.create', ({ conn }, p) =>
    createStream(db, scopeOf(conn), {
      name: p.name,
      json_schema: p.json_schema,
      description: p.description,
      created_by: myName(broker, conn),
    }),
  );

  broker.handle('stream.append', async ({ conn }, p) => {
    const me = myName(broker, conn);
    const scope = scopeOf(conn);
    const stream = getStream(db, scope, p.name);
    if (!stream) throw new WigwagError('not_found', `Stream not found: ${p.name}`);
    const { seq } = appendRecord(db, scope, p.name, p.record, me);
    await fanOut(
      { kind: 'stream', stream: p.name },
      me,
      scope,
      stream.workspace,
      `stream ${p.name} #${seq}`,
      { stream: p.name, seq, record: p.record, appended_by: me },
      p.record,
    );
    return { seq };
  });

  broker.handle('stream.read', ({ conn }, p) => ({
    records: readRecords(db, scopeOf(conn), p.name, p.after_seq, p.limit),
  }));

  broker.handle('stream.subscribe', ({ conn }, p) => {
    if (!getStream(db, scopeOf(conn), p.name)) throw new WigwagError('not_found', `Stream not found: ${p.name}`);
    addSubscription(
      db,
      myName(broker, conn),
      `stream:${p.name}`,
      p.priority,
      p.filter as Record<string, unknown> | null,
    );
    return {};
  });

  broker.handle('stream.list', ({ conn }) => ({ streams: listStreams(db, scopeOf(conn)) }));
}
