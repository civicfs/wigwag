/** @jsxImportSource react */
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import type { Client } from '../../src/client/client.js';
import type { MessageRow } from '../../src/store/messages.js';
import { App } from '../../src/tui/App.js';

export class Out extends EventEmitter {
  frames: string[] = [];
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }
  write = (f: string) => {
    this.frames.push(f);
  };
  get last() {
    return this.frames.at(-1) ?? '';
  }
}
export class In extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write = (d: string) => {
    this.data = d;
    this.emit('readable');
    this.emit('data', d);
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
}

export type Handlers = Record<string, (params: Record<string, unknown>) => unknown>;

/** Mounts the App on stdout/stdin stubs of the given size against a stub client that records its calls. */
export function mount(
  snapshot: unknown,
  show: (id: string) => unknown,
  columns: number,
  rows: number,
  handlers: Handlers = {},
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = Object.assign(new EventEmitter(), {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (handlers[method]) return handlers[method](params);
      if (method === 'owner.snapshot') return snapshot;
      if (method === 'owner.show') return show(String(params.id ?? ''));
      return {};
    },
    close: () => {},
  }) as unknown as Client;
  const stdout = new Out(columns, rows);
  const stdin = new In();
  const app = render(<App client={client} />, {
    // biome-ignore lint/suspicious/noExplicitAny: stubs for the Node streams Ink expects
    stdout: stdout as any,
    // biome-ignore lint/suspicious/noExplicitAny: stubs for the Node streams Ink expects
    stdin: stdin as any,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return { app, stdout, stdin, calls, client, frame: () => stdout.last };
}

export const msg = (i: number): MessageRow => ({
  id: `msg-${i}`,
  from_name: 'chatty-bot',
  from_workspace: null,
  to_target: 'claude-main',
  kind: 'message',
  priority: 'normal',
  subject: `subject-${i}`,
  body: `body of message ${i}`,
  attachments: [],
  reply_to: null,
  request_id: null,
  expires_at: null,
  stream: null,
  created_at: '2026-10-07T00:00:00Z',
});

export const DOWN = '\u001B[B';
export const tick = () => new Promise((r) => setTimeout(r, 5));
