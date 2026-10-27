import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus, rebaseDeliveries } from '../src/delivery.js';
import { runOnce } from '../src/runner.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { writeJson, hash, readJson } from '../src/util.js';
import { snapshot } from '../src/sessions.js';
import { recordedVerdict } from '../src/delivery-review.js';
import { fileURLToPath } from 'node:url';
import { git, fixture, assertNoPublication, openSpecLines, reviewRecord, multiFixture, humanCommit, acceptNext, plannedIssue, fakeVerify, idleRunner } from './helpers/delivery-fixture.js';

test('single target: after runner rebase the restarted version executes again on the new base instead of recovering its pre-rebase PASS', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const { versionQueue } = await import('../src/queue.js');
  // The runner names its worktree by the source: move the fixture's worktree there, as runner start would create it.
  const worktree = path.join(await fs.realpath(f.root), '.protoflow/runner', `worktree-${hash(f.config.source).slice(0, 12)}`);
  await git(f.root, 'worktree', 'move', f.worktree, worktree); f.worktree = worktree;
  f.config.adapters.codex = { command: { argv: [process.execPath, '-e', 'process.exit(9)'], timeoutMs: 60000 } };
  await writeJson(path.join(f.root, '.protoflow/runner/state.json'), { schemaVersion: 1, worktree, status: 'IDLE', configHash: hash(f.config) });
  const human = await humanCommit(f, 'docs/human.md', 'TASK-082\n');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
  // A maintainer answered the planner's questions with runner retry --answer before the base moved.
  const answered = await sourceStatus(f.root);
  answered.entries[0].retries = [{ previousStatus: 'BLOCKED', reason: 'Planner PLN-fixture needs a person: Which backend?', reasonCode: 'needs-human', at: '2026-10-27T04:57:00.000Z', answer: { text: 'Use the local backend.', via: 'cli' } }, { previousStatus: 'STOPPED', reason: 'Interrupted', at: '2026-10-27T04:57:30.000Z' }];
  await saveSourceState(f.root, answered);
  // Rebased by an engine that did not record the rebase for the queue (0.3.46): only the source state knows.
  const rebased = await rebaseDeliveries(f.root, f.config, f.worktree);
  assert.deepEqual(rebased.versions, [`git-${f.shas[0]}`]);
  // The version starts over, but the answer stays with it for its next plan, marked as given before the rebase.
  const [restarted] = (await sourceStatus(f.root)).entries;
  assert.deepEqual([restarted.status, restarted.attempts], ['PENDING', []]);
  assert.deepEqual(restarted.retries, [{ ...answered.entries[0].retries[0], carried: { by: 'rebase', at: rebased.at, archive: rebased.archive } }]);
  assert.equal((await versionQueue(f.worktree, f.config)).versions[0].acceptedBy, 'VER-1', 'before the fix the old PASS still accepts the version');

  const controller = new AbortController(), events = [];
  const result = await runOnce(f.root, f.config, { signal: controller.signal, onEvent: event => { events.push(event); if (event.event === 'execute') controller.abort(); } });
  assert.notEqual(result.recovered, true, JSON.stringify(result));
  assert.deepEqual(events.slice(0, 1).map(event => [event.event, event.manifestId, event.attempt]), [['execute', `git-${f.shas[0]}`, 0]], JSON.stringify({ result, events }));
  const id = `REBASE-${rebased.at.replace(/[:.]/g, '-')}`;
  for (const directory of [f.root, f.worktree]) {
    const record = await readJson(path.join(directory, `.protoflow/rebases/${id}.json`));
    assert.deepEqual([record.at, record.to, record.versions], [rebased.at, human, [`git-${f.shas[0]}`]]);
  }
  for (const directory of [f.root, f.worktree]) {
    const queue = await versionQueue(directory, f.config);
    assert.deepEqual([queue.current?.id, queue.versions[0].acceptedBy, queue.versions[0].rejections], [`git-${f.shas[0]}`, null, undefined]);
  }
  // A verification made after the rebase accepts the version again.
  await acceptNext(f, { sha: f.shas[0], ordinal: 1, verificationId: 'VER-1b', executionId: 'EXEC-fixture-1b', content: '<main>v1 on the current base</main>\n', reuseFrozen: true });
  assert.equal((await versionQueue(f.worktree, f.config)).versions[0].acceptedBy, 'VER-1b');
});

