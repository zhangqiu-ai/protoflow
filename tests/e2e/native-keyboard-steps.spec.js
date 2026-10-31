import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { nativeResponse } from '../../src/drivers/native-tree.js';
import { nativeKeyboardFixture, fill, locate } from '../fixtures/native-keyboard.js';

function capture(steps, overrides = {}) {
  const fixture = nativeKeyboardFixture();
  return nativeResponse({ ...fixture.raw, ...overrides }, fixture.png, { ...fixture.options, steps });
}

test('native PNG response retains editing through locating and waiting while preserving measured occlusion', () => {
  for (const steps of [[fill, ...locate], [{ action: 'clear', anchor: 'editor.content' }, ...locate]]) {
    const result = capture(steps);
    expect(result.response.status).toBe('PASS');
    expect(result.response.occluded).toEqual([{ x: 0, y: 10, width: 10, height: 6 }]);
    expect(result.response.missing).toEqual(['editor.keyboard-key']);
    expect(result.response.elements.find(item => item.anchor === 'editor.save').visible).toBe(true);
    expect(result.response.elements.find(item => item.anchor === 'editor.behind').visible).toBe(true);
    const png = PNG.sync.read(result.png); expect([png.width, png.height]).toEqual([20, 32]);
  }
});

test('neutral actions alone and interactions after input cannot retain editing intent', () => {
  for (const steps of [locate, ...['tap', 'toggle', 'select', 'back', 'unknown'].map(action => [fill, { action, anchor: 'editor.save' }, ...locate])]) {
    const result = capture(steps); expect(result.response.status).toBe('FAIL'); expect(result.png).toBeUndefined();
  }
});

test('a missing keyboard frame remains NOT_RUN after locating and waiting', () => {
  const result = capture([fill, ...locate], { keyboardFrame: undefined });
  expect(result.response.status).toBe('NOT_RUN'); expect(result.png).toBeUndefined();
});

test('offscreen and absent keyboards never create an occlusion mask', () => {
  for (const overrides of [{ keyboardFrame: { x: 0, y: 22, width: 10, height: 8 } }, { keyboardVisible: false }]) {
    const result = capture([fill, { action: 'tap', anchor: 'editor.save' }, ...locate], overrides);
    expect(result.response.status).toBe('PASS'); expect(result.response.occluded).toBeUndefined();
    expect(PNG.sync.read(result.png).height).toBe(32);
  }
});
