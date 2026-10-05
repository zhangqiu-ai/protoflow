import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checkpoint, startSession } from '../src/sessions.js';
import { createContext, executeContext, createReview, decideReview, createBaseline, loadArtifact } from '../src/workflow.js';
import { fingerprint, projectPath, hash, writeJson, runCommand } from '../src/util.js';

const config = {
  schemaVersion: 1, prototypeDir: 'prototype', policy: { requireHumanReview: true },
  mappings: [{ id: 'button', prototypeFiles: ['prototype/index.html'], prototype: '#button', application: '#button', component: 'src/button.js' }],
};

async function fixture(t, { level } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-audit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'prototype/index.html'), '<button id="button">Save</button>');
  await fs.writeFile(path.join(root, 'src/button.js'), 'export const label = "Save";');
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  const manifest = await checkpoint(root, config, { level });
  return { root, manifest };
}

// Synthetic unit fixture for protocol gates only. This is never browser acceptance evidence.
async function syntheticVerification(root, manifest, { status = 'PASS', omitHashes = false } = {}) {
  const relative = '.protoflow/artifacts/SYNTHETIC/screenshot.fixture';
  const artifact = await projectPath(root, relative);
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  const content = 'Synthetic fixture for artifact-integrity unit tests; not a screenshot.';
  await fs.writeFile(artifact, content);
  const verification = {
    schemaVersion: 1, id: 'VER-SYNTHETIC', fixture: 'synthetic-unit-protocol-only',
    manifestId: manifest.id, manifestHash: hash(manifest), prototypeHash: manifest.afterHash,
    project: await fingerprint(root), git: { head: null }, status,
    build: { status }, functional: { status },
    visual: { status, scenes: [{ id: 'synthetic-fixture', mappings: [{ id: 'button', status }] }], artifacts: [artifact] },
    artifactHashes: omitHashes ? {} : { [relative]: hash(content) },
  };
  await writeJson(await projectPath(root, `.protoflow/verifications/${verification.id}.json`), verification);
  return { verification, artifact, relative };
}

test('synthetic protocol fixture: screenshot mutation blocks approval even though project fingerprint ignores artifacts', async t => {
  const { root, manifest } = await fixture(t);
  const { verification, artifact } = await syntheticVerification(root, manifest);
  const review = await createReview(root, config, manifest.id, verification.id);
  await fs.writeFile(artifact, 'replaced evidence');
  assert.equal((await fingerprint(root)).hash, verification.project.hash);
  await assert.rejects(decideReview(root, config, review.id, { status: 'approved', reviewer: 'Unit fixture reviewer' }), /Visual evidence changed/);
  assert.equal((await loadArtifact(root, 'reviews', review.id)).status, 'pending');
});

test('synthetic protocol fixture: missing artifact blocks approval', async t => {
  const { root, manifest } = await fixture(t);
  const { verification, artifact } = await syntheticVerification(root, manifest);
  const review = await createReview(root, config, manifest.id, verification.id);
  await fs.unlink(artifact);
  await assert.rejects(decideReview(root, config, review.id, { status: 'approved', reviewer: 'Unit fixture reviewer' }), { code: 'ENOENT' });
});

test('synthetic protocol fixture: evidence mutations after approval block baseline promotion', async t => {
  const { root, manifest } = await fixture(t);
  const { verification, artifact } = await syntheticVerification(root, manifest);
  const review = await createReview(root, config, manifest.id, verification.id);
  const approved = await decideReview(root, config, review.id, { status: 'approved', reviewer: 'Unit fixture reviewer' });
  assert.equal(approved.status, 'approved');
  await fs.writeFile(artifact, 'tampered after approval');
  await assert.rejects(createBaseline(root, config, review.id), /Visual evidence changed/);
  await assert.rejects(fs.stat(path.join(root, '.protoflow/baselines/latest.json')), { code: 'ENOENT' });
});

test('synthetic protocol fixture: missing artifact hashes and NOT_RUN verification cannot be approved', async t => {
  const { root, manifest } = await fixture(t);
  const missing = await syntheticVerification(root, manifest, { omitHashes: true });
  const missingReview = await createReview(root, config, manifest.id, missing.verification.id);
  await assert.rejects(decideReview(root, config, missingReview.id, { status: 'approved', reviewer: 'Unit fixture reviewer' }), /Missing visual evidence hashes/);
  const skipped = await syntheticVerification(root, manifest, { status: 'NOT_RUN' });
  const skippedReview = await createReview(root, config, manifest.id, skipped.verification.id);
  await assert.rejects(decideReview(root, config, skippedReview.id, { status: 'approved', reviewer: 'Unit fixture reviewer' }), /requires PASS/);
});

test('synthetic protocol fixture: review binds verification JSON and current application content', async t => {
  const { root, manifest } = await fixture(t);
  const { verification } = await syntheticVerification(root, manifest);
  const review = await createReview(root, config, manifest.id, verification.id);
  await writeJson(await projectPath(root, `.protoflow/verifications/${verification.id}.json`), { ...verification, extra: 'mutated' });
  await assert.rejects(decideReview(root, config, review.id, { status: 'approved', reviewer: 'Unit fixture reviewer' }), /Review evidence changed/);
  await writeJson(await projectPath(root, `.protoflow/verifications/${verification.id}.json`), verification);
  await fs.writeFile(path.join(root, 'src/button.js'), 'export const label = "Changed after verify";');
  await assert.rejects(decideReview(root, config, review.id, { status: 'approved', reviewer: 'Unit fixture reviewer' }), /Project changed since verification/);
});

