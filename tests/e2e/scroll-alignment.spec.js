import { test, expect } from '@playwright/test';
import { captureOnPage } from '../../src/drivers/web.js';
const html = ({ nested = false, disabled = false, short = false, block = false, farFromEnd = false } = {}) => `<!doctype html><style>body{margin:0}#scroller{height:280px;width:300px;overflow-y:${disabled ? 'hidden' : 'auto'};border:0}#content{height:${short ? 180 : 1100}px;position:relative}button{position:absolute;top:${short ? 80 : farFromEnd ? 700 : 900}px;left:20px;width:120px;height:40px}#inner{height:240px;overflow:auto;margin-top:300px}#inner>div{height:900px;position:relative}#modal{position:fixed;inset:40px;background:white}</style><main data-pf="demo"><div id="scroller"><div id="content">${nested ? '<div id="inner"><div>' : ''}<button data-pf="demo.export" onclick="document.body.insertAdjacentHTML('beforeend','<aside id=modal role=dialog>Export</aside>')">Export</button>${nested ? '</div></div>' : ''}</div></div></main>${block ? '<script>document.querySelector("#scroller").scrollTo=()=>{};</script>' : ''}`;
const options = steps => ({ attribute: 'data-pf', anchors: ['demo', 'demo.export'], steps });
const end = { action: 'scroll-to', anchor: 'demo.export', value: 'end' };
const measured = page => page.locator('#scroller').evaluate(el => ({ top: el.scrollTop, max: Math.max(0, el.scrollHeight - el.clientHeight) }));
for (const short of [false, true]) test(`end reaches and verifies actual DOM end (${short ? 'short' : 'long'})`, async ({ page }) => {
 await page.setContent(html({ short })); await captureOnPage(page, options([end]));
 const result = await measured(page); expect(result.top).toBeCloseTo(result.max, 5);
});
test('end survives a subsequent public click and modal', async ({ page }) => {
 await page.setContent(html()); await captureOnPage(page, options([end, { action: 'tap', anchor: 'demo.export' }]));
 await expect(page.getByRole('dialog')).toBeVisible(); const result = await measured(page); expect(result.top).toBeCloseTo(result.max, 5);
});
for (const [name, input, reason] of [
 ['nested', { nested: true }, /nested scroll/], ['disabled', { disabled: true }, /unique vertical scroll/], ['intercepted', { block: true }, /not at scroll end/]
]) test(`${name} cannot produce false end success`, async ({ page }) => {
 await page.setContent(html(input)); await expect(captureOnPage(page, options([end]))).rejects.toThrow(reason);
});
test('unknown scroll values fail closed', async ({ page }) => {
 await page.setContent(html()); await expect(captureOnPage(page, options([{ ...end, value: 'middle' }]))).rejects.toThrow(/unsupported scroll-to value/);
});
test('legacy scroll-to keeps visibility semantics', async ({ page }) => {
 await page.setContent(html()); await captureOnPage(page, options([{ action: 'scroll-to', anchor: 'demo.export' }]));
 await expect(page.getByRole('button', { name: 'Export' })).toBeInViewport(); const result = await measured(page); expect(result.top).toBeLessThan(result.max);
});

test('a later click that legitimately reverses the end scroll is rejected', async ({ page }) => {
 await page.setContent(html());
 await page.locator('#content').evaluate(el => { const top = document.createElement('button'); top.setAttribute('data-pf', 'demo.top'); top.textContent = 'Top'; top.style.top = '50px'; top.onclick = () => document.body.insertAdjacentHTML('beforeend', '<aside id=modal role=dialog>Export</aside>'); el.append(top); });
 await expect(captureOnPage(page, options([end, { action: 'tap', anchor: 'demo.top' }]))).rejects.toThrow(/not at scroll end/);
 await expect(page.getByRole('dialog')).toBeVisible();
});

test('hidden target cannot establish a rendered end precondition', async ({ page }) => {
 await page.setContent(html()); await page.getByRole('button', { name: 'Export' }).evaluate(el => el.style.visibility = 'hidden');
 await expect(captureOnPage(page, options([end]))).rejects.toThrow(/target is not rendered/);
});
