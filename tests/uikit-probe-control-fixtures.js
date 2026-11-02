import { readFileSync } from 'node:fs';
import { anchorFacts } from '../src/drivers/native-tree.js';
import { validateProbePair, supplementUIKitFacts } from '../src/drivers/uikit-probe.js';

const rect = (x = 0, y = 0, width = 400, height = 800) => ({ x, y, width, height });
const source = {
  userInteractionEnabled: 'UIView.userInteractionEnabled', effectiveUserInteractionEnabled: 'currentUIKitAncestorInteraction',
  buttonTrait: 'UIAccessibilityTraitsButton', linkTrait: 'UIAccessibilityTraitsLink', rnRole: 'RCTComponentViewProtocol.props.ViewProps.accessibilityRole',
  rnDisabled: 'RCTComponentViewProtocol.props.ViewProps.accessibilityState.disabled'
};
const semantics = () => {
  const facts = { userInteractionEnabled: true, effectiveUserInteractionEnabled: true, buttonTrait: true, linkTrait: false, rnRole: 'button', rnDisabled: true };
  return { ...facts, sources: Object.fromEntries(Object.keys(facts).map(key => [key, source[key]])) };
};
const uikit = (identifier, text = '', children = [], frame = rect(), extra = {}) => ({
  identifier, class: text ? 'RCTParagraphComponentView' : 'RCTViewComponentView', frameInWindow: frame, frameInScreen: frame,
  bounds: rect(0, 0, frame.width, frame.height), order: 0, hidden: false, ancestorOrSelfHidden: false, alpha: 1, effectiveAlpha: 1,
  clipsToBounds: false, clipIntersection: frame, clipMethod: 'axisAlignedBoundsIntersection', transformed: false,
  attachedToWindow: true, renderEligible: true, occlusion: 'notComputed', text,
  textSource: text ? 'RCTParagraphComponentView.attributedText' : 'none', children: children.map((child, order) => ({ ...child, order })), ...extra
});
const ax = (identifier, type, label, children = [], frame = rect()) => ({ identifier, type, label, frame, children, enabled: false });
const clone = value => structuredClone(value);
const count = node => 1 + (node.children ?? []).reduce((n, child) => n + count(child), 0);
export function controlFixture(change = () => {}) {
  const controlFrame = rect(20, 100, 40, 40), labelFrame = rect(20, 40, 200, 20), containerFrame = rect(0, 20, 400, 200);
  const control = uikit('test.action', '', [uikit('', '', [], rect(30, 110, 20, 20), { class: 'RNSVGPath' })], controlFrame,
    { accessibilityLabel: 'Accessible operation', observedSemantics: semantics() });
  const container = uikit('test.container', '', [uikit('test.title', 'Visible heading', [], labelFrame), control], containerFrame);
  const tree = uikit('test.screen', '', [container]);
  const axControl = ax('test.action', 'button', 'Accessible operation', [], controlFrame);
  const axContainer = ax('test.container', 'other', '', [ax('test.title', 'staticText', 'Visible heading', [], labelFrame), axControl], containerFrame);
  const rawAX = ax('test.screen', 'other', '', [axContainer]);
  const anchors = ['test.screen', 'test.container', 'test.title', 'test.action'];
  const fixture = { tree, control: tree.children[0].children[1], container: tree.children[0], rawAX,
    axControl: rawAX.children[0].children[1], axContainer: rawAX.children[0], anchors, rect, uikit, ax };
  change(fixture);
  const capture = { source: 'currentUIKitViewTree', occlusion: 'notComputed', nodeCount: count(tree), windows: [{
    sceneSession: 'synthetic-control-window', bounds: fixture.windowFrame ?? rect(), windowFrame: fixture.windowFrame ?? rect(), screenBounds: fixture.windowFrame ?? rect(), screenScale: 3,
    screenAnchor: 'test.screen', tree
  }] };
  const session = { nonce: '11111111-1111-4111-8111-111111111111', contextId: 'CTX-control-text', sceneId: 'test.screen.initial', screenAnchor: 'test.screen' };
  const expectedBuild = { bundleIdentifier: 'dev.example.capture', shortVersion: '1.0', buildVersion: '1', reactNativeVersion: '0.86.3', executableSha256: 'a'.repeat(64), javascriptSha256: 'b'.repeat(64) };
  const sample = (id, startedAt, finishedAt) => ({ schemaVersion: 1, status: 'OK', nonce: session.nonce, sampleId: id,
    correlation: session, actualBuild: expectedBuild, mainThread: true, startedAt, finishedAt, capture: clone(capture) });
  const verified = validateProbePair({
    before: sample('22222222-2222-4222-8222-222222222222', 1, 1.01), after: sample('33333333-3333-4333-8333-333333333333', 1.3, 1.31),
    timing: { axStartedAt: 1.05, axFinishedAt: 1.1, screenshotStartedAt: 1.15, screenshotFinishedAt: 1.2 }, session, expectedBuild
  });
  const options = { anchors, screen: 'test.screen', content: fixture.content ?? rect() };
  const response = { schemaVersion: 1, status: 'PASS', ...anchorFacts(rawAX, options) };
  fixture.changeResponse?.(response);
  const before = { response: clone(response), rawAX: clone(rawAX), capture: clone(verified.capture) };
  const result = supplementUIKitFacts(response, rawAX, verified.capture, options);
  return { ...fixture, response, result, before, capture: verified.capture };
}

