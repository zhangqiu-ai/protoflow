import { test, expect } from '@playwright/test';
import { runStaleWindowModel } from '../helpers/ios-edit-menu-stale-window.js';

test('actual Swift stale-window refresh and original input/menu guards hold in fourteen Foundation paths', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'macOS Swift Foundation protocol model; no Simulator is used');
  test.setTimeout(90000);
  const report = await runStaleWindowModel({ outputDirectory: testInfo.outputPath('swift-stale-window') });
  expect(report.kind).toBe('ACTUAL_SWIFT_STALE_WINDOW_QUERY_MODEL_NOT_UIKIT_OR_CAUSAL_EVIDENCE');
  expect(report.results).toHaveLength(14);
  expect(report.results.filter(value => !value.pass), JSON.stringify(report)).toEqual([]);
  expect(report.exitCode).toBe(0);
  expect(report.results.find(value => value.mode === 'stale-window')).toMatchObject({ forwards: 1, afterForwardSnapshots: 1, deletes: 1 });
  expect(report.results.find(value => value.mode === 'snapshot-throw')).toMatchObject({ reason: 'public edit menu refresh snapshot is unavailable', deletes: 0 });
  expect(report.results.find(value => value.mode === 'secure')).toMatchObject({ valueReads: 0, deletes: 0 });
});
