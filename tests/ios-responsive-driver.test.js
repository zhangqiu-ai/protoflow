import test from 'node:test';
import assert from 'node:assert/strict';
import { driverOptions, responsiveOptionsError, measuredAppContent } from '../scripts/ios-driver.js';

const capture = () => ({ windows: [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, windowFrame: { x: 100, y: 50, width: 800, height: 600 },
  screenBounds: { x: 0, y: 0, width: 1200, height: 900 }, safeAreaInsets: { top: 24, left: 0, bottom: 20, right: 0 },
  tree: { transformed: false, frameInScreen: { x: 100, y: 50, width: 800, height: 600 } } }] });

test('responsive opt-ins leave default driver options unchanged', () => {
  assert.deepEqual({ ...driverOptions([]) }, { frame: 'safe-area' });
  assert.equal(responsiveOptionsError(driverOptions([]), {}), null);
  assert.equal(responsiveOptionsError(driverOptions(['--orientation', 'landscape-left', '--frame', 'device']), {}), null);
});

test('rotation rejects a stale host safe-area and app-window needs an authenticated probe context', () => {
  assert.match(responsiveOptionsError(driverOptions(['--rotate-after-steps', 'landscape-left']), {}), /needs --frame/);
  assert.match(responsiveOptionsError(driverOptions(['--frame', 'app-window']), {}), /needs --uikit-probe-context/);
  assert.match(responsiveOptionsError(driverOptions(['--orientation', 'diagonal']), {}), /invalid --orientation/);
  assert.match(responsiveOptionsError(driverOptions(['--appearance', 'auto']), {}), /invalid --appearance/);
  assert.match(responsiveOptionsError(driverOptions(['--hittable-anchors', 'note.save,note.save']), {}), /invalid --hittable-anchors/);
  assert.match(responsiveOptionsError(driverOptions(['--hittable-anchors', '']), {}), /invalid --hittable-anchors/);
  assert.equal(responsiveOptionsError(driverOptions(['--hittable-anchors', 'note.save']), {}), null);
});

test('input retention is limited to named nonempty fill steps on an explicit disposable QA fixture', () => {
  const options = driverOptions(['--frame', 'device', '--rotate-after-steps', 'portrait', '--preserve-known-synthetic-inputs', 'thread.input']);
  const request = { fixture: { data: { session: 'qa' } }, steps: [{ action: 'fill', anchor: 'thread.input', value: 'synthetic long input' }] };
  assert.equal(responsiveOptionsError(options, request), null);
  assert.match(responsiveOptionsError(options, { ...request, fixture: {} }), /needs qa fixture/);
  assert.match(responsiveOptionsError(options, { ...request, steps: [] }), /needs qa fixture/);
  assert.match(responsiveOptionsError({ ...options, 'preserve-known-synthetic-inputs': 'thread.input,thread.input' }, request), /unique filled anchors/);
});

test('app-window cropping uses actual translated window bounds and measured safe-area insets', () => {
  assert.deepEqual(measuredAppContent(capture()), { x: 100, y: 74, width: 800, height: 556 });
});

test('app-window cropping rejects missing, nonnumeric, transformed, clipped and impossible geometry', () => {
  const corruptions = [
    c => { delete c.windows[0].safeAreaInsets; },
    c => { c.windows[0].safeAreaInsets.top = '24'; },
    c => { c.windows[0].safeAreaInsets.bottom = -1; },
    c => { c.windows[0].safeAreaInsets.top = 600; },
    c => { c.windows[0].tree.transformed = true; },
    c => { c.windows[0].tree.frameInScreen.width = 799; },
    c => { c.windows[0].windowFrame.width = 900; },
    c => { c.windows[0].screenBounds.width = 850; },
    c => { c.windows[0].bounds.x = 1; },
    c => { c.windows.push(c.windows[0]); },
    c => { c.windows[0].safeAreaInsets.top = NaN; },
  ];
  for (const corrupt of corruptions) {
    const data = capture(); corrupt(data);
    assert.throws(() => measuredAppContent(data), /invalid or transformed measured geometry/);
  }
});
