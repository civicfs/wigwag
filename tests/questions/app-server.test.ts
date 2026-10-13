import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { AppServer } from '../../src/questions/app-server.js';

describe('Codex app-server transport', () => {
  it('initializes over a Unix WebSocket and keeps server requests separate from client responses', async () => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const socket = join(mkdtempSync(join(tmpdir(), 'ww-as-')), 's');
    await new Promise<void>((r) => http.listen(socket, r));
    const seen: unknown[] = [];
    wss.on('connection', (ws) =>
      ws.on('message', (b) => {
        const f = JSON.parse(b.toString());
        seen.push(f);
        if (f.method === 'initialize') ws.send(JSON.stringify({ id: f.id, result: {} }));
        if (f.method === 'thread/resume') {
          ws.send(JSON.stringify({ id: 99, method: 'item/tool/requestUserInput', params: { threadId: 't' } }));
          ws.send(JSON.stringify({ id: f.id, result: { thread: { id: 't' } } }));
        }
      }),
    );
    const app = new AppServer(socket, 5000);
    const events: unknown[] = [];
    app.on('message', (f) => events.push(f));
    try {
      await app.connect();
      expect(await app.call('thread/resume', { threadId: 't' })).toEqual({ thread: { id: 't' } });
      expect(events).toContainEqual({ id: 99, method: 'item/tool/requestUserInput', params: { threadId: 't' } });
      expect(seen).toContainEqual({ method: 'initialized', params: {} });
    } finally {
      app.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
  it('bounds stalled initialization and closes its connection', async () => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const socket = join(mkdtempSync(join(tmpdir(), 'ww-as-')), 's');
    await new Promise<void>((r) => http.listen(socket, r));
    const app = new AppServer(socket, 40);
    try {
      await expect(app.connect()).rejects.toThrow(/timed out/);
    } finally {
      app.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
