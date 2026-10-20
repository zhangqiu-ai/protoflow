import { test, expect } from '@playwright/test';
import { captureOnPage } from '../../src/drivers/web.js';

test('dynamic text outside any anchor is left out of anchor text but stays on screen', async ({ page }) => {
  await page.setContent(`<main data-pf="home" data-pf-role="screen"><h1 data-pf="home.title">Settings</h1>
    <nav aria-label="Main navigation"><button>Growth</button> <button>Chats<i data-pf-text="dynamic" style="display:inline-block">3</i></button></nav></main>`);
  const { elements } = await captureOnPage(page, { attribute: 'data-pf', anchors: ['home', 'home.title'] });
  expect(elements.home.text.replace(/\s+/g, ' ').trim()).toBe('Settings Growth Chats');
  // Restored before the screenshot, with its own inline display.
  expect(await page.locator('i').evaluate(node => [node.style.display, node.offsetWidth > 0])).toEqual(['inline-block', true]);
});

test('anchors.dynamicText selectors mark fixture text without touching the prototype', async ({ page }) => {
  await page.setContent(`<main data-pf="home" data-pf-role="screen"><h1 data-pf="home.title">Settings</h1>
    <nav><button>Chats<i class="badge">3</i></button></nav></main>`);
  const plain = await captureOnPage(page, { attribute: 'data-pf', anchors: ['home'] });
  expect(plain.elements.home.text.replace(/\s+/g, ' ').trim()).toBe('Settings Chats3');
  const marked = await captureOnPage(page, { attribute: 'data-pf', anchors: ['home'], dynamicText: ['.badge'] });
  expect(marked.elements.home.text.replace(/\s+/g, ' ').trim()).toBe('Settings Chats');
});
