import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { checkpoint, startSession } from '../src/sessions.js';
import { versionQueue } from '../src/queue.js';
import { loadVersion } from '../src/versions.js';
import { createContext, prepareIntegration, verify, createReview } from '../src/workflow.js';
import { fingerprint, hash, writeJson, projectPath } from '../src/util.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/protoflow.js', import.meta.url));
const config = {
  schemaVersion: 1, prototypeDir: 'prototype', policy: { requireHumanReview: true },
  mappings: [{ id: 'button', prototypeFiles: ['prototype/**'], prototype: '#button', application: '#button', component: 'src/button.js' }],
};
const markup = label => `<button id="button">${label}</button>`;
const page = root => path.join(root, 'prototype/index.html');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(page(root), markup('Save'));
  await fs.writeFile(path.join(root, 'src/button.js'), 'export const label = "Save";');
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  return root;
}

/** Designers keep editing: three prototype versions are checkpointed without waiting for the application. */
async function threeVersions(root) {
  const versions = [await checkpoint(root, config, { summary: 'v1' })];
  for (const label of ['Publish', 'Send']) {
    await fs.writeFile(page(root), markup(label));
    versions.push(await checkpoint(root, config, { summary: `v${versions.length + 1}` }));
  }
  return versions;
}

// Synthetic unit fixture for queue logic only; real browser acceptance is covered by the Playwright E2E suite.
async function accept(root, manifest) {
  const record = { schemaVersion: 1, id: `VER-SYNTHETIC-${manifest.id}`, createdAt: new Date().toISOString(), fixture: 'synthetic-queue-unit',
    manifestId: manifest.id, manifestHash: hash(manifest), prototypeHash: manifest.afterHash, project: await fingerprint(root, { exclude: ['prototype'] }), status: 'PASS',
    build: { status: 'PASS' }, functional: { status: 'PASS' }, visual: { status: 'PASS', artifacts: [] }, artifactHashes: {} };
  await writeJson(await projectPath(root, `.protoflow/verifications/${record.id}.json`), record);
  return record;
}

test('prototype versions queue freely while the application works strictly in order', async t => {
  const root = await fixture(t);
  const [v1, v2, v3] = await threeVersions(root);
  assert.equal(v2.beforeHash, v1.afterHash);
  assert.equal(v3.beforeHash, v2.afterHash);
  let queue = await versionQueue(root, config);
  assert.equal(queue.status, 'PENDING');
  assert.equal(queue.current.id, v1.id);
  assert.deepEqual(queue.waiting, [v2.id, v3.id]);

  for (const later of [v2, v3]) {
    await assert.rejects(createContext(root, config, later.id), error => error.code === 'VERSION_ORDER' && error.queue.current.id === v1.id);
    await assert.rejects(verify(root, config, later.id), /依原型版本順序推進/);
    await assert.rejects(prepareIntegration(root, config, later.id, 'specKit'), /不能跨版本工作/);
  }

  // The live prototype is at v3, yet v1 work receives exactly v1's frozen content and diff.
  const context = await createContext(root, config, v1.id);
  assert.equal(context.prototypeVersion.manifestId, v1.id);
  assert.equal(await fs.readFile(path.join(root, context.prototypeVersion.prototypeDir, 'index.html'), 'utf8'), markup('Save'));
  assert.match(context.instructions, new RegExp(`${context.prototypeVersion.prototypeDir}/`));
  const notRun = await verify(root, config, v1.id);
  assert.equal(notRun.status, 'NOT_RUN');
  assert.equal(notRun.prototypeVersion.manifestId, v1.id);
  assert.equal((await versionQueue(root, config)).current.id, v1.id);

  const accepted = await accept(root, v1);
  queue = await versionQueue(root, config);
  assert.equal(queue.current.id, v2.id);
  assert.equal(queue.lastAccepted.acceptedBy, accepted.id);
  await assert.rejects(createContext(root, config, v1.id), /已由 .* 驗收/);
  assert.equal((await createReview(root, config, v1.id, accepted.id)).status, 'pending');
  await assert.rejects(createContext(root, config, v3.id), /目前版本是/);
  const v2Context = await createContext(root, config, v2.id);
  assert.match(v2Context.manifest.changes[0].diff, /-<button id="button">Save/);
  assert.match(v2Context.manifest.changes[0].diff, /\+<button id="button">Publish/);

  await accept(root, v2);
  await accept(root, v3);
  queue = await versionQueue(root, config);
  assert.equal(queue.status, 'IDLE');
  assert.equal(queue.current, null);
});

