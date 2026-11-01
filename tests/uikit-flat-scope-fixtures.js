import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateProbePair, supplementUIKitFacts } from '../src/drivers/uikit-probe.js';

export const recordedNote = JSON.parse(readFileSync(new URL('./fixtures/uikit-flat-note-public.json', import.meta.url)));
const rect = (x = 0, y = 0, width = 400, height = 500) => ({ x, y, width, height });
function view(identifier, frame, children = [], extra = {}) {
  const value = { identifier, class: 'UIView', frameInScreen: frame, frameInWindow: frame,
    bounds: rect(0, 0, frame.width, frame.height), order: 0, hidden: false, ancestorOrSelfHidden: false,
    alpha: 1, effectiveAlpha: 1, clipsToBounds: false, clipIntersection: frame, clipMethod: 'axisAlignedBoundsIntersection',
    transformed: false, attachedToWindow: true, renderEligible: true, occlusion: 'notComputed', text: '', textSource: 'none',
    children: children.map((child, order) => ({ ...child, order })), ...extra };
  if (value.inputRedacted) delete value.children;
  return value;
}
const text = (value, frame = rect(40, 130, 280, 20), extra = {}) => view('', frame, [], { text: value, textSource: 'UILabel.text', class: 'UILabel', ...extra });
const noteFrame = rect(20, 100, 360, 160);
function parent(children) { return view('', rect(), children); }
function tree(children) { return view('test.screen', rect(), children, { class: 'UIWindow' }); }
const note = () => view('test.note', noteFrame);
const scroll = (children, extra = {}) => view('', rect(0, 0, 400, 200), children, { class: 'UIScrollView', clipsToBounds: true,
  scrollGeometry: { source: 'UIScrollView.publicGeometry', isScrollView: true, scrollEnabled: true,
    contentOffset: { x: 0, y: 0 }, contentSize: { width: 400, height: 1000 }, contentInset: { top: 0, left: 0, bottom: 0, right: 0 } }, ...extra });
const count = node => 1 + (node.children ?? []).reduce((total, child) => total + count(child), 0);
function captureFor(root) {
  return { source: 'currentUIKitViewTree', occlusion: 'notComputed', nodeCount: count(root), windows: [{
    sceneSession: 'synthetic-flat-window', bounds: rect(), windowFrame: rect(), screenBounds: rect(),
    screenScale: 2, screenAnchor: 'test.screen', tree: root
  }] };
}
export function runScopeCapture(capture, anchors, screen) {
  const unchanged = structuredClone(capture), now = 100;
  const session = { nonce: '11111111-1111-4111-8111-111111111111', contextId: 'CTX-flat-scope', sceneId: 'test.screen.flat', screenAnchor: screen };
  const build = { bundleIdentifier: 'dev.example.synthetic', shortVersion: '1', buildVersion: '1', reactNativeVersion: '0.86.3',
    executableSha256: 'a'.repeat(64), javascriptSha256: 'b'.repeat(64) };
  const sample = (sampleId, startedAt) => ({ schemaVersion: 1, status: 'OK', mainThread: true, nonce: session.nonce,
    correlation: session, actualBuild: build, sampleId, startedAt, finishedAt: startedAt + 0.01, capture: structuredClone(capture) });
  const verified = validateProbePair({ before: sample('22222222-2222-4222-8222-222222222222', now),
    after: sample('33333333-3333-4333-8333-333333333333', now + 0.5), session, expectedBuild: build,
    timing: { axStartedAt: now + 0.1, axFinishedAt: now + 0.2, screenshotStartedAt: now + 0.3, screenshotFinishedAt: now + 0.4 } });
  const response = { status: 'PASS', viewport: { width: 400, height: 500, scale: 2 }, elements: [], missing: anchors };
  try {
    return supplementUIKitFacts(response, { type: 'application', frame: rect(), children: [] }, verified.capture,
      { anchors, screen, content: rect() });
  } finally { assert.deepEqual(capture, unchanged, 'derived interpretation must not edit original public observations'); }
}
export function recordedNoteFacts() { return runScopeCapture(structuredClone(recordedNote.capture), ['ai.thread', 'ai.note'], 'ai.thread'); }
export const flatScopeCases = [
  { name: 'same-parent flattened siblings keep their visible text', make: () => tree([parent([note(), text('Own')])]), expected: 'Own' },
  { name: 'a sibling group may own nested public Text', make: () => tree([parent([note(), view('', noteFrame, [text('Nested')])])]), expected: 'Nested' },
  { name: 'a later modal leaf never borrows background branch text', make: () => tree([parent([text('Background')]), parent([note(), text('Own')])]), expected: 'Own', screenIncludes: ['Background', 'Own'] },
  { name: 'an earlier leaf never borrows later modal branch text', make: () => tree([parent([note(), text('Own')]), parent([text('Modal')])]), expected: 'Own', screenIncludes: ['Own', 'Modal'] },
  { name: 'a nested sibling container retains legal shared text', make: () => tree([parent([note(), view('test.inner', rect(30, 120, 320, 60)), text('Nested owner')])]), expected: 'Nested owner' },
  { name: 'typed inputs remain excluded from flattened sibling text', make: () => tree([parent([note(), text('Own'), view('test.input', noteFrame, [], { inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true })])]), expected: 'Own' },
  { name: 'single observed scroll keeps offscreen sibling content eligible', make: () => tree([scroll([parent([
    view('test.note', rect(20, 400, 360, 100), [], { renderEligible: false, clipIntersection: rect(0, 0, 0, 0) }),
    text('Offscreen own', rect(40, 420, 280, 20), { renderEligible: false, clipIntersection: rect(0, 0, 0, 0) })
  ])])]), expected: 'Offscreen own', offscreen: true },
  { name: 'same-parent partial overlap still rejects ambiguous ownership', make: () => tree([parent([note(), view('test.peer', rect(200, 110, 200, 100)), text('Own')])]), error: /ambiguous flattened sibling geometry/ },
  { name: 'sameRect sibling ownership still fails closed', make: () => tree([parent([note(), view('test.peer', noteFrame), text('Own')])]), error: /ambiguous flattened sibling geometry/ },
  { name: 'transformed flattened anchor still fails closed', make: () => tree([parent([view('test.note', noteFrame, [], { transformed: true }), text('Own')])]), error: /transformed flattened text geometry/ },
  { name: 'transformed nested text ancestor still fails closed', make: () => tree([parent([note(), view('', noteFrame, [text('Own')], { transformed: true })])]), error: /transformed flattened text geometry/ },
  { name: 'nonfinite public geometry still fails validation', make: () => tree([parent([view('test.note', rect(NaN, 100, 360, 160)), text('Own')])]), error: /nonfinite|invalid geometry/ }
];
export function scopeCaseFacts(scenario) {
  return runScopeCapture(captureFor(scenario.make()), ['test.screen', 'test.note'], 'test.screen');
}
