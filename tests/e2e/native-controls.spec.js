import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { captureOnPage } from '../../src/drivers/web.js';
import { anchorFacts, elementText, subtreeText } from '../../src/drivers/native-tree.js';

const fixture = JSON.parse(await readFile(new URL('../fixtures/ios/rn-control-label.raw.json', import.meta.url), 'utf8'));
const normalized = value => value.replace(/\s+/g, ' ').trim();

test('a leaf checkbox accessible name is not visible text, either on the control or its parent', async ({ page }) => {
  await page.setContent('<main data-pf="settings"><input data-pf="settings.wifi" type="checkbox" aria-label="Wi-Fi" style="width:300px;height:44px"></main>');
  await expect(page.getByRole('checkbox', { name: 'Wi-Fi' })).toBeVisible();
  const web = await captureOnPage(page, { attribute: 'data-pf', anchors: ['settings', 'settings.wifi'] });
  expect(web.elements['settings.wifi'].text).toBe('');
  expect(normalized(web.elements.settings.text)).toBe('');

  const control = { type: 'switch', identifier: 'settings.wifi', label: 'Wi-Fi', value: '1', frame: { x: 0, y: 0, width: 300, height: 44 } };
  expect(elementText(control)).toBe(web.elements['settings.wifi'].text);
  expect(subtreeText({ type: 'other', children: [control] })).toBe(normalized(web.elements.settings.text));
  expect(control.label).toBe('Wi-Fi');
});

test('a visible reminder title and a different switch accessible name match the native snapshot without extra words', async ({ page }) => {
  await page.setContent(`<main data-pf="settings.before"><div>Before shared sessions</div><div>Available once sessions have a time</div>
    <input data-pf="settings.before-toggle" type="checkbox" aria-label="Session reminder" disabled></main>`);
  await expect(page.getByRole('checkbox', { name: 'Session reminder' })).toBeDisabled();
  const anchors = ['settings.before', 'settings.before-toggle'];
  const web = await captureOnPage(page, { attribute: 'data-pf', anchors });
  expect(normalized(web.elements['settings.before'].text)).toBe('Before shared sessions Available once sessions have a time');
  expect(web.elements['settings.before-toggle'].text).toBe('');

  const native = Object.fromEntries(anchorFacts(fixture.tree, {
    anchors, screen: 'settings', content: fixture.tree.frame
  }).elements.map(item => [item.anchor, item]));
  for (const id of anchors) expect(native[id].text).toBe(normalized(web.elements[id].text));
  // A hierarchical snapshot has the same semantics as React Native's flattened sibling nodes.
  const [row, ...children] = fixture.tree.children;
  expect(subtreeText({ ...row, children })).toBe(normalized(web.elements['settings.before'].text));
  expect(children.at(-1).label).toBe('Session reminder');
});
