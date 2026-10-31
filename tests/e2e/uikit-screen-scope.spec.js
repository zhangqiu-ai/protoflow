import { test, expect } from '@playwright/test';
import { screenScopeFixture } from '../uikit-screen-scope-fixtures.js';

const normalized = text => text.replace(/\s+/g, ' ').trim();
test('the whole-screen DOM and owned-window physical text include the complete dock before main', async ({ page }) => {
  await page.setContent('<main data-testid="screen" style="display:flex"><aside style="width:300px"><p>Profile</p><p>Search</p><p>Settings</p></aside><section style="width:910px"><h1>Visible heading</h1><button aria-label="Accessible operation"><svg></svg></button></section></main>');
  const fixture = screenScopeFixture();
  expect(fixture.result.elements.find(item => item.anchor === 'test.screen').text).toBe(normalized(await page.getByTestId('screen').innerText()));
  expect(fixture.result.elements.find(item => item.anchor === 'test.action').text).toBe(await page.getByRole('button', { name: 'Accessible operation' }).innerText());
  expect(fixture.rawAX).toEqual(fixture.before.rawAX);
});

test('an actual later dialog remains after the page in DOM and owned-window scope', async ({ page }) => {
  await page.setContent('<main data-testid="screen"><div style="display:flex"><aside><p>Profile</p><p>Search</p><p>Settings</p></aside><section>Visible heading</section></div><div role="dialog"><h2>Dialog title</h2><button>Continue</button></div></main>');
  const fixture = screenScopeFixture(({ tree, uikit, rect }) => tree.children.push(uikit('test.dialog', '', [uikit('', 'Dialog title', [], rect(400, 300, 300, 24)), uikit('', 'Continue', [], rect(400, 500, 300, 44))], rect(350, 250, 500, 400))));
  expect(fixture.result.elements.find(item => item.anchor === 'test.screen').text).toBe(normalized(await page.getByTestId('screen').innerText()));
});
