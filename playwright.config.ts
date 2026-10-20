import { defineConfig } from '@playwright/test';

/**
 * Real-browser end-to-end tests. They exercise the *built* application
 * served by the compiled backend against the deterministic mock upstream.
 * Run `npm run build` first, then `npm run test:e2e`.
 */
const APP_PORT = 18201;
const MOCK_PORT = 18200;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `node tools/mock-upstream.mjs --port ${MOCK_PORT} --api-key e2e-test-key`,
      // The mock answers 401 without its API key, so readiness is the open port.
      port: MOCK_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node dist/server/index.js',
      url: `http://127.0.0.1:${APP_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        KAGGLE_KIT_HOST: '127.0.0.1',
        KAGGLE_KIT_PORT: String(APP_PORT),
        KAGGLE_KIT_DATA_DIR: './.data/e2e',
        KAGGLE_KIT_LOG_LEVEL: 'warn',
      },
    },
  ],
});
