import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: ['web-clipped-text.spec.js', 'web-clipped-text-guards.spec.js', 'web-text.spec.js', 'native-controls.spec.js'],
  workers: 1, fullyParallel: false, timeout: 15000, reporter: 'list', use: { viewport: { width: 400, height: 250 }, trace: 'retain-on-failure' } });
