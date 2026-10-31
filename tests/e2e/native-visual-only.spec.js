import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { captureOnPage } from '../../src/drivers/web.js';
import { anchorFacts } from '../../src/drivers/native-tree.js';
import { compareStructure, compareVisual } from '../../src/tiers.js';

const summary = '2 records in the last 7 days';
const screen = { anchors: [
  { id: 'goal', role: 'screen', parent: null },
  { id: 'goal.chart', role: 'region', parent: 'goal' },
  { id: 'goal.chart.caption', role: 'element', parent: 'goal.chart' },
  { id: 'goal.chart.bars', role: 'element', parent: 'goal.chart', visualOnly: true }
] };
const options = { attribute: 'data-pf', anchors: screen.anchors.map(anchor => anchor.id) };
const html = (caption = 'Weekly progress', height = 110) => `<style>
  body { margin: 0; } main { width: 320px; height: 180px; background: white; }
  figure { margin: 0; width: 300px; height: 160px; } figcaption { height: 30px; }
  [role=img] { width: 280px; height: 120px; display: flex; align-items: end; gap: 20px; }
  i { display: block; background: #204fc0; width: 120px; }
  </style><main data-pf="goal"><figure data-pf="goal.chart">
  <figcaption data-pf="goal.chart.caption">${caption}</figcaption>
  <div data-pf="goal.chart.bars" data-pf-visual-only role="img" aria-label="${summary}"><i style="height:${height}px"></i><i style="height:${height}px"></i></div>
  </figure></main>`;
const box = (x, y, width, height) => ({ x, y, width, height });
// Controlled normalized native snapshot: image label is present, but no staticText child renders it.
const native = (caption = 'Weekly progress') => {
  const tree = { type: 'other', identifier: 'goal', frame: box(0, 0, 320, 180), children: [
    { type: 'other', identifier: 'goal.chart', frame: box(0, 0, 300, 160), children: [
      { type: 'staticText', identifier: 'goal.chart.caption', label: caption, frame: box(0, 0, 300, 30) },
      { type: 'image', identifier: 'goal.chart.bars', label: summary, frame: box(0, 30, 280, 120) }
    ] }
  ] };
  return { elements: Object.fromEntries(anchorFacts(tree, { anchors: options.anchors, screen: 'goal', content: tree.frame }).elements.map(item => [item.anchor, item])) };
};

for (const caption of ['Weekly progress', summary]) {
  test(`a visual-only image description leaves parent text while the static caption stays: ${caption}`, async ({ page }) => {
    await page.setContent(html(caption));
    await expect(page.getByRole('img', { name: summary })).toBeVisible();
    const web = await captureOnPage(page, options);
    expect(web.elements['goal.chart.bars'].text).toBe('');
    expect(web.elements['goal.chart'].text.trim()).toBe(caption);
    const app = native(caption);
    expect(app.elements['goal.chart.bars'].text).toBe(summary);
    expect(compareStructure(screen, {}, web, app, { native: true })).toMatchObject({ status: 'PASS', reasons: [] });
    const changed = compareStructure(screen, {}, web, native('Changed caption'), { native: true });
    expect(changed.status).toBe('FAIL');
    expect(changed.reasons.some(reason => reason.startsWith('goal.chart: text'))).toBe(true);
    expect(changed.reasons.some(reason => reason.startsWith('goal.chart.caption: text'))).toBe(true);
  });
}

test('missing captured graphic text does not authorize guessing what to remove from a parent', async ({ page }) => {
  await page.setContent(html());
  const web = await captureOnPage(page, options);
  const app = native();
  delete app.elements['goal.chart.bars'];
  const result = compareStructure(screen, {}, web, app, { native: true });
  expect(result.status).toBe('FAIL');
  expect(result.reasons.some(reason => reason.startsWith('goal.chart: text'))).toBe(true);
});

test('visual-only bars still fail pixel and perceptual comparison when their visible height changes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 180 });
  await page.setContent(html());
  const before = await captureOnPage(page, options);
  await page.setContent(html('Weekly progress', 1));
  const after = await captureOnPage(page, options);
  expect(compareStructure(screen, {}, before, after).status).toBe('PASS');
  for (const mode of ['pixel', 'perceptual']) {
    const result = compareVisual(screen, before, after, { mode });
    expect(result.status).toBe('FAIL');
    expect(result.reasons.some(reason => reason.startsWith('goal.chart.bars:'))).toBe(true);
  }
});


test('the captured React Native chart excludes its visual-only description from T1 parent text', async ({ page }) => {
  const { tree } = JSON.parse(await readFile(new URL('../fixtures/ios/visual-only-chart.raw.json', import.meta.url), 'utf8'));
  const chart = { anchors: [
    { id: 'growth.goal.chart', role: 'screen', parent: null },
    { id: 'growth.goal.chart.bars', role: 'element', parent: 'growth.goal.chart', visualOnly: true },
    { id: 'growth.goal.chart.note', role: 'element', parent: 'growth.goal.chart' }
  ] };
  const note = tree.children.find(node => node.identifier === 'growth.goal.chart.note').label;
  await page.setContent(`<main data-pf="growth.goal.chart"><div data-pf="growth.goal.chart.bars" data-pf-visual-only role="img" aria-label="${summary}" style="width:338px;height:56px"></div><p data-pf="growth.goal.chart.note">${note}</p></main>`);
  const ids = chart.anchors.map(anchor => anchor.id);
  const web = await captureOnPage(page, { attribute: 'data-pf', anchors: ids });
  const app = { elements: Object.fromEntries(anchorFacts(tree, { anchors: ids, screen: 'growth.goal.chart', content: tree.frame }).elements.map(item => [item.anchor, item])) };
  expect(app.elements['growth.goal.chart'].text).toContain(summary);
  expect(compareStructure(chart, {}, web, app, { native: true })).toMatchObject({ status: 'PASS', reasons: [] });
});