test('repair option does not bypass context freshness and stale context never starts executor', async t => {
  const { root, manifest } = await fixture(t);
  const context = await createContext(root, config, manifest.id);
  await fs.writeFile(path.join(root, 'src/button.js'), 'export const changed = true;');
  const executorConfig = { ...config, adapters: { codex: { command: { argv: [process.execPath, '-e', 'require("fs").writeFileSync("executor-ran", "yes")'] } } } };
  await assert.rejects(executeContext(root, executorConfig, context.id, { execute: true, repair: { attempt: 1 } }), /Context is stale/);
  await assert.rejects(fs.stat(path.join(root, 'executor-ran')), { code: 'ENOENT' });
});

test('fingerprint rejects internal symlinks into ignored state and tracks regular linked source content', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, '.protoflow'), { recursive: true });
  await fs.writeFile(path.join(root, '.protoflow/hidden.js'), 'before');
  await fs.symlink(path.join(root, '.protoflow/hidden.js'), path.join(root, 'src/hidden.js'));
  await assert.rejects(fingerprint(root), /Tracked symlink points into ignored state/);
  await fs.unlink(path.join(root, 'src/hidden.js'));
  await fs.symlink(path.join(root, 'src/button.js'), path.join(root, 'src/linked.js'));
  const before = await fingerprint(root);
  await fs.writeFile(path.join(root, 'src/button.js'), 'after');
  const after = await fingerprint(root);
  assert.notEqual(before.hash, after.hash);
  assert.notEqual(before.files['src/linked.js'], after.files['src/linked.js']);
});

test('project paths reject unresolved or escaping symlinks before writes', async t => {
  const { root } = await fixture(t);
  await fs.symlink(path.join(root, 'missing-target'), path.join(root, 'broken'));
  await assert.rejects(projectPath(root, 'broken/data.json'), /Unresolved symlink/);
  await fs.symlink(os.tmpdir(), path.join(root, 'escaped'));
  await assert.rejects(projectPath(root, 'escaped/data.json'), /Symlink escapes project/);
  await assert.rejects(projectPath(root, '../outside.json'), /Path escapes project/);
});

test('planning gates L2 spec and L3 approved ADR to the exact manifest', async t => {
  const { root, manifest } = await fixture(t, { level: 'L2' });
  await assert.rejects(createContext(root, config, manifest.id), /L2 requires --spec/);
  await fs.writeFile(path.join(root, 'spec.md'), 'Specification fixture: require save behavior and acceptance criteria.');
  const level2 = await createContext(root, config, manifest.id, { spec: 'spec.md' });
  assert.equal(level2.spec.path, 'spec.md');
  const session = await startSession(root, config);
  await fs.writeFile(path.join(root, 'prototype/index.html'), '<button id="button">Authenticate</button>');
  const level3 = await checkpoint(root, config, { sessionId: session.id, level: 'L3' });
  await assert.rejects(createContext(root, config, level3.id, { spec: 'spec.md' }), /requires --adr/);
  const adr = { status: 'approved', reviewer: 'Unit fixture reviewer', manifestHash: hash(manifest), decision: 'Approve fixture architecture' };
  await fs.writeFile(path.join(root, 'adr.json'), JSON.stringify(adr));
  await assert.rejects(createContext(root, config, level3.id, { spec: 'spec.md', adr: 'adr.json' }), /bound to this manifestHash/);
  await fs.writeFile(path.join(root, 'adr.json'), JSON.stringify({ ...adr, manifestHash: hash(level3), status: 'pending' }));
  await assert.rejects(createContext(root, config, level3.id, { spec: 'spec.md', adr: 'adr.json' }), /human approval/);
  await fs.writeFile(path.join(root, 'adr.json'), JSON.stringify({ ...adr, manifestHash: hash(level3) }));
  const accepted = await createContext(root, config, level3.id, { spec: 'spec.md', adr: 'adr.json' });
  assert.equal(accepted.manifestHash, hash(level3));
  assert.equal(accepted.adr.hash, hash(await fs.readFile(path.join(root, 'adr.json'), 'utf8')));
});

test('unmapped prototype changes block context generation instead of producing an empty execution target', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'prototype/unmapped.css'), 'button { color: blue }');
  const manifest = await checkpoint(root, config);
  await assert.rejects(createContext(root, config, manifest.id), /Map changed prototype files.*prototype\/unmapped.css/);
});

test('planning evidence in ignored state is independently bound to its content before execution', async t => {
  const { root, manifest } = await fixture(t, { level: 'L2' });
  const file = await projectPath(root, '.protoflow/planning/spec.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'Original specification');
  const context = await createContext(root, config, manifest.id, { spec: '.protoflow/planning/spec.md' });
  await fs.writeFile(file, 'Changed specification');
  assert.equal((await fingerprint(root)).hash, context.project.hash);
  await assert.rejects(executeContext(root, config, context.id), /Planning evidence changed/);
});

test('command argv remains literal and stdin transports JSON without shell interpolation', async t => {
  const { root } = await fixture(t);
  const literal = '$(touch injected-marker); `touch another-marker` $HOME && echo unsafe';
  const result = await runCommand(root, { argv: [process.execPath, '-e', 'let data=""; process.stdin.on("data", x => data += x); process.stdin.on("end", () => console.log(JSON.stringify({argv:process.argv.slice(1),input:JSON.parse(data)})));', literal] }, { value: literal });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(JSON.parse(result.stdout), { argv: [literal], input: { value: literal } });
  await assert.rejects(fs.stat(path.join(root, 'injected-marker')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'another-marker')), { code: 'ENOENT' });
});

test('command timeout terminates process and reports FAIL instead of acceptance', { timeout: 5000 }, async t => {
  const { root } = await fixture(t);
  const result = await runCommand(root, { argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 60 });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.equal((await runCommand(root, null)).status, 'NOT_RUN');
  await assert.rejects(runCommand(root, { argv: [] }), /non-empty argv/);
});
