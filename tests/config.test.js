import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/install.js';
import { loadConfig } from '../src/config.js';

async function target(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
}
test('configuration rejects invalid commands, traversal, thresholds, unknown keys and duplicate mapping ids', async t => {
  const root = await target(t);
  const original = await loadConfig(root);
  const mapping = { id: 'card', prototypeFiles: ['prototype/*.html'], prototype: '#card', application: '#card', component: 'app.html' };
  for (const config of [
    { ...original, prototypeDir: '../outside' },
    { ...original, unknown: true },
    { ...original, visual: { maxDiffRatio: 1.01 } },
    { ...original, adapters: { codex: { command: { argv: 'echo hi' } } } },
    { ...original, mappings: [mapping, mapping] },
    { ...original, mappings: [{ ...mapping, component: '../../outside.js' }] }
  ]) {
    await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
    await assert.rejects(loadConfig(root));
  }
});
test('configuration accepts glob classification and per-scene deterministic settings', async t => {
  const root = await target(t);
  const config = await loadConfig(root);
  config.classification.rules = [{ pattern: '**/*.js', level: 'L3' }];
  config.visual.scenes = [{ id: 'test', prototypeUrl: 'prototype/index.html', applicationUrl: 'app.html', viewport: { width: 1000, height: 800 }, timezoneId: 'UTC', timeoutMs: 10000, maxDiffRatio: 0.001, fixture: { data: ['stable'] } }];
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  assert.deepEqual(await loadConfig(root), config);
});

test('configuration publishes the independent review adapter and optional scoped draft delivery', async t => {
  const root = await target(t), config = await loadConfig(root);
  config.runner = { delivery: { branch: 'protoflow/delivery', baseBranch: 'main', paths: ['app/clean-electron', 'package.json'], draft: true, merge: 'manual' } };
  config.adapters.independentReview = { command: { argv: ['node', '/shared/scripts/codex-review-adapter.js'], timeoutMs: 600000 } };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config)); assert.deepEqual(await loadConfig(root), config);
  for (const paths of [[], ['app', 'app']]) { await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify({ ...config, runner: { delivery: { ...config.runner.delivery, paths } } })); await assert.rejects(loadConfig(root)); }
});

test('v1 project acceptance requires an adapter command and does not extend v2 functional commands', async t => {
  const root = await target(t), config = await loadConfig(root);
  config.verification.functional = { adapter: 'acceptance' };
  config.visual.mode = 'adapter';
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  await assert.rejects(loadConfig(root), /acceptance/);
  config.adapters.acceptance = { command: { argv: ['node', 'acceptance.mjs'] }, options: { fixture: true } };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  assert.deepEqual(await loadConfig(root), config);
  const v2 = { schemaVersion: 2, prototypeDir: 'prototype', targets: [{ id: 'web', platform: 'web', driver: { kind: 'playwright-web', urlTemplate: 'app/{page}.html' }, functional: { argv: ['node', 'test.mjs'] } }] };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(v2));
  assert.deepEqual(await loadConfig(root), v2);
  v2.targets[0].functional = { adapter: 'acceptance' };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(v2));
  await assert.rejects(loadConfig(root));
});

test('adapters.codex.ignoreUserConfig is an optional boolean in both config schemas', async t => {
  const root = await target(t), config = await loadConfig(root);
  config.adapters.codex = { command: { argv: ['node', '/shared/scripts/codex-adapter.js'] }, ignoreUserConfig: true };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config)); assert.deepEqual(await loadConfig(root), config);
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify({ ...config, adapters: { ...config.adapters, codex: { ...config.adapters.codex, ignoreUserConfig: 'yes' } } }));
  await assert.rejects(loadConfig(root));
  // The independent reviewer always isolates itself; the option is not accepted there.
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify({ ...config, adapters: { ...config.adapters, independentReview: { command: null, ignoreUserConfig: true } } }));
  await assert.rejects(loadConfig(root));
  const v2 = { schemaVersion: 2, prototypeDir: 'prototype', targets: [{ id: 'web', platform: 'web', driver: { kind: 'playwright-web', urlTemplate: 'app/{page}.html' } }], adapters: { codex: { command: null, ignoreUserConfig: false } } };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(v2)); assert.deepEqual(await loadConfig(root), v2);
});
