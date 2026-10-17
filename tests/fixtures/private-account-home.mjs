// Test-only CLI preload: never discover the real account's agent home from a private fixture.

import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

const userInfo = os.userInfo;
os.userInfo = () => {
  const home = process.env.WIGWAG_TEST_ACCOUNT_HOME ?? process.env.HOME;
  if (!home) throw new Error('Private account-home fixture requires HOME');
  return { ...userInfo(), homedir: home };
};
syncBuiltinESMExports();
