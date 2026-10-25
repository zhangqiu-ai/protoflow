import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationFor, notifyDesktop } from '../src/notify.js';

test('a blocked version, a blocked issue fix and an issue for a maintainer reach the desktop; other events do not', () => {
  const blocked = notificationFor({ event: 'blocked', target: 'mobile', reasonCode: 'environment', reason: 'Claude execution cannot run in this environment: OAuth token has expired\nmore' }, 'siyue');
  assert.deepEqual(blocked, { title: 'ProtoFlow · siyue · mobile', subtitle: '版本阻塞：環境問題（登入、網路或建置環境），修好後重試', message: 'Claude execution cannot run in this environment: OAuth token has expired' });
  assert.equal(notificationFor({ event: 'blocked', reasonCode: 'stalled', reason: 'x' }, 'app').subtitle, '版本阻塞：修復沒有進展');
  assert.equal(notificationFor({ event: 'blocked', reasonCode: 'base-moved', reason: 'x' }, 'app').subtitle, '版本阻塞：基底分支已移動');
  assert.equal(notificationFor({ event: 'blocked', reasonCode: 'operator-action', reason: 'x' }, 'app').subtitle, '版本阻塞：需要操作員修改執行代理不能改的檔案');
  assert.equal(notificationFor({ event: 'blocked', reasonCode: null, reason: 'x' }, 'app').subtitle, '版本阻塞：需要處理');
  assert.equal(notificationFor({ event: 'issue-blocked', reason: 'tests fail' }, 'app').subtitle, 'Issue 修復阻塞');
  assert.equal(notificationFor({ event: 'issue-triaged', number: 7, status: 'needs-human' }, 'app').subtitle, 'Issue #7 需要人決定');
  assert.deepEqual(notificationFor({ event: 'waiver-requested', target: 'mobile', scene: 'nav.sidebar.initial', variant: 'ipad', tier: 'structure', findings: 2, waiverId: 'WVR-1' }, 'siyue'),
    { title: 'ProtoFlow · siyue · mobile', subtitle: '豁免待核准', message: 'nav.sidebar.initial / ipad · structure：2 項發現，執行代理標示為引擎限制' });
  for (const event of [{ event: 'issue-triaged', number: 7, status: 'planned' }, { event: 'verified', status: 'FAIL' }, { event: 'scanned' }, { event: 'waiver-applied' }, { event: 'waiver-request-failed' }]) assert.equal(notificationFor(event, 'app'), null);
});

test('macOS notifications pass their texts as osascript arguments and can be turned off', async () => {
  const calls = [];
  const run = async (root, command) => { calls.push({ root, command }); return { status: 'PASS' }; };
  const event = { event: 'blocked', reasonCode: 'stalled', reason: '" & do shell script "touch /tmp/x" & "' };
  const note = await notifyDesktop('/work/siyue', {}, event, { run, platform: 'darwin', env: {} });
  assert.equal(note.title, 'ProtoFlow · siyue');
  assert.equal(calls.length, 1);
  const { argv } = calls[0].command;
  assert.equal(argv[0], 'osascript'); assert.ok(argv.slice(1, 7).every(part => !part.includes('touch')), 'the reason never enters the script source');
  assert.deepEqual(argv.slice(-3), [note.title, note.subtitle, event.reason]);
  assert.equal(await notifyDesktop('/work/siyue', { dashboard: { name: 'Siyue' } }, event, { run, platform: 'darwin', env: {} }).then(item => item.title), 'ProtoFlow · Siyue');
  calls.length = 0;
  assert.equal(await notifyDesktop('/work/siyue', { notifications: { desktop: false } }, event, { run, platform: 'darwin', env: {} }), null);
  assert.equal(await notifyDesktop('/work/siyue', {}, event, { run, platform: 'linux', env: {} }), null);
  assert.equal(await notifyDesktop('/work/siyue', {}, event, { run, platform: 'darwin', env: { NODE_TEST_CONTEXT: 'child' } }), null, 'tests never post to the desktop');
  assert.equal(await notifyDesktop('/work/siyue', {}, { event: 'scanned' }, { run, platform: 'darwin', env: {} }), null);
  assert.equal(calls.length, 0);
  // A failing osascript never fails the runner.
  assert.ok(await notifyDesktop('/work/siyue', {}, event, { run: async () => { throw new Error('no osascript'); }, platform: 'darwin', env: {} }));
});
