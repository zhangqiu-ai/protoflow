// Proposal 0005: maintainer waivers. FAKE verification records written by hand; no runner, driver or provider runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requestEngineLimitWaivers } from '../src/runner.js';
import { applyWaivers, requestWaiver, decideWaiver, listWaivers, loadWaiver, shareWaivers, findVerification, findingsHash, waiverHash } from '../src/waivers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const config = { schemaVersion: 1, prototypeDir: 'prototype', mappings: [], policy: { waivers: { reviewers: ['qiuge'] } } };
const findings = ['nav.sidebar: text "Inbox" vs "Settings"', 'nav.sidebar.item: expected 3 element(s), found 2'];
const ai = { kind: 'ai', name: 'ai:codex' };

async function project(t, { worktree = false } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-waivers-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), runner = path.join(base, 'worktree');
  // A failed verification lives only in the runner worktree, with its screenshots.
  const home = worktree ? runner : root;
  const art = '.protoflow/artifacts/VER-fixture-1/web/nav.sidebar.initial';
  for (const name of ['prototype.png', 'application.png', 'diff.png']) {
    await fs.mkdir(path.join(home, art), { recursive: true });
    await fs.writeFile(path.join(home, art, name), PNG);
  }
  await fs.mkdir(path.join(home, '.protoflow/verifications'), { recursive: true });
  await fs.writeFile(path.join(home, '.protoflow/verifications/VER-fixture-1.json'), JSON.stringify({
    id: 'VER-fixture-1', manifestId: 'git-1', manifestHash: 'mh-1', status: 'FAIL',
    visual: { scenes: [{ id: 'nav.sidebar.initial', variant: null, status: 'FAIL', artifacts: ['prototype.png', 'application.png', 'diff.png'].map(name => `${art}/${name}`), tiers: {
      structure: { status: 'FAIL', reasons: findings }, tokens: { status: 'PASS', reasons: [] }, layout: { status: 'PASS', reasons: [] }, visual: { status: 'FAIL', reasons: ['diff 4.0% > 1.0%'] }
    } }] }
  }));
  if (worktree) {
    await fs.mkdir(path.join(root, '.protoflow/runner'), { recursive: true });
    await fs.writeFile(path.join(root, '.protoflow/runner/state.json'), JSON.stringify({ worktree: runner }));
  }
  return { root, runner };
}
const request = (root, options = {}) => requestWaiver(root, config, { verificationId: 'VER-fixture-1', scene: 'nav.sidebar.initial', tier: 'structure', reason: 'overlay reading order is an engine limitation', engineIssue: 'https://github.com/zhangqiu-ai/protoflow/issues/1', requestedBy: ai, ...options });

/** An approved waiver as decideWaiver writes it, for applyWaivers rules. */
const approved = (change = {}) => {
  const waiver = { id: 'WVR-1', status: 'approved', target: 'web', scene: 'tasks.initial', variant: null, tier: 'structure', manifestHash: 'mh-1', findings, findingsHash: findingsHash(findings), reason: 'engine limit', ...change };
  return { ...waiver, decision: { status: 'approved', reviewer: 'qiuge', reviewerKind: 'human', waiverHash: waiverHash(waiver) } };
};
const scene = (reasons = findings, extra = {}) => ({ id: 'tasks.initial', variant: null, tiers: {
  structure: { status: 'FAIL', reasons: [...reasons] }, tokens: { status: 'PASS', reasons: [] }, layout: { status: 'PASS', reasons: [] }, visual: { status: 'PASS', reasons: [] }, ...extra
} });
const policy = { structure: 'required', tokens: 'required', layout: 'required', visual: 'required' };
const apply = (waivers, sceneValue = scene(), options = {}) => applyWaivers(waivers, { target: 'web', manifestHash: 'mh-1', scene: sceneValue, policy, ...options });