test('frozen versions keep binary assets and detect tampering', async t => {
  const root = await fixture(t);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  await fs.writeFile(path.join(root, 'prototype/logo.png'), image);
  const v1 = await checkpoint(root, config);
  await fs.writeFile(path.join(root, 'prototype/logo.png'), Buffer.from([1, 2, 3]));
  await checkpoint(root, config);
  const version = await loadVersion(root, config, v1);
  assert.deepEqual(await fs.readFile(path.join(root, version.prototypeDir, 'logo.png')), image);
  await fs.writeFile(path.join(root, version.prototypeDir, 'logo.png'), 'tampered');
  await assert.rejects(loadVersion(root, config, v1), /version store changed/);
  await assert.rejects(createContext(root, config, v1.id), /version store changed/);
});

test('legacy manifests without a version store are frozen only while the live prototype still matches', async t => {
  const root = await fixture(t);
  const session = await startSession(root, config);
  await fs.writeFile(page(root), markup('Publish'));
  const manifest = await checkpoint(root, config, { sessionId: session.id });
  await fs.rm(path.join(root, '.protoflow/versions'), { recursive: true });
  assert.equal((await loadVersion(root, config, manifest)).hash, manifest.afterHash);
  await fs.rm(path.join(root, '.protoflow/versions'), { recursive: true });
  await fs.writeFile(page(root), markup('Later'));
  await assert.rejects(loadVersion(root, config, manifest), /cannot be reconstructed/);
});

test('policy.sequentialVersions false allows explicit out-of-order work', async t => {
  const root = await fixture(t);
  const [, , v3] = await threeVersions(root);
  const unordered = { ...config, policy: { ...config.policy, sequentialVersions: false } };
  assert.equal((await versionQueue(root, unordered)).sequential, false);
  assert.equal((await createContext(root, unordered, v3.id)).manifestId, v3.id);
});

test('CLI: design checkpoints are not blocked by application work; out-of-order work exits 3', async t => {
  const root = await fixture(t);
  const run = async args => {
    try { return { code: 0, ...(await exec(process.execPath, [cli, ...args, '--project', root])) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const v1 = JSON.parse((await run(['checkpoint', '--summary', 'v1'])).stdout);
  // Simulate a long-running application command holding the application lock.
  await fs.mkdir(path.join(root, '.protoflow/active.lock'));
  await fs.writeFile(page(root), markup('Publish'));
  const second = await run(['checkpoint', '--summary', 'v2']);
  assert.equal(second.code, 0, second.stderr);
  const v2 = JSON.parse(second.stdout);
  assert.match((await run(['verify', '--manifest', v1.id])).stderr, /active\.lock/);
  await fs.rmdir(path.join(root, '.protoflow/active.lock'));

  const queue = JSON.parse((await run(['queue'])).stdout);
  assert.equal(queue.current.id, v1.id);
  assert.deepEqual(queue.waiting, [v2.id]);
  const blocked = await run(['context', '--manifest', v2.id]);
  assert.equal(blocked.code, 3);
  const error = JSON.parse(blocked.stderr);
  assert.equal(error.status, 'BLOCKED');
  assert.equal(error.queue.current.id, v1.id);
  assert.equal(JSON.parse((await run(['status'])).stdout).queue.current.id, v1.id);
  assert.equal((await run(['context', '--manifest', v1.id])).code, 0);
});
