import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus, rebaseDeliveries } from '../src/delivery.js';
import { sourceStatus } from '../src/source.js';
import { writeJson, hash, readJson } from '../src/util.js';
import { git, fixture, humanCommit, acceptNext, plannedIssue, fakeVerify, idleRunner, onGitHub } from './helpers/delivery-fixture.js';

test('FAKE providers only: an issue fix without the planned tests is repaired, and a reviewer FAIL blocks it without merging', async t => {
  const f = await fixture(t);
  const { issues } = await plannedIssue(f);
  const { runIssues } = await import('../src/issue-runner.js');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await idleRunner(f);
  const base = await git(f.remote, 'rev-parse', 'main');
  process.env.FAKE_ISSUE_TESTS = '2'; process.env.FAKE_REVIEW_MODE = 'fail';
  t.after(() => { delete process.env.FAKE_ISSUE_TESTS; delete process.env.FAKE_REVIEW_MODE; });
  const result = await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify() });
  assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, /Independent review AIR-\S+ returned FAIL/);
  const work = JSON.parse(await fs.readFile(path.join(f.root, '.protoflow/issues/state.json'), 'utf8')).issues[12].targets.application;
  // First attempt added no test: repaired with that reason; the second passed verification.
  assert.deepEqual(work.attempts.map(item => item.status), ['FAIL', 'PASS']); assert.match(work.attempts[0].error, /adds or edits no test file/);
  // Nothing merged; the worktree is back at the base for the prototype stream.
  assert.equal(await git(f.remote, 'rev-parse', 'main'), base); assert.equal((await f.gh()).prs.some(item => item.head === 'protoflow/issue-12'), false);
  assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), base); assert.equal(await git(f.worktree, 'status', '--porcelain', '--untracked-files=no'), '');
  const issue = await issues();
  assert.deepEqual(issue.labels, ['protoflow', 'protoflow:blocked']);
  assert.match(issue.comments.at(-1).body, /status `protoflow:blocked`[\s\S]*returned FAIL[\s\S]*- high app\/index.html:1: Synthetic fixture finding/);
  assert.deepEqual(await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify() }), { status: 'IDLE' });
});

test('FAKE providers only: a stopped runner never blocks an issue fix, and a base that moves before review makes it start over', async t => {
  const f = await fixture(t);
  const { issues } = await plannedIssue(f);
  const { runIssues } = await import('../src/issue-runner.js');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await idleRunner(f);
  const issueState = async () => (await readJson(path.join(f.root, '.protoflow/issues/state.json'))).issues[12];
  // Stopped while the first attempt is verified: the work stays RUNNING and nothing is published as blocked.
  const controller = new AbortController(), first = fakeVerify();
  const stopped = await runIssues(f.root, f.config, null, { signal: controller.signal, verifyVersion: async (...args) => { const report = await first(...args); controller.abort(); return report; } });
  assert.deepEqual(stopped, { status: 'STOPPED', number: 12, target: 'application' });
  assert.equal((await issueState()).targets.application.status, 'RUNNING');
  assert.equal((await issues()).labels.includes('protoflow:blocked'), false);
  // Another change lands on the base while the fix is verified: the committed fix is dropped and done again.
  const startBase = await git(f.remote, 'rev-parse', 'main'), clone = path.join(f.base, 'other-change');
  const verify = fakeVerify();
  let moved = false;
  const moving = async (...args) => {
    if (!moved) {
      moved = true;
      await git(f.base, 'clone', '-q', f.remote, clone); await git(clone, 'config', 'user.email', 'fixture@protoflow.test'); await git(clone, 'config', 'user.name', 'Fixture');
      await fs.writeFile(path.join(clone, 'OTHER.md'), 'FAKE FIXTURE: another target merged\n'); await git(clone, 'add', 'OTHER.md'); await git(clone, 'commit', '-q', '-m', 'other change'); await git(clone, 'push', '-q', 'origin', 'HEAD:main');
    }
    return verify(...args);
  };
  const retry = await runIssues(f.root, f.config, null, { verifyVersion: moving });
  assert.equal(retry.status, 'RETRY'); assert.match(retry.reason, /^Starting over: the base moved before review/);
  let work = (await issueState()).targets.application;
  assert.equal(work.restarts, 1); assert.equal(work.commit, undefined); assert.equal(work.history[0].reason, 'the base moved before review');
  assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), startBase);
  const result = await runIssues(f.root, f.config, null, { verifyVersion: verify });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  work = (await issueState()).targets.application;
  assert.deepEqual(work.baseMoves.map(move => move.from), [startBase]);
  assert.equal(await git(f.remote, 'show', 'main:OTHER.md'), 'FAKE FIXTURE: another target merged');
  assert.equal(await git(f.remote, 'show', 'main:app/index.html'), '<main>v1 fixed</main>');
  // One "started" comment for the issue, however often its work resumed.
  assert.equal((await issues()).comments.filter(comment => comment.body.startsWith('<!-- protoflow:issue-started 12 -->')).length, 1);
  assert.equal((await issues()).state, 'closed');
});