test('an approved waiver passes the gate only while every current finding is one it waived', () => {
  const exact = scene(), result = apply([approved()], exact);
  assert.equal(result.gate.structure.status, 'PASS');
  assert.deepEqual(result.applied.map(item => [item.id, item.tier, item.findings]), [['WVR-1', 'structure', findings]]);
  // The tier keeps its FAIL and findings and records which waiver let it through.
  assert.equal(exact.tiers.structure.status, 'FAIL');
  assert.deepEqual(exact.tiers.structure.reasons, findings);
  assert.deepEqual(exact.tiers.structure.waiver, { id: 'WVR-1', waiverHash: approved().decision.waiverHash });
  // Fewer findings (part of it fixed) is still covered (decision A).
  assert.equal(apply([approved()], scene([findings[1]])).gate.structure.status, 'PASS');
  // One new or changed finding and the waiver no longer applies.
  const changed = apply([approved()], scene([findings[0], 'nav.sidebar: text "Inbox" vs "Archive"']));
  assert.equal(changed.gate.structure.status, 'FAIL');
  assert.deepEqual(changed.applied, []);
  assert.match(changed.skipped[0].why, /^findings changed: 1 not waived \(nav\.sidebar: text "Inbox" vs "Archive"\)/);
});

test('a waiver applies only to its own scene, variant, target, tier and prototype version, once approved', () => {
  const skippedWhy = (waiver, options) => apply([waiver], scene(), options).skipped[0]?.why;
  assert.equal(skippedWhy(approved(), { manifestHash: 'mh-2' }), 'waiver belongs to another prototype version');
  assert.equal(skippedWhy({ ...approved(), status: 'requested' }), 'requested, not approved yet');
  assert.equal(skippedWhy({ ...approved(), status: 'revoked' }), 'waiver is revoked');
  // A rejected waiver is not a candidate at all.
  assert.deepEqual(apply([{ ...approved(), status: 'rejected' }]).skipped, []);
  // Editing the findings, or the scope, after approval breaks the approval's hash.
  assert.equal(skippedWhy({ ...approved(), findings: [...findings, 'more'], findingsHash: findingsHash([...findings, 'more']) }), 'waiver changed after approval');
  assert.equal(skippedWhy({ ...approved(), findings: [...findings, 'more'] }), 'waiver changed after approval');
  // Another scene, variant, target or tier is simply not a candidate.
  for (const other of [{ scene: 'tasks.empty' }, { variant: 'ipad' }, { target: 'mobile' }, { tier: 'tokens' }]) {
    const result = apply([approved(other)]);
    assert.deepEqual([result.gate.structure.status, result.applied, result.skipped], ['FAIL', [], []], JSON.stringify(other));
  }
});

test('visual (T4), advisory and passing tiers are never waived', () => {
  const visualFail = scene([], { structure: { status: 'PASS', reasons: [] }, visual: { status: 'FAIL', reasons: ['diff 4%'] } });
  const visual = apply([approved({ tier: 'visual', findings: ['diff 4%'], findingsHash: findingsHash(['diff 4%']) })], visualFail);
  assert.deepEqual([visual.gate.visual.status, visual.applied, visual.skipped], ['FAIL', [], []]);
  const advisory = apply([approved()], scene(), { policy: { ...policy, structure: 'advisory' } });
  assert.deepEqual([advisory.applied, advisory.skipped], [[], []]);
  assert.deepEqual(apply([approved()], scene([], { structure: { status: 'PASS', reasons: [] } })).applied, []);
});

test('a request copies the findings and screenshots of the verification; agents and the CLI can only request', async t => {
  const { root } = await project(t, { worktree: true });
  // The verification lives only in the runner worktree.
  assert.equal((await findVerification(root, config, 'VER-fixture-1')).report.id, 'VER-fixture-1');
  const waiver = await request(root);
  assert.equal(waiver.status, 'requested');
  assert.deepEqual([waiver.target, waiver.scene, waiver.variant, waiver.tier, waiver.manifestHash, waiver.manifestId, waiver.verificationId], [null, 'nav.sidebar.initial', null, 'structure', 'mh-1', 'git-1', 'VER-fixture-1']);
  assert.deepEqual(waiver.findings, findings);
  assert.equal(waiver.findingsHash, findingsHash(findings));
  assert.deepEqual(waiver.requestedBy, ai);
  assert.equal(waiver.decision, null);
  assert.deepEqual(waiver.evidence, ['prototype.png', 'application.png', 'diff.png'].map(name => `.protoflow/artifacts/${waiver.id}/${name}`));
  for (const file of waiver.evidence) assert.deepEqual(await fs.readFile(path.join(root, file)), PNG);
  assert.deepEqual((await listWaivers(root)).map(item => item.id), [waiver.id]);
  assert.equal((await loadWaiver(root, waiver.id)).id, waiver.id);
  // The same request again returns the open waiver instead of a second one.
  const again = await request(root, { reason: 'again' });
  assert.deepEqual([again.id, again.existing], [waiver.id, true]);
  assert.equal((await listWaivers(root)).length, 1);
});

