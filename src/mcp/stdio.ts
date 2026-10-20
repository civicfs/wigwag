import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** The SDK's send resolves on queue admission or drain. Channel receipts need the local write callback instead. */
export class FlushedStdioServerTransport extends StdioServerTransport {
  private readonly pendingWrites = new Set<(error?: Error | null) => void>();
  private outputClosed = false;

  constructor(
    stdin: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
  ) {
    super(stdin, output);
    // Keep the error listener for this stdio transport's lifetime: Node can emit error after its write callback.
    output.on('error', (error: Error) => {
      for (const finish of this.pendingWrites) finish(error);
      this.onerror?.(error);
    });
    output.on('close', () => {
      this.outputClosed = true;
      this.rejectWrites();
    });
  }

  override send(message: JSONRPCMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.outputClosed || this.output.destroyed || !this.output.writable) {
        reject(new Error('MCP stdio output is closed'));
        return;
      }
      const json = serializeMessage(message);
      const finish = (error?: Error | null) => {
        if (!this.pendingWrites.delete(finish)) return;
        if (error) reject(error);
        else resolve();
      };
      this.pendingWrites.add(finish);
      try {
        this.output.write(json, finish);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectWrites(): void {
    for (const finish of this.pendingWrites) finish(new Error('MCP stdio output closed before the write completed'));
  }

  override async close(): Promise<void> {
    this.outputClosed = true;
    this.rejectWrites();
    await super.close();
  }
}
