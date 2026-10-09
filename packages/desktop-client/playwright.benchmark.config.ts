import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';

/**
 * UI performance benchmarks (e2e/benchmarks/*.bench.ts). These are not part
 * of the regular e2e suite: the default config only matches *.test.ts.
 */
export default defineConfig({
  ...baseConfig,
  testDir: 'e2e/benchmarks/',
  testMatch: '**/*.bench.ts',
  // Keep Playwright's own artifacts out of test-results/benchmarks, which
  // Playwright would otherwise wipe at the start of every run.
  outputDir: 'test-results/benchmark-artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60 * 60_000,
  reporter: [['list']],
  use: {
    ...baseConfig.use,
    trace: 'off',
    screenshot: 'off',
  },
});
