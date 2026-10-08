import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { cmdTail } from '../../src/cli/commands/owner.js';
import type { MessageRow } from '../../src/store/messages.js';

const hooks = vi.hoisted(() => ({ connect: vi.fn(), output: [] as string[] }));
vi.mock('../../src/cli/util.js', async (original) => ({
  ...(await original<typeof import('../../src/cli/util.js')>()),
  ownerConnect: hooks.connect,
  out: (text: string) => hooks.output.push(text),
}));

it('prints an initial-feed/live-buffer overlap once while applying --name in both paths (T13 overlap pin)', async () => {
  const initialSignals = process.listeners('SIGINT');
  let event!: (name: string, data: unknown) => void;
  const client = new EventEmitter();
  const message = (id: string, to = 'alpha-one'): MessageRow => ({
    id,
    from_name: 'peer-one',
    from_workspace: null,
    to_target: to,
    kind: 'message',
    priority: 'low',
    subject: 's',
    body: 'b',
    attachments: [],
    reply_to: null,
    request_id: null,
    expires_at: null,
    stream: null,
    created_at: '',
  });
  const overlap = message('msg-overlap');
  const buffered = message('msg-buffered');
  const emit = (m: MessageRow) => event('feed', { type: 'message', payload: m });
  const call = async (method: string) => {
    if (method === 'owner.feed') {
      emit(overlap); // it is in both the initial reply and the already subscribed live buffer
      emit(buffered);
      emit(message('msg-hidden-before', 'other-one'));
      return { messages: [overlap] };
    }
    return {};
  };
  const close = () => client.emit('close');
  hooks.connect.mockImplementation(async (listener) => {
    event = listener;
    return { client: Object.assign(client, { call, close }) };
  });
  hooks.output.length = 0;
  const previousExitCode = process.exitCode;
  const running = cmdTail(['-f', '--name', 'alpha-one']);
  try {
    await vi.waitFor(() => expect(hooks.output.join('\n')).toContain('msg-buffered'));
    emit(message('msg-live'));
    emit(message('msg-hidden-after', 'other-one'));
    const output = hooks.output.join('\n');
    for (const id of ['msg-overlap', 'msg-buffered', 'msg-live']) expect(output.split(id)).toHaveLength(2);
    expect(output).not.toContain('msg-hidden');
  } finally {
    for (const listener of process.listeners('SIGINT'))
      if (!initialSignals.includes(listener)) {
        listener('SIGINT');
        process.removeListener('SIGINT', listener);
      }
    await running;
    process.exitCode = previousExitCode;
  }
});