test('requests are refused without reviewers, for T4, without a reason, for a mislabelled agent or a tier that did not fail', async t => {
  const { root } = await project(t);
  await assert.rejects(requestWaiver(root, { ...config, policy: {} }, { verificationId: 'VER-fixture-1', scene: 'nav.sidebar.initial', tier: 'structure', reason: 'x', requestedBy: ai }), /Waivers are off for this project/);
  await assert.rejects(request(root, { tier: 'visual' }), /Visual \(T4\) findings can never be waived/);
  await assert.rejects(request(root, { tier: 'pixels' }), /Unknown tier pixels/);
  await assert.rejects(request(root, { reason: '  ' }), /needs --reason/);
  await assert.rejects(request(root, { requestedBy: { kind: 'human', name: 'ai:codex' } }), /requestedBy must be a person or an ai: identity/);
  await assert.rejects(request(root, { requestedBy: { kind: 'ai', name: 'codex' } }), /requestedBy must be a person or an ai: identity/);
  await assert.rejects(request(root, { tier: 'tokens' }), /tokens did not fail with findings/);
  await assert.rejects(request(root, { scene: 'nav.other' }), /has no scene nav\.other/);
  await assert.rejects(request(root, { variant: 'ipad' }), /for variant ipad/);
  await assert.rejects(request(root, { verificationId: 'VER-missing' }), /not found in the project or its runner worktrees/);
  await assert.rejects(request(root, { verificationId: '../x' }), /Invalid verification id/);
  assert.deepEqual(await listWaivers(root), []);
  // A v2 target whose tier is advisory has nothing to waive.
  const v2 = { schemaVersion: 2, targets: [{ id: 'web', platform: 'web', driver: { kind: 'playwright-web', urlTemplate: 'app/{page}.html' }, tiers: { structure: 'advisory' } }], policy: config.policy };
  await assert.rejects(requestWaiver(root, v2, { verificationId: 'VER-fixture-1', scene: 'nav.sidebar.initial', tier: 'structure', reason: 'x', requestedBy: ai }), /structure is advisory for this target/);
});

test('only a listed person decides: approval binds the waiver, rejection is final, and only an approved waiver is revoked', async t => {
  const { root } = await project(t);
  const waiver = await request(root);
  await assert.rejects(decideWaiver(root, config, waiver.id, { status: 'approved', reviewer: 'ai:claude' }), /an ai: identity never does/);
  await assert.rejects(decideWaiver(root, config, waiver.id, { status: 'approved', reviewer: 'someone' }), /someone is not a waiver reviewer \(policy\.waivers\.reviewers: qiuge\)/);
  await assert.rejects(decideWaiver(root, { ...config, policy: {} }, waiver.id, { status: 'approved', reviewer: 'qiuge' }), /Waivers are off/);
  await assert.rejects(decideWaiver(root, config, waiver.id, { status: 'revoked', reviewer: 'qiuge' }), /only an approved waiver can be revoked/);
  await assert.rejects(decideWaiver(root, config, waiver.id, { status: 'maybe', reviewer: 'qiuge' }), /Invalid waiver decision/);
  await assert.rejects(decideWaiver(root, config, 'WVR-missing', { status: 'approved', reviewer: 'qiuge' }), /Waiver WVR-missing not found/);
  const yes = await decideWaiver(root, config, waiver.id, { status: 'approved', reviewer: 'qiuge', notes: 'until #1 lands' });
  assert.equal(yes.status, 'approved');
  assert.deepEqual({ ...yes.decision, at: null }, { status: 'approved', reviewer: 'qiuge', reviewerKind: 'human', at: null, notes: 'until #1 lands', waiverHash: waiverHash(waiver) });
  await assert.rejects(decideWaiver(root, config, waiver.id, { status: 'approved', reviewer: 'qiuge' }), /already approved/);
  const revoked = await decideWaiver(root, config, waiver.id, { status: 'revoked', reviewer: 'qiuge' });
  assert.deepEqual([revoked.status, revoked.revocation.reviewer, revoked.revocation.reviewerKind, revoked.decision.status], ['revoked', 'qiuge', 'human', 'approved']);
  // A revoked waiver no longer blocks a fresh request for the same findings.
  const fresh = await request(root);
  assert.notEqual(fresh.id, waiver.id);
  const no = await decideWaiver(root, config, fresh.id, { status: 'rejected', reviewer: 'qiuge' });
  assert.deepEqual([no.status, no.decision.waiverHash], ['rejected', undefined]);
  await assert.rejects(decideWaiver(root, config, fresh.id, { status: 'approved', reviewer: 'qiuge' }), /already rejected/);
});

