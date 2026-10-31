import test from 'node:test';
import assert from 'node:assert/strict';
import { screenScopeFixture } from './uikit-screen-scope-fixtures.js';

const screen = fixture => fixture.result.elements.find(item => item.anchor === 'test.screen');
const nonText = ({ text, provenance, ...facts }) => facts;
const assertImmutable = fixture => {
  assert.deepEqual(fixture.response, fixture.before.response);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
  for (const original of fixture.response.elements) assert.deepEqual(nonText(fixture.result.elements.find(item => item.anchor === original.anchor)), nonText(original));
};

test('a nested screen anchor reports the whole owned window text even with no missing anchors', () => {
  const fixture = screenScopeFixture(), item = screen(fixture);
  assert.equal(item.text, 'Profile Search Settings Visible heading');
  assert.deepEqual(item.bounds, { x: 0, y: 0, width: 1210, height: 782 });
  assert.equal(item.provenance.textCorrection, 'publicOwnedWindowScreenText');
  assert.equal(item.provenance.textScope, 'ownedWindow');
  assert.deepEqual(item.provenance.fields, ['text']);
  assert.deepEqual(item.provenance.scopeNativeNodePath, [0]);
  assert.equal(item.provenance.originalAX.text, fixture.response.elements[0].text);
  assert.equal(fixture.result.elements.find(value => value.anchor === 'test.action').text, '');
  assert.equal(fixture.result.elements.find(value => value.anchor === 'test.container').text, 'Visible heading');
  assertImmutable(fixture);
});

test('whole-window text excludes hidden, transparent, clipped, parked and redacted input content', () => {
  const fixture = screenScopeFixture(({ sidebar, uikit, rect }) => {
    const hidden = uikit('', 'Hidden', [], rect(20, 200, 200, 20), { hidden: true, ancestorOrSelfHidden: true, renderEligible: false });
    const transparent = uikit('', 'Transparent', [], rect(20, 230, 200, 20), { alpha: 0, effectiveAlpha: 0, renderEligible: false });
    const clipped = uikit('', 'Clipped', [], rect(20, 260, 200, 20), { clipIntersection: rect(0, 0, 0, 0), renderEligible: false });
    const parked = uikit('', 'Parked', [], rect(-320, 290, 200, 20), { clipIntersection: rect(0, 0, 0, 0), renderEligible: false });
    const input = uikit('', '', [], rect(20, 320, 200, 20), { inputRedacted: true, textSource: 'redactedInput' });
    delete input.children;
    sidebar.children.push(hidden, transparent, clipped, parked, input);
  });
  assert.equal(screen(fixture).text, 'Profile Search Settings Visible heading');
  assertImmutable(fixture);
});

test('the owned window reads a real later overlay after both dock and main, never as main-only text', () => {
  const fixture = screenScopeFixture(({ tree, uikit, rect }) => {
    tree.children.push(uikit('test.dialog', '', [uikit('', 'Dialog title', [], rect(400, 300, 300, 24)), uikit('', 'Continue', [], rect(400, 500, 300, 44))], rect(350, 250, 500, 400)));
  });
  assert.equal(screen(fixture).text, 'Profile Search Settings Visible heading Dialog title Continue');
  assertImmutable(fixture);
});

test('physical handle and count values remain intact instead of being replaced by prototype expectations', () => {
  const fixture = screenScopeFixture(({ sidebar, uikit, rect }) => {
    sidebar.children.push(uikit('', '@member', [], rect(20, 75, 200, 20)), uikit('', 'All chats 6', [], rect(20, 145, 200, 20)));
  });
  assert.equal(screen(fixture).text, 'Profile @member Search All chats 6 Settings Visible heading');
  assertImmutable(fixture);
});

test('prior screen provenance remains available under the exact owned-window scope provenance', () => {
  const previous = { source: 'previousAX', fields: ['text'], note: 'original fact' };
  const fixture = screenScopeFixture(value => { value.axControl.label = ''; value.changeResponse = response => { response.elements[0].provenance = previous; }; });
  assert.deepEqual(screen(fixture).provenance.previousProvenance, previous);
  assertImmutable(fixture);
});

test('an additional AX window cannot contribute text to the verified owned UIKit window', () => {
  const fixture = screenScopeFixture(({ rawAX, ax, rect }) => rawAX.children.push(ax('', 'window', '', [ax('', 'staticText', 'Foreign window', [], rect(700, 450, 100, 20))], rect(0, 0, 1210, 834))));
  assert.equal(screen(fixture).text, 'Profile Search Settings Visible heading');
  assertImmutable(fixture);
});

