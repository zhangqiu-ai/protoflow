import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { nativeResponse } from '../src/drivers/native-tree.js';
import { nativeKeyboardFixture, fill, locate } from './fixtures/native-keyboard.js';

const capture = (steps, changes = {}) => {
  const { raw, png, options } = nativeKeyboardFixture();
  return nativeResponse({ ...raw, ...changes }, png, { ...options, steps });
};

test('input followed by locating or waiting keeps only the measured keyboard occlusion', () => {
  for (const steps of [[fill, locate[0]], [fill, locate[1]], [fill, ...locate], [{ action: 'clear', anchor: 'editor.content' }, ...locate]]) {
    const { response, png } = capture(steps);
    assert.equal(response.status, 'PASS');
    assert.deepEqual(response.occluded, [{ x: 0, y: 10, width: 10, height: 6 }]);
    assert.deepEqual(response.viewport, { width: 10, height: 16, scale: 2 });
    assert.deepEqual([PNG.sync.read(png).width, PNG.sync.read(png).height], [20, 32]);
    assert.deepEqual(response.missing, ['editor.keyboard-key']);
    assert.equal(response.elements.find(item => item.anchor === 'editor.behind').visible, true);
  }
});

test('the long-note edit sequence may finish by bringing Save into view without ending input', () => {
  const steps = [{ action: 'tap', anchor: 'editor.note' }, { action: 'tap', anchor: 'editor.title' },
    { action: 'scroll-to', anchor: 'editor.title' }, { ...fill, anchor: 'editor.title' },
    { action: 'tap', anchor: 'editor.content' }, { action: 'scroll-to', anchor: 'editor.content' }, fill,
    { action: 'scroll-to', anchor: 'editor.save' }];
  assert.equal(capture(steps).response.status, 'PASS');
});

test('locating and waiting cannot establish editing without preceding input', () => {
  for (const steps of [[], [locate[0]], [locate[1]], locate, [{ action: 'tap', anchor: 'editor.content' }, ...locate]]) {
    assert.equal(capture(steps).response.status, 'FAIL');
  }
});

test('tap, toggle, select, back and unknown actions interrupt preceding input even before neutral suffixes', () => {
  for (const action of ['tap', 'toggle', 'select', 'back', 'unknown']) {
    assert.equal(capture([fill, { action, anchor: 'editor.save' }, ...locate]).response.status, 'FAIL');
  }
  assert.equal(capture([fill, { action: 'tap', anchor: 'editor.save' }, ...locate, fill, ...locate]).response.status, 'PASS');
});

test('input followed by locating still requires a measured keyboard frame', () => {
  assert.equal(capture([fill, ...locate], { keyboardFrame: undefined }).response.status, 'NOT_RUN');
});

test('a parked or absent keyboard creates no mask regardless of the last interaction', () => {
  for (const steps of [locate, [fill, ...locate], [fill, { action: 'tap', anchor: 'editor.save' }, ...locate]]) {
    const parked = capture(steps, { keyboardFrame: { x: 0, y: 22, width: 10, height: 8 } });
    assert.equal(parked.response.status, 'PASS'); assert.equal(parked.response.occluded, undefined);
    const absent = capture(steps, { keyboardVisible: false });
    assert.equal(absent.response.status, 'PASS'); assert.equal(absent.response.occluded, undefined);
  }
});