test('multi-target FAKE transport: an unpublished delivery whose base moved is rebuilt on the current base, unless a reviewer rejected it', async t => {
  for (const mode of ['approved', 'rejected']) await t.test(mode, async t => {
    const f = await multiFixture(t); f.config.policy.autoApprove = true;
    if (mode === 'approved') {
      const trigger = path.join(path.dirname(f.root), 'push-reject'); await fs.writeFile(trigger, 'armed');
      process.env.FAKE_DELIVERY_GIT_PUSH_REJECT = trigger;
      assert.equal((await syncDeliveries(f.root, f.config, { target: 'desktop' })).status, 'FAIL'); delete process.env.FAKE_DELIVERY_GIT_PUSH_REJECT;
    } else {
      process.env.FAKE_REVIEW_MODE = 'fail';
      assert.equal((await syncDeliveries(f.root, f.config, { target: 'desktop' })).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
    }
    const old = (await deliveryStatus(f.root, f.config, 'desktop')).deliveries[0];
    assert.equal(old.steps.pushedAt, undefined);
    // The sibling target merges first, so the base moves under the unpublished desktop delivery.
    assert.equal((await syncDeliveries(f.root, f.config, { target: 'web' })).status, 'PASS');
    const moved = await git(f.remote, 'rev-parse', 'main');
    const result = await syncDeliveries(f.root, f.config, { target: 'desktop' });
    const deliveries = (await deliveryStatus(f.root, f.config, 'desktop')).deliveries;
    if (mode === 'approved') {
      assert.equal(result.status, 'PASS', JSON.stringify(result));
      assert.deepEqual(deliveries.map(item => item.status), ['REVOKED', 'MERGED']);
      assert.deepEqual(deliveries[0].revocation.staleBase, { from: old.baseSha, to: moved });
      assert.equal(deliveries[1].baseSha, moved);
    } else {
      assert.equal(result.status, 'BLOCKED');
      assert.deepEqual(deliveries.map(item => item.status), ['BLOCKED'], 'a reviewer verdict is not discarded by rebuilding');
    }
  });
});

test('FAKE transport: a PASS lost to the network after the provider ran is re-reviewed automatically by the runner', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const trigger = path.join(f.base, 'outage-trigger');
  // The fake reviewer arms a one-shot GitHub outage right after returning PASS; the post-review check then fails.
  Object.assign(process.env, { FAKE_REVIEW_TRIGGER: trigger, FAKE_GH_UNAVAILABLE_AFTER: trigger });
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
  delete process.env.FAKE_REVIEW_TRIGGER; delete process.env.FAKE_GH_UNAVAILABLE_AFTER;
  const blocked = (await deliveryStatus(f.root)).deliveries[0], record = await reviewRecord(f, blocked.independentReviewId);
  assert.equal(record.status, 'BLOCKED'); assert.ok(record.processFile, 'the provider ran');
  assert.equal((await recordedVerdict(f.root, record)).status, 'PASS');
  const events = [];
  const result = await runOnce(f.root, f.config, { onEvent: event => events.push(event.event) });
  assert.equal(result.status, 'PASS', JSON.stringify(result)); assert.equal(events[0], 'review-retry');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'MERGED');
});

test('FAKE transport: in-place retries absorb a dropped read so the delivery completes in one sync', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const trigger = path.join(f.base, 'outage-trigger'); await fs.writeFile(trigger, 'armed');
  // One proxy failure of the next ls-remote: without retries the commit step blocks on it.
  process.env.FAKE_DELIVERY_GIT_UNAVAILABLE = trigger;
  process.env.PROTOFLOW_NETWORK_RETRIES = '1';
  const result = await syncDeliveries(f.root, f.config);
  delete process.env.FAKE_DELIVERY_GIT_UNAVAILABLE;
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  await assert.rejects(fs.access(trigger), { code: 'ENOENT' }, 'the outage happened and was absorbed');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'MERGED');
});

