import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { versionQueue, assertCurrentVersion } from '../src/queue.js';
import { loadProgress, saveProgress, streamTargets, runnerStatePath, deliveryBranch } from '../src/streams.js';
import { saveSourceState } from '../src/source.js';
import { applicationFingerprint } from '../src/workflow.js';
import { hash, writeJson } from '../src/util.js';

const target = (id, root) => ({ id, platform: 'web', root, driver: { kind: 'playwright-web', urlTemplate: `${root}/{page}.html` } });
const multi = { schemaVersion: 2, prototypeDir: 'prototype', targets: [target('web', 'web'), target('ios', 'ios')], release: { requireTargets: ['web', 'ios'] }, runner: { delivery: { branch: 'protoflow/delivery', baseBranch: 'main' } } };
const single = { schemaVersion: 2, prototypeDir: 'prototype', targets: [target('web', 'web')], runner: { delivery: { branch: 'protoflow/delivery', baseBranch: 'main' } } };

async function project(t, manifests) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-streams-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [index, id] of manifests.entries()) await writeJson(path.join(root, `.protoflow/manifests/${id}.json`), { id, createdAt: `2026-10-08T00:00:0${index}Z`, summary: id, afterHash: `after-${id}`, mappings: [] });
  return root;
}
async function accept(root, id, targetId) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, `.protoflow/manifests/${id}.json`), 'utf8'));
  await writeJson(path.join(root, `.protoflow/verifications/VER-${id}-${targetId ?? 'legacy'}.json`), { id: `VER-${id}-${targetId ?? 'legacy'}`, createdAt: '2026-10-08T01:00:00Z', manifestId: id, manifestHash: hash(manifest), prototypeHash: manifest.afterHash, status: 'PASS', ...(targetId && { target: targetId }) });
}

test('each target has its own cursor; release follows the slowest required target', async t => {
  const root = await project(t, ['v1', 'v2', 'v3']);
  await accept(root, 'v1', 'web'); await accept(root, 'v2', 'web');
  await accept(root, 'v1', 'ios');
  const queue = await versionQueue(root, multi);
  assert.deepEqual(queue.versions.map(version => version.acceptance), ['accepted', 'partial', 'pending']);
  assert.deepEqual(queue.targets.web, { status: 'PENDING', current: 'v3', waiting: [], lastAccepted: 'v2' });
  assert.deepEqual(queue.targets.ios, { status: 'PENDING', current: 'v2', waiting: ['v3'], lastAccepted: 'v1' });
  assert.equal(queue.current.id, 'v2', 'top level: first version not yet accepted by every target');
  assert.deepEqual(queue.release, { requireTargets: ['web', 'ios'], version: 'v1', summary: 'v1' });
  assert.equal((await versionQueue(root, multi, { target: 'web' })).current.id, 'v3');
  // Order is enforced per target.
  await assertCurrentVersion(root, multi, 'v2', { target: 'ios' });
  await assert.rejects(assertCurrentVersion(root, multi, 'v3', { target: 'ios' }), /目前版本是 v2/);
  await assert.rejects(assertCurrentVersion(root, multi, 'v2'), /several targets .*pass --target/);
});

test('verifications from before targets existed count for the first target only', async t => {
  const root = await project(t, ['v1']);
  await accept(root, 'v1', undefined);
  const queue = await versionQueue(root, multi);
  assert.deepEqual(queue.versions[0].targets, { web: 'VER-v1-legacy', ios: null });
  assert.equal((await versionQueue(root, single)).current, null);
});

test('target progress follows the shared source; single-target projects keep the source state', async t => {
  const root = await project(t, []);
  await saveSourceState(root, { schemaVersion: 1, status: 'READY', entries: [{ sha: 'a'.repeat(40), manifestId: 'git-a', prototypeHash: 'h', ordinal: 1, status: 'PASS', attempts: [] }] });
  const web = await loadProgress(root, multi, 'web');
  assert.equal(web.entries[0].status, 'PENDING', 'a target starts every version as pending');
  web.entries[0].status = 'PASS';
  await saveProgress(root, multi, 'web', web);
  assert.equal((await loadProgress(root, multi, 'web')).entries[0].status, 'PASS');
  assert.equal((await loadProgress(root, multi, 'ios')).entries[0].status, 'PENDING');
  assert.equal((await loadProgress(root, single, null)).entries[0].status, 'PASS');
  await assert.rejects(loadProgress(root, multi, null), /pass --target/);
  assert.deepEqual(streamTargets(multi), ['web', 'ios']);
  assert.deepEqual(streamTargets(single), [null]);
  assert.equal(runnerStatePath(multi, 'ios'), '.protoflow/runner/ios/state.json');
  assert.equal(runnerStatePath(single, null), '.protoflow/runner/state.json');
  assert.equal(deliveryBranch(multi, 'ios'), 'protoflow/delivery/ios');
  assert.equal(deliveryBranch(single, null), 'protoflow/delivery');
});

test('a target’s application hash ignores the other targets’ roots but not shared files', async t => {
  const root = await project(t, []);
  for (const file of ['web/index.html', 'ios/App.swift', 'shared.json']) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), 'x'); }
  const before = { web: (await applicationFingerprint(root, multi, 'web')).hash, ios: (await applicationFingerprint(root, multi, 'ios')).hash };
  await fs.writeFile(path.join(root, 'ios/App.swift'), 'changed');
  assert.equal((await applicationFingerprint(root, multi, 'web')).hash, before.web);
  assert.notEqual((await applicationFingerprint(root, multi, 'ios')).hash, before.ios);
  await fs.writeFile(path.join(root, 'shared.json'), 'changed');
  assert.notEqual((await applicationFingerprint(root, multi, 'web')).hash, before.web);
});
