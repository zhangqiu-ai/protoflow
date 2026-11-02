import { test, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { captureOnPage, captureWeb } from '../../src/drivers/web.js';

const options = { attribute: 'data-pf', anchors: ['screen', 'bar', 'action', 'label'] };
const compact = value => value.replace(/\s+/g, ' ').trim();
// `text` keeps innerText (what an accessibility tree reads); `visibleText` leaves clipped accessibility-only text out.
const shown = item => item.visibleText ?? item.text;
const pageMarkup = (clip = 'rect(0px, 0px, 0px, 0px)', position = 'absolute', extra = '') => `<body style="background:white"><main data-pf="screen"><header data-pf="bar"><button data-pf="action"><svg width="20" height="20"></svg><span data-pf="label" style="position:${position};width:1px;height:1px;overflow:hidden;clip:${clip}">New chat${extra}</span></button><span>New chat</span></header><p>Visible body</p></main></body>`;

test('empty computed clip excludes only its real text source and retains the accessible name', async ({ page }) => {
  await page.setContent(pageMarkup());
  const { elements } = await captureOnPage(page, options);
  expect(shown(elements.action)).toBe('');
  expect(shown(elements.label)).toBe('');
  expect(compact(shown(elements.bar))).toBe('New chat');
  expect(compact(shown(elements.screen))).toBe('New chat Visible body');
  expect(elements.action.text).toBe('New chat');
  expect(compact(elements.screen.text)).toBe('New chat New chat Visible body');
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toHaveCount(1);
});

test('CSSOM mask restores application DOM, inline priority, sheets, layout, pixels and ARIA', async ({ page }) => {
  await page.setContent(pageMarkup('rect(0px,0px,0px,0px)', 'absolute', '<b style="visibility:visible">Still clipped</b>'));
  const before = await page.evaluate(() => {
    const sheet = new CSSStyleSheet(); sheet.replaceSync('p{color:rgb(12,34,56)}');
    document.adoptedStyleSheets = [sheet]; window.originalClipSheets = [...document.adoptedStyleSheets];
    window.clipMutationCount = 0; window.clipObserver = new MutationObserver(records => { window.clipMutationCount += records.length; }); window.clipObserver.observe(document.querySelector('main'), { subtree: true, attributes: true, childList: true, characterData: true });
    return { html: document.querySelector('main').outerHTML, bounds: [...document.querySelectorAll('[data-pf]')].map(node => node.getBoundingClientRect().toJSON()), styleCount: document.styleSheets.length };
  });
  const accessibleBefore = await page.locator('[data-pf="action"]').ariaSnapshot();
  const pixels = await page.screenshot({ animations: 'disabled' });
  const result = await captureOnPage(page, options);
  const after = await page.evaluate(() => ({ html: document.querySelector('main').outerHTML,
    bounds: [...document.querySelectorAll('[data-pf]')].map(node => node.getBoundingClientRect().toJSON()),
    restored: document.adoptedStyleSheets.length === window.originalClipSheets.length && document.adoptedStyleSheets.every((sheet, i) => sheet === window.originalClipSheets[i]), mutations: window.clipMutationCount + window.clipObserver.takeRecords().length }));
  expect(after).toEqual({ html: before.html, bounds: before.bounds, restored: true, mutations: 0 });
  expect(result.screenshot.equals(pixels)).toBe(true);
  expect(shown(result.elements.action)).toBe('');
  const { x, y, width, height } = before.bounds[2];
  expect(result.elements.action.bounds).toEqual({ x, y, width, height });
  expect(await page.locator('[data-pf="action"]').ariaSnapshot()).toBe(accessibleBefore);
});

for (const [name, clip, position] of [
  ['positive area', 'rect(0px,1px,1px,0px)', 'absolute'],
  ['partial region', 'rect(0px,100px,12px,0px)', 'absolute'],
  ['static ineffective clip', 'rect(0px,0px,0px,0px)', 'static'],
  ['auto unsupported edge', 'rect(auto,0px,0px,0px)', 'absolute'],
]) test(`${name} keeps the original text`, async ({ page }) => {
  await page.setContent(pageMarkup(clip, position));
  const original = await page.locator('[data-pf="action"]').innerText();
  const { elements } = await captureOnPage(page, options);
  expect(shown(elements.action)).toBe(original);
  expect(elements.action.visibleText).toBeUndefined();
});

test('visibility important that prevents a complete mask keeps the whole original text group', async ({ page }) => {
  await page.setContent(pageMarkup('rect(0px,0px,0px,0px)', 'absolute', '<b style="visibility:visible!important">Override</b>') + '<span data-pf="second" style="position:fixed;clip:rect(0px,0px,0px,0px)">Second name</span>');
  const original = await page.locator('[data-pf="screen"]').innerText();
  const { elements } = await captureOnPage(page, { ...options, anchors: [...options.anchors, 'second'] });
  expect(shown(elements.screen)).toBe(original);
  expect(shown(elements.second)).toBe('Second name');
});

test('fixed descendant really stays unpainted under empty clip, then is omitted from text', async ({ page }) => {
  await page.setContent('<body style="margin:0;background:#fff"><main data-pf="screen"><div style="position:absolute;left:10px;top:10px;width:1px;height:1px;clip:rect(0px,0px,0px,0px)"><span data-pf="label" style="position:fixed;left:200px;top:120px;width:80px;height:40px;background:#00ff00;display:block">Fixed hidden</span></div><p>Visible body</p></main></body>');
  const before = PNG.sync.read(await page.screenshot());
  const at = (150 * before.width + 270) * 4;
  expect([...before.data.subarray(at, at + 4)]).toEqual([255, 255, 255, 255]);
  const { elements } = await captureOnPage(page, { ...options, anchors: ['screen', 'label'] });
  expect(shown(elements.label)).toBe('');
  expect(compact(shown(elements.screen))).toBe('Visible body');
  await page.locator('div').evaluate(node => node.style.clip = 'auto');
  const visible = PNG.sync.read(await page.screenshot());
  expect([...visible.data.subarray(at, at + 4)]).toEqual([0, 255, 0, 255]);
});

test('input values, placeholders, dynamic text and dynamic anchors preserve their existing rules', async ({ page }) => {
  await page.setContent(`<main data-pf="screen"><input data-pf="input" value="Typed value"><textarea data-pf="textarea">Typed note</textarea><input data-pf="empty" placeholder="Helpful hint"><input data-pf="checkbox" type="checkbox"><span data-pf="dynamic" style="display:inline!important">Fixture title</span><i data-pf-text="dynamic" style="display:inline-block">7</i><small data-pf-text="dynamic">8</small><button data-pf="action"><span style="position:absolute;clip:rect(0px,0px,0px,0px)">New chat</span></button><b>Visible body</b></main>`);
  await page.locator('[data-pf="input"]').fill('Edited actual value');
  await page.locator('[data-pf="textarea"]').fill('Edited actual note');
  const before = await page.locator('main').evaluate(node => node.outerHTML);
  // Playwright screenshot animation cleanup itself adds empty style attributes to input controls.
  // Verify the actual collector boundary before screenshot tooling runs, without changing production code.
  await page.evaluate(() => {
    window.inputClipRecords = [];
    window.inputClipObserver = new MutationObserver(records => window.inputClipRecords.push(...records));
    window.inputClipObserver.observe(document.querySelector('main'), { subtree: true, attributes: true, childList: true, characterData: true });
  });
  let collectorBoundary;
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async settings => {
    collectorBoundary = await page.evaluate(() => {
      const records = [...window.inputClipRecords, ...window.inputClipObserver.takeRecords()];
      return { html: document.querySelector('main').outerHTML,
        inputMutations: records.filter(record => record.target.matches?.('input,textarea')).length,
        otherMutations: records.filter(record => !record.target.matches?.('[data-pf="dynamic"],[data-pf-text="dynamic"]')).length,
        dynamicMutations: records.filter(record => record.target.matches?.('[data-pf="dynamic"],[data-pf-text="dynamic"]')).length };
    });
    return screenshot(settings);
  };
  const { elements } = await captureOnPage(page, { ...options, anchors: ['screen', 'action', 'input', 'textarea', 'empty', 'checkbox', 'dynamic'], dynamicAnchors: ['dynamic'] });
  expect(shown(elements.input)).toBe('Edited actual value'); expect(shown(elements.textarea)).toBe('Edited actual note');
  expect(shown(elements.empty)).toBe('Helpful hint'); expect(shown(elements.checkbox)).toBe('');
  expect(shown(elements.dynamic)).toBe('Fixture title'); expect(shown(elements.action)).toBe('');
  expect(shown(elements.screen)).not.toContain('New chat'); expect(shown(elements.screen)).not.toContain('Fixture title'); expect(shown(elements.screen)).not.toContain('7');
  expect(collectorBoundary.html).toBe(before);
  expect(collectorBoundary.inputMutations).toBe(0); expect(collectorBoundary.otherMutations).toBe(0);
  expect(collectorBoundary.dynamicMutations).toBeGreaterThan(0); // Existing dynamic exclusion temporarily changes display.
  expect(await page.locator('[data-pf="input"]').inputValue()).toBe('Edited actual value');
  expect(await page.locator('[data-pf="textarea"]').inputValue()).toBe('Edited actual note');
});


test('style-attribute selectors cannot hide a genuinely visible neighbouring text node', async ({ page }) => {
  await page.setContent('<style>.clipping{position:absolute;clip:rect(0px,0px,0px,0px)}.clipping[style]+span{display:none}</style><main data-pf="screen"><span class="clipping">Clipped name</span><span>Visible peer</span></main>');
  const { elements } = await captureOnPage(page, { ...options, anchors: ['screen'] });
  expect(shown(elements.screen)).toBe('Visible peer');
  expect(await page.locator('.clipping').getAttribute('style')).toBeNull();
});

test('default captureWeb applies the same collector without a prototype flag', async ({ browser }) => {
  const result = await captureWeb(browser, { ...options, url: 'data:text/html,' + encodeURIComponent(pageMarkup()), viewport: { width: 400, height: 250, scale: 1 } });
  expect(shown(result.elements.action)).toBe('');
  expect(compact(shown(result.elements.screen))).toBe('New chat Visible body');
});
