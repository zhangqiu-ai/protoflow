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
