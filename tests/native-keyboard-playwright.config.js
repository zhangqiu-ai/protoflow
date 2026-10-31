import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: './e2e', testMatch: 'native-keyboard-steps.spec.js', workers: 1,
  fullyParallel: false, timeout: 30000, reporter: 'list' });
