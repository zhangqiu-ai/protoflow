import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './e2e', testMatch: 'uikit-nested-scroll.spec.js', workers: 1, retries: 0, reporter: 'list', outputDir: './nested-scroll-output' });
