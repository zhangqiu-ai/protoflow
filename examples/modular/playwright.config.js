import { defineConfig } from '@playwright/test';

const baseURL = process.env.PROTOFLOW_MODULAR_URL ?? 'http://127.0.0.1:4319';
export default defineConfig({
  testDir: './tests', workers: 1, reporter: 'list',
  outputDir: './test-results',
  use: { baseURL, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.PROTOFLOW_MODULAR_URL ? undefined : {
    command: 'node server.js', url: baseURL,
    env: { PROTOFLOW_MODULAR_PORT: '4319' },
    reuseExistingServer: true, timeout: 10000,
  },
});
