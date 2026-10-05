import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyVisual } from '../../src/visual.js';

const root = path.resolve('examples/demo');
const mapping = { id: 'card', prototype: '#card', application: '[data-ui=card]', priority: 'critical' };
const scene = (extras = {}) => ({ id: 'demo', prototypeUrl: 'http://127.0.0.1:4318/prototype/', applicationUrl: 'http://127.0.0.1:4318/app/', viewport: { width: 1000, height: 720 }, ...extras });
const verify = (info, scenes, mappings = [mapping], visual = {}) => verifyVisual(root, { mappings, visual: { scenes, maxDiffRatio: 0.01, ...visual } }, info.outputPath('visual'));

test('matching independent prototype and app pass with inspectable artifacts', async ({ page }, info) => {
  await page.goto('/app/');
  await expect(page.getByRole('heading', { name: 'Create a design session' })).toBeVisible();
  const result = await verify(info, [scene()]);
  expect(result.status).toBe('PASS');
  expect(result.scenes[0].mappings[0].status).toBe('PASS');
  expect(result.artifacts).toHaveLength(6);
  await page.goto(`file://${result.artifacts.at(-1)}`);
  await expect(page.getByRole('heading', { name: 'ProtoFlow visual review' })).toBeVisible();
});

test('layout mismatch fails a critical mapping even when viewport threshold is permissive', async ({ page }, info) => {
  await page.goto('/app/?mismatch=1');
  await expect(page.getByRole('button', { name: 'Create session' })).toBeVisible();
  const result = await verify(info, [scene({ applicationUrl: 'http://127.0.0.1:4318/app/?mismatch=1' })], [mapping], { maxDiffRatio: 1 });
  expect(result.status).toBe('FAIL');
  expect(result.scenes[0].mappings[0].reasons.join(' ')).toContain('Geometry width');
});

test('interaction state is exercised and compared through the runner', async ({ page }, info) => {
  await page.goto('/app/');
  await page.getByLabel('Session name').fill('Settings screen');
  await page.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByText('Session created: Settings screen')).toBeVisible();
  const result = await verify(info, [scene({ steps: [{ action: 'fill', prototype: '#name', application: '#session-name', value: 'Settings screen' }, { action: 'click', prototype: '#create', application: '[data-ui=create]' }] })]);
  expect(result.status).toBe('PASS');
});

test('explicit paired masks ignore volatile text while missing masks fail closed', async ({ page }, info) => {
  await page.goto('/app/?clock=1');
  await expect(page.getByText('Application clock: 10:00')).toBeVisible();
  const volatileScene = scene({ prototypeUrl: 'http://127.0.0.1:4318/prototype/?clock=1', applicationUrl: 'http://127.0.0.1:4318/app/?clock=1' });
  const unmasked = await verify(info, [volatileScene], [mapping], { maxDiffRatio: 0 });
  expect(unmasked.status).toBe('FAIL');
  const masked = await verify(info, [{ ...volatileScene, masks: [{ prototype: '#clock', application: '[data-ui=clock]' }] }], [mapping], { maxDiffRatio: 0 });
  expect(masked.status).toBe('PASS');
  const missing = await verify(info, [{ ...volatileScene, masks: [{ prototype: '#missing', application: '[data-ui=clock]' }] }]);
  expect(missing.status).toBe('FAIL');
});

test('missing mapping fails and HTML review escapes untrusted scene names', async ({ page }, info) => {
  await page.goto('/prototype/');
  await expect(page.getByLabel('Session name')).toBeVisible();
  const result = await verify(info, [scene({ id: '<script>alert(1)</script>', mappings: ['absent'] })]);
  expect(result.status).toBe('FAIL');
  expect(result.scenes[0].reasons.join(' ')).toContain('Unknown mapping');
  const report = await readFile(result.artifacts.at(-1), 'utf8');
  expect(report).toContain('&lt;script&gt;');
  expect(report).not.toContain('<script>alert');
  const noMappings = await verify(info, [scene()], []);
  expect(noMappings.status).toBe('FAIL');
  expect(noMappings.scenes[0].reasons.join(' ')).toContain('No component mappings');
});

test('local file URLs can verify the demo without a web adapter', async ({ page }, info) => {
  await page.goto('/app/');
  await expect(page.getByRole('heading')).toHaveText('Create a design session');
  const result = await verify(info, [scene({ prototypeUrl: 'prototype/index.html', applicationUrl: 'app/index.html' })]);
  expect(result.status).toBe('PASS');
  const mismatch = await verify(info, [scene({ prototypeUrl: 'prototype/index.html', applicationUrl: 'app/index.html?mismatch=1' })]);
  expect(mismatch.status).toBe('FAIL');
  expect(mismatch.scenes[0].mappings[0].reasons.join(' ')).toContain('Geometry width');
  const outside = await verify(info, [scene({ applicationUrl: pathToFileURL(path.resolve('tests/visual.test.js')).href })]);
  expect(outside.status).toBe('FAIL');
  expect(outside.scenes[0].reasons.join(' ')).toContain('Path escapes project');
});
