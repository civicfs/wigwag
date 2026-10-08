/** @jsxImportSource react */
import { render } from 'ink';
import { ownerConnect } from '../cli/util.js';
import { App } from './App.js';

export async function runTui(): Promise<void> {
  const { client } = await ownerConnect();
  await client.call('owner.subscribe');
  const app = render(<App client={client} />);
  await app.waitUntilExit();
  client.close();
}
