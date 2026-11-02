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

test('diag', async ({ page }) => {
  const report = {};
  await page.setContent(markup);
  const a = await shot(page); const a2 = await shot(page);
  const result = await captureOnPage(page, { attribute: 'data-pf', anchors: ['screen', 'bar', 'action', 'label'] });
  const c = await shot(page);
  Object.assign(report, { a_a2: diff(a, a2), a_capture: diff(a, result.screenshot), capture_after: diff(result.screenshot, c), a_after: diff(a, c) });
  await page.setContent(markup);
  const f0 = await shot(page);
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' });
  report.freezeOnly = diff(f0, await shot(page));
  await page.setContent(markup);
  const m0 = await shot(page);
  await page.evaluate(() => { const s = new CSSStyleSheet(); s.replaceSync('[data-pf=label],[data-pf=label] *{visibility:hidden!important}'); const saved = [...document.adoptedStyleSheets]; document.adoptedStyleSheets = [...saved, s]; void document.body.innerText; document.adoptedStyleSheets = saved; });
  report.maskOnly = diff(m0, await shot(page));
  await page.setContent(markup);
  const r0 = await shot(page);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.rafOnly = diff(r0, await shot(page));
  throw new Error(`CLIPDIAG ${process.platform} ${JSON.stringify(report)}`);
});