test('FAKE providers only: a backend issue is implemented by the backend executor; the frontend executor is never called', async t => {
  const f = await fixture(t);
  const { record } = await plannedIssue(f);
  record.plan.area = 'backend'; record.planHash = hash(record.plan);
  await writeJson(path.join(f.root, `.protoflow/plans/${record.id}.json`), record);
  const claudeRuns = path.join(f.base, 'claude-runs');
  f.config.adapters.claude = { command: { argv: [process.execPath, '-e', `require('fs').appendFileSync(process.argv[1],'x');process.exit(1)`, claudeRuns] } };
  f.config.policy = { ...f.config.policy, executor: { primary: 'claude', fallback: 'codex', routes: { frontend: 'claude', backend: 'codex' } } };
  const { runIssues } = await import('../src/issue-runner.js');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await idleRunner(f);
  const events = [];
  const result = await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify(), onEvent: event => events.push(event) });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const execute = events.find(event => event.event === 'issue-execute');
  assert.equal(execute.area, 'backend'); assert.equal(execute.executor, 'codex');
  const work = (await readJson(path.join(f.root, '.protoflow/issues/state.json'))).issues[12].targets.application;
  assert.deepEqual(work.executorRoute, { area: 'backend', primary: 'codex', fallback: 'claude' });
  assert.equal(work.attempts[0].executor, 'codex');
  await assert.rejects(fs.access(claudeRuns), { code: 'ENOENT' });
});

test('FAKE providers only: worktree changes the base already has (runner configure) are settled; other changes keep the issue waiting', async t => {
  const f = await fixture(t);
  await plannedIssue(f);
  const { runIssues } = await import('../src/issue-runner.js');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await idleRunner(f);
  // The base gets a new README, as runner configure syncs a committed config into every worktree.
  const clone = path.join(f.base, 'base-change');
  await git(f.base, 'clone', '-q', f.remote, clone); await git(clone, 'config', 'user.email', 'fixture@protoflow.test'); await git(clone, 'config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(clone, 'README.md'), 'app\nFAKE FIXTURE: synced setting\n'); await git(clone, 'commit', '-q', '-am', 'sync setting'); await git(clone, 'push', '-q', 'origin', 'HEAD:main');
  await fs.writeFile(path.join(f.worktree, 'README.md'), 'app\nFAKE FIXTURE: local edit\n');
  assert.match((await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify() })).reason, /Issue #12 waits: the runner worktree has uncommitted changes \(README\.md\)/);
  await fs.writeFile(path.join(f.worktree, 'README.md'), 'app\nFAKE FIXTURE: synced setting\n');
  const events = [];
  const result = await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify(), onEvent: event => events.push(event) });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.deepEqual(events.find(event => event.event === 'issue-settled-changes').files, ['README.md']);
  assert.equal(await git(f.remote, 'show', 'main:README.md'), 'app\nFAKE FIXTURE: synced setting');
  assert.equal(await git(f.remote, 'show', 'main:app/index.html'), '<main>v1 fixed</main>');
});

