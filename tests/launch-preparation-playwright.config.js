import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: './e2e', testMatch: ['ios-launch-preparation.spec.js', 'ios-edit-menu-pagination.spec.js', 'uikit-probe-settling.spec.js'], workers: 1,
  fullyParallel: false, timeout: 60000, reporter: 'list' });
