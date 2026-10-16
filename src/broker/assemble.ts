import { loadConfig } from '../config.js';
import { CodexQuestions } from '../questions/codex.js';
import { installQuestionHooks } from '../questions/hook-handlers.js';
import { installQuestions } from '../questions/service.js';
import { ClaudeChannelTransport } from '../transports/claude-channel.js';
import { CodexQueueTransport } from '../transports/codex-queue.js';
import type { TransportRegistry } from '../transports/types.js';
import { VERSION } from '../version.js';
import { DeliveryEngine } from './delivery.js';
import { installData } from './handlers/data.js';
import { installMessages } from './handlers/messages.js';
import { installOwner } from './handlers/owner.js';
import { installRequests } from './handlers/requests.js';
import { installIdentity } from './identity.js';
import { installNaming } from './naming.js';
import { Broker } from './server.js';

function installSys(broker: Broker): void {
  broker.handle('sys.ping', () => ({ pong: true, pid: process.pid, version: VERSION }));
}

function installDelivery(broker: Broker, transports: TransportRegistry): DeliveryEngine {
  const engine = new DeliveryEngine({
    db: broker.db,
    config: broker.config,
    transports,
    emitFeed: (type, payload) => broker.broadcastOwner(type, payload),
    log: (l) => broker.log(l),
  });
  broker.engine = engine;
  broker.bus.on('session.available', (s) => {
    engine.onAvailable(s).catch((e) => broker.log(`onAvailable failed: ${(e as Error).message}`));
  });
  broker.digestProvider = (name) => engine.takeDigest(name);
  broker.onStart.push(() => {
    engine.resumeAll().catch((e) => broker.log(`resumeAll failed: ${(e as Error).message}`));
  });
  broker.onStop.push(() => engine.stop());
  return engine;
}

export async function startBroker(home: string, opts: { transports?: TransportRegistry } = {}): Promise<Broker> {
  const config = loadConfig(home);
  const broker = new Broker(home, config);
  const transports = opts.transports ?? {
    claude: new ClaudeChannelTransport((id) => broker.connectionFor(id)),
    codex: new CodexQueueTransport(config.codex.binary, config.codex.queue_timeout_ms),
  };
  installSys(broker);
  installIdentity(broker);
  installNaming(broker);
  installDelivery(broker, transports);
  installMessages(broker);
  installData(broker);
  installRequests(broker);
  installOwner(broker);
  const questions = installQuestions(broker);
  installQuestionHooks(broker, questions);
  const codexQuestions = new CodexQuestions(questions);
  questions.prepareCodex = (session) => codexQuestions.attach(session);
  broker.onStop.push(() => codexQuestions.stop());
  await broker.start();
  return broker;
}
