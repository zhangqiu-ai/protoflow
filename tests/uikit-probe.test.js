import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProbePair, supplementUIKitFacts } from '../src/drivers/uikit-probe.js';

const clone = value => structuredClone(value);
const rect = (x = 0, y = 0, width = 400, height = 800) => ({ x, y, width, height });
const session = { nonce: '11111111-1111-4111-8111-111111111111', contextId: 'CTX-native-proof', sceneId: 'test.screen.modal', screenAnchor: 'test.screen' };
const expectedBuild = { bundleIdentifier: 'dev.siyue.capture', shortVersion: '0.0.1', buildVersion: '1', reactNativeVersion: '0.86.3', executableSha256: 'a'.repeat(64), javascriptSha256: 'b'.repeat(64) };
function node(identifier, text = '', children = [], extra = {}) {
  const frame = extra.frameInWindow ?? rect();
  const result = {
    identifier, class: text ? 'RCTParagraphComponentView' : 'RCTViewComponentView', frameInWindow: frame,
    frameInScreen: frame, bounds: rect(0, 0, frame.width, frame.height), order: 0, hidden: false,
    ancestorOrSelfHidden: false, alpha: 1, effectiveAlpha: 1, clipsToBounds: false,
    clipIntersection: frame, clipMethod: 'axisAlignedBoundsIntersection', transformed: false,
    attachedToWindow: true, renderEligible: true, occlusion: 'notComputed', text,
    textSource: text ? 'RCTParagraphComponentView.attributedText' : 'none',
    children: children.map((child, order) => ({ ...child, order })), ...extra
  };
  if (result.inputRedacted) delete result.children;
  return result;
}
const countNodes = item => 1 + (item.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
function capture(tree) {
  return {
    source: 'currentUIKitViewTree', occlusion: 'notComputed', nodeCount: countNodes(tree),
    windows: [{ sceneSession: 'synthetic-window-session', bounds: rect(), screenAnchor: session.screenAnchor,
      windowFrame: rect(), screenBounds: rect(), screenScale: 3, interfaceOrientation: 1,
      safeAreaInsets: { top: 20, left: 0, bottom: 20, right: 0 }, tree }]
  };
}
function currentTree() {
  return node('', '', [
    node('test.screen', '', [
      node('test.background', '', [node('test.title', 'Actual background title', [], { frameInWindow: rect(20, 40, 300, 24) })], { frameInWindow: rect(0, 20, 400, 760) })
    ]),
    node('test.modal', '', [
      node('test.modal.title', 'Actual modal title', [], { frameInWindow: rect(20, 520, 300, 24) }),
      node('test.modal.save', 'Save actual draft', [], { class: 'UIButton', textSource: 'UIButton.currentTitle', frameInWindow: rect(20, 580, 360, 44) }),
      node('test.modal.input', '', [], { class: 'UITextField', inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true, frameInWindow: rect(20, 550, 360, 30) })
    ], { frameInWindow: rect(0, 500, 400, 300), accessibilityViewIsModal: true })
  ], { class: 'UIWindow' });
}
function pair(tree = currentTree()) {
  const at = Date.now() / 1000 - 1;
  const sample = (sampleId, startedAt, finishedAt) => ({
    schemaVersion: 1, status: 'OK', nonce: session.nonce, sampleId, correlation: clone(session),
    actualBuild: clone(expectedBuild), startedAt, finishedAt, mainThread: true, capture: capture(clone(tree))
  });
  return {
    before: sample('22222222-2222-4222-8222-222222222222', at, at + 0.05),
    after: sample('33333333-3333-4333-8333-333333333333', at + 0.3, at + 0.35),
    timing: { axStartedAt: at + 0.1, axFinishedAt: at + 0.2, screenshotStartedAt: at + 0.21, screenshotFinishedAt: at + 0.22 },
    expectedBuild: clone(expectedBuild), session: clone(session)
  };
}
const options = anchors => ({ anchors, screen: session.screenAnchor, content: rect(0, 20, 400, 760) });
const response = elements => ({ schemaVersion: 1, status: 'PASS', screenshot: 'screen.png', viewport: { width: 400, height: 760, scale: 3 }, elements, missing: [] });
const axTree = { type: 'application', frame: rect(), children: [{ type: 'other', identifier: 'test.modal', frame: rect(0, 500, 400, 300), children: [{ type: 'staticText', identifier: 'test.modal.title', label: 'Actual modal title', frame: rect(20, 520, 300, 24) }] }] };
const byId = result => Object.fromEntries(result.elements.map(item => [item.anchor, item]));
const verifiedCapture = tree => validateProbePair(pair(tree)).capture;

// These are synthetic transport/interpretation cases, not RN runtime or pixel acceptance.
test('two fresh identical current UIKit samples bind actual build, session and AX/screenshot bracket', () => {
  const input = pair();
  const before = clone(input);
  const result = validateProbePair(input);
  assert.deepEqual(result.capture, input.before.capture);
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(input, before, 'validation must not rewrite raw observations');
});

test('probe validation fails closed on nonce, context, scene, screen, sample replay and actual build mismatches', () => {
  const changes = [
    p => { p.after.nonce = '44444444-4444-4444-8444-444444444444'; },
    p => { p.after.correlation.contextId = 'CTX-another'; },
    p => { p.after.correlation.sceneId = 'test.screen.initial'; },
    p => { p.after.correlation.screenAnchor = 'different.screen'; },
    p => { p.after.sampleId = p.before.sampleId; },
    p => { p.after.actualBuild.bundleIdentifier = 'dev.other.capture'; },
    p => { p.after.actualBuild.executableSha256 = 'c'.repeat(64); },
    p => { p.after.actualBuild.javascriptSha256 = 'd'.repeat(64); },
    p => { p.after.actualBuild.reactNativeVersion = '0.86.4'; },
    p => { p.after.mainThread = false; },
    p => { p.after.status = 'ERROR'; p.after.reason = 'SCREEN_NOT_ATTACHED'; }
  ];
  for (const change of changes) { const input = pair(); change(input); assert.throws(() => validateProbePair(input)); }
});

test('probe validation rejects reversed, overlapping, nonfinite and expired capture brackets', () => {
  const changes = [
    p => { p.before.finishedAt = p.timing.axStartedAt + 0.01; },
    p => { p.timing.axFinishedAt = p.timing.screenshotStartedAt + 0.01; },
    p => { p.after.startedAt = p.timing.screenshotFinishedAt - 0.01; },
    p => { p.before.startedAt = p.before.finishedAt + 1; },
    p => { p.after.finishedAt = p.after.startedAt - 1; },
    p => { p.after.finishedAt = p.before.startedAt + 10.01; },
    p => { p.timing.screenshotStartedAt = Number.NaN; }
  ];
  for (const change of changes) { const input = pair(); change(input); assert.throws(() => validateProbePair(input)); }
});

test('probe validation rejects changed current text, geometry, visibility or mounted nodes between samples', () => {
  const changes = [
    p => { p.after.capture.windows[0].tree.children[0].children[0].children[0].text = 'A later title'; },
    p => { p.after.capture.windows[0].tree.children[0].frameInWindow.y += 1; },
    p => { p.after.capture.windows[0].tree.children[0].hidden = true; },
    p => { p.after.capture.windows[0].tree.children[0].children = []; p.after.capture.nodeCount = countNodes(p.after.capture.windows[0].tree); }
  ];
  for (const change of changes) { const input = pair(); change(input); assert.throws(() => validateProbePair(input)); }
});

test('probe validation rejects unbounded strings, trees, geometry and response bytes', () => {
  const changes = [
    p => { p.before.capture.windows[0].tree.text = 'x'.repeat(4097); },
    p => { p.before.capture = capture(node(session.screenAnchor, '', Array.from({ length: 2048 }, () => node('')))); },
    p => { p.before.capture.windows[0].tree.frameInWindow.x = Infinity; },
    p => { p.before.untrustedPadding = 'x'.repeat(2 * 1024 * 1024); },
    p => {
      let root = node(session.screenAnchor);
      for (let index = 0; index < 66; index++) root = node('', '', [root]);
      p.before.capture = capture(root);
    }
  ];
  for (const change of changes) { const input = pair(); change(input); assert.throws(() => validateProbePair(input)); }
});

test('UIKit supplementation adds only observed missing identifiers and keeps raw AX evidence unchanged', () => {
  const input = response([{ anchor: 'test.modal.save', count: 1, text: 'Save actual draft', bounds: rect(23, 559, 350, 45), visible: true, enabled: false, interactive: true, editable: false, role: 'button' }]);
  input.missing = ['test.title', 'unobserved.anchor'];
  const savedResponse = clone(input), savedAX = clone(axTree);
  const result = supplementUIKitFacts(input, axTree, verifiedCapture(currentTree()), options(['test.modal.save', 'test.title', 'unobserved.anchor']));
  const elements = byId(result);
  assert.deepEqual(elements['test.modal.save'], input.elements[0]);
  assert.equal(elements['test.title'].text, 'Actual background title');
  assert.deepEqual(elements['test.title'].bounds, rect(20, 20, 300, 24));
  assert.equal(elements['test.title'].count, 1);
  assert.equal(elements['test.title'].provenance.source, 'currentUIKitViewTree');
  assert.equal(elements['test.title'].provenance.occlusion, 'notComputed');
  assert.deepEqual(elements['test.title'].provenance.nativeNodePath, [0, 0, 0, 0], 'path identifies the real node under windows[0].tree');
  assert.ok(elements['test.title'].provenance.fields.includes('text'));
  assert.ok(result.missing.includes('unobserved.anchor'));
  assert.equal(elements['unobserved.anchor'], undefined);
  assert.deepEqual(input, savedResponse);
  assert.deepEqual(axTree, savedAX, 'UIKit facts never become invented AX nodes');
});

test('UIKit text uses public rendered text sources and never an accessibility label, value or input subtree', () => {
  const tree = currentTree();
  tree.children[0].children[0].children.push(
    node('test.a11y-only', '', [], { accessibilityLabel: 'Accessible chart description only' }),
    node('test.hidden', 'Hidden text must stay out', [], { hidden: true, ancestorOrSelfHidden: true, renderEligible: false }),
    node('test.alpha-zero', 'Transparent text must stay out', [], { alpha: 0, effectiveAlpha: 0, renderEligible: false }),
    node('test.clipped', 'Clipped text must stay out', [], { clipIntersection: rect(0, 0, 0, 0), renderEligible: false })
  );
  const result = supplementUIKitFacts(response([]), axTree, verifiedCapture(tree), options(['test.screen', 'test.a11y-only', 'test.modal.input', 'test.hidden', 'test.alpha-zero', 'test.clipped']));
  const elements = byId(result);
  assert.equal(elements['test.a11y-only'].text, '');
  assert.equal(elements['test.modal.input'], undefined, 'a redacted UIKit input cannot supplement a missing AX input');
  for (const id of ['test.hidden', 'test.alpha-zero', 'test.clipped']) assert.equal(elements[id].visible, false);
  for (const hiddenText of ['Accessible chart description only', 'Hidden text must stay out', 'Transparent text must stay out', 'Clipped text must stay out']) assert.ok(!elements['test.screen'].text.includes(hiddenText));
});

test('malformed redacted input observations never expose input text through a supplemented ancestor', () => {
  const tree = currentTree();
  const field = tree.children[1].children[2];
  field.text = 'private input bytes';
  field.value = 'private input bytes';
  field.children = [node('test.secret.child', 'private input bytes')];
  assert.throws(() => validateProbePair(pair(tree)));
});

test('background parent text follows its actual UIKit subtree while screen scope includes the modal', () => {
  const input = response([
    { anchor: 'test.screen', count: 1, text: 'Actual modal title', bounds: rect(0, 0, 400, 760), visible: true, enabled: true, interactive: false },
    { anchor: 'test.background', count: 1, text: '', bounds: rect(0, 0, 400, 760), visible: true, enabled: false, interactive: true, editable: false }
  ]);
  input.missing = ['test.title'];
  const result = supplementUIKitFacts(input, axTree, verifiedCapture(currentTree()), options(['test.screen', 'test.background', 'test.title']));
  const elements = byId(result);
  assert.equal(elements['test.background'].text, 'Actual background title');
  assert.ok(!elements['test.background'].text.includes('Actual modal title'));
  assert.ok(elements['test.screen'].text.includes('Actual background title'));
  assert.ok(elements['test.screen'].text.includes('Actual modal title'));
  assert.equal(elements['test.background'].provenance.textScope, 'subtree');
  assert.equal(elements['test.screen'].provenance.textScope, 'ownedWindow');
  for (const original of input.elements) {
    const changed = elements[original.anchor];
    for (const key of ['bounds', 'visible', 'enabled', 'interactive', 'editable']) assert.deepEqual(changed[key], original[key]);
  }
});

test('complete AX facts are preserved when the current UIKit tree has no requested missing anchors', () => {
  const input = response([{ anchor: 'test.title', count: 1, text: 'AX leaf title remains authoritative', bounds: rect(21, 21, 301, 24), visible: true, interactive: false }]);
  const result = supplementUIKitFacts(input, axTree, verifiedCapture(currentTree()), options(['test.title']));
  assert.deepEqual(result, input);
});

test('a missing native action gets actual text and geometry without fabricated interactivity', () => {
  const result = supplementUIKitFacts(response([]), axTree, verifiedCapture(currentTree()), options(['test.modal.save']));
  const item = byId(result)['test.modal.save'];
  assert.equal(item.text, 'Save actual draft');
  assert.notEqual(item.interactive, true);
  assert.notEqual(item.editable, true);
  assert.equal(item.provenance.source, 'currentUIKitViewTree');
});

test('an identifier already present in the raw AX snapshot cannot be papered over by UIKit supplementation', () => {
  const input = response([{ anchor: 'test.screen', count: 1, visible: true, text: 'Original AX screen text', bounds: rect(0, 0, 400, 760), interactive: false }]);
  input.missing = ['test.title'];
  const raw = { type: 'application', frame: rect(), children: [{ type: 'other', children: [{ type: 'staticText', identifier: 'test.title', label: 'AX already observed this title', frame: rect(20, 40, 300, 24) }] }] };
  const result = supplementUIKitFacts(input, raw, verifiedCapture(currentTree()), options(['test.screen', 'test.title']));
  assert.deepEqual(result, input, 'a normalizer omission is not absence from AX; neither add the leaf nor rewrite ancestor text');
});

test('independent build identity requires actual nonempty identifiers and 64-character SHA-256 digests', () => {
  for (const [key, invalid] of [
    ['bundleIdentifier', ''], ['shortVersion', ''], ['buildVersion', ''],
    ['executableSha256', 'not-a-digest'], ['javascriptSha256', 'a'.repeat(63)], ['javascriptSha256', 'g'.repeat(64)]
  ]) {
    const input = pair();
    input.expectedBuild[key] = invalid;
    input.before.actualBuild[key] = invalid;
    input.after.actualBuild[key] = invalid;
    assert.throws(() => validateProbePair(input), undefined, `${key}=${JSON.stringify(invalid)}`);
  }
});

test('a stable pair cannot promote impossible inherited hidden or alpha states into rendered facts', () => {
  const changes = [
    tree => { tree.children[0].hidden = true; tree.children[0].ancestorOrSelfHidden = true; tree.children[0].renderEligible = false; },
    tree => { tree.children[0].children[0].children[0].alpha = 0; },
    tree => { tree.children[0].alpha = 0; tree.children[0].effectiveAlpha = 0; tree.children[0].renderEligible = false; }
  ];
  for (const change of changes) {
    const tree = currentTree();
    change(tree);
    assert.throws(() => validateProbePair(pair(tree)), undefined, 'child effective visibility must agree with actual ancestor state');
  }
});

test('stable samples with an unattached, non-renderable owned window root are rejected rather than producing empty screen text', () => {
  const tree = currentTree();
  tree.attachedToWindow = false;
  tree.renderEligible = false;
  const input = pair(tree);
  assert.deepEqual(input.before.capture, input.after.capture, 'both observations report the same root state');
  assert.throws(() => validateProbePair(input), undefined, 'a stable invalid window root cannot become a successful capture');
});

const semanticSources = {
  userInteractionEnabled: 'UIView.userInteractionEnabled',
  effectiveUserInteractionEnabled: 'currentUIKitAncestorInteraction',
  buttonTrait: 'UIAccessibilityTraitsButton',
  linkTrait: 'UIAccessibilityTraitsLink',
  controlEnabled: 'UIControl.enabled',
  inputKind: 'UIKit.publicType',
  rnRole: 'RCTComponentViewProtocol.props.ViewProps.role',
  rnDisabled: 'RCTComponentViewProtocol.props.ViewProps.accessibilityState.disabled'
};
function observedSemantics(values = {}, sources = {}) {
  const fields = { userInteractionEnabled: true, effectiveUserInteractionEnabled: true, buttonTrait: false, linkTrait: false, ...values };
  return { ...fields, sources: Object.fromEntries(Object.keys(fields).map(key => [key, sources[key] ?? semanticSources[key]])) };
}
function withSemanticNode(item) {
  const tree = currentTree();
  const siblings = tree.children[0].children[0].children;
  siblings.push({ ...item, order: siblings.length });
  return tree;
}
function semanticFact(item) {
  const tree = withSemanticNode(item);
  return byId(supplementUIKitFacts(response([]), axTree, verifiedCapture(tree), options([item.identifier])))[item.identifier];
}
function noSemanticPromotion(item) {
  let found;
  try { found = semanticFact(item); }
  catch { return; } // Rejecting malformed public metadata is also fail-closed.
  assert.notEqual(found?.interactive, true);
  assert.notEqual(found?.editable, true);
}

test('a static text accessibility name does not create action semantics without public traits or roles', () => {
  const item = semanticFact(node('test.semantic.label', 'Actual static text', [], {
    accessibilityLabel: 'Accessible action-sounding name', observedSemantics: observedSemantics()
  }));
  assert.equal(item.text, 'Actual static text');
  assert.notEqual(item.interactive, true);
  assert.notEqual(item.editable, true);
  assert.equal(item.enabled, undefined, 'interaction permission is not an enabled-state observation');
});

test('public button and link traits permit action facts only with effective UIKit interaction', () => {
  for (const trait of ['buttonTrait', 'linkTrait']) {
    const item = semanticFact(node(`test.semantic.${trait}`, 'Actual action text', [], {
      observedSemantics: observedSemantics({ [trait]: true })
    }));
    assert.equal(item.interactive, true);
    assert.notEqual(item.editable, true);
    const blocked = semanticFact(node(`test.semantic.blocked.${trait}`, 'Still rendered text', [], {
      observedSemantics: observedSemantics({ [trait]: true, effectiveUserInteractionEnabled: false })
    }));
    assert.notEqual(blocked.interactive, true);
    assert.notEqual(blocked.editable, true);
  }
});

test('observed disabled values survive supplementation and absence of enabled evidence stays unknown', () => {
  const disabled = semanticFact(node('test.semantic.disabled-control', 'Disabled action', [], {
    class: 'UIButton', textSource: 'UIButton.currentTitle', observedSemantics: observedSemantics({ buttonTrait: true, controlEnabled: false })
  }));
  assert.equal(disabled.interactive, true);
  assert.equal(disabled.enabled, false);
  for (const rnDisabled of [true, false]) {
    const item = semanticFact(node(`test.semantic.rn-disabled-${rnDisabled}`, '', [], {
      observedSemantics: observedSemantics({ rnRole: 'button', rnDisabled })
    }));
    assert.equal(item.interactive, true);
    assert.equal(item.enabled, !rnDisabled);
  }
  const unknown = semanticFact(node('test.semantic.enabled-unknown', '', [], {
    observedSemantics: observedSemantics({ rnRole: 'button' })
  }));
  assert.equal(unknown.enabled, undefined);
});

test('whitelisted RN public roles provide semantics while actual descendant Text remains the only visible label', () => {
  for (const [rnRole, inputType] of [['button', null], ['link', null], ['checkbox', 'checkbox'], ['radio', 'radio'], ['switch', 'checkbox']]) {
    const item = semanticFact(node(`test.semantic.rn-${rnRole}`, '', [node('', 'Actual visible descendant')], {
      accessibilityLabel: 'Accessibility-only description', observedSemantics: observedSemantics({ rnRole }, {
        rnRole: rnRole === 'link' ? 'RCTComponentViewProtocol.props.ViewProps.accessibilityRole' : semanticSources.rnRole
      })
    }));
    assert.equal(item.interactive, true, rnRole);
    assert.equal(item.editable, Boolean(inputType), rnRole);
    assert.equal(item.inputType ?? null, inputType, rnRole);
    assert.equal(item.text, 'Actual visible descendant');
    assert.ok(!item.text.includes('Accessibility-only'));
  }
  const leafSwitch = semanticFact(node('test.semantic.uikit-switch', '', [], {
    class: 'UISwitch', accessibilityLabel: 'Do not treat a switch name as visible text',
    observedSemantics: observedSemantics({ inputKind: 'switch', controlEnabled: true })
  }));
  assert.equal(leafSwitch.interactive, true);
  assert.equal(leafSwitch.editable, true);
  assert.equal(leafSwitch.inputType, 'checkbox');
  assert.equal(leafSwitch.text, '');
});

test('unknown RN roles or untrusted semantic sources cannot promote a node into an action or input', () => {
  noSemanticPromotion(node('test.semantic.unknown-role', '', [], { observedSemantics: observedSemantics({ rnRole: 'menu-admin' }) }));
  noSemanticPromotion(node('test.semantic.label-role', '', [], {
    observedSemantics: observedSemantics({ rnRole: 'button' }, { rnRole: 'UIView.accessibilityLabel' })
  }));
  noSemanticPromotion(node('test.semantic.label-trait', '', [], {
    observedSemantics: observedSemantics({ buttonTrait: true }, { buttonTrait: 'UIView.accessibilityLabel' })
  }));
  noSemanticPromotion(node('test.semantic.untrusted-interaction', '', [], {
    observedSemantics: observedSemantics({ buttonTrait: true }, { effectiveUserInteractionEnabled: 'expected-prototype-value' })
  }));
});

test('trusted redacted input metadata supplements structure and readonly state without input content', () => {
  for (const editable of [true, false]) {
    const field = semanticFact(node(`test.semantic.input-${editable}`, '', [], {
      class: 'UITextField', inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true,
      observedSemantics: observedSemantics({ inputKind: 'textField', editable, controlEnabled: editable }, { editable: 'UITextField.enabled' })
    }));
    assert.ok(field);
    assert.equal(field.editable, editable);
    assert.equal(field.enabled, editable);
    assert.equal(field.inputType, 'text');
    assert.equal(field.text, '');
    assert.ok(!('value' in field));
    assert.ok(!('accessibilityValue' in field));
    assert.ok(!('accessibilityLabel' in field));
  }
  const view = semanticFact(node('test.semantic.readonly-textview', '', [], {
    class: 'UITextView', inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true,
    observedSemantics: observedSemantics({ inputKind: 'textView', editable: false }, { editable: 'UITextView.editable' })
  }));
  assert.equal(view.editable, false);
  assert.equal(view.text, '');
  const generic = semanticFact(node('test.semantic.generic-input', '', [], {
    class: 'CustomTextInput', inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true,
    observedSemantics: observedSemantics({ editable: true }, { editable: 'UITextView.editable' })
  }));
  assert.equal(generic, undefined, 'generic UITextInput is not guessed into a UIKit text type');
});

test('trusted UIKit semantics never replace existing AX interaction facts when only ancestor text is supplemented', () => {
  const controlId = 'test.semantic.ax-control', labelId = 'test.semantic.actual-label';
  const tree = withSemanticNode(node(controlId, '', [node(labelId, 'Actual descendant label')], {
    observedSemantics: observedSemantics({ rnRole: 'checkbox', rnDisabled: false })
  }));
  const original = { anchor: controlId, count: 1, bounds: rect(31, 41, 200, 45), visible: true, enabled: false, interactive: false, editable: false, inputType: 'text', role: 'other', text: '' };
  const input = response([original]);
  input.missing = [labelId];
  const raw = { type: 'application', frame: rect(), children: [{ type: 'other', identifier: controlId, frame: rect(31, 61, 200, 45) }] };
  const found = byId(supplementUIKitFacts(input, raw, verifiedCapture(tree), options([controlId, labelId])))[controlId];
  assert.equal(found.text, 'Actual descendant label');
  for (const key of ['bounds', 'visible', 'enabled', 'interactive', 'editable', 'inputType', 'role']) assert.deepEqual(found[key], original[key]);
  assert.deepEqual(found.provenance.fields, ['text']);
});
