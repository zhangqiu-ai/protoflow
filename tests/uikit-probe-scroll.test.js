import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProbePair, supplementUIKitFacts } from '../src/drivers/uikit-probe.js';

// Synthetic current facts only: these cases do not establish native UIKit/RN runtime behavior.
const rect = (x = 0, y = 0, width = 400, height = 500) => ({ x, y, width, height });
const session = { nonce: '11111111-1111-4111-8111-111111111111', contextId: 'CTX-scroll-proof', sceneId: 'test.screen.scrolled', screenAnchor: 'test.screen' };
const build = { bundleIdentifier: 'dev.siyue.capture', shortVersion: '0.0.1', buildVersion: '1', reactNativeVersion: '0.86.3', executableSha256: 'a'.repeat(64), javascriptSha256: 'b'.repeat(64) };
function view(identifier, frame, children = [], extra = {}) {
  const item = { identifier, class: 'RCTViewComponentView', frameInWindow: frame, frameInScreen: frame,
    bounds: rect(0, 0, frame.width, frame.height), order: 0, hidden: false, ancestorOrSelfHidden: false,
    alpha: 1, effectiveAlpha: 1, clipsToBounds: false, clipIntersection: frame,
    clipMethod: 'axisAlignedBoundsIntersection', transformed: false, attachedToWindow: true, renderEligible: true,
    occlusion: 'notComputed', text: '', textSource: 'none', children: children.map((child, order) => ({ ...child, order })), ...extra };
  if (item.inputRedacted) delete item.children;
  return item;
}
const label = (id, text, frame, extra = {}) => view(id, frame, [], { class: 'UILabel', text, textSource: 'UILabel.text', ...extra });
const scrollGeometry = () => ({ source: 'UIScrollView.publicGeometry', isScrollView: true, scrollEnabled: true,
  contentOffset: { x: 0, y: 0 }, contentSize: { width: 400, height: 1000 }, contentInset: { top: 0, left: 0, bottom: 0, right: 0 } });
function treeWithScroll(leaf = label('test.offscreen', 'Actual offscreen text', rect(20, 700, 320, 20), { renderEligible: false, clipIntersection: rect(0, 0, 0, 0) })) {
  const scroll = view('test.scroll', rect(0, 100, 400, 400), [leaf], { class: 'UIScrollView', clipsToBounds: true, scrollGeometry: scrollGeometry() });
  return view('', rect(), [view('test.screen', rect(), [scroll])], { class: 'UIWindow' });
}
const count = tree => 1 + (tree.children ?? []).reduce((total, child) => total + count(child), 0);
function verified(tree) {
  const at = Date.now() / 1000 - 1;
  const capture = { source: 'currentUIKitViewTree', occlusion: 'notComputed', nodeCount: count(tree), windows: [{
    sceneSession: 'synthetic-scroll-window', bounds: rect(), screenAnchor: session.screenAnchor, windowFrame: rect(),
    screenBounds: rect(), screenScale: 3, interfaceOrientation: 1, safeAreaInsets: { top: 0, left: 0, bottom: 0, right: 0 }, tree
  }] };
  const sample = (sampleId, startedAt, finishedAt) => ({ schemaVersion: 1, status: 'OK', nonce: session.nonce,
    sampleId, correlation: structuredClone(session), actualBuild: structuredClone(build), mainThread: true,
    startedAt, finishedAt, capture: structuredClone(capture) });
  return validateProbePair({ before: sample('22222222-2222-4222-8222-222222222222', at, at + 0.05),
    after: sample('33333333-3333-4333-8333-333333333333', at + 0.3, at + 0.35),
    timing: { axStartedAt: at + 0.1, axFinishedAt: at + 0.2, screenshotStartedAt: at + 0.21, screenshotFinishedAt: at + 0.22 }, expectedBuild: build, session }).capture;
}
function supplement(tree, anchors) {
  const capture = verified(tree), unchanged = structuredClone(capture);
  const response = { schemaVersion: 1, status: 'PASS', viewport: { width: 400, height: 500, scale: 3 }, screenshot: 'screen.png', elements: [], missing: anchors };
  const rawAX = { type: 'application', frame: rect(), children: [] };
  let result;
  try { result = supplementUIKitFacts(response, rawAX, capture, { anchors, screen: 'test.screen', content: rect() }); }
  finally { assert.deepEqual(capture, unchanged, 'interpretation must preserve current node parents, raw clips and renderEligible even when refusing geometry'); }
  return Object.fromEntries(result.elements.map(item => [item.anchor, item]));
}
function notPromoted(tree, id = 'test.offscreen') {
  let facts;
  try { facts = supplement(tree, [id]); }
  catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error;
    return; // Unsupported or inconsistent observations may fail closed; raw-mutation assertions may not.
  }
  assert.notEqual(facts[id]?.visible, true);
  assert.notEqual(facts[id]?.provenance.scrollContentEligible, true);
}

