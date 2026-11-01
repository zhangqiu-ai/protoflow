import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: ['uikit-window-layers.spec.js', 'native-controls.spec.js', 'native-visual-only.spec.js'], workers: 1,
  fullyParallel: false, timeout: 10000, reporter: 'list' });