test('FAKE gh only: the dashboard merges a manual delivery PR only at the reviewed commit, as the signed-in person', async t => {
  const f = await fixture(t, { merge: 'manual' });
  const { runAction } = await import('../src/dashboard-actions.js');
  const { dashboardSnapshot } = await import('../src/dashboard-data.js');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await writeJson(path.join(f.root, 'protoflow.config.json'), f.config);
  const [delivery] = (await deliveryStatus(f.root)).deliveries;
  assert.equal(delivery.status, 'PR_OPEN_MANUAL');
  let view = await dashboardSnapshot(f.root, { service: false });
  assert.deepEqual(view.attention.filter(item => item.kind === 'manual-merge').map(item => item.deliveryId), [delivery.id]);
  process.env.FAKE_GH_REAL_REMOTE = f.remote; process.env.FAKE_GH_ROOT = f.root;
  const result = await runAction(f.root, { action: 'merge', deliveryId: delivery.id });
  assert.equal(result.status, 'PASS'); assert.equal(result.actor, 'human:fixture-person'); assert.equal(result.commit, delivery.commit);
  assert.equal((await f.gh()).prs.find(pr => pr.number === delivery.pr.number).state, 'MERGED');
  const merged = (await f.gh()).calls.find(call => call[1] === 'merge');
  assert.deepEqual(merged.slice(merged.indexOf('--match-head-commit'), merged.indexOf('--match-head-commit') + 2), ['--match-head-commit', delivery.commit]);
  const saved = (await deliveryStatus(f.root)).deliveries[0];
  assert.equal(saved.status, 'PR_OPEN_MANUAL'); assert.equal(saved.manualMerge.mergedBy, 'human:fixture-person'); assert.equal(saved.manualMerge.via, 'dashboard');
  view = await dashboardSnapshot(f.root, { service: false });
  assert.equal(view.attention.filter(item => item.kind === 'manual-merge').length, 0, 'a merged PR no longer waits');
  assert.deepEqual(await runAction(f.root, { action: 'merge', deliveryId: delivery.id }), { status: 'PASS', already: true, pr: saved.pr.url, mergeCommit: saved.manualMerge.mergeCommit });
  const log = (await fs.readFile(path.join(f.root, '.protoflow/dashboard/actions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => [entry.action, entry.status]), [['merge', 'PASS'], ['merge', 'PASS']]);
});

test('FAKE gh only: delivery sync records a manual PR a person merged on GitHub, so the dashboard stops asking to merge it', async t => {
  const f = await fixture(t, { merge: 'manual' });
  const { dashboardSnapshot } = await import('../src/dashboard-data.js');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await writeJson(path.join(f.root, 'protoflow.config.json'), f.config);
  const [delivery] = (await deliveryStatus(f.root)).deliveries;
  const merged = await onGitHub(f, 'merge');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'IDLE');
  const saved = (await deliveryStatus(f.root)).deliveries[0];
  assert.equal(saved.status, 'PR_OPEN_MANUAL');
  assert.deepEqual(saved.manualMerge, { mergedBy: 'github:fixture-person', mergedAt: merged.mergedAt, mergeCommit: merged.mergeCommit, via: 'github' });
  assert.equal(await git(f.remote, 'rev-parse', `${merged.mergeCommit}^2`), delivery.commit);
  const view = await dashboardSnapshot(f.root, { service: false });
  assert.equal(view.attention.filter(item => item.kind === 'manual-merge').length, 0);
});

test('single target: runner rebase takes up a manual PR a person merged on GitHub, and refuses while it is open or closed unmerged', async t => {
  const f = await fixture(t, { merge: 'manual' }); f.config.policy.autoApprove = true;
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  const [manual] = (await deliveryStatus(f.root)).deliveries;
  assert.equal(manual.status, 'PR_OPEN_MANUAL');
  const human = await humanCommit(f, 'docs/human.md', 'TASK-081\n');
  const v2 = `${'2'.repeat(8)}${'b'.repeat(32)}`;
  await acceptNext(f, { sha: v2, ordinal: 2, verificationId: 'VER-2', executionId: 'EXEC-fixture-2', content: '<main>v2</main>\n' });
  await assert.rejects(rebaseDeliveries(f.root, f.config, f.worktree), new RegExp(`Delivery ${manual.id} has an open pull request #${manual.pr.number}`));

  await onGitHub(f, { state: 'CLOSED', closedAt: '2026-10-22T23:37:33Z' });
  await assert.rejects(rebaseDeliveries(f.root, f.config, f.worktree), /was closed without merging and its commits are still on protoflow\/delivery/);
  assert.equal((await deliveryStatus(f.root)).deliveries[0].manualClosed.closedAt, '2026-10-22T23:37:33Z');
  await onGitHub(f, { state: 'OPEN', closedAt: null });
  await assert.rejects(rebaseDeliveries(f.root, f.config, f.worktree), /has an open pull request/);
  assert.equal((await deliveryStatus(f.root)).deliveries[0].manualClosed, undefined);

  const merged = await onGitHub(f, 'merge');
  const result = await rebaseDeliveries(f.root, f.config, f.worktree);
  assert.deepEqual([result.to, result.deliveries, result.versions], [merged.mergeCommit, [], [`git-${v2}`]]);
  assert.equal(await git(f.worktree, 'rev-parse', `${merged.mergeCommit}^1`), human);
  assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), merged.mergeCommit);
  const saved = (await deliveryStatus(f.root)).deliveries[0];
  assert.deepEqual([saved.status, saved.manualMerge.via, saved.manualMerge.mergeCommit], ['PR_OPEN_MANUAL', 'github', merged.mergeCommit]);
  const source = await sourceStatus(f.root);
  assert.deepEqual(source.entries.map(entry => entry.status), ['PASS', 'PENDING']);
  assert.equal(source.entries[0].deliveryId, manual.id);
});