test('single-scroll offscreen content gets separate eligibility without rewriting raw rendering or hierarchy', () => {
  const tree = treeWithScroll();
  const before = structuredClone(tree);
  const facts = supplement(tree, ['test.screen', 'test.scroll', 'test.offscreen']);
  const item = facts['test.offscreen'];
  assert.equal(item.visible, true, 'native legacy rendered content includes supported offscreen scroll content');
  assert.equal(item.text, 'Actual offscreen text');
  assert.equal(item.provenance.renderEligible, false, 'raw clipping stays visible in provenance');
  assert.equal(item.provenance.scrollContentEligible, true);
  assert.equal(typeof item.provenance.scrollContentReason, 'string');
  assert.ok(item.provenance.scrollContentReason.length > 0);
  assert.deepEqual(item.provenance.scrollAncestorPaths, [[0, 0, 0]]);
  assert.ok(facts['test.scroll'].text.includes('Actual offscreen text'));
  assert.ok(facts['test.screen'].text.includes('Actual offscreen text'));
  assert.deepEqual(tree, before);
});

test('a genuine non-scroll local clip prevents scroll-content promotion', () => {
  const leaf = treeWithScroll().children[0].children[0].children[0];
  const clip = view('test.local-clip', rect(0, 100, 400, 30), [leaf], { clipsToBounds: true });
  notPromoted(treeWithScroll(clip));
});

test('hidden, alpha-zero, detached, zero-sized or transformed offscreen content never becomes eligible', () => {
  const cases = [
    { hidden: true, ancestorOrSelfHidden: true },
    { alpha: 0, effectiveAlpha: 0 },
    { attachedToWindow: false },
    { frameInWindow: rect(20, 700, 0, 0), frameInScreen: rect(20, 700, 0, 0), bounds: rect(0, 0, 0, 0) },
    { transformed: true }
  ];
  for (const extra of cases) {
    const leaf = label('test.offscreen', 'Must not be promoted', rect(20, 700, 320, 20), { renderEligible: false, clipIntersection: rect(0, 0, 0, 0), ...extra });
    notPromoted(treeWithScroll(leaf));
  }
});

test('observed nested scrolls are supported while transformed scroll ancestors remain refused', () => {
  const inner = treeWithScroll().children[0].children[0];
  inner.identifier = 'test.inner-scroll';
  assert.equal(supplement(treeWithScroll(inner), ['test.offscreen'])['test.offscreen'].provenance.scrollContentEligible, true);
  const transformed = treeWithScroll();
  transformed.children[0].children[0].transformed = true;
  notPromoted(transformed);
});

test('scroll class names alone and untrusted geometry sources do not authorize promotion', () => {
  const absent = treeWithScroll();
  delete absent.children[0].children[0].scrollGeometry;
  notPromoted(absent);
  const untrusted = treeWithScroll();
  untrusted.children[0].children[0].scrollGeometry.source = 'expected-prototype-geometry';
  notPromoted(untrusted);
});

