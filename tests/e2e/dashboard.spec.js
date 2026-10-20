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
  await expect(card).toContainText('待你處理 2');
  await expect(page.locator('#conn')).toHaveText('即時');
});

test('a project shows the live executor, the decisions waiting for a person and the verification evidence', async ({ page }) => {
  await page.goto(`${url}#/p/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fixture App');
  await expect(page.getByText('前端 Claude · claude-sonnet-5-5 · 後端 Codex · gpt-codex')).toBeVisible();
  // Live lane: the executor and what it did, from its trace.
  await expect(page.getByText('執行者動作 · 進行中')).toBeVisible();
  await expect(page.locator('.acts')).toContainText('Run unit tests: npm test');
  await expect(page.locator('.acts')).toContainText('app/settings.js');
  // Decisions.
  await expect(page.getByRole('button', { name: '核准並合併' })).toBeVisible();
  await expect(page.getByRole('button', { name: '核准：交回 AI' })).toBeVisible();
  await expect(page.getByText('Should Saved hide on any change?')).toBeVisible();
  // Evidence: matrix row and both screenshots served from the project.
  await expect(page.locator('table').first()).toContainText('settings.initial');
  const images = page.locator('.shot img');
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
  // Dismissing the confirmation sends nothing.
  const before = calls.length;
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '核准：交回 AI' }).click();
  await page.waitForTimeout(300);
  expect(calls.length).toBe(before);
});
