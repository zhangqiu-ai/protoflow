import { test, expect } from '@playwright/test';
import { windowLayerFixture, windowText, partialWindowFixture, partialWindowFrames } from '../uikit-window-layer-fixtures.js';
const normalized = value => value.replace(/\s+/g, ' ').trim();

for (const offscreen of [false, true]) test(`DOM two columns and a later full-window popup preserve document text order, offscreen=${offscreen}`, async ({ page }) => {
  await page.setContent(`<main data-testid="window" style="position:relative;width:1210px;height:834px"><div style="position:absolute;inset:0"><aside style="width:300px"><p>Profile</p><p>Search</p><p style="margin-top:600px">Settings</p></aside></div><section style="margin-left:300px"><h1>Visible heading</h1><div style="height:620px;overflow:auto"><p style="margin-top:${offscreen ? 780 : 180}px">Body paragraph</p></div></section><div style="position:absolute;inset:0"><div style="position:absolute;inset:0"></div><div role="dialog" style="position:absolute;left:375px;top:180px;width:460px;height:400px"><h2>Dialog title</h2><button>Continue</button></div></div></main>`);
  expect(windowText(windowLayerFixture({ offscreen }))).toBe(normalized(await page.getByTestId('window').innerText()));
});

test('DOM keeps genuine different dialog text and excludes redacted-style input values', async ({ page }) => {
  await page.setContent('<main data-testid="window"><aside><p>Profile</p><p>Search</p><p>Settings</p><input aria-label="Private input" value="must not become visible text"></aside><section><h1>Visible heading</h1><p>Body paragraph</p></section><div role="dialog"><h2>Different actual title</h2><button>Continue</button></div></main>');
  const fixture = windowLayerFixture({}, ({ popup }) => { popup.children[0].children[1].children[0].text = 'Different actual title'; });
  expect(windowText(fixture)).toBe(normalized(await page.getByTestId('window').innerText()));
});

for (const [side, { frame }] of Object.entries(partialWindowFrames)) test(`DOM and rendered UIKit preserve positive-clipped ${side} text whose centre is outside the window`, async ({ page }) => {
  await page.setViewportSize({ width: 1210, height: 834 });
  await page.setContent(`<style>body{margin:0}</style><main data-testid="window" style="position:relative;width:1210px;height:834px;overflow:hidden"><span data-testid="partial" style="position:absolute;left:${frame.x}px;top:${frame.y}px;width:${frame.width}px;height:${frame.height}px">Partly visible</span></main>`);
  const bounds = await page.getByTestId('partial').boundingBox();
  expect(bounds).not.toBeNull();
  const intersectionWidth = Math.min(bounds.x + bounds.width, 1210) - Math.max(bounds.x, 0);
  const intersectionHeight = Math.min(bounds.y + bounds.height, 834) - Math.max(bounds.y, 0);
  expect(intersectionWidth).toBeGreaterThan(0); expect(intersectionHeight).toBeGreaterThan(0);
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  expect(cx < 0 || cx > 1210 || cy < 0 || cy > 834).toBe(true);
  const actualText = await page.getByTestId('partial').innerText();
  expect(await page.getByTestId('window').innerText()).toContain(actualText);
  expect(windowText(partialWindowFixture(side))).toContain(actualText);
});
