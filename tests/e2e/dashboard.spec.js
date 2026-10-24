// Dashboard acceptance in a real browser (proposal 0004). FAKE project state; actions are recorded, not executed.
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  const card = page.getByRole('main').getByRole('link', { name: /Fixture App/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('實作');
  await expect(card.locator('.due')).toHaveText('待你2');
  // Ring gauges summarise every project; the hero says how many decisions wait.
  await expect(page.getByRole('img', { name: '等你 2' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('2 件等你決定');
  // Agents behind the project: the planner, then the executors by area.
  await expect(card.locator('.card-f .agent')).toHaveText(['O', 'S', 'C']);
  await expect(page.locator('#conn')).toHaveText('即時');
  // A working project shows its live progress on the card: version, phase, a running timer and the executor's latest action.
  await expect(card).toHaveClass(/busy/);
  const strip = card.locator('.strip');
  await expect(strip).toContainText('Settings toggle');
  await expect(strip).toContainText('執行者');
  await expect(strip.locator('.agent.working')).toHaveText('S');
  await expect(strip.locator('.strip-act')).toContainText('Run unit tests: npm test');
  const first = await strip.locator('.timer').textContent();
  await expect.poll(() => strip.locator('.timer').textContent(), { timeout: 3000 }).not.toBe(first);
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

test('a page left open across a service restart picks up the new token instead of failing the action', async ({ page }) => {
  await page.goto(`${url}#/p/${id}`);
  await expect(page.getByRole('button', { name: '核准並合併' })).toBeVisible();
  // Restart on the same port: the new service mints a different token than the one in the open page.
  const port = new URL(url).port, before = dashboard.token;
  await dashboard.close();
  dashboard = createDashboardServer({ home: fixture.home, port: Number(port), service: false, pollMs: 200, actions: async (root, body) => { calls.push(body); return { status: 'PASS' }; } });
  await dashboard.listen();
  expect(dashboard.token).not.toBe(before);
  const sent = calls.length;
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '核准並合併' }).click();
  await expect(page.locator('#toast')).toContainText('核准並合併：完成');
  expect(calls.length).toBe(sent + 1);
  expect(calls.at(-1)).toEqual({ action: 'merge', target: null, deliveryId: 'DLV-fixture-1' });
});

test('the sidebar lists every project on every page, switches between them and folds away', async ({ page }) => {
  const other = await dashboardFixture({ executing: false });
  await addProject(fixture.root, { home: other.home });
  await addProject(other.root, { home: other.home, name: 'Second App' });
  const server = createDashboardServer({ home: other.home, port: 0, service: false, pollMs: 200 });
  const base = await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(base);
    const nav = page.getByRole('navigation', { name: '專案' }), toggle = page.getByRole('button', { name: '專案側邊欄' });
    const first = nav.getByRole('link', { name: /Fixture App/ }), second = nav.getByRole('link', { name: /Second App/ });
    await expect(nav.locator('.nav-item')).toHaveCount(4);
    await expect(nav.getByRole('link', { name: /總覽/ })).toHaveAttribute('aria-current', 'page');
    // Each project: where its busiest target is, a live dot while it works, and how many decisions wait.
    await expect(first).toContainText('實作');
    await expect(first.locator('.nav-dot')).toHaveClass(/now/);
    await expect(first.locator('.nav-due')).toHaveText('2');
    await first.click();
    await expect(page).toHaveURL(new RegExp(`#/p/${id}$`));
    await expect(page.locator('.track li.now')).toHaveText('實作');
    await expect(first).toHaveAttribute('aria-current', 'page');
    // ⌥↓ / ⌥↑ step through the list from anywhere on the page; the highlight follows.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).toHaveURL(new RegExp(`#/p/${await projectId(other.root)}$`));
    await expect(second).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => page.locator('.nav-ind').evaluate(node => node.style.transform)).toBe(`translateY(${await second.evaluate(node => node.offsetTop)}px)`);
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('2 個專案');
    // [ folds the sidebar to tiles, remembered across a reload; a tip names the project under the pointer.
    await page.keyboard.press('[');
    await expect(page.locator('body')).toHaveClass(/side-mini/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/side-mini/);
    await first.hover();
    await expect(page.locator('.nav-tip')).toHaveText('Fixture App · 實作');
    await toggle.click();
    await expect(page.locator('body')).not.toHaveClass(/side-mini/);
    // On a phone the sidebar is a drawer: closed until asked for, and it closes once a page is picked.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(nav).toBeHidden();
    await toggle.click();
    await expect(nav).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await second.click();
    await expect(nav).toBeHidden();
    await expect(page).toHaveURL(/#\/p\//);
  } finally { await server.close(); await other.cleanup(); }
});

test('the inbox gathers what waits across projects, most urgent first, with the fix for a known failure', async ({ page, context }) => {
  const blocked = await dashboardFixture({ blockedError: 'Claude execution FAIL (EXEC-fixture, exit 1): Failed to authenticate: OAuth session expired and could not be refreshed', blockedAt: new Date(Date.now() - 2 * 3600000 - 300000).toISOString() });
  await addProject(blocked.root, { home: blocked.home });
  const sent = [];
  const server = createDashboardServer({ home: blocked.home, port: 0, service: false, pollMs: 200, actions: async (root, body) => { sent.push(body); return { status: 'PASS', next: 'FAKE FIXTURE action recorded' }; } });
  const base = await server.listen();
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    // FAKE notifications: recorded instead of shown; the test decides when the page counts as hidden.
    await page.addInitScript(() => {
      window.__notes = [];
      window.Notification = class { static permission = 'granted'; static requestPermission = async () => 'granted'; constructor(title, options) { this.title = title; this.options = options; window.__notes.push(this); } close() {} };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden === true });
      localStorage.setItem('protoflow.notify', 'on');
    });
    await page.goto(base);
    // The tab says how many decisions wait, in its title and icon.
    await expect(page).toHaveTitle('(3) ProtoFlow 儀表板');
    await expect(page.locator('#favicon')).toHaveAttribute('href', /^data:image\/svg\+xml,.*%3E3%3C/);
    await page.getByRole('main').getByRole('link', { name: '3 件等你決定' }).click();
    await expect(page).toHaveURL(/#\/inbox$/);
    await expect(page.getByRole('navigation', { name: '專案' }).getByRole('link', { name: /等你/ })).toHaveAttribute('aria-current', 'page');
    const group = page.getByRole('region', { name: 'Fixture App' });
    await expect(group.locator('.ask')).toHaveCount(3);
    // Blocked work leads; its card names the expired login, the command to run and the steps before retrying.
    const first = group.locator('.ask').first();
    await expect(first).toContainText('阻塞');
    await expect(first.locator('.diag')).toContainText('Claude 登入失效');
    // It says how long it has waited for a person.
    await expect(first.locator('.waited')).toHaveText(/^等了 2 小時( \d+ 分)?$/);
    await expect(first.locator('.diag ol li code').first()).toHaveText('claude');
    await first.getByRole('button', { name: '複製命令 claude' }).click();
    await expect(page.locator('#toast')).toHaveText('已複製：claude');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('claude');
    page.once('dialog', dialog => { expect(dialog.message()).toContain('Claude 登入失效'); dialog.accept(); });
    await first.getByRole('button', { name: '已處理，重試' }).click();
    await expect(first.locator('.signed')).toContainText('已重新排入');
    expect(sent.at(-1)).toEqual({ action: 'retry', target: null });
    // Notifications: switched on here; a new item while the page is hidden becomes a desktop notification.
    await expect(page.getByRole('button', { name: '桌面通知已開啟' })).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => { window.__hidden = true; });
    const issues = path.join(blocked.root, '.protoflow/issues/state.json');
    const state = JSON.parse(await fs.readFile(issues, 'utf8'));
    state.issues['6'].status = 'needs-human';
    await fs.writeFile(issues, JSON.stringify(state));
    await expect.poll(() => page.evaluate(() => window.__notes.map(note => note.title))).toEqual(['Fixture App · Issue 等你']);
    await expect(page).toHaveTitle('(4) ProtoFlow 儀表板');
    await page.evaluate(() => window.__notes[0].onclick());
    await expect(page).toHaveURL(new RegExp(`#/p/${await projectId(blocked.root)}$`));
    // Switched off, nothing more is sent.
    await page.evaluate(() => { window.__hidden = false; });
    await page.goto(`${base}#/inbox`);
    await page.getByRole('button', { name: '桌面通知已開啟' }).click();
    await expect(page.getByRole('button', { name: '開啟桌面通知' })).toHaveAttribute('aria-pressed', 'false');
  } finally { await server.close(); await blocked.cleanup(); }
});