export const controlCases = [
  { name: 'icon only and disabled preserve all AX facts and ancestor public text', expected: ['', 'Visible heading', 'Visible heading'], change() {} },
  ...['UILabel.text', 'RCTParagraphComponentView.attributedText', 'UIButton.currentTitle'].map(textSource => ({
    name: `real visible text remains from ${textSource}`, expected: ['Send', 'Visible heading Send', 'Visible heading Send'],
    change({ control, uikit, rect }) {
      if (textSource === 'UIButton.currentTitle') Object.assign(control, { class: 'UIButton', text: 'Send', textSource, children: [] });
      else control.children = [uikit('', 'Send', [], rect(20, 100, 40, 40), { textSource, class: textSource === 'UILabel.text' ? 'UILabel' : 'RCTParagraphComponentView' })];
    }
  })),
  { name: 'existing provenance remains available alongside original AX label', expected: ['', 'Visible heading', 'Visible heading'],
    change(fixture) { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.action').provenance = { source: 'nativeAX', fields: ['text'], note: 'original evidence' }; }; } },
  { name: 'public link role uses the same noninput text-only rule', expected: ['', 'Visible heading', 'Visible heading'],
    change({ control, axControl }) { axControl.type = 'link'; Object.assign(control.observedSemantics, { rnRole: 'link', buttonTrait: false, linkTrait: true }); } },
  { name: 'duplicate redacted UIKit identifier cannot hide behind the supplementation filter', unchanged: true,
    change({ container, uikit, rect }) { const input = uikit('test.action', '', [], rect(20, 100, 40, 40), { inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true }); delete input.children; container.children.push(input); } },
  { name: 'flattened AX container rederives only scopes receiving the control label', expected: ['', 'Visible heading', 'Visible heading'],
    change({ rawAX, axContainer }) { const children = axContainer.children; axContainer.children = []; rawAX.children.push(...children); } },
  { name: 'ambiguous UIKit control leaves every AX text untouched', unchanged: true,
    change({ container, control }) { container.children.push(clone(control)); } },
  { name: 'ambiguous ancestor fails the whole correction group closed', unchanged: true,
    change({ tree, container }) { tree.children.push({ ...clone(container), children: [] }); } },
  { name: 'mismatched control frame leaves every AX text untouched', unchanged: true,
    change({ axControl }) { axControl.frame = { ...axControl.frame, x: 21 }; } },
  { name: 'mismatched public role leaves every AX text untouched', unchanged: true,
    change({ control }) { control.observedSemantics.rnRole = 'link'; } },
  { name: 'missing public semantics leaves every AX text untouched', unchanged: true,
    change({ control }) { delete control.observedSemantics; } },
  { name: 'input-containing action is excluded without reading any input value', unchanged: true,
    change({ control, uikit, rect }) { const input = uikit('', '', [], rect(20, 100, 20, 20), { inputRedacted: true, textSource: 'redactedInput', accessibilityLabelRedacted: true }); delete input.children; control.children.push(input); } },
  { name: 'duplicate raw AX control leaves every AX text untouched', unchanged: true,
    change({ axContainer, axControl }) { axContainer.children.push(clone(axControl)); } },
  { name: 'duplicate response scope fails the whole correction group closed', unchanged: true,
    change(fixture) { fixture.changeResponse = response => response.elements.push(clone(response.elements.find(item => item.anchor === 'test.container'))); } },
  { name: 'response action role mismatch fails the whole correction group closed', unchanged: true,
    change(fixture) { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.action').role = 'other'; }; } },
  { name: 'failed correction group cannot be rewritten through an unrelated missing anchor', unchangedExisting: true,
    change({ container, axContainer }) { container.identifier = ''; axContainer.children = axContainer.children.filter(node => node.identifier !== 'test.title'); } },
  { name: 'unmatched affected ancestor fails the correction group closed', unchanged: true,
    change({ container }) { container.identifier = ''; } },
  { name: 'unidentified sibling action keeps its original AX contribution', expected: ['', 'Visible heading Unidentified operation', 'Visible heading Unidentified operation'],
    change({ axContainer, ax, rect }) { axContainer.children.push(ax('', 'button', 'Unidentified operation', [], rect(100, 100, 40, 40))); } },
  { name: 'uncorrelated sibling action keeps its original AX contribution', expected: ['', 'Visible heading Uncorrelated action', 'Visible heading Uncorrelated action'],
    change({ container, axContainer, uikit, ax, rect }) { container.children.push(uikit('test.other', '', [], rect(100, 100, 40, 40))); axContainer.children.push(ax('test.other', 'button', 'Uncorrelated action', [], rect(100, 100, 40, 40))); } }
];

export function summarizeControlCase(fixture) {
  const ids = ['test.action', 'test.container', 'test.screen'];
  return ids.map(id => fixture.result.elements.find(item => item.anchor === id)?.text);
}

export function savedHomeFixture() {
  const saved = JSON.parse(readFileSync(new URL('./uikit-probe-home-observation.json', import.meta.url), 'utf8'));
  const { capture } = validateProbePair({ before: { ...saved.before, capture: saved.capture }, after: { ...saved.after, capture: saved.capture },
    timing: saved.timing, expectedBuild: saved.before.actualBuild, session: saved.before.correlation });
  const before = structuredClone(saved);
  const result = supplementUIKitFacts(saved.response, saved.rawAX, capture, { anchors: saved.response.elements.map(item => item.anchor), screen: 'ai.home', content: saved.content });
  return { saved, before, result };
}
