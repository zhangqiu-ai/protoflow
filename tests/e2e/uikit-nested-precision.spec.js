import { test, expect } from '@playwright/test';
import { interpretUIKitCapture } from '../../src/drivers/uikit-probe-text.js';
import { precisionFixture, textFacts } from '../uikit-nested-precision-fixtures.js';
// Real DOM dimensions feed a declared numeric coordinate port; this is not a UIKit/native capture.
test('measured DOM physical extent divided by known scale survives float32 representation', async ({ page }, info) => {
  await page.setContent('<div data-testid="extent" style="position:absolute;top:3202px;height:467px;width:402px"></div>');
  const physical = await page.getByTestId('extent').evaluate(node => { const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}; });
  const scale = 3, points = physical.height / scale, y = physical.top / scale;
  const clipY = Math.fround(y), float32Points = Math.fround(physical.bottom / scale) - clipY;
  expect(physical.height).toBe(467); expect(points - float32Points).toBeGreaterThan(1e-6);
  const capture = precisionFixture({ height: points, clipHeight: float32Points, y, clipY, scale });
  await info.attach('numeric-port', { body: JSON.stringify({ physical, scale, y, clipY, points, float32Points, difference: points-float32Points, limitation: 'Explicit offline physical-to-point/float32 edge port; not an observed UIKit conversion.' }, null, 2), contentType: 'application/json' });
  expect(textFacts(interpretUIKitCapture, capture).eligibility.scrollContentEligible).toBe(true);
});
for (const requestedClip of [.01, .1, 1]) test(`actual DOM partial clip ${requestedClip}px remains refused`, async ({ page }, info) => {
  await page.setContent(`<div data-testid="parent" style="height:${156-requestedClip}px;width:720px;overflow:hidden"><div data-testid="inner" style="height:156px;width:720px"></div></div>`);
  const frames = await page.evaluate(() => Object.fromEntries(['parent','inner'].map(id => { const r=document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect(); return [id,{x:r.x,y:r.y,width:r.width,height:r.height}]; })));
  const delta = frames.inner.height-frames.parent.height;
  expect(delta).toBeGreaterThan(1e-4);
  await info.attach('measured-clipping', { body: JSON.stringify({ requestedClip, frames, delta }, null, 2), contentType:'application/json' });
  const capture=precisionFixture({ height: frames.inner.height, clipHeight: frames.parent.height });
  expect(textFacts(interpretUIKitCapture,capture).eligibility.scrollContentEligible).toBe(false);
});
test('identical actual DOM viewports keep baseline containment without fallback scale', async ({ page }) => {
  await page.setContent('<div data-testid="viewport" style="height:156px;width:720px"></div>');
  const height=await page.getByTestId('viewport').evaluate(node=>node.getBoundingClientRect().height);
  const capture=precisionFixture({height,clipHeight:height}); delete capture.windows[0].screenScale;
  expect(textFacts(interpretUIKitCapture,capture).eligibility.scrollContentEligible).toBe(true);
});
