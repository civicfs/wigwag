import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { WigwagError } from '../../errors.js';
import { readBoundedFile } from '../../files.js';
import { BLOB_REF_RE } from '../../ids.js';
import { isTextual, mediaTypeFor } from '../../mime.js';
import { getBlobMeta, putBlob, readBlob } from '../../store/blobs.js';
import { activeLinks, addLink, removeLink, scopeOf } from '../../store/links.js';
import {
  type DeliveryRow,
  deliveriesByState,
  deliveriesOfMessage,
  feed,
  findRequest,
  findResponse,
  getMessage,
  type Priority,
} from '../../store/messages.js';
import { holderOf, listSessions } from '../../store/sessions.js';
import { activeThrottles } from '../../store/subs.js';
import { workspaceLabel } from '../../workspace.js';
import { publicSession } from '../registry.js';
import type { Broker } from '../server.js';
import { sendMessage } from './messages.js';

export type OwnerDelivery = DeliveryRow & { subject: string; from_name: string; priority: Priority };

export function installOwner(broker: Broker): void {
  const db = broker.db;

  const withMessage = (rows: DeliveryRow[]): OwnerDelivery[] =>
    rows.map((d) => {
      const m = getMessage(db, d.message_id);
      return { ...d, subject: m?.subject ?? '', from_name: m?.from_name ?? '', priority: m?.priority ?? 'normal' };
    });

  broker.handle('owner.subscribe', ({ conn }) => {
    conn.ownerSubscribed = true;
    return {};
  });

  broker.handle('owner.snapshot', (_c, p) => ({
    sessions: listSessions(db).map((s) => publicSession(db, s)),
    feed: feed(db, { limit: p.feed_limit }),
    deliveries: withMessage(deliveriesByState(db, ['pending', 'held', 'failed', 'stuck'])),
    throttles: activeThrottles(db),
  }));

  broker.handle('owner.feed', (_c, p) => ({ messages: feed(db, { before: p.before, limit: p.limit, name: p.name }) }));

  broker.handle('owner.send', async (_c, p) => {
    const attachments = p.attach_paths.map((path) => {
      if (!isAbsolute(path)) throw new WigwagError('bad_request', `Attachment path must be absolute: ${path}`);
      return putBlob(
        db,
        broker.home,
        readBoundedFile(path, broker.config.limits.max_blob_bytes),
        { media_type: mediaTypeFor(path), name: basename(path), created_by: 'owner' },
        broker.config.limits.max_blob_bytes,
      ).ref;
    });
    const m = await sendMessage(broker, {
      from: 'owner',
      to: p.to,
      kind: 'message',
      priority: p.priority,
      subject: p.subject,
      body: p.body,
      attachments,
    });
    return { id: m.id };
  });

  broker.handle('owner.release_throttle', async (_c, p) => {
    await broker.engine?.release(p.from, p.to);
    return {};
  });

  broker.handle('owner.deliveries', (_c, p) => ({ deliveries: withMessage(deliveriesByState(db, p.states)) }));

  broker.handle('owner.blobs', (_c, p) => ({
    blobs: db.prepare('SELECT * FROM blobs ORDER BY created_at DESC LIMIT ?').all(p.limit),
  }));

  // Spec §17 links. An argument with a "/" is an absolute path inside a workspace; otherwise a session name.
  const workspaceArg = async (x: string, mustExist: boolean): Promise<string> => {
    if (x.includes('/')) {
      if (!isAbsolute(x)) throw new WigwagError('bad_request', `Workspace path must be absolute: ${x}`);
      // final m-3: linking a path that does not exist would create a phantom workspace. Unlink stays lenient so a
      // link to a since-deleted directory can still be removed.
      if (mustExist && !existsSync(x)) throw new WigwagError('not_found', `No such directory: ${x}`);
      if (mustExist && !statSync(x).isDirectory())
        throw new WigwagError('bad_request', `Workspace path must be a directory: ${x}`);
      return broker.workspaces.resolve(x);
    }
    const s = holderOf(db, x);
    if (!s) throw new WigwagError('not_found', `No session named "${x}"; pass a workspace path instead`);
    return s.workspace;
  };
  const links = () => ({
    links: activeLinks(db).map((l) => ({ ...l, a_label: workspaceLabel(l.a), b_label: workspaceLabel(l.b) })),
  });

  broker.handle('owner.links', () => links());

  broker.handle('owner.link', async (_c, p) => {
    const a = await workspaceArg(p.a, true);
    const b = await workspaceArg(p.b, true);
    if (addLink(db, a, b)) {
      broker.broadcastOwner('link', { a, b, active: true });
      // Held messages that the merged scope now allows are retried; stuck ones stay stuck.
      const scope = scopeOf(db, a);
      for (const s of listSessions(db)) {
        // Final review I-7: the link is committed; pushes of the newly allowed backlog run detached.
        if (s.state !== 'offline' && scope.has(s.workspace)) {
          broker.engine
            ?.onAvailable(s)
            .catch((e) => broker.log(`onAvailable after link failed: ${(e as Error).message}`));
        }
      }
    }
    return links();
  });

  broker.handle('owner.unlink', async (_c, p) => {
    const a = await workspaceArg(p.a, false);
    const b = await workspaceArg(p.b, false);
    if (!removeLink(db, a, b)) {
      throw new WigwagError('not_found', `${workspaceLabel(a)} and ${workspaceLabel(b)} are not linked`);
    }
    broker.broadcastOwner('link', { a, b, active: false });
    return links();
  });

  broker.handle('owner.show', (_c, { id }) => {
    if (id.startsWith('msg-')) {
      const message = getMessage(db, id);
      if (!message) throw new WigwagError('not_found', `Message not found: ${id}`);
      const events = db
        .prepare(
          'SELECT recipient, from_state, to_state, detail, at FROM delivery_events WHERE message_id = ? ORDER BY rowid',
        )
        .all(id);
      return { kind: 'message', message, deliveries: deliveriesOfMessage(db, id), events };
    }
    if (id.startsWith('req-')) {
      const request = findRequest(db, id);
      if (!request) throw new WigwagError('not_found', `Request not found: ${id}`);
      return { kind: 'request', request, response: findResponse(db, id) ?? null };
    }
    if (BLOB_REF_RE.test(id)) {
      const meta = getBlobMeta(db, id);
      if (!meta) throw new WigwagError('not_found', `Blob not found: ${id}`);
      const text =
        meta.size <= broker.config.limits.inline_blob_bytes && isTextual(meta.media_type)
          ? readBlob(broker.home, id).toString('utf8')
          : null;
      return { kind: 'blob', meta, text };
    }
    throw new WigwagError('not_found', `Unrecognized id: ${id}`);
  });
}
