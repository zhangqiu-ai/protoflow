import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_ONLY_FILES } from '../src/environment.js';

// The verification that reuses a browser capture runs in tests/e2e/verification-reuse.spec.js, where Chromium is installed.

test('TEST_ONLY_FILES names files that cannot change the build or the screens', () => {
  for (const file of ['tests/foo.test.ts', 'e2e/x.spec.ts', 'README.md', 'src/__tests__/a.js', 'a/b/spec/c.js', 'jest.config.cjs', 'playwright.config.js', 'src/a.test.mts', 'docs/x.txt', '__mocks__/fs.js', 'test/fixtures/a.json']) assert.ok(TEST_ONLY_FILES.test(file), file);
  for (const file of ['src/app.tsx', 'package.json', 'ios/Podfile', 'testsuite/a.js', 'spectacle/a.js', 'app/tasks.html', 'build.js']) assert.ok(!TEST_ONLY_FILES.test(file), file);
});
