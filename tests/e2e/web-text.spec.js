import { test, expect } from '@playwright/test';
import { captureOnPage } from '../../src/drivers/web.js';
import { compareStructure } from '../../src/tiers.js';

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

test('a dynamic anchor is left out where it is, so static text with the same words stays in its container', async ({ page }) => {
  // The title bar is dynamic and reads exactly like the sidebar heading in the application, not in the prototype.
  const screen = { anchors: [
    { id: 'settings', role: 'screen', parent: null },
    { id: 'settings.titlebar', role: 'element', parent: 'settings', dynamic: true },
    { id: 'settings.nav', role: 'region', parent: 'settings' }
  ] };
  const page_ = titlebar => `<main data-pf="settings" data-pf-role="screen"><header data-pf="settings.titlebar">${titlebar}</header>
    <aside><h2>設定</h2><nav data-pf="settings.nav"><a>外觀與語言</a> <a>通知</a></nav></aside></main>`;
  const options = { attribute: 'data-pf', anchors: screen.anchors.map(anchor => anchor.id), dynamicAnchors: ['settings.titlebar'] };
  await page.setContent(page_('設定 · 外觀與語言'));
  const prototype = await captureOnPage(page, options);
  await page.setContent(page_('設定'));
  const application = await captureOnPage(page, options);
  expect(application.elements.settings.text.replace(/\s+/g, ' ').trim()).toBe('設定 外觀與語言 通知');
  expect(application.elements['settings.titlebar'].text).toBe('設定');
  expect(await page.locator('header').evaluate(node => node.style.display)).toBe('');
  const state = { expect: { visible: [], hidden: [] } };
  expect(compareStructure(screen, state, prototype, application)).toMatchObject({ status: 'PASS', reasons: [] });
  // Without the anchors the comparison removes the title bar's words by value, and takes the sidebar heading too.
  const plain = { ...options, dynamicAnchors: [] };
  const plainPrototype = await page.setContent(page_('設定 · 外觀與語言')).then(() => captureOnPage(page, plain));
  const plainApplication = await page.setContent(page_('設定')).then(() => captureOnPage(page, plain));
  expect(compareStructure(screen, state, plainPrototype, plainApplication).status).toBe('FAIL');
});
