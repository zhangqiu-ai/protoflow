import test from 'node:test';
import assert from 'node:assert/strict';
import { insetFixture, screen, stripTextEvidence } from './uikit-screen-inset-fixtures.js';

const originalText = 'Profile Search Settings Visible heading';
const bottom = { x: 300, y: 32, width: 910, height: 802 };
const immutable = f => {
  assert.deepEqual(f.response, f.before.response);
  assert.deepEqual(f.rawAX, f.before.rawAX);
  assert.deepEqual(f.capture, f.before.capture);
  for (const item of f.response.elements) assert.deepEqual(stripTextEvidence(f.result.elements.find(x => x.anchor === item.anchor)), stripTextEvidence(item));
};
for (const [name, frame] of [
  ['whole content', { x: 0, y: 32, width: 1210, height: 782 }],
  ['whole owned window', { x: 0, y: 0, width: 1210, height: 834 }],
  ['bottom owned-window safe-area extension', bottom],
  ['top owned-window safe-area extension', { x: 300, y: 0, width: 910, height: 814 }],
  ['both owned-window safe-area extensions', { x: 300, y: 0, width: 910, height: 834 }],
]) test(`${name} still reads the full owned window`, () => {
  const f = insetFixture(frame);
  assert.equal(screen(f).text, originalText);
  assert.equal(screen(f).provenance.textCorrection, 'publicOwnedWindowScreenText');
  assert.deepEqual(screen(f).provenance.fields, ['text']);
  immutable(f);
});
for (const [name, frame, change] of [
  ['zero intersection', { x: 300, y: 815, width: 910, height: 19 }, () => {}],
  ['extends outside owned window', { x: 300, y: 32, width: 910, height: 803 }, () => {}],
  ['AX/UIKit mismatch', bottom, f => { f.screenAX.frame = { ...f.screenAX.frame, width: 909 }; }],
  ['duplicate current screen', bottom, f => { f.tree.children.push(structuredClone(f.screenUIKit)); }],
  ['blocked correction group', bottom, f => { f.container.identifier = ''; }],
  ['input semantics', bottom, f => { f.screenUIKit.observedSemantics.inputKind = 'textView'; f.screenUIKit.observedSemantics.sources.inputKind = 'UIKit.publicType'; }],
  ['hidden screen', bottom, f => { Object.assign(f.screenUIKit, { hidden: true, ancestorOrSelfHidden: true, renderEligible: false }); }],
]) test(`${name} cannot activate screen scope correction`, () => {
  const f = insetFixture(frame, change);
  assert.notEqual(screen(f).provenance?.textCorrection, 'publicOwnedWindowScreenText');
  immutable(f);
});
test('a foreign AX window cannot supply text when the owned screen extends into an inset', () => {
  const f = insetFixture(bottom, ({ rawAX, ax, rect }) => rawAX.children.push(ax('', 'window', '', [ax('', 'staticText', 'Foreign window text', [], rect(400, 400, 100, 20))], rect(0, 0, 1210, 834))));
  assert.equal(screen(f).text, originalText);
  assert.equal(screen(f).text.includes('Foreign'), false);
  immutable(f);
});
