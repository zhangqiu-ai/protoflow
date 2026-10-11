import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkpoint } from '../src/sessions.js';
import { versionQueue, assertCurrentVersion } from '../src/queue.js';
import { createReview, decideReview, createContext, loadArtifact } from '../src/workflow.js';
import { fingerprint, hash, writeJson, projectPath } from '../src/util.js';

/*
 * Rejection and reopening: a PASS verification that a later review rejects (human or independent model review)
 * no longer accepts its version for its target, so the same version can be repaired and verified again in order.
 * Synthetic records exercise the protocol only; real browser acceptance lives in the Playwright E2E suite.
 */

const target = id => ({ id, platform: 'web', root: id, driver: { kind: 'playwright-web', urlTemplate: `${id}/{page}.html` } });
const multi = { schemaVersion: 2, prototypeDir: 'prototype', targets: [target('web'), target('electron')], release: { requireTargets: ['web', 'electron'] } };

async function records(t, manifests) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const written = {};
  for (const [index, id] of manifests.entries()) {
    written[id] = { id, createdAt: `2026-10-09T00:00:0${index}Z`, summary: id, afterHash: `after-${id}`, mappings: [] };
    await writeJson(path.join(root, `.protoflow/manifests/${id}.json`), written[id]);
  }
  const verification = async (id, manifestId, targetId, createdAt, status = 'PASS') => {
    const record = { id, createdAt, manifestId, manifestHash: hash(written[manifestId]), prototypeHash: written[manifestId].afterHash, target: targetId, status };
    await writeJson(path.join(root, `.protoflow/verifications/${id}.json`), record);
    return record;
  };
  const rejection = (id, record, reviewedAt, reviewerKind = 'model') => writeJson(path.join(root, `.protoflow/reviews/${id}.json`), {
    id, manifestId: record.manifestId, verificationId: record.id, verificationHash: hash(record), status: 'changes_requested', reviewerKind, reviewer: reviewerKind === 'model' ? 'ai:codex:session' : 'Fixture reviewer', reviewedAt
  });
  return { root, verification, rejection };
}

test('a rejected PASS reopens its version for that target only; older PASS records stay history', async t => {
  const { root, verification, rejection } = await records(t, ['v1', 'v2']);
  await verification('VER-web-v1-old', 'v1', 'web', '2026-10-09T01:00:00Z');
  const rejected = await verification('VER-web-v1', 'v1', 'web', '2026-10-09T01:01:00Z');
  await verification('VER-web-v2', 'v2', 'web', '2026-10-09T01:02:00Z');
  await verification('VER-electron-v1', 'v1', 'electron', '2026-10-09T01:03:00Z');
  let queue = await versionQueue(root, multi);
  assert.deepEqual(queue.targets.web, { status: 'IDLE', current: null, waiting: [], lastAccepted: 'v2' });
  const electronBefore = queue.targets.electron;

  await rejection('REV-model', rejected, '2026-10-09T02:00:00Z');
  queue = await versionQueue(root, multi);
  // Neither the rejected PASS, an older PASS of the same version, nor the later version verified on top of it count.
  assert.deepEqual(queue.targets.web, { status: 'PENDING', current: 'v1', waiting: ['v2'], lastAccepted: null });
  assert.deepEqual(queue.versions.map(version => version.targets.web), [null, null]);
  assert.deepEqual(queue.versions[0].rejections.map(item => [item.reviewId, item.verificationId, item.target, item.reviewerKind]), [['REV-model', 'VER-web-v1', 'web', 'model']]);
  assert.deepEqual(queue.versions[1].rejections.map(item => item.reviewId), ['REV-model']);
  // The other target is untouched and the release does not follow the stale PASS.
  assert.deepEqual(queue.targets.electron, electronBefore);
  assert.equal(queue.versions[0].targets.electron, 'VER-electron-v1');
  assert.equal(queue.release.version, null);
  // FIFO stays: the reopened version is current, the later one may not be worked on.
  await assertCurrentVersion(root, multi, 'v1', { target: 'web' });
  await assert.rejects(assertCurrentVersion(root, multi, 'v2', { target: 'web' }), /目前版本是 v1/);

  // A new verification after the decision accepts the same version again; the later version needs its own.
  await verification('VER-web-v1-repaired', 'v1', 'web', '2026-10-09T03:00:00Z');
  queue = await versionQueue(root, multi);
  assert.deepEqual(queue.targets.web, { status: 'PENDING', current: 'v2', waiting: [], lastAccepted: 'v1' });
  assert.equal(queue.versions[0].targets.web, 'VER-web-v1-repaired');
  await verification('VER-web-v2-repaired', 'v2', 'web', '2026-10-09T03:01:00Z');
  assert.equal((await versionQueue(root, multi)).targets.web.status, 'IDLE');
  // Nothing was deleted or rewritten.
  assert.equal((await fs.readdir(path.join(root, '.protoflow/verifications'))).length, 6);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.protoflow/verifications/VER-web-v1.json'), 'utf8')).status, 'PASS');
});