test('FAKE transport: a review whose provider was stopped before answering is retried as infrastructure', async t => {
  const { interruptedProvider } = await import('../src/delivery-review.js');
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const trigger = path.join(f.base, 'outage-trigger');
  Object.assign(process.env, { FAKE_REVIEW_TRIGGER: trigger, FAKE_GH_UNAVAILABLE_AFTER: trigger });
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
  delete process.env.FAKE_REVIEW_TRIGGER; delete process.env.FAKE_GH_UNAVAILABLE_AFTER;
  // Rewrite the attempt as a runner stop would have left it: no run, no answer, killed process.
  const delivery = (await deliveryStatus(f.root)).deliveries[0], file = path.join(f.root, `.protoflow/delivery/independent-reviews/${delivery.independentReviewId}.json`);
  const record = await readJson(file);
  for (const key of ['runFile', 'runHash', 'sessionId', 'traceHash', 'verdictHash', 'retryable', 'reasonCode']) delete record[key];
  record.reason = 'Independent review FAIL: provider did not complete safely';
  await writeJson(path.join(f.root, record.processFile), { status: 'FAIL', exitCode: null, spawned: true, stdout: '', stderr: '', processGroupActive: false, error: 'Command exited with a surviving subprocess group; terminated the group and blocked advancement' });
  record.processHash = hash(await readJson(path.join(f.root, record.processFile)));
  await writeJson(file, record);
  assert.equal(await interruptedProvider(f.root, record), true);
  assert.equal(await interruptedProvider(f.root, { ...record, status: 'PASS' }), false);
  const events = [];
  const result = await runOnce(f.root, f.config, { onEvent: event => events.push(event.event) });
  assert.equal(result.status, 'PASS', JSON.stringify(result)); assert.equal(events[0], 'review-retry');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'MERGED');
});