test('the runner worktree verifies against a fresh copy of the project waivers', async t => {
  const { root, runner } = await project(t, { worktree: true });
  await fs.mkdir(path.join(runner, '.protoflow/waivers'), { recursive: true });
  await fs.writeFile(path.join(runner, '.protoflow/waivers/WVR-stale.json'), '{}');
  await shareWaivers(root, runner);
  assert.deepEqual(await listWaivers(runner), []);
  const waiver = await request(root);
  await shareWaivers(root, runner);
  assert.deepEqual((await listWaivers(runner)).map(item => item.id), [waiver.id]);
  // Sharing with the project itself is a no-op.
  await shareWaivers(root, root);
  assert.deepEqual((await listWaivers(root)).map(item => item.id), [waiver.id]);
});

test('the runner requests (never approves) a waiver for an engine limitation the executor marked and that failed twice the same way', async t => {
  const { root, runner } = await project(t, { worktree: true });
  const report = JSON.parse(await fs.readFile(path.join(runner, '.protoflow/verifications/VER-fixture-1.json'), 'utf8'));
  const previous = structuredClone(report);
  const limits = [
    { scene: 'nav.sidebar.initial', tier: 'structure', reason: 'overlay reading order', engineIssue: 'https://github.com/zhangqiu-ai/protoflow/issues/1' },
    { scene: 'nav.sidebar.initial', tier: 'visual', reason: 'pixels' },
    { scene: 'nav.sidebar.initial', tier: 'tokens' },
    'not a limit'
  ];
  await fs.mkdir(path.join(runner, '.protoflow/engine-limits'), { recursive: true });
  await fs.writeFile(path.join(runner, '.protoflow/engine-limits/CTX-fixture.json'), JSON.stringify({ limits }));
  const entry = { sha: 'a'.repeat(40), manifestId: 'git-1' }, record = { contextId: 'CTX-fixture', executor: 'codex' };
  const events = [];
  const run = (change = {}) => requestEngineLimitWaivers(root, config, runner, { entry, record, report, previous, onEvent: event => events.push(event), ...change });
  // Not without reviewers, a previous verification, a repair context, or when the findings changed since the last attempt.
  assert.deepEqual(await requestEngineLimitWaivers(root, { ...config, policy: {} }, runner, { entry, record, report, previous, onEvent: () => {} }), []);
  assert.deepEqual(await run({ previous: null }), []);
  assert.deepEqual(await run({ record: { contextId: null } }), []);
  const moved = structuredClone(previous); moved.visual.scenes[0].tiers.structure.reasons = [findings[0]];
  assert.deepEqual(await run({ previous: moved }), []);
  // Only the T4 claim, which is never waivable, is reported; nothing was requested.
  assert.deepEqual([events.map(event => [event.event, event.tier]), await listWaivers(root)], [[['waiver-request-failed', 'visual']], []]);
  events.length = 0;
  const [id] = await run();
  const waiver = await loadWaiver(root, id);
  assert.deepEqual([waiver.status, waiver.requestedBy, waiver.reason, waiver.engineIssue, waiver.decision], ['requested', { kind: 'ai', name: 'ai:codex' }, 'overlay reading order', 'https://github.com/zhangqiu-ai/protoflow/issues/1', null]);
  // The screenshots come from the runner worktree, where the failed verification lives.
  assert.equal(waiver.evidence.length, 3);
  assert.deepEqual(events.map(event => [event.event, event.tier, event.waiverId ?? event.reason]), [['waiver-requested', 'structure', id], ['waiver-request-failed', 'visual', 'Visual (T4) findings can never be waived']]);
  // The next failure with the same findings finds the open request instead of asking again.
  events.length = 0;
  assert.deepEqual(await run(), []);
  assert.deepEqual(events.map(event => event.event), ['waiver-request-failed']);
});