test('rejecting a FAIL verification records a decision without reopening anything', async t => {
  const { root, verification, rejection } = await records(t, ['v1']);
  const failed = await verification('VER-fail', 'v1', 'web', '2026-10-09T01:00:00Z', 'FAIL');
  await verification('VER-pass', 'v1', 'web', '2026-10-09T01:01:00Z');
  await rejection('REV-human', failed, '2026-10-09T02:00:00Z', 'human');
  const queue = await versionQueue(root, multi);
  assert.equal(queue.versions[0].targets.web, 'VER-pass');
  assert.equal(queue.versions[0].rejections, undefined);
});

async function contextProject(t, projectConfig = multi) {
  const { root } = await records(t, []);
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.writeFile(path.join(root, 'prototype/index.html'), '<main data-pf="home" data-pf-role="screen"><button data-pf="home.save" data-pf-role="action">Save</button></main>');
  const manifest = await checkpoint(root, projectConfig, {});
  const reject = async (id, targetId) => {
    const verification = { id: `VER-${id}`, createdAt: '2026-10-09T01:00:00Z', manifestId: manifest.id, manifestHash: hash(manifest), prototypeHash: manifest.afterHash, target: targetId, status: 'PASS' };
    const review = { id: `REV-${id}`, manifestId: manifest.id, verificationId: verification.id, verificationHash: hash(verification),
      status: 'changes_requested', reviewerKind: 'model', reviewer: 'ai:codex:session', reviewedAt: '2026-10-09T02:00:00Z', notes: `${id} repair`,
      findings: [{ severity: 'high', description: `${id} layout differs from the frozen prototype` }], model: { sessionId: 'session' } };
    await writeJson(path.join(root, `.protoflow/verifications/${verification.id}.json`), verification);
    await writeJson(path.join(root, `.protoflow/reviews/${review.id}.json`), review);
    return review;
  };
  return { root, manifest, reject };
}

test('repair contexts include only rejection findings for their selected target', async t => {
  const { root, manifest, reject } = await contextProject(t);
  const review = await reject('web', 'web');
  const before = await versionQueue(root, multi);
  assert.equal(before.targets.electron.current, manifest.id);
  assert.deepEqual(before.versions[0].rejections.map(item => item.target), ['web']);

  const desktop = await createContext(root, multi, manifest.id, { target: 'electron' });
  assert.equal(desktop.rejections, undefined);
  assert.doesNotMatch(desktop.instructions, /rejected in review|address every finding in rejections/);
  const web = await createContext(root, multi, manifest.id, { target: 'web' });
  assert.deepEqual(web.rejections, [{ reviewId: review.id, manifestId: manifest.id, verificationId: review.verificationId, status: review.status,
    reviewerKind: review.reviewerKind, reviewer: review.reviewer, notes: review.notes, findings: review.findings, model: review.model }]);
  assert.match(web.instructions, /rejected in review and this version was reopened/);
  assert.deepEqual((await versionQueue(root, multi)).versions, before.versions);
});

test('repair contexts map legacy untargeted rejections to the first configured target', async t => {
  const reordered = { ...multi, targets: [target('electron'), target('web')] };
  const { root, manifest, reject } = await contextProject(t, reordered);
  const review = await reject('legacy');
  assert.deepEqual((await versionQueue(root, reordered)).versions[0].rejections.map(item => item.target), ['electron']);

  const web = await createContext(root, reordered, manifest.id, { target: 'web' });
  assert.equal(web.rejections, undefined);
  assert.doesNotMatch(web.instructions, /rejected in review|address every finding in rejections/);
  const desktop = await createContext(root, reordered, manifest.id, { target: 'electron' });
  assert.deepEqual(desktop.rejections.map(item => item.reviewId), [review.id]);
  assert.deepEqual(desktop.rejections[0].findings, review.findings);
  assert.match(desktop.instructions, /rejected in review and this version was reopened/);
});

