// FAKE PROJECT STATE for dashboard tests only: engine records written by hand, never real runner or provider evidence.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findingsHash, waiverHash } from '../../src/waivers.js';

const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); };
// A 1×1 PNG.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export async function dashboardFixture({ executing = true, autoApprove = true, reviewRejected = false, blockedError = null, blockedReasonCode = null, blockedAt = null, waivers = false, deviceWait = null } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-dashboard-')));
  const root = path.join(base, 'project'), worktree = path.join(root, '.protoflow/runner/worktree-fixture'), home = path.join(base, 'home');
  await write(path.join(root, 'protoflow.config.json'), { schemaVersion: 1, prototypeDir: 'prototype', mappings: [], dashboard: { name: 'Fixture App', reviewer: 'Fixture Person' },
    policy: { autoApprove, ...(waivers && { waivers: { reviewers: ['Fixture Person'] } }), executor: { primary: 'claude', fallback: 'codex', routes: { frontend: 'claude', backend: 'codex' } } },
    runner: { delivery: { remote: 'origin', branch: 'protoflow/delivery', baseBranch: 'main', merge: 'manual' } },
    adapters: { claude: { command: { argv: ['node', 'claude-exec-adapter.js', '--model', 'claude-sonnet-5-5'] } }, codex: { command: { argv: ['node', 'codex-adapter.js', '--model', 'gpt-codex'] } }, planner: { command: { argv: ['node', 'claude-adapter.js', '--model', 'claude-opus-5-5'] } }, independentReview: { provider: 'claude', command: { argv: ['node', 'claude-review-adapter.js', '--model', 'claude-opus-5-5'] } } } });
  const sha1 = '1'.repeat(40), sha2 = '2'.repeat(40);
  const attempt = { attempt: 0, startedAt: new Date(Date.now() - 125000).toISOString(), status: 'RUNNING', processes: executing ? [{ phase: 'execute', status: 'RUNNING', startedAt: new Date(Date.now() - 60000).toISOString(), pid: 999999 }] : [] };
  // deviceWait: the verification waits for a simulator another project's runner holds.
  if (deviceWait) Object.assign(attempt, { processes: [], deviceWait });
  await write(path.join(root, '.protoflow/source/state.json'), { schemaVersion: 1, status: 'READY', entries: [
    { sha: sha1, manifestId: `git-${sha1}`, ordinal: 1, status: 'PASS', verificationId: 'VER-fixture-1', deliveryId: 'DLV-fixture-1', attempts: [{ status: 'PASS' }] },
    // blockedError: the version stopped on that failure instead of running.
    blockedError ? { sha: sha2, manifestId: `git-${sha2}`, ordinal: 2, status: 'BLOCKED', error: blockedError, ...(blockedReasonCode && { reasonCode: blockedReasonCode }), ...(blockedAt && { blockedAt }), planId: 'PLN-fixture-2', attempts: [{ ...attempt, status: 'BLOCKED', processes: [] }] }
      : { sha: sha2, manifestId: `git-${sha2}`, ordinal: 2, status: 'RUNNING', planId: 'PLN-fixture-2', attempts: [attempt] }
  ] });
  await write(path.join(root, `.protoflow/manifests/git-${sha1}.json`), { id: `git-${sha1}`, summary: 'Login screen', level: 'L1' });
  await write(path.join(root, `.protoflow/manifests/git-${sha2}.json`), { id: `git-${sha2}`, summary: 'Settings toggle', level: 'L1' });
  await write(path.join(root, '.protoflow/runner/state.json'), { schemaVersion: 1, worktree, status: 'RUNNING', branch: 'protoflow-runner-fixture' });
  await write(path.join(root, '.protoflow/runner/heartbeat.json'), { pid: process.pid, service: true, version: '0.0.0-fixture', at: new Date().toISOString(), failingPasses: 0 });
  await write(path.join(root, '.protoflow/runner/events.jsonl'), [{ at: new Date(Date.now() - 90000).toISOString(), event: 'planned', manifestId: `git-${sha2}`, decision: 'implement' }, { at: new Date(Date.now() - 60000).toISOString(), event: 'execute', manifestId: `git-${sha2}`, attempt: 0 }].map(event => JSON.stringify(event)).join('\n') + '\n');
  // The executor's live trace (Claude stream-json shape).
  await write(path.join(worktree, '.protoflow/live/execute.json'), { contextId: 'CTX-fixture', executor: 'claude', model: 'claude-sonnet-5-5', kind: 'implement', manifestId: `git-${sha2}`, startedAt: new Date(Date.now() - 60000).toISOString() });
  await write(path.join(worktree, '.protoflow/live/execute.jsonl'), [
    { type: 'system', subtype: 'init', session_id: 'fixture' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'FAKE FIXTURE: adding the weekly toggle.' }, { type: 'tool_use', name: 'Read', input: { file_path: `${worktree}/app/settings.js` } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${worktree}/app/settings.js` } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run unit tests' } }] } }
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  // Newest verification with one scene and its screenshots.
  const art = '.protoflow/artifacts/VER-fixture-1/web/settings.initial';
  await write(path.join(root, '.protoflow/verifications/VER-fixture-1.json'), { id: 'VER-fixture-1', createdAt: new Date().toISOString(), manifestId: `git-${sha1}`, status: 'FAIL', build: { status: 'PASS' }, functional: { status: 'PASS' },
    visual: { status: 'FAIL', scenes: [{ id: 'settings.initial', screen: 'settings', state: 'initial', status: 'FAIL', tiers: { structure: { status: 'PASS', reasons: [] }, tokens: { status: 'FAIL', reasons: ['settings.save: color #000 differs from #2F5BEA'] }, layout: { status: 'PASS', reasons: [] }, visual: { status: 'FAIL', reasons: [] } } }] },
    artifactHashes: { [`${art}/prototype.png`]: 'x', [`${art}/application.png`]: 'y' } });
  await write(path.join(root, `${art}/prototype.png`), PNG);
  await write(path.join(root, `${art}/application.png`), PNG);
  // Either a manual PR waiting to be merged, or a delivery the independent review rejected with a finding.
  const delivery = reviewRejected
    ? { id: 'DLV-fixture-1', status: 'BLOCKED', versions: [`git-${sha1}`], commit: 'a'.repeat(40), independentReviewId: 'AIR-fixture-1', error: 'Independent review FAIL', updatedAt: new Date().toISOString() }
    : { id: 'DLV-fixture-1', status: 'PR_OPEN_MANUAL', versions: [`git-${sha1}`], commit: 'a'.repeat(40), pr: { number: 7, url: 'https://github.com/protoflow-fixture/application/pull/7' }, updatedAt: new Date().toISOString() };
  await write(path.join(root, '.protoflow/delivery/state.json'), { schemaVersion: 1, deliveries: [delivery] });
  if (reviewRejected) {
    await write(path.join(root, '.protoflow/delivery/independent-reviews/AIR-fixture-1.json'), { id: 'AIR-fixture-1', status: 'FAIL', runFile: '.protoflow/delivery/independent-reviews/AIR-fixture-1/run.json' });
    await write(path.join(root, '.protoflow/delivery/independent-reviews/AIR-fixture-1/run.json'), { verdict: { status: 'FAIL', summary: 'FAKE FIXTURE: one visible defect.', findings: [{ severity: 'normal', file: 'app/settings.js', description: 'FAKE FIXTURE: the folder icon is only 8px wide.' }] } });
  }
  await write(path.join(root, '.protoflow/issues/state.json'), { schemaVersion: 1, repository: { id: 101, nameWithOwner: 'protoflow-fixture/application' }, issues: {
    5: { number: 5, status: 'needs-human', snapshotId: 'ISS-5-000000000000', planId: 'PLN-issue-5', reason: 'FAKE FIXTURE: contradicts the prototype', history: [] },
    6: { number: 6, status: 'in-progress', snapshotId: 'ISS-6-000000000000', planId: 'PLN-issue-6', history: [], targets: { application: { status: 'RUNNING', attempts: [{}], executorRoute: { primary: 'codex' } } } }
  } });
  await write(path.join(root, '.protoflow/issues/snapshots/ISS-5-000000000000.json'), { title: 'Hide Saved after a change' });
  await write(path.join(root, '.protoflow/issues/snapshots/ISS-6-000000000000.json'), { title: 'Unit-test the validation' });
  await write(path.join(root, '.protoflow/plans/PLN-issue-5.json'), { plan: { decision: 'needs-human', area: 'frontend', level: 'L1', summary: 'New interaction', questions: ['Should Saved hide on any change?'] } });
  await write(path.join(root, '.protoflow/plans/PLN-issue-6.json'), { plan: { decision: 'implement', area: 'backend', level: 'L1', summary: 'Extract and test', questions: [] } });
  if (waivers) {
    // Proposal 0005: VER-fixture-1 passed with an approved waiver on its tokens finding; another request waits for a reviewer.
    const tokens = ['settings.save: color #000 differs from #2F5BEA'], structure = ['settings.toggle: text "Weekly" vs "Monthly"'];
    const scope = { target: null, scene: 'settings.initial', variant: null, manifestHash: 'fixture-manifest-hash' };
    const used = { ...scope, tier: 'tokens', findingsHash: findingsHash(tokens) };
    await write(path.join(root, '.protoflow/waivers/WVR-fixture-1.json'), { schemaVersion: 1, id: 'WVR-fixture-1', status: 'approved', ...used, manifestId: `git-${sha1}`, verificationId: 'VER-fixture-0', findings: tokens, reason: 'FAKE FIXTURE: token sampling reads the pressed state', engineIssue: 'https://github.com/protoflow-fixture/engine/issues/1', requestedBy: { kind: 'ai', name: 'ai:claude' }, requestedAt: new Date(Date.now() - 7200000).toISOString(), evidence: [], decision: { status: 'approved', reviewer: 'Fixture Person', reviewerKind: 'human', at: new Date(Date.now() - 3600000).toISOString(), notes: '', waiverHash: waiverHash(used) } });
    const evidence = ['prototype.png', 'application.png'].map(name => `.protoflow/artifacts/WVR-fixture-2/${name}`);
    for (const file of evidence) await write(path.join(root, file), PNG);
    await write(path.join(root, '.protoflow/waivers/WVR-fixture-2.json'), { schemaVersion: 1, id: 'WVR-fixture-2', status: 'requested', ...scope, tier: 'structure', findingsHash: findingsHash(structure), manifestId: `git-${sha2}`, verificationId: 'VER-fixture-2', findings: structure, reason: 'FAKE FIXTURE: overlay reading order is an engine limitation', engineIssue: null, requestedBy: { kind: 'ai', name: 'ai:codex' }, requestedAt: new Date(Date.now() - 600000).toISOString(), evidence, decision: null });
    const file = path.join(root, '.protoflow/verifications/VER-fixture-1.json'), report = JSON.parse(await fs.readFile(file, 'utf8'));
    const scene = report.visual.scenes[0];
    scene.status = 'PASS'; scene.tiers.visual = { status: 'PASS', reasons: [] }; scene.tiers.tokens.waiver = { id: 'WVR-fixture-1', waiverHash: waiverHash(used) }; scene.waived = [{ tier: 'tokens', waiverId: 'WVR-fixture-1' }];
    report.status = 'PASS'; report.visual.status = 'PASS';
    report.waivers = report.visual.waivers = [{ id: 'WVR-fixture-1', target: null, scene: 'settings.initial', variant: null, tier: 'tokens', findings: tokens, reason: 'FAKE FIXTURE: token sampling reads the pressed state', engineIssue: 'https://github.com/protoflow-fixture/engine/issues/1' }];
    await write(file, report);
  }
  return { base, root, worktree, home, sha1, sha2, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}
