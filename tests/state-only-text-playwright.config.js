import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'./e2e',testMatch:'state-only-text-accounting.spec.js',workers:1,retries:0,timeout:30000,use:{channel:'chromium',headless:true,trace:'retain-on-failure'},reporter:'list' });
