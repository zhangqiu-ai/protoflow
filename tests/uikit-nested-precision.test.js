import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretUIKitCapture } from '../src/drivers/uikit-probe-text.js';
import { precisionFixture, textFacts, find } from './uikit-nested-precision-fixtures.js';
test('exact observed 4.069e-5pt representation difference preserves complete nested viewport', () => {
  const capture = precisionFixture(), saved = structuredClone(capture);
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, true);
  assert.deepEqual(capture, saved);
});
for (const delta of [.00011, .01, .1, 1]) test(`real ${delta}pt partial viewport clipping remains refused`, () => {
  const capture = precisionFixture({ height: 156, clipHeight: 156 - delta });
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, false);
});
for (const scale of [undefined, null, 0, -1, NaN, Infinity]) test(`unknown or invalid scale ${String(scale)} cannot authorize precision fallback`, () => {
  const capture = precisionFixture(); capture.windows[0].screenScale = scale;
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, false);
});
test('small point error crossing rounded physical boundary remains refused', () => {
  const capture = precisionFixture({ height: 155.50002, clipHeight: 155.49998, scale: 1 });
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, false);
});
test('different window provenance cannot authorize precision fallback', () => {
  const capture = precisionFixture(); capture.windows.push(structuredClone(capture.windows[0]));
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, false);
});
test('unknown provenance cannot authorize precision fallback', () => {
  const capture = precisionFixture(); delete capture.source;
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, false);
});
test('input ancestor cannot acquire precision fallback eligibility', () => {
  const capture = precisionFixture(); find(capture.windows[0].tree, 'test.inner-content').inputRedacted = true;
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, false);
});
test('near clip geometry cannot borrow a foreign sibling owner text', () => {
  const capture = precisionFixture(), root = capture.windows[0].tree;
  const text = find(root, 'test.text'), inner = find(root, 'test.inner-content');
  inner.children = []; root.children.push(text);
  assert.equal(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible, false);
});
