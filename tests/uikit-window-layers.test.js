import test from 'node:test';
import assert from 'node:assert/strict';
import { windowLayerFixture, windowText, backgroundText } from './uikit-window-layer-fixtures.js';

const immutable = fixture => {
  assert.deepEqual(fixture.response, fixture.before.response);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
};

test('whole-window columns keep their own subtree order before a later overlapping anonymous popup host', () => {
  const fixture = windowLayerFixture();
  assert.equal(windowText(fixture), `${backgroundText} Dialog title Continue`);
  assert.equal(fixture.result.elements.find(item => item.anchor === 'test.container').text, 'Visible heading');
  immutable(fixture);
});

test('nonoverlapping columns remain complete blocks, including a low sidebar setting before the main header', () => {
  const fixture = windowLayerFixture({ popup: false });
  assert.equal(windowText(fixture), backgroundText);
  immutable(fixture);
});

test('a supported scroller keeps below-fold content before the popup without inventing visibility or text', () => {
  const fixture = windowLayerFixture({ offscreen: true });
  assert.equal(windowText(fixture), `${backgroundText} Dialog title Continue`);
  const body = fixture.capture.windows[0].tree.children[1].children.at(-1).children[0];
  assert.equal(body.renderEligible, false);
  assert.deepEqual(body.clipIntersection, { x: 0, y: 0, width: 0, height: 0 });
  immutable(fixture);
});

test('multiple overlapping anonymous popups retain their actual tree layer order after the background', () => {
  const fixture = windowLayerFixture({ secondPopup: true });
  assert.equal(windowText(fixture), `${backgroundText} Dialog title Continue Second dialog Confirm`);
  immutable(fixture);
});

for (const [name, extra] of [
  ['hidden', { hidden: true, ancestorOrSelfHidden: true, renderEligible: false }],
  ['zero alpha', { alpha: 0, effectiveAlpha: 0, renderEligible: false }],
  ['zero clip outside a scroller', { clipIntersection: { x: 0, y: 0, width: 0, height: 0 }, renderEligible: false }],
]) test(`${name} text does not enter whole-window layer sorting`, () => {
  const fixture = windowLayerFixture({}, ({ sidebar, uikit, rect }) => sidebar.children.push(uikit('', 'Must remain absent', [], rect(20, 220, 200, 24), extra)));
  assert.equal(windowText(fixture), `${backgroundText} Dialog title Continue`);
  immutable(fixture);
});

test('a redacted input contributes neither placeholder nor value to window text or its public text paths', () => {
  const fixture = windowLayerFixture({}, ({ sidebar, uikit, rect }) => {
    const input = uikit('test.input', '', [], rect(20, 220, 200, 24), { inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true });
    delete input.children; sidebar.children.push(input);
  });
  assert.equal(windowText(fixture), `${backgroundText} Dialog title Continue`);
  immutable(fixture);
});

test('an empty anonymous host and normal nested wrappers do not become named layers or erase background text', () => {
  const fixture = windowLayerFixture({ popup: false }, ({ tree, uikit, rect }) => {
    tree.children[1] = uikit('', '', [tree.children[1]], rect(300, 32, 910, 782));
    tree.children.push(uikit('', '', [], rect(0, 0, 1210, 834)));
  });
  assert.equal(windowText(fixture), backgroundText);
  immutable(fixture);
});

test('wrong observed dialog text is preserved, never replaced with the expected wording', () => {
  const fixture = windowLayerFixture({}, ({ popup }) => { popup.children[0].children[1].children[0].text = 'Different actual title'; });
  assert.equal(windowText(fixture), `${backgroundText} Different actual title Continue`);
  immutable(fixture);
});
