import { defineConfig } from '@playwright/test';

// Isolated interpreter/DOM/Foundation regressions only: no Simulator, device, provider or Electron launch.
export default defineConfig({ testDir: './e2e', testMatch: [
  'uikit-text-ownership.spec.js', 'uikit-atomic-descendant.spec.js', 'uikit-control-text.spec.js', 'uikit-image-text.spec.js',
  'uikit-other-text.spec.js', 'uikit-screen-scope.spec.js', 'uikit-screen-inset.spec.js',
  'uikit-window-layers.spec.js', 'native-controls.spec.js', 'native-visual-only.spec.js',
  'uikit-nested-scroll.spec.js', 'scroll-alignment.spec.js', 'scroll-alignment-swift.spec.js',
  'ios-launch-preparation.spec.js', 'ios-edit-menu-pagination.spec.js',
  'uikit-probe-settling.spec.js', 'native-keyboard-steps.spec.js',
  'uikit-typed-progress.spec.js', 'uikit-nested-precision.spec.js', 'uikit-full-root.spec.js',
  'state-only-text-accounting.spec.js', 'scroll-start.spec.js', 'scroll-start-swift.spec.js',
], workers: 1, fullyParallel: false, retries: 0, timeout: 60000, reporter: 'list',
use: { channel: 'chromium', headless: true, trace: 'retain-on-failure' } });