for (const blockedGroup of [false, true]) test(`${blockedGroup ? 'an existing blocked group' : 'a failed frame gate'} cannot be bypassed by an unrelated missing anchor`, () => {
  const fixture = screenScopeFixture(({ container, screenAX, sidebar, uikit, rect, anchors }) => {
    if (blockedGroup) container.identifier = '';
    else screenAX.frame.x += 1;
    sidebar.children.push(uikit('test.extra', 'Extra observed text', [], rect(20, 200, 200, 20)));
    anchors.push('test.extra');
  });
  assert.notEqual(screen(fixture).provenance?.textCorrection, 'publicOwnedWindowScreenText');
  assert.equal(screen(fixture).text.includes('Profile'), false);
  assert.equal(fixture.result.elements.find(item => item.anchor === 'test.extra').text, 'Extra observed text');
  assertImmutable(fixture);
});

test('unconfirmed empty whole-window text cannot erase the original AX content', () => {
  const fixture = screenScopeFixture(({ sidebar, container }) => { sidebar.children = []; container.children = []; });
  assert.notEqual(screen(fixture).provenance?.textCorrection, 'publicOwnedWindowScreenText');
  assertImmutable(fixture);
});

export const rejectedScreenScopes = [
  ['duplicate AX screen', ({ rawAX, screenAX }) => rawAX.children[0].children.push(structuredClone(screenAX))],
  ['duplicate UIKit screen', ({ tree, screenUIKit }) => tree.children.push(structuredClone(screenUIKit))],
  ['duplicate response screen', fixture => { fixture.changeResponse = response => response.elements.push(structuredClone(response.elements[0])); }],
  ['AX/UIKit frame mismatch', ({ screenAX }) => { screenAX.frame.x += 1; }],
  ['different response text', fixture => { fixture.changeResponse = response => { response.elements[0].text = 'A different sample'; }; }],
  ['response count mismatch', fixture => { fixture.changeResponse = response => { response.elements[0].count = 2; }; }],
  ['response role mismatch', fixture => { fixture.changeResponse = response => { response.elements[0].role = 'button'; }; }],
  ['response input type', fixture => { fixture.changeResponse = response => { response.elements[0].inputType = 'password'; }; }],
  ['response editable', fixture => { fixture.changeResponse = response => { response.elements[0].editable = true; }; }],
  ['response bounds mismatch', fixture => { fixture.changeResponse = response => { response.elements[0].bounds.width -= 1; }; }],
  ['AX input screen', ({ screenAX }) => { screenAX.type = 'textField'; }],
  ['UIKit input semantics', ({ screenUIKit }) => { screenUIKit.observedSemantics.inputKind = 'textView'; screenUIKit.observedSemantics.sources.inputKind = 'UIKit.publicType'; }],
  ['UIKit action semantics', ({ screenUIKit }) => { screenUIKit.observedSemantics.buttonTrait = true; }],
  ['hidden UIKit anchor', ({ screenUIKit }) => { Object.assign(screenUIKit, { hidden: true, ancestorOrSelfHidden: true, renderEligible: false }); }],
  ['hidden AX anchor', ({ screenAX }) => { screenAX.visible = false; }],
  ['unknown UIKit semantics', ({ screenUIKit }) => { delete screenUIKit.observedSemantics; }],
  ['content exceeds owned window', fixture => { fixture.windowFrame = fixture.rect(0, 0, 1000, 834); }],
  ['non-subregion full screen', ({ screenAX, screenUIKit, rect }) => { const frame = rect(0, 32, 1210, 782); screenAX.frame = frame; screenUIKit.frameInScreen = frame; screenUIKit.frameInWindow = frame; screenUIKit.clipIntersection = frame; }],
  ['screen outside content', ({ screenAX, screenUIKit }) => { screenAX.frame.x = -1; screenUIKit.frameInScreen.x = -1; screenUIKit.frameInWindow.x = -1; }],
  ['blocked existing correction group', ({ container }) => { container.identifier = ''; }],
];

for (const [name, change] of rejectedScreenScopes) test(`${name} cannot activate screen scope correction`, () => {
  const fixture = screenScopeFixture(change);
  assert.notEqual(screen(fixture).provenance?.textCorrection, 'publicOwnedWindowScreenText');
  assertImmutable(fixture);
});

for (const [name, change] of rejectedScreenScopes.filter(([name]) => name !== 'blocked existing correction group')) test(`${name} fails closed independently of a control text rewrite`, () => {
  const fixture = screenScopeFixture(value => { value.axControl.label = ''; change(value); });
  assert.notEqual(screen(fixture).provenance?.textCorrection, 'publicOwnedWindowScreenText');
  assertImmutable(fixture);
});