test('motion is switched off when the system asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${url}#/p/${id}`);
  await expect(page.locator('.track li.now .node')).toBeVisible();
  expect(await page.locator('.track li.now .node').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
});

test('the layout fits a phone width without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of ['', '#/inbox', `#/p/${id}`]) {
    await page.goto(`${url}${hash}`);
    await expect(page.locator('#conn')).toHaveText('即時');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
});

test('a comparison opens full size, side by side or overlaid, and closes with Escape', async ({ page }) => {
  await page.goto(`${url}#/p/${id}`);
  await page.getByRole('button', { name: '放大查看App' }).click();
  const viewer = page.getByRole('dialog', { name: '原型與 App 對照' });
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText('settings.initial');
  await expect(viewer).toContainText('配色 未過');
  await expect(viewer.getByRole('img', { name: '原型截圖' })).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'App截圖' })).toBeVisible();
  await viewer.getByRole('tab', { name: '疊圖' }).click();
  const divider = viewer.getByRole('slider', { name: '原型與 App 分界' });
  await divider.fill('20');
  await expect(viewer.locator('.v-top')).toHaveAttribute('style', /inset\(0(px)? 80% 0(px)? 0(px)?\)/);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
});

test('a delivery the independent review rejected offers to send the version back for repair, with the findings', async ({ page }) => {
  const rejected = await dashboardFixture({ reviewRejected: true, autoApprove: false });
  await addProject(rejected.root, { home: rejected.home });
  const sent = [];
  const server = createDashboardServer({ home: rejected.home, port: 0, service: false, pollMs: 200, actions: async (root, body) => { sent.push(body); return { status: 'PASS', next: 'FAKE FIXTURE action recorded' }; } });
  const base = await server.listen();
  try {
    await page.goto(`${base}#/p/${await projectId(rejected.root)}`);
    const card = page.locator('.ask', { hasText: '審查未過' });
    await expect(card).toContainText('Login screen');
    await expect(card.locator('.findings')).toContainText('the folder icon is only 8px wide');
    await expect(card.locator('.findings code')).toHaveText('settings.js');
    await expect(page.getByRole('button', { name: '核准版本' })).toHaveCount(0);
    page.once('dialog', dialog => dialog.accept());
    await card.getByRole('button', { name: '退回重修' }).click();
    await expect(card.locator('.signed')).toContainText('已退回 · 下一輪重修');
    expect(sent.at(-1)).toEqual({ action: 'request-changes', target: null, deliveryId: 'DLV-fixture-1' });
  } finally { await server.close(); await rejected.cleanup(); }
});
