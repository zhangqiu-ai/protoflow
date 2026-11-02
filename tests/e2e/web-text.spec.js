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

test('inline-block boxes drawn apart read as separate words without changing the page', async ({ page }) => {
  // A list number in its own inline-block box and two adjacent buttons: innerText alone reads "1.Write" and
  // "Check request statusGenerate again".
  await page.setContent(`<main data-pf="thread" data-pf-role="screen"><section data-pf="thread.message"><p>Start small.</p><ol role="list" style="list-style:none"><li><span style="display:inline-block;width:20px;margin-left:-20px;padding-right:4px;text-align:right">1. </span>Write down one thing.</li><li><span style="display:inline-block;width:20px;margin-left:-20px;padding-right:4px;text-align:right">2. </span>Pick one action.</li></ol></section>
    <section data-pf="thread.failure"><p>Check status first.</p><button data-pf="thread.check">Check request status</button><button>Generate again</button></section>
    <span data-pf="thread.stack" style="display:inline-flex"><span style="display:inline-flex;width:18px">X</span><span style="display:inline-flex;width:18px">L</span></span>
    <p data-pf="thread.inline">Plain <b>bold</b><i>italic</i> and <span style="display:inline-flex">flex</span>box</p>
    <span data-pf="thread.sr" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)">Back</span></main>`);
  const before = await page.evaluate(() => ({ html: document.body.outerHTML, sheets: document.adoptedStyleSheets.length, bounds: [...document.querySelectorAll('button, li > span')].map(node => node.getBoundingClientRect().toJSON()) }));
  const { elements } = await captureOnPage(page, { attribute: 'data-pf', anchors: ['thread', 'thread.message', 'thread.failure', 'thread.check', 'thread.stack', 'thread.inline'] });
  const words = text => text.replace(/\s+/g, ' ').trim();
  expect(words(elements['thread.message'].text)).toBe('Start small. 1. Write down one thing. 2. Pick one action.');
  expect(words(elements['thread.failure'].text)).toBe('Check status first. Check request status Generate again');
  expect(elements['thread.check'].text).toBe('Check request status');
  // An inline-flex stack keeps its items apart as flex items, as innerText already reads them.
  expect(words(elements['thread.stack'].text)).toBe('X L');
  // Ordinary inline elements still join as drawn; only the inline-flex box is separated.
  expect(words(elements['thread.inline'].text)).toBe('Plain bolditalic and flex box');
  // visibleText leaves out the clipped label and separates the same boxes.
  expect(words(elements.thread.visibleText)).toBe(words(elements.thread.text).replace(/ ?Back$/, ''));
  expect(words(elements.thread.visibleText)).toContain('Check request status Generate again');
  // Facts other than text are read as the page lays out, and nothing is left behind.
  expect(elements['thread.check'].bounds).toEqual((({ x, y, width, height }) => ({ x, y, width, height }))(before.bounds[2]));
  expect(await page.evaluate(() => ({ html: document.body.outerHTML, sheets: document.adoptedStyleSheets.length, bounds: [...document.querySelectorAll('button, li > span')].map(node => node.getBoundingClientRect().toJSON()) })))
    .toEqual(before);
});
