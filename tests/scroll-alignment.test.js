import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScrollEnds, validateScrollSteps } from '../src/drivers/scroll-alignment.js';
const steps = [{ action: 'scroll-to', anchor: 'demo.export', value: 'end' }];
const frame = (x, y, width, height) => ({ x, y, width, height });
function fixture() {
 const target = { identifier: 'demo.export', attachedToWindow: true, ancestorOrSelfHidden: false, renderEligible: true, transformed: false, frameInScreen: frame(30, 180, 120, 40), children: [] };
 const scroll = { identifier: '', attachedToWindow: true, renderEligible: true, transformed: false, bounds: frame(0, 720, 300, 280), frameInScreen: frame(0, 0, 300, 280),
  scrollGeometry: { source: 'UIScrollView.publicGeometry', isScrollView: true, scrollEnabled: true, contentSize: { width: 300, height: 1000 }, contentOffset: { x: 0, y: 720 }, adjustedContentInset: { top: 0, left: 0, bottom: 0, right: 0 } }, children: [target] };
 const root = { identifier: 'demo', transformed: false, children: [scroll] };
 return { capture: { windows: [{ screenScale: 2, tree: root }] }, root, scroll, target, observations: [{ anchor: 'demo.export', source: 'XCUIAutomation.publicScrollGesture', endpointVerified: false, gestureCount: 3, stationarySamples: 2, scrollFrame: { ...scroll.frameInScreen }, targetFrame: { ...target.frameInScreen } }] };
}
const verify = f => nativeScrollEnds(f.capture, steps, f.observations);
test('vertical endpoint is measured from the actual observed adjusted inset, viewport and content size', () => {
 const f = fixture(); assert.equal(verify(f)[0].maximum, 720); assert.deepEqual(verify(f)[0].nativeNodePath, [0, 0]);
 f.scroll.scrollGeometry.adjustedContentInset.bottom = 20; f.scroll.scrollGeometry.contentOffset.y = 740; assert.equal(verify(f)[0].maximum, 740);
});
test('short content uses the reachable negative top inset endpoint', () => {
 const f = fixture(); f.scroll.scrollGeometry.contentSize.height = 80; f.scroll.scrollGeometry.adjustedContentInset.top = 30; f.scroll.scrollGeometry.contentOffset.y = -30;
 assert.equal(verify(f)[0].maximum, -30);
});
test('one physical pixel is the endpoint measurement precision, not a visual comparison waiver', () => {
 const f = fixture(); f.capture.windows[0].screenScale = 3; f.scroll.scrollGeometry.contentOffset.y += 0.3; verify(f);
 f.scroll.scrollGeometry.contentOffset.y += 0.1; assert.throws(() => verify(f), /not at scroll end/);
});
for (const [name, change, reason] of [
 ['stationary but not end', f => f.scroll.scrollGeometry.contentOffset.y = 600, /not at scroll end/],
 ['missing adjusted inset', f => delete f.scroll.scrollGeometry.adjustedContentInset, /adjusted content inset/],
 ['NaN adjusted inset', f => f.scroll.scrollGeometry.adjustedContentInset.bottom = NaN, /adjusted content inset/],
 ['disabled', f => f.scroll.scrollGeometry.scrollEnabled = false, /rendered and enabled/],
 ['transformed target', f => f.target.transformed = true, /transformed/],
 ['hidden target', f => f.target.ancestorOrSelfHidden = true, /not rendered/],
 ['duplicate target', f => f.root.children.push(structuredClone(f.target)), /unique exact target/],
 ['foreign branch same frames', f => { f.scroll.children = []; f.root.children.push(f.target); }, /unique vertical scroll/],
 ['nested scroll', f => f.scroll.children = [{ ...structuredClone(f.scroll), children: [f.target] }], /nested scroll/],
 ['horizontal content', f => f.scroll.scrollGeometry.contentSize.width = 400, /horizontal scroll/],
 ['scope changed after gesture', f => f.observations[0].scrollFrame.y = 30, /scope changed/],
 ['target changed after gesture', f => f.observations[0].targetFrame.y = 30, /scope changed/],
 ['gesture never observed', f => f.observations.length = 0, /gesture observation/],
 ['out of bounds gestures', f => f.observations[0].gestureCount = 11, /gesture bounds/]
]) test(`${name} fails closed`, () => { const f = fixture(); change(f); assert.throws(() => verify(f), reason); });
test('legacy, unknown, duplicate and missing-probe options remain explicit', () => {
 assert.deepEqual(validateScrollSteps([{ action: 'scroll-to', anchor: 'demo.export' }]), []);
 assert.deepEqual(nativeScrollEnds(null, []), []);
 assert.throws(() => validateScrollSteps([{ ...steps[0], value: 'center' }]), /unsupported/);
 assert.throws(() => validateScrollSteps([...steps, ...steps]), /repeated/);
 assert.throws(() => validateScrollSteps(steps, { requireUIKit: true }), /needs current UIKit probe/);
});
