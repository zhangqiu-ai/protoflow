import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  projects: [
    { name: 'chromium', testIgnore: ['**/electron.spec.js', '**/ios.spec.js', '**/android.spec.js'] },
    { name: 'electron', testMatch: '**/electron.spec.js' },
    // Opt-in real simulator acceptance; skipped unless PROTOFLOW_IOS_DEVICE is set (see tests/e2e/ios.spec.js).
    { name: 'ios', testMatch: '**/ios.spec.js' },
    // Opt-in real emulator acceptance; skipped unless PROTOFLOW_ANDROID_AVD is set (see tests/e2e/android.spec.js).
    { name: 'android', testMatch: '**/android.spec.js' },
  ],
  use: { baseURL: 'http://127.0.0.1:4318', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: 'list',
  webServer: { command: 'node examples/demo/server.js', url: 'http://127.0.0.1:4318/prototype/', reuseExistingServer: false, timeout: 15000 },
});
