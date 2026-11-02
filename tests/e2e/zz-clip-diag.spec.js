import { test } from '@playwright/test';
import { PNG } from 'pngjs';
import { captureOnPage } from '../../src/drivers/web.js';

// Temporary Linux diagnosis for the CSSOM mask pixel assertion; removed before merge.
const markup = `<body style="background:white"><main data-pf="screen"><header data-pf="bar"><button data-pf="action"><svg width="20" height="20"></svg><span data-pf="label" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px)">New chat<b style="visibility:visible">Still clipped</b></span></button><span>New chat</span></header><p>Visible body</p></main></body>`;
const diff = (a, b) => {
  const x = PNG.sync.read(a), y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return { size: [x.width, x.height, y.width, y.height] };
  let count = 0, box = null; const samples = [];
  for (let i = 0; i < x.data.length; i += 4) {
    if (x.data[i] === y.data[i] && x.data[i + 1] === y.data[i + 1] && x.data[i + 2] === y.data[i + 2] && x.data[i + 3] === y.data[i + 3]) continue;
    const p = i / 4, px = p % x.width, py = Math.floor(p / x.width); count++;
    box = box ? [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)] : [px, py, px, py];
    if (samples.length < 4) samples.push([px, py, [...x.data.slice(i, i + 4)], [...y.data.slice(i, i + 4)]]);
  }
  return { bytesEqual: a.equals(b), count, box, samples };
};
const shot = page => page.screenshot({ animations: 'disabled' });

const setup = async (page, { sheet, observer }) => {
  await page.setContent(markup);
  await page.evaluate(({ sheet, observer }) => {
    if (sheet) { const s = new CSSStyleSheet(); s.replaceSync('p{color:rgb(12,34,56)}'); document.adoptedStyleSheets = [s]; }
    if (observer) { window.o = new MutationObserver(() => {}); window.o.observe(document.querySelector('main'), { subtree: true, attributes: true, childList: true, characterData: true }); }
  }, { sheet, observer });
};
const options = { attribute: 'data-pf', anchors: ['screen', 'bar', 'action', 'label'] };

test('diag', async ({ page }) => {
  const report = {};
  for (const [name, sheet, observer, aria] of [['full', true, true, true], ['noSheet', false, true, true], ['noObserver', true, false, true], ['noAria', true, true, false], ['sheetOnly', true, false, false]]) {
    await setup(page, { sheet, observer });
    if (aria) await page.locator('[data-pf="action"]').ariaSnapshot();
    const a = await shot(page); const a2 = await shot(page);
    const result = await captureOnPage(page, options);
    const c = await shot(page);
    report[name] = { a_a2: diff(a, a2), a_capture: diff(a, result.screenshot), a_after: diff(a, c), capture_after: diff(result.screenshot, c) };
  }
  await setup(page, { sheet: true, observer: false });
  const s0 = await shot(page);
  await page.evaluate(() => { const saved = [...document.adoptedStyleSheets]; const m = new CSSStyleSheet(); m.replaceSync('[data-pf=label],[data-pf=label] *{visibility:hidden!important}'); document.adoptedStyleSheets = [...saved, m]; void document.body.innerText; document.adoptedStyleSheets = saved; });
  report.sheetMaskOnly = diff(s0, await shot(page));
  await setup(page, { sheet: true, observer: false });
  const t0 = await shot(page);
  await page.evaluate(() => { document.adoptedStyleSheets = [...document.adoptedStyleSheets]; });
  report.sheetReassignOnly = diff(t0, await shot(page));
  throw new Error(`CLIPDIAG2 ${process.platform} ${JSON.stringify(report)}`);
});
