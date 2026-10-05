import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4318', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: 'list',
  webServer: { command: 'node examples/demo/server.js', url: 'http://127.0.0.1:4318/prototype/', reuseExistingServer: false, timeout: 15000 },
});
