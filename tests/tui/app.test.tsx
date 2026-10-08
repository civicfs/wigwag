/** @jsxImportSource react */
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { Broker } from '../../src/broker/server.js';
import { App } from '../../src/tui/App.js';
import { mcpClient, ownerClient, startTestBroker, until } from '../helpers.js';

let broker: Broker | null = null;
afterEach(async () => {
  await broker?.stop();
  broker = null;
});

describe('TUI app against a live broker', () => {
  it('shows live sessions and switches to the deliveries tab', async () => {
    const started = await startTestBroker();
    broker = started.broker;
    const a = await mcpClient(started.home, { requested_name: 'alpha-one' });
    const owner = await ownerClient(started.home);
    await owner.call('owner.subscribe');
    const ui = render(<App client={owner} />);
    await until(() => (ui.lastFrame() ?? '').includes('alpha-one'));
    ui.stdin.write('2');
    await until(() => (ui.lastFrame() ?? '').includes('nothing held, failed or stuck'));
    expect(ui.lastFrame()).toContain('alpha-one');
    ui.unmount();
    a.client.close();
    owner.close();
  });
});
