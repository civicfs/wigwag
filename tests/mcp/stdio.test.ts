import { PassThrough, Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { describe, expect, it, vi } from 'vitest';
import { FlushedStdioServerTransport as StdioServerTransport } from '../../src/mcp/stdio.js';

const message = {
  jsonrpc: '2.0' as const,
  method: 'notifications/claude/channel',
  params: { content: 'from codex', meta: {} },
};

describe('MCP channel stdio write completion', () => {
  it('waits for the write callback even when the writable queue admits the notification', async () => {
    let complete: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        complete = callback;
      },
    });
    const transport = new StdioServerTransport(new PassThrough(), output);
    let finished = false;
    const writing = transport.send(message).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    complete?.();
    await writing;
    expect(finished).toBe(true);
  });

  it('rejects a backpressured notification when the output closes without drain', async () => {
    const output = new Writable({ highWaterMark: 1, write() {} });
    output.on('error', () => {});
    const transport = new StdioServerTransport(new PassThrough(), output);
    const writing = transport.send(message);
    let rejected = false;
    void writing.catch(() => {
      rejected = true;
    });
    output.destroy(new Error('fixture pipe closed'));
    await vi.waitFor(() => expect(rejected).toBe(true));
    await expect(writing).rejects.toThrow();
  });

  it('propagates a real MCP Server notification write failure from the fake host pipe', async () => {
    let complete!: (error?: Error | null) => void;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        complete = callback;
      },
    });
    const server = new Server(
      { name: 'wigwag-test', version: '0' },
      {
        capabilities: { experimental: { 'claude/channel': {} } },
      },
    );
    const transport = new StdioServerTransport(new PassThrough(), output);
    await server.connect(transport);
    try {
      const writing = server.notification({ method: message.method, params: message.params });
      const rejected = expect(writing).rejects.toThrow('fixture host write failed');
      complete(new Error('fixture host write failed'));
      await rejected;
    } finally {
      await server.close();
    }
  });
});