test('FAKE provider: Claude executor evidence is verified with the executor rules and bound with its provider', async t => {
  const execTrace = tools => [
    { type: 'system', subtype: 'init', session_id: 'claude-executor-1', tools, mcp_servers: [], model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits' },
    { type: 'assistant', session_id: 'claude-executor-1', message: { content: [{ type: 'tool_use', name: 'Edit' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-executor-1', result: 'FAKE FIXTURE ONLY' }
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
  for (const [tools, expected] of [[['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'], 'PASS'], [['Read', 'Edit', 'WebFetch'], 'BLOCKED']]) {
    const f = await fixture(t);
    const file = path.join(f.worktree, '.protoflow/contexts/EXEC-fixture-1.json'), record = await readJson(file);
    Object.assign(record, { executor: 'claude' }); record.result.stdout = execTrace(tools);
    await writeJson(file, record);
    const result = await syncDeliveries(f.root, f.config);
    assert.equal(result.status, expected, JSON.stringify(result));
    if (expected === 'PASS') {
      const [delivery] = (await deliveryStatus(f.root)).deliveries;
      const { binding } = await readJson(path.join(f.root, `.protoflow/delivery/independent-reviews/${delivery.independentReviewId}/request.json`));
      assert.deepEqual(binding.executors.map(item => [item.executor, item.sessionId]), [['claude', 'claude-executor-1']]);
    } else assert.match(result.deliveries[0].error, /beyond the executor set: WebFetch/);
  }
});

test('FAKE provider: a Claude acceptor reviews the same bound request, and its FAIL blocks like any verdict', async t => {
  const claudeReview = fileURLToPath(new URL('../scripts/claude-review-adapter.js', import.meta.url));
  for (const mode of ['review-pass', 'review-fail']) {
    const f = await fixture(t); delete process.env.PROTOFLOW_CLAUDE;
    f.config.adapters.independentReview = { provider: 'claude', command: { argv: [process.execPath, claudeReview, '--model', 'claude-opus-5-5', '--max-budget-usd', '5'], timeoutMs: 60000 } };
    process.env.FAKE_CLAUDE_MODE = mode;
    const result = await syncDeliveries(f.root, f.config); delete process.env.FAKE_CLAUDE_MODE;
    const [delivery] = (await deliveryStatus(f.root)).deliveries;
    const record = await reviewRecord(f, delivery.independentReviewId);
    const request = await readJson(path.join(f.root, record.requestFile)), run = await readJson(path.join(f.root, `.protoflow/delivery/independent-reviews/${record.id}/run.json`));
    assert.equal(request.binding.provider, 'claude'); assert.match(request.binding.providerExecutable.path, /claude$/);
    assert.equal(run.provider, 'claude'); assert.equal(run.sandbox, 'read-only'); assert.equal(run.sessionId, 'fake-session-a');
    if (mode === 'review-pass') {
      assert.equal(result.status, 'PASS', JSON.stringify(result)); assert.equal(delivery.status, 'MERGED'); assert.equal(record.status, 'PASS');
    } else {
      assert.equal(result.status, 'BLOCKED'); assert.equal(record.status, 'BLOCKED'); assert.match(record.reason, /Independent review FAIL/);
      assert.equal((await recordedVerdict(f.root, record)).findings[0].description, 'Synthetic Claude fixture finding, no real provider review');
    }
  }
});

test('FAKE provider: the Claude acceptor must be the shared adapter with known options and a read-only trace', async t => {
  const claudeReview = fileURLToPath(new URL('../scripts/claude-review-adapter.js', import.meta.url));
  for (const [argv, mode, pattern] of [
    [[process.execPath, claudeReview, '--dangerously-skip-permissions', 'yes'], 'review-pass', /Unsupported independent review adapter options/],
    [[process.execPath, fileURLToPath(new URL('../scripts/codex-review-adapter.js', import.meta.url))], 'review-pass', /must use the shared read-only Claude review adapter/],
    [[process.execPath, claudeReview], 'write-tool', /provider did not complete safely/]
  ]) {
    const f = await fixture(t); delete process.env.PROTOFLOW_CLAUDE;
    f.config.adapters.independentReview = { provider: 'claude', command: { argv, timeoutMs: 60000 } };
    process.env.FAKE_CLAUDE_MODE = mode;
    const result = await syncDeliveries(f.root, f.config); delete process.env.FAKE_CLAUDE_MODE;
    assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
    const record = await reviewRecord(f, (await deliveryStatus(f.root)).deliveries[0].independentReviewId);
    assert.match(record.reason, pattern);
    if (mode === 'write-tool') assert.match(JSON.parse((await readJson(path.join(f.root, record.processFile))).stdout).error, /offered tools beyond read-only: Bash/);
    await assertNoPublication(f);
  }
});

test('FAKE provider: a planned version binds its plan criteria for the acceptor, who must not be the planner session', async t => {
  const claudeReview = fileURLToPath(new URL('../scripts/claude-review-adapter.js', import.meta.url));
  const criteria = [{ id: 'AC1', text: 'FAKE FIXTURE CRITERION: index shows v1', anchors: [], evidence: 'code' }];
  for (const [name, sessionId, tamper, expected, pattern] of [
    ['bound', 'planner-session-1', false, 'PASS', null],
    ['planner reviews', 'fake-session-a', false, 'BLOCKED', /separate fresh session from every planner, executor and author/],
    ['changed plan', 'planner-session-1', true, 'BLOCKED', /Plan PLN-fixture-1 is missing, changed or belongs to another version/]
  ]) {
    const f = await fixture(t); delete process.env.PROTOFLOW_CLAUDE;
    f.config.adapters.independentReview = { provider: 'claude', command: { argv: [process.execPath, claudeReview, '--model', 'claude-opus-5-5'], timeoutMs: 60000 } };
    const plan = { decision: 'implement', level: 'L1', summary: 'FAKE FIXTURE PLAN', steps: ['edit index'], acceptanceCriteria: criteria, tests: [], risks: [], questions: [] };
    await writeJson(path.join(f.worktree, '.protoflow/plans/PLN-fixture-1.json'), { id: 'PLN-fixture-1', manifestId: `git-${f.shas[0]}`, sessionId, plan: tamper ? { ...plan, summary: 'edited later' } : plan, planHash: hash(plan) });
    const stateFile = path.join(f.root, '.protoflow/source/state.json'), state = await readJson(stateFile);
    state.entries[0].planId = 'PLN-fixture-1'; await saveSourceState(f.root, state);
    process.env.FAKE_CLAUDE_MODE = 'review-pass'; process.env.FAKE_CLAUDE_RECORD = path.join(f.base, 'claude-input.json');
    const result = await syncDeliveries(f.root, f.config); delete process.env.FAKE_CLAUDE_MODE; delete process.env.FAKE_CLAUDE_RECORD;
    assert.equal(result.status, expected, `${name}: ${JSON.stringify(result)}`);
    if (expected === 'PASS') {
      const record = await reviewRecord(f, (await deliveryStatus(f.root)).deliveries[0].independentReviewId);
      const { binding } = await readJson(path.join(f.root, record.requestFile));
      assert.deepEqual(binding.versions[0].plan, { id: 'PLN-fixture-1', planHash: hash(plan), sessionId: 'planner-session-1', acceptanceCriteria: criteria });
      const { input } = await readJson(path.join(f.base, 'claude-input.json'));
      assert.match(input, /acceptanceCriteria come from an independent planner/); assert.match(input, /FAKE FIXTURE CRITERION: index shows v1/);
    } else {
      const delivery = (await deliveryStatus(f.root)).deliveries[0];
      const reason = delivery?.independentReviewId ? (await reviewRecord(f, delivery.independentReviewId)).reason : JSON.stringify(result);
      assert.match(reason, pattern, name);
      await assertNoPublication(f);
    }
  }
});

test('FAKE providers only: a planned issue waits for the delivered prototype stream, then is fixed, reviewed, merged by PR and closed', async t => {
  const f = await fixture(t);
  f.config.runner.delivery.prBodyTrailers = ['OpenSpec-Change: rewrite-mobile-ui'];
  const { issues, record } = await plannedIssue(f);
  const { runIssues } = await import('../src/issue-runner.js');
  await idleRunner(f);
  // Prototype work comes first: the accepted version is not delivered yet.
  assert.match((await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify() })).reason, /Issue #12 waits: the prototype stream has work/);
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  // A rejected, retired delivery is settled too: it must not keep the target busy.
  const deliveries = await readJson(path.join(f.root, '.protoflow/delivery/state.json'));
  deliveries.deliveries.unshift({ id: 'DLV-retired-fixture', status: 'REVOKED', versions: [] });
  await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), deliveries);
  await idleRunner(f);
  const events = [];
  const result = await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify(), onEvent: event => events.push(event.event) });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.deepEqual(events.filter(name => name.startsWith('issue-')), ['issue-started', 'issue-execute', 'issue-verified', 'issue-reviewed', 'issue-merged', 'issue-done']);
  const state = JSON.parse(await fs.readFile(path.join(f.root, '.protoflow/issues/state.json'), 'utf8')).issues[12];
  const work = state.targets.application;
  assert.equal(state.status, 'done'); assert.equal(work.status, 'MERGED');
  // The fix reached the base through its own PR; the commit names the issue and its evidence.
  assert.equal(await git(f.remote, 'show', 'main:app/index.html'), '<main>v1 fixed</main>');
  assert.equal(await git(f.remote, 'show', 'main:app/index.test.js'), '// FAKE FIXTURE TEST');
  assert.match(await git(f.worktree, 'log', '-1', '--format=%B', work.commit), /^Fix #12: Index shows the wrong label\n\nFixes #12\nIssue-Snapshot: ISS-12-[0-9a-f]{12}\nPlan: PLN-fixture-12\n/);
  const pr = (await f.gh()).prs.find(item => item.head === 'protoflow/issue-12');
  assert.equal(pr.state, 'MERGED'); assert.equal(pr.title, 'Fix #12: Index shows the wrong label');
  assert.deepEqual(openSpecLines(pr.body), ['OpenSpec-Change: rewrite-mobile-ui']); assert.match(pr.body, /^Fixes #12\n[\s\S]*not a human approval\.\n\nOpenSpec-Change: rewrite-mobile-ui$/);
  assert.match(work.approval.reviewer, /^ai:codex-independent-review:review-fixture-AIR-/);
  // The acceptor judged the issue binding: snapshot, plan criteria and a regression verification of the latest version.
  const review = await reviewRecord(f, work.reviewId);
  const { binding } = await readJson(path.join(f.root, review.requestFile));
  assert.deepEqual(binding.issue.plan.acceptanceCriteria, record.plan.acceptanceCriteria); assert.equal(binding.issue.plan.sessionId, 'planner-session-12');
  assert.equal(binding.versions.length, 1); assert.equal(binding.versions[0].regression, true); assert.equal(binding.versions[0].verificationId, work.verificationId);
  assert.deepEqual(binding.executors.map(item => item.sessionId), ['executor-issue-1']);
  assert.equal(binding.remote.branch, 'protoflow/issue-12');
  // The issue is closed with an AI-labelled record of what merged.
  const issue = await issues();
  assert.equal(issue.state, 'closed'); assert.deepEqual(issue.labels, ['protoflow', 'protoflow:done']);
  assert.deepEqual(issue.comments.map(comment => comment.body.split('\n')[0]), ['<!-- protoflow:issue-started 12 -->', '<!-- protoflow:issue-done 12 -->']);
  assert.match(issue.comments[1].body, /Closed automatically after every planned target merged[\s\S]*not a human approval/);
  assert.deepEqual(await runIssues(f.root, f.config, null, { verifyVersion: fakeVerify() }), { status: 'IDLE' });
});