// Single-stream project with a real checkpoint and review records; the verification is a synthetic protocol fixture.
const config = { schemaVersion: 1, prototypeDir: 'prototype', policy: { requireHumanReview: true, autoApprove: false },
  mappings: [{ id: 'button', prototypeFiles: ['prototype/**'], prototype: '#button', application: '#button', component: 'src/button.js' }] };

async function reviewed(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-model-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prototype')); await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'prototype/index.html'), '<button id="button">Save</button>');
  await fs.writeFile(path.join(root, 'src/button.js'), 'export const label = "Save";');
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  const manifest = await checkpoint(root, config, {});
  const relative = '.protoflow/artifacts/VER-SYNTHETIC-PASS/screenshot.fixture';
  await fs.mkdir(path.dirname(await projectPath(root, relative)), { recursive: true });
  await fs.writeFile(await projectPath(root, relative), 'Synthetic fixture for review protocol tests; not a screenshot.');
  const verification = { schemaVersion: 1, id: 'VER-SYNTHETIC-PASS', createdAt: new Date(Date.now() - 1000).toISOString(), fixture: 'synthetic-review-lifecycle',
    manifestId: manifest.id, manifestHash: hash(manifest), prototypeHash: manifest.afterHash, project: await fingerprint(root, { exclude: ['prototype'] }), git: { head: null }, status: 'PASS',
    build: { status: 'PASS' }, functional: { status: 'PASS' }, visual: { status: 'PASS', scenes: [{ id: 'synthetic', mappings: [{ id: 'button', status: 'PASS' }] }], artifacts: [] },
    artifactHashes: { [relative]: hash('Synthetic fixture for review protocol tests; not a screenshot.') } };
  await writeJson(await projectPath(root, `.protoflow/verifications/${verification.id}.json`), verification);
  const evidence = path.join(root, '..', `${path.basename(root)}-model-review.json`);
  t.after(() => fs.rm(evidence, { force: true }));
  const result = { kind: 'independent-model-review', status: 'FAIL', reviewExecuted: true, sessionId: 'session-1', verificationId: verification.id, verificationHash: hash(verification),
    manifestId: manifest.id, applicationHash: verification.project.hash, completedAt: new Date().toISOString(),
    modelResult: { status: 'FAIL', findings: [{ severity: 'high', file: 'src/button.js:1', reason: 'Root geometry differs from the frozen prototype' }, { severity: 'medium', file: 'tests/button.spec.js', reason: 'Asserts the wrong root' }], summary: 'Contract gap' } };
  await fs.writeFile(evidence, JSON.stringify(result));
  return { root, manifest, verification, evidence, result };
}

test('single-stream repair contexts preserve untargeted rejection findings', async t => {
  const { root, manifest, reject } = await contextProject(t, config);
  const review = await reject('legacy');
  const context = await createContext(root, config, manifest.id);
  assert.equal(context.target, undefined);
  assert.deepEqual(context.rejections.map(item => item.reviewId), [review.id]);
  assert.deepEqual(context.rejections[0].findings, review.findings);
  assert.match(context.instructions, /rejected in review and this version was reopened/);
});

