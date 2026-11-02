import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureOnPage } from '../src/drivers/web.js';

// Guards execute in a real browser because CSS applicability and computed values are browser facts.
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
for (const scenario of [
  { name: 'zero width absolute rectangle', position: 'absolute', clip: 'rect(0px,0px,10px,0px)', text: '' },
  { name: 'zero height fixed rectangle', position: 'fixed', clip: 'rect(2px,20px,2px,0px)', text: '' },
  { name: 'reversed rectangle', position: 'absolute', clip: 'rect(0px,-1px,10px,0px)', text: '' },
  { name: 'positive area', position: 'absolute', clip: 'rect(0px,1px,1px,0px)', text: 'Observed label' },
  { name: 'auto edge remains unsupported', position: 'absolute', clip: 'rect(auto,0px,0px,0px)', text: 'Observed label' },
  { name: 'static clip has no effect', position: 'static', clip: 'rect(0px,0px,0px,0px)', text: 'Observed label' },
  { name: 'invalid clip declaration remains unchanged', position: 'absolute', clip: 'rect(NaN,0px,0px,0px)', text: 'Observed label' },
  { name: 'clip-path stays outside this change', position: 'absolute', clip: 'auto', extra: 'clip-path:inset(50%)', text: 'Observed label' },
  { name: 'unavailable CSSOM keeps original observation', position: 'absolute', clip: 'rect(0px,0px,0px,0px)', noCSSOM: true, text: 'Observed label' },
]) test(scenario.name, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<main data-pf="root"><button data-pf="action" aria-label="Accessible operation"><span style="position:${scenario.position};clip:${scenario.clip};${scenario.extra ?? ''}">Observed label</span></button></main>`);
    if (scenario.noCSSOM) await page.evaluate(() => { window.CSSStyleSheet = undefined; });
    const { elements } = await captureOnPage(page, { attribute: 'data-pf', anchors: ['root', 'action'] });
    // `text` stays innerText, the accessibility-only text included; `visibleText` leaves it out where it differs.
    assert.equal(elements.action.text, 'Observed label');
    assert.equal(elements.root.text, 'Observed label');
    assert.equal(elements.action.visibleText ?? elements.action.text, scenario.text);
    assert.equal(elements.root.visibleText ?? elements.root.text, scenario.text);
    assert.equal(elements.action.enabled, true);
    assert.equal(elements.action.interactive, true);
    assert.equal(elements.action.count, 1);
    assert.equal(await page.locator('button').getAttribute('aria-label'), 'Accessible operation');
  } finally { await page.close(); }
});
