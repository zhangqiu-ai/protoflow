import { test, expect } from '@playwright/test';
import { insetFixture, screen } from '../uikit-screen-inset-fixtures.js';
const normalized = value => value.replace(/\s+/g, ' ').trim();
for (const [edge, top, height] of [['bottom', 32, 802], ['top-and-bottom', 0, 834]]) {
  test(`${edge} main-pane inset extension matches actual whole-window DOM text`, async ({ page }) => {
    await page.setViewportSize({ width: 1210, height: 834 });
    await page.setContent(`<main data-testid="window" style="position:absolute;inset:0"><aside style="position:absolute;left:0;top:0;width:300px;height:834px"><p>Profile</p><p>Search</p><p>Settings</p></aside><section data-testid="main" style="position:absolute;left:300px;top:${top}px;width:910px;height:${height}px"><h1>Visible heading</h1><button aria-label="Accessible operation"><svg></svg></button></section></main>`);
    const actual = await page.getByTestId('main').boundingBox();
    expect(actual).toEqual({ x: 300, y: top, width: 910, height });
    const f = insetFixture(actual);
    expect(screen(f).text).toBe(normalized(await page.getByTestId('window').innerText()));
    expect(screen(f).provenance.textCorrection).toBe('publicOwnedWindowScreenText');
    expect(f.rawAX).toEqual(f.before.rawAX);
    expect(f.capture).toEqual(f.before.capture);
  });
}