test('an independent model review records a bound FAIL, reopens the version and cannot approve', async t => {
  const { root, manifest, verification, evidence, result } = await reviewed(t);
  const verificationBytes = await fs.readFile(path.join(root, `.protoflow/verifications/${verification.id}.json`));
  await assert.rejects(assertCurrentVersion(root, config, manifest.id), /已由 VER-SYNTHETIC-PASS 驗收/);
  const pending = await createReview(root, config, manifest.id, verification.id);
  const model = { reviewer: 'ai:codex:session-1', reviewerKind: 'model', model: { evidence, session: 'session-1' } };

  // Separate decision kinds: a model never approves, policy approval never rejects, identities are never mixed.
  await assert.rejects(decideReview(root, config, pending.id, { ...model, status: 'approved' }), /may only reject or request changes/);
  await assert.rejects(decideReview(root, config, pending.id, { status: 'changes_requested', reviewer: 'ai:codex:session-1', reviewerKind: 'automated' }), /may only approve verified changes; record an independent model review/);
  await assert.rejects(decideReview(root, config, pending.id, { ...model, status: 'changes_requested', reviewer: 'Codex' }), /AI reviewers must use an ai: identity/);
  await assert.rejects(decideReview(root, config, pending.id, { status: 'changes_requested', reviewer: 'ai:codex:session-1' }), /Human reviewers cannot use an ai: identity/);
  await assert.rejects(decideReview(root, config, pending.id, { ...model, status: 'changes_requested', model: {} }), /requires model\.evidence/);
  // The evidence must be the completed FAIL review of exactly this verification.
  for (const [change, pattern] of [[{ verificationHash: 'other' }, /verificationHash does not match/], [{ status: 'PASS' }, /only records FAIL/], [{ reviewExecuted: false }, /not executed/], [{ applicationHash: 'other' }, /applicationHash/], [{ sessionId: 'session-2' }, /session session-2 is not session-1/]]) {
    await fs.writeFile(evidence, JSON.stringify({ ...result, ...change }));
    await assert.rejects(decideReview(root, config, pending.id, { ...model, status: 'changes_requested' }), pattern);
  }
  await fs.writeFile(evidence, JSON.stringify(result));
  assert.equal((await loadArtifact(root, 'reviews', pending.id)).status, 'pending');

  const decided = await decideReview(root, config, pending.id, { ...model, status: 'changes_requested', notes: result.modelResult.summary });
  assert.equal(decided.reviewerKind, 'model');
  assert.equal(decided.model.sessionId, 'session-1');
  assert.equal(decided.model.verificationHashForm, 'record');
  assert.equal(decided.model.hash, hash(await fs.readFile(evidence)));
  assert.equal(hash(await fs.readFile(await projectPath(root, decided.model.path))), decided.model.hash);
  assert.deepEqual(decided.findings, [{ severity: 'high', description: 'src/button.js:1: Root geometry differs from the frozen prototype' }, { severity: 'normal', description: 'tests/button.spec.js: Asserts the wrong root' }]);
  assert.deepEqual(decided.bound, { manifestHash: hash(manifest), prototypeHash: manifest.afterHash, verificationHash: hash(verification), verificationStatus: 'PASS', applicationHash: verification.project.hash, applicationAtDecision: verification.project.hash, reopens: true });

  // The version is current again: same-version repair and verification are allowed and the context carries the findings.
  const queue = await versionQueue(root, config);
  assert.equal(queue.current.id, manifest.id);
  assert.equal(queue.versions[0].acceptedBy, null);
  await assertCurrentVersion(root, config, manifest.id);
  const context = await createContext(root, config, manifest.id);
  assert.deepEqual(context.rejections.map(item => [item.reviewId, item.reviewerKind, item.findings.length]), [[pending.id, 'model', 2]]);
  assert.match(context.instructions, /rejected in review and this version was reopened/);
  // The rejected verification cannot be approved afterwards, by a human or by policy.
  const later = await createReview(root, config, manifest.id, verification.id);
  await assert.rejects(decideReview(root, config, later.id, { status: 'approved', reviewer: 'Fixture reviewer' }), /was rejected by REV-.* \(model, changes_requested\)/);
  // Policy approval still requires independent review evidence, even when its input verification was revoked.
  await assert.rejects(decideReview(root, { ...config, policy: { ...config.policy, autoApprove: true } }, later.id, { status: 'approved', reviewer: 'ai:protoflow-runner', reviewerKind: 'automated' }), /requires independent AI review PASS evidence/);
  // History is kept: the PASS verification is byte-identical, the decided review cannot be changed.
  assert.deepEqual(await fs.readFile(path.join(root, `.protoflow/verifications/${verification.id}.json`)), verificationBytes);
  await assert.rejects(decideReview(root, config, pending.id, { ...model, status: 'rejected' }), /already decided/);
});

test('model review evidence may bind the verification by its file bytes', async t => {
  const { root, manifest, verification, evidence, result } = await reviewed(t);
  const fileHash = hash(await fs.readFile(path.join(root, `.protoflow/verifications/${verification.id}.json`)));
  assert.notEqual(fileHash, hash(verification));
  await fs.writeFile(evidence, JSON.stringify({ ...result, verificationHash: fileHash }));
  const pending = await createReview(root, config, manifest.id, verification.id);
  const decided = await decideReview(root, config, pending.id, { status: 'rejected', reviewer: 'ai:codex:session-1', reviewerKind: 'model', model: { evidence } });
  assert.equal(decided.model.verificationHashForm, 'file');
  assert.equal((await versionQueue(root, config)).current.id, manifest.id);
});