test('FAKE gh only: the dashboard refuses to merge a manual PR whose head moved after review', async t => {
  const f = await fixture(t, { merge: 'manual' });
  const { runAction } = await import('../src/dashboard-actions.js');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await writeJson(path.join(f.root, 'protoflow.config.json'), f.config);
  const [delivery] = (await deliveryStatus(f.root)).deliveries;
  // Someone pushes another commit to the delivery branch after the independent review.
  const clone = path.join(f.base, 'late-push');
  await git(f.base, 'clone', '-q', '--branch', 'protoflow/delivery', f.remote, clone); await git(clone, 'config', 'user.email', 'fixture@protoflow.test'); await git(clone, 'config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(clone, 'LATE.md'), 'unreviewed\n'); await git(clone, 'add', 'LATE.md'); await git(clone, 'commit', '-q', '-m', 'late'); await git(clone, 'push', '-q', 'origin', 'HEAD:protoflow/delivery');
  await assert.rejects(runAction(f.root, { action: 'merge', deliveryId: delivery.id }), /is not the reviewed delivery commit/);
  assert.equal((await f.gh()).prs.find(pr => pr.number === delivery.pr.number).state, 'OPEN');
});

test('the dashboard approves a verified version as the configured person, bound to its verification', async t => {
  const f = await fixture(t);
  const { runAction } = await import('../src/dashboard-actions.js');
  const { dashboardSnapshot } = await import('../src/dashboard-data.js');
  f.config.dashboard = { reviewer: 'Fixture Person' };
  await writeJson(path.join(f.root, 'protoflow.config.json'), f.config);
  // The runner exports accepted evidence to the project root (exportEvidence); the fixture wrote it to the worktree.
  await fs.cp(path.join(f.worktree, '.protoflow/artifacts'), path.join(f.root, '.protoflow/artifacts'), { recursive: true });
  const view = await dashboardSnapshot(f.root, { service: false });
  const item = view.attention.find(entry => entry.kind === 'review');
  assert.ok(item, JSON.stringify(view.attention));
  const result = await runAction(f.root, { action: 'approve', manifestId: item.manifestId, verificationId: item.verificationId });
  assert.equal(result.status, 'PASS'); assert.equal(result.reviewer, 'Fixture Person');
  const review = await readJson(path.join(f.root, `.protoflow/reviews/${result.reviewId}.json`));
  assert.equal(review.status, 'approved'); assert.equal(review.reviewerKind ?? 'human', 'human'); assert.equal(review.verificationId, item.verificationId);
  assert.equal((await dashboardSnapshot(f.root, { service: false })).attention.filter(entry => entry.kind === 'review').length, 0);
  // A reviewer named in the request is ignored: the dashboard approves only as the configured person, never as an AI.
  const again = await runAction(f.root, { action: 'approve', manifestId: item.manifestId, verificationId: item.verificationId, reviewer: 'ai:someone' });
  assert.equal(again.reviewer, 'Fixture Person');
  assert.equal((await fs.readdir(path.join(f.root, '.protoflow/reviews'))).filter(name => name.endsWith('.json')).length, 2);
});
