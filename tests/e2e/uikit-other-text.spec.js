import { test, expect } from '@playwright/test';
import { otherFixture, buttonParent, observedOtherBranches } from '../uikit-probe-other-text-fixtures.js';

test('a noninteractive profile character is visible text independently of its accessible name', async ({ page }) => {
  await page.setContent('<main data-testid="screen">Visible heading<div role="group" aria-label="Accessible operation" data-testid="avatar"><span>Z</span></div></main>');
  const text = await page.getByTestId('avatar').innerText(), fixture = otherFixture();
  expect(text).toBe('Z');
  expect(fixture.result.elements.find(item => item.anchor === 'test.action').text).toBe(text);
  expect(fixture.result.elements.find(item => item.anchor === 'test.screen').text).toBe(await page.getByTestId('screen').innerText().then(value => value.replace(/\s+/g, ' ').trim()));
  expect(fixture.result.elements.find(item => item.anchor === 'test.action').provenance.originalAX.label).toBe('Accessible operation');
  expect(fixture.rawAX).toEqual(fixture.before.rawAX);
});

test('the same true character remains on the leaf and its corrected profile button parent', async ({ page }) => {
  await page.setContent('<button aria-label="Profile accessible name" data-testid="profile">Visible heading <span role="group" aria-label="Accessible operation" data-testid="avatar">Z</span></button>');
  const fixture = otherFixture(value => buttonParent(value));
  expect(fixture.result.elements.find(item => item.anchor === 'test.action').text).toBe(await page.getByTestId('avatar').innerText());
  expect(fixture.result.elements.find(item => item.anchor === 'test.container').text).toBe(await page.getByTestId('profile').innerText());
  expect(fixture.capture).toEqual(fixture.before.capture);
});

test('an empty current subtree keeps the AX name instead of using emptiness to clear unknown content', async ({ page }) => {
  await page.setContent('<div role="group" aria-label="Accessible operation" data-testid="avatar"></div>');
  const fixture = otherFixture(({ control }) => { control.children = []; });
  expect(await page.getByTestId('avatar').innerText()).toBe('');
  expect(fixture.result).toEqual(fixture.before.response);
  expect(fixture.result.elements.find(item => item.anchor === 'test.action').text).toBe('Accessible operation');
});

for (const { observation, fixture } of observedOtherBranches()) test(`recorded ${observation.sourceScene} branch keeps the profile glyph and original AX name`, async ({ page }) => {
  await page.setContent('<button aria-label="Profile accessible name">Visible heading<span data-testid="avatar">Z</span></button>');
  const own = fixture.result.elements.find(item => item.anchor === observation.ax.identifier);
  expect(own.text).toBe(await page.getByTestId('avatar').innerText());
  expect(own.provenance.originalAX.label).toBe(observation.ax.label);
  expect(fixture.response).toEqual(fixture.before.response);
  expect(fixture.rawAX).toEqual(fixture.before.rawAX);
});
