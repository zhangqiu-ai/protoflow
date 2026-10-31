import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: ['uikit-screen-scope.spec.js'], workers: 1,
  fullyParallel: false, timeout: 10000, reporter: 'list' });
