// Dashboard acceptance in a real browser (proposal 0004). FAKE project state; actions are recorded, not executed.
import { test, expect } from '@playwright/test';
import { dashboardFixture } from '../helpers/dashboard-fixture.js';
import { addProject, projectId } from '../../src/dashboard-data.js';
import { createDashboardServer } from '../../src/dashboard-server.js';

let fixture, dashboard, url, id;
const calls = [];
test.beforeAll(async () => {
  fixture = await dashboardFixture();
  await addProject(fixture.root, { home: fixture.home });
  id = await projectId(fixture.root);
  dashboard = createDashboardServer({ home: fixture.home, port: 0, service: false, pollMs: 200, actions: async (root, body) => { calls.push(body); return { status: 'PASS', next: 'FAKE FIXTURE action recorded' }; } });
  url = await dashboard.listen();
});
test.afterAll(async () => { await dashboard?.close(); await fixture?.cleanup(); });

test('the overview lists every registered project with its stage and what needs a person', async ({ page }) => {
  await page.goto(url);
  const card = page.getByRole('link', { name: /Fixture App/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('實作');
  await expect(card.locator('.due')).toHaveText('待你2');
  // Ring gauges summarise every project; the hero says how many decisions wait.
  await expect(page.getByRole('img', { name: '等你 2' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('2 件等你決定');
  // Agents behind the project: the planner, then the executors by area.
  await expect(card.locator('.agent')).toHaveText(['O', 'S', 'C']);
  await expect(page.locator('#conn')).toHaveText('即時');
});

test('a project shows the live executor, the decisions waiting for a person and the verification evidence', async ({ page }) => {
  await page.goto(`${url}#/p/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fixture App');
  await expect(page.locator('.role[title="Claude · claude-sonnet-5-5"]')).toHaveText('S前端');
  await expect(page.locator('.role[title="Codex · gpt-codex"]')).toHaveText('C後端');
  // Pipeline: done stages are checked, the current one is marked.
  await expect(page.locator('.track li.done')).toHaveText(['規劃']);
  await expect(page.locator('.track li.now')).toHaveText('實作');
  // Console: the executor and what it did, from its trace, with a live cursor.
  await expect(page.locator('.console .who')).toContainText('claude-sonnet-5-5');
  await expect(page.locator('.acts')).toContainText('Run unit tests: npm test');
  await expect(page.locator('.acts')).toContainText('app/settings.js');
  await expect(page.locator('.acts .cursor')).toHaveCount(1);
  // Decisions.
  await expect(page.getByRole('button', { name: '核准並合併' })).toBeVisible();
  await expect(page.getByRole('button', { name: '交回 AI' })).toBeVisible();
  await expect(page.getByText('Should Saved hide on any change?')).toBeVisible();
  // Evidence: the pass ring, the scene with its tier dots and both screenshots in device frames.
  await expect(page.getByRole('img', { name: '通過 0 / 1' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'settings.initial' }).getByRole('img', { name: /結構 通過，配色 未過，版面 通過/ })).toBeVisible();
  const images = page.locator('.scene .device img');
  await expect(images).toHaveCount(2);
  // Screenshots load lazily, as they come into view.
  for (const image of await images.all()) { await image.scrollIntoViewIfNeeded(); await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth)).toBeGreaterThan(0); }
});

test('approving from the dashboard asks for confirmation and sends the bound action with the page token', async ({ page }) => {
  await page.goto(`${url}#/p/${id}`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '核准並合併' }).click();
  await expect(page.locator('#toast')).toContainText('核准並合併：完成');
  expect(calls.at(-1)).toEqual({ action: 'merge', target: null, deliveryId: 'DLV-fixture-1' });
  // The card turns into the signed state instead of offering the button again.
  await expect(page.locator('.ask.done .signed')).toContainText('已核准 · 合併中');
  await expect(page.getByRole('button', { name: '核准並合併' })).toHaveCount(0);
  // Dismissing the confirmation sends nothing.
  const before = calls.length;
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '交回 AI' }).click();
  await page.waitForTimeout(300);
  expect(calls.length).toBe(before);
});

test('motion is switched off when the system asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${url}#/p/${id}`);
  await expect(page.locator('.track li.now .node')).toBeVisible();
  expect(await page.locator('.track li.now .node').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
});

test('the layout fits a phone width without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of ['', `#/p/${id}`]) {
    await page.goto(`${url}${hash}`);
    await expect(page.locator('#conn')).toHaveText('即時');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});
