import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', workers: 1, reporter: 'list',
  outputDir: './test-results',
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
