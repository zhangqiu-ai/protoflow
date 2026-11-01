import { test, expect } from '@playwright/test';
import { captureOnPage } from '../../src/drivers/web.js';
import { compareStructure } from '../../src/tiers.js';
import { page as contract, state, html } from '../state-only-text-fixtures.js';
const ids = ['sample', 'sample.value', ...state.expect.visible];
for (const [name, changes, expected] of [
  ['equal dynamic and static text', {}, 'PASS'],
  ['two static occurrences', { values: ['shared-key', 'shared-key'] }, 'PASS'],
  ['dynamic value changes', { value: 'changed-key' }, 'PASS'],
  ['wrong static text', { wrong: true }, 'FAIL'],
  ['missing static text', { missing: true }, 'FAIL'],
  ['hidden static scope', { hidden: true }, 'FAIL'],
  ['duplicate static scope', { duplicate: true }, 'FAIL'],
]) test(`real DOM: ${name}`, async ({ page }) => {
  await page.setContent(html({ values: changes.values ?? ['shared-key'] }));
  const prototype = await captureOnPage(page, { attribute: 'data-pf', anchors: ids, dynamicAnchors: ['sample.value'] });
  await page.setContent(html(changes));
  // A full-text capture is the public fallback input, as from a native ancestor. No fact/string is injected.
  const application = await captureOnPage(page, { attribute: 'data-pf', anchors: ids });
  expect(compareStructure(contract, state, prototype, application, { native: true }).status).toBe(expected);
  if (!changes.hidden) expect(await page.locator('[data-pf="sample.panel"]').first().innerText()).toContain('Choices');
});

test('real DOM: an ambiguous full scope is not matched to whichever occurrence would pass', async ({ page }) => {
  await page.setContent(html());
  const prototype = await captureOnPage(page, { attribute: 'data-pf', anchors: ids, dynamicAnchors: ['sample.value'] });
  await page.locator('[data-pf="sample.panel"]').evaluate(node => {
    const copy = node.cloneNode(true); copy.removeAttribute('data-pf');
    for (const item of copy.querySelectorAll('[data-pf]')) item.removeAttribute('data-pf');
    node.parentElement.append(copy);
  });
  const application = await captureOnPage(page, { attribute: 'data-pf', anchors: ids });
  expect(application.elements['sample.panel'].count).toBe(1);
  expect(compareStructure(contract, state, prototype, application, { native: true }).status).toBe('FAIL');
});
