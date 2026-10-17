import { vi } from 'vitest';

// Account-home discovery must stay private even when a test overrides HOME.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return {
    ...os,
    userInfo: () => ({ ...os.userInfo(), homedir: process.env.WIGWAG_TEST_ACCOUNT_HOME ?? process.env.HOME }),
  };
});
