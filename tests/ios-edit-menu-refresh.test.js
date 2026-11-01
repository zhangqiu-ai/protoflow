import test from 'node:test';
import assert from 'node:assert/strict';
import { runStaleWindowModel } from './helpers/ios-edit-menu-stale-window.js';

test('actual Swift edit-menu refresh preserves fourteen Foundation protocol paths', { skip: process.platform !== 'darwin', timeout: 90000 }, async () => {
  const report = await runStaleWindowModel();
  assert.equal(report.kind, 'ACTUAL_SWIFT_STALE_WINDOW_QUERY_MODEL_NOT_UIKIT_OR_CAUSAL_EVIDENCE');
  assert.equal(report.results.length, 14);
  assert.deepEqual(report.results.filter(value => !value.pass), [], JSON.stringify(report));
  assert.equal(report.exitCode, 0);
  assert.equal(report.results.find(value => value.mode === 'stale-window').afterForwardSnapshots, 1);
  assert.equal(report.results.find(value => value.mode === 'snapshot-throw').deletes, 0);
  assert.equal(report.results.find(value => value.mode === 'secure').valueReads, 0);
});
