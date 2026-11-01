import assert from 'node:assert/strict';

const rect = (x, y, width, height) => ({ x, y, width, height });
const geometry = (width, height) => ({ source: 'UIScrollView.publicGeometry', isScrollView: true, scrollEnabled: true,
  contentOffset: { x: 0, y: 0 }, contentSize: { width, height }, contentInset: { top: 0, left: 0, bottom: 0, right: 0 } });
function node(identifier, frame, children = [], extra = {}) {
  return { identifier, class: 'SyntheticView', frameInScreen: frame, attachedToWindow: true, ancestorOrSelfHidden: false,
    hidden: false, effectiveAlpha: 1, clipsToBounds: false, transformed: false, renderEligible: false,
    text: '', textSource: 'none', children, ...extra };
}
function capture(root) { return { windows: [{ tree: root }] }; }
export function measuredTopology() {
  // Exact public numeric geometry from the preserved growth.home.initial observation; only identity/text and
  // redundant non-clipping wrappers are removed. This is not a newly captured/native acceptance fixture.
  const text = node('test.text', rect(891, 1131, 148, 17), [], { text: 'Measured nested text', textSource: 'UILabel.text', clipsToBounds: true });
  const innerContent = node('test.inner-content', rect(395, 1024, 660, 156), [text]);
  const inner = node('test.inner', rect(395, 1024, 720, 156), [innerContent], { clipsToBounds: true, scrollGeometry: geometry(660, 156) });
  const viewportClip = node('test.viewport-clip', rect(395, 1024, 720, 156), [inner], { clipsToBounds: true });
  const outerContent = node('test.outer-content', rect(300, 86, 910, 1198), [viewportClip]);
  const outer = node('test.outer', rect(300, 86, 910, 728), [outerContent], { renderEligible: true, clipsToBounds: true, scrollGeometry: geometry(910, 1198) });
  const pane = node('test.pane', rect(300, 0, 910, 834), [outer], { renderEligible: true, clipsToBounds: true });
  return capture(node('test.window', rect(0, 0, 1210, 834), [pane], { renderEligible: true }));
}
function find(capture, identifier) {
  let found;
  const walk = node => { if (node.identifier === identifier) found = node; for (const child of node.children ?? []) walk(child); };
  walk(capture.windows[0].tree); assert.ok(found, identifier); return found;
}
function crossAxisTopology() {
  const text = node('test.text', rect(220, 310, 20, 20), [], { text: 'Cross-axis nested text', textSource: 'UILabel.text' });
  const inner = node('test.inner', rect(0, 300, 100, 50), [text], { clipsToBounds: true, scrollGeometry: geometry(300, 50) });
  const clip = node('test.viewport-clip', rect(0, 300, 100, 50), [inner], { clipsToBounds: true });
  const outer = node('test.outer', rect(0, 0, 100, 100), [clip], { renderEligible: true, clipsToBounds: true, scrollGeometry: geometry(100, 500) });
  return capture(node('test.window', rect(0, 0, 100, 100), [outer], { renderEligible: true }));
}
function threeLayerTopology() {
  const text = node('test.text', rect(210, 430, 20, 10), [], { text: 'Three observed scrolls', textSource: 'UILabel.text' });
  const inner = node('test.inner', rect(200, 310, 50, 40), [text], { clipsToBounds: true, scrollGeometry: geometry(50, 150) });
  const middle = node('test.middle', rect(0, 300, 100, 100), [inner], { clipsToBounds: true, scrollGeometry: geometry(300, 100) });
  const outer = node('test.outer', rect(0, 0, 100, 100), [middle], { renderEligible: true, clipsToBounds: true, scrollGeometry: geometry(100, 500) });
  return capture(node('test.window', rect(0, 0, 100, 100), [outer], { renderEligible: true }));
}
const mutate = (make, change) => () => { const result = make(); change(result); return result; };
export const scenarios = [
  { name: 'preserved numeric nested topology is eligible without changing raw rendering', make: measuredTopology, eligible: true },
  { name: 'horizontal inner content may extend beyond the outer vertical content width', make: crossAxisTopology, eligible: true },
  { name: 'three observed scroll coordinate systems compose using consecutive viewports', make: threeLayerTopology, eligible: true },
  { name: 'a partial permanent clip between scrolls cannot authorize an entire inner viewport', make: mutate(measuredTopology, c => { find(c, 'test.viewport-clip').frameInScreen.height = 20; }), eligible: false },
  { name: 'a local non-scroll clip after the inner scroll still excludes its text', make: mutate(measuredTopology, c => {
    const inner = find(c, 'test.inner'), text = find(c, 'test.text'); inner.children = [node('test.local-clip', rect(395, 1024, 720, 20), [text], { clipsToBounds: true })];
  }), eligible: false },
  { name: 'an inner viewport outside the observed outer content extent is refused', make: mutate(measuredTopology, c => { find(c, 'test.outer').scrollGeometry.contentSize.height = 900; }), eligible: false },
  { name: 'a leaf outside the innermost observed content extent is refused', make: mutate(measuredTopology, c => { find(c, 'test.inner').scrollGeometry.contentSize.width = 600; }), eligible: false },
  { name: 'an outer viewport not rendered by the current capture is refused', make: mutate(measuredTopology, c => { find(c, 'test.outer').renderEligible = false; }), eligible: false },
  { name: 'an explicitly disabled nested scroll remains unsupported', make: mutate(measuredTopology, c => { find(c, 'test.inner').scrollGeometry.scrollEnabled = false; }), eligible: false },
  ...['test.window', 'test.pane', 'test.outer-content', 'test.inner', 'test.text'].flatMap(id => [
    { name: `${id} detached chain refuses eligibility`, make: mutate(measuredTopology, c => { find(c, id).attachedToWindow = false; }), eligible: false },
    { name: `${id} hidden chain refuses eligibility`, make: mutate(measuredTopology, c => { find(c, id).hidden = true; }), eligible: false },
    { name: `${id} zero-alpha chain refuses eligibility`, make: mutate(measuredTopology, c => { find(c, id).effectiveAlpha = 0; }), eligible: false },
    { name: `${id} transformed chain refuses eligibility`, make: mutate(measuredTopology, c => { find(c, id).transformed = true; }), eligible: false },
  ]),
  { name: 'unknown clipping metadata cannot authorize nested eligibility', make: mutate(measuredTopology, c => { delete find(c, 'test.outer-content').clipsToBounds; }), eligible: false },
  { name: 'unknown attachment metadata cannot authorize nested eligibility', make: mutate(measuredTopology, c => { delete find(c, 'test.outer-content').attachedToWindow; }), eligible: false },
  { name: 'incomplete observed inner scroll geometry fails closed', make: mutate(measuredTopology, c => { delete find(c, 'test.inner').scrollGeometry.contentOffset; }), throws: /invalid public scroll geometry/ },
  { name: 'non-finite observed scroll geometry fails closed', make: mutate(measuredTopology, c => { find(c, 'test.inner').scrollGeometry.contentSize.width = NaN; }), throws: /invalid public scroll geometry/ },
  { name: 'an explicitly untrusted intermediate scroll geometry is refused', make: mutate(threeLayerTopology, c => { find(c, 'test.middle').scrollGeometry.source = 'untrusted'; }), eligible: false },
];
export function verifyScenario(interpretUIKitCapture, scenario) {
  const current = scenario.make(), unchanged = structuredClone(current);
  try {
    if (scenario.throws) { assert.throws(() => interpretUIKitCapture(current, () => ({})), scenario.throws); return; }
    const observed = interpretUIKitCapture(current, () => ({}));
    const text = find(current, 'test.text'), eligibility = observed.eligibility.get(text);
    assert.equal(eligibility.scrollContentEligible, scenario.eligible, eligibility.scrollContentReason);
    assert.equal(text.renderEligible, false, 'derived eligibility must not rewrite raw rendering');
    if (scenario.eligible) {
      assert.equal(eligibility.scrollContentReason, 'observedNestedScrollContentOutsideViewport');
      assert.ok(eligibility.scrollAncestorPaths.length >= 2);
      assert.equal(observed.facts(text).text, text.text);
    }
  } finally { assert.deepEqual(current, unchanged, 'raw geometry/hierarchy/eligibility must remain unchanged'); }
}