function flattenedTree({ modal = false } = {}) {
  const note = view('test.note', rect(20, 120, 360, 44));
  const text = label('test.note.copy', 'Actual sibling note text', rect(40, 130, 300, 24));
  const input = view('test.note.input', rect(40, 130, 300, 24), [], { class: 'UITextField', inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true });
  const background = view('test.background', rect(), [note, text, input]);
  const layers = [background];
  if (modal) layers.push(view('test.modal', rect(), [label('test.modal.title', 'Modal text must stay outside the note', rect(40, 130, 300, 24))], { accessibilityViewIsModal: true }));
  return view('', rect(), [view('test.screen', rect(), layers)], { class: 'UIWindow' });
}

test('a flattened empty anchor reads actual same-layer sibling Text without fabricating descendants', () => {
  const tree = flattenedTree();
  const note = tree.children[0].children[0].children[0];
  assert.deepEqual(note.children, []);
  const facts = supplement(tree, ['test.note', 'test.note.copy', 'test.note.input']);
  assert.equal(facts['test.note'].text, 'Actual sibling note text');
  assert.equal(facts['test.note'].provenance.textScope, 'flattenedSiblingGeometry');
  assert.deepEqual(note.children, [], 'sibling interpretation never edits the raw UIKit parent relation');
  assert.equal(facts['test.note.input'], undefined, 'redacted input without trusted editing metadata is not fabricated');
});

test('a flattened background note excludes another modal branch even when its text geometrically overlaps', () => {
  const facts = supplement(flattenedTree({ modal: true }), ['test.screen', 'test.note', 'test.note.copy', 'test.modal.title']);
  assert.equal(facts['test.note'].text, 'Actual sibling note text');
  assert.equal(facts['test.note'].provenance.textScope, 'flattenedSiblingGeometry');
  assert.ok(!facts['test.note'].text.includes('Modal text'));
  assert.ok(facts['test.screen'].text.includes('Actual sibling note text'));
  assert.ok(facts['test.screen'].text.includes('Modal text must stay outside the note'));
});


test('ambiguous empty sibling anchors competing for the same actual Text refuse geometry', () => {
  for (const peerFrame of [rect(200, 110, 200, 60), rect(20, 120, 360, 44)]) {
    const tree = flattenedTree();
    const background = tree.children[0].children[0];
    background.children.push(view('test.competing-note', peerFrame, [], { order: background.children.length }));
    const unchanged = structuredClone(tree);
    assert.throws(() => supplement(tree, ['test.note', 'test.competing-note']), /ambiguous flattened sibling geometry/);
    assert.deepEqual(tree, unchanged, 'ambiguous candidates are not repaired by inserting synthetic children');
  }
});

test('flattened text geometry fails closed for transformed anchors and selected-text ancestors', () => {
  const cases = [
    tree => { tree.children[0].children[0].children[0].transformed = true; },
    tree => { tree.children[0].children[0].transformed = true; },
    tree => { tree.children[0].children[0].children[1].transformed = true; }
  ];
  for (const transform of cases) {
    const tree = flattenedTree();
    transform(tree);
    const unchanged = structuredClone(tree);
    assert.throws(() => supplement(tree, ['test.note']), /transformed flattened text geometry/);
    assert.deepEqual(tree, unchanged);
  }
  // The selected Text's transformed ancestor need not also contain the empty anchor.
  const tree = flattenedTree();
  const background = tree.children[0].children[0], selected = background.children[1];
  background.children[1] = view('', rect(20, 120, 360, 44), [selected], { order: 1 });
  assert.equal(supplement(tree, ['test.note'])['test.note'].text, 'Actual sibling note text', 'the non-transformed control fixture genuinely selects this Text');
  background.children[1].transformed = true;
  const unchanged = structuredClone(tree);
  assert.throws(() => supplement(tree, ['test.note']), /transformed flattened text geometry/);
  assert.deepEqual(tree, unchanged);
});
