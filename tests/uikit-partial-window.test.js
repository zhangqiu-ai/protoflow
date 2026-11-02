import test from 'node:test';
import assert from 'node:assert/strict';
import { partialWindowFixture, partialWindowFrames, windowText } from './uikit-window-layer-fixtures.js';

const originalInputs = fixture => {
  assert.deepEqual(fixture.capture, fixture.before.capture);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.response, fixture.before.response);
};
for (const side of Object.keys(partialWindowFrames)) test(`a rendered positive clip at the ${side} window edge retains its full original text part`, () => {
  const fixture = partialWindowFixture(side);
  assert.ok(windowText(fixture).includes('Partly visible'));
  const item = fixture.result.elements.find(row => row.anchor === 'test.screen');
  const retained = item.provenance.textNodePaths.map(at => at.slice(1).reduce((node, i) => node.children[i], fixture.capture.windows[0].tree))
    .find(node => node.identifier === 'test.partial');
  assert.ok(retained, 'the actual partial Text node retains its original evidence path');
  assert.equal(retained.text, 'Partly visible');
  assert.deepEqual(retained.frameInScreen, partialWindowFrames[side].frame);
  assert.deepEqual(retained.clipIntersection, partialWindowFrames[side].clip);
  assert.equal(retained.renderEligible, true);
  originalInputs(fixture);
});

for (const [reason, change] of [
  ['zero clip', partial => Object.assign(partial, { clipIntersection: { x: 0, y: 0, width: 0, height: 0 }, renderEligible: false })],
  ['hidden', partial => Object.assign(partial, { hidden: true, ancestorOrSelfHidden: true, renderEligible: false })],
  ['zero alpha', partial => Object.assign(partial, { alpha: 0, effectiveAlpha: 0, renderEligible: false })],
]) test(`partial geometry does not promote ${reason} text`, () => {
  const fixture = partialWindowFixture('left', change);
  assert.equal(windowText(fixture).includes('Partly visible'), false);
  originalInputs(fixture);
});

test('a partially clipped redacted input remains absent from window text and its public paths', () => {
  const fixture = partialWindowFixture('left', partial => {
    Object.assign(partial, { text: '', textSource: 'redactedInput', inputRedacted: true, accessibilityLabelRedacted: true });
    delete partial.children;
  });
  assert.equal(windowText(fixture).includes('Partly visible'), false);
  const item = fixture.result.elements.find(row => row.anchor === 'test.screen');
  assert.ok(item.provenance.textNodePaths.every(at => at.slice(1).reduce((node, i) => node.children[i], fixture.capture.windows[0].tree).identifier !== 'test.partial'));
  originalInputs(fixture);
});
