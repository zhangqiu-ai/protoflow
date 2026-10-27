import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus, deliveryReport } from '../src/delivery.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { writeJson, fingerprint, readJson } from '../src/util.js';
import { createReview, decideReview } from '../src/workflow.js';
import { requestIndependentReview } from '../src/delivery-review.js';
import { transientFailure } from '../src/delivery-scope.js';
import { fileURLToPath } from 'node:url';
import { exec, git, fixtureRepository, fixture, committedFixture, assertNoPublication, restartProgram, reviewRecord } from './helpers/delivery-fixture.js';

test('FAKE GitHub: same-named fork branches and changed PR refs block comments and manual completion', async t => {
  for (const mode of ['fork-repository', 'head-sha', 'base-sha']) await t.test(mode, async t => {
    const f = await fixture(t, { merge: 'manual' });
    const pr = { number: 1, repository: fixtureRepository, head: f.config.runner.delivery.branch, base: 'main', state: 'OPEN', comments: [] };
    if (mode === 'fork-repository') pr.headRepo = { id: 999, full_name: 'attacker/application', html_url: 'https://github.com/attacker/application' };
    if (mode === 'head-sha') pr.headSha = '0'.repeat(40);
    if (mode === 'base-sha') pr.baseSha = '0'.repeat(40);
    await writeJson(path.join(f.base, 'gh.json'), { prs: [pr], calls: [], environments: [] });
    const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
    assert.match(result.deliveries[0].error, /PR repository\/base\/head identity/);
    const github = await f.gh(); assert.equal(github.prs[0].comments.length, 0); assert.ok(!github.calls.some(call => ['create', 'comment', 'ready', 'merge'].includes(call[1])));
  });
});

test('FAKE GitHub: a recovered PR is checked again for fork repository identity', async t => {
  const f = await fixture(t, { merge: 'manual' }); process.env.FAKE_GH_FAIL = 'comment';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
  const github = await f.gh(); github.prs[0].headRepo = { id: 999, full_name: 'attacker/application', html_url: 'https://github.com/attacker/application' };
  await writeJson(path.join(f.base, 'gh.json'), github);
  const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
  assert.match(result.deliveries[0].error, /PR repository\/base\/head identity/); assert.equal((await f.gh()).prs[0].comments.length, 0);
});

test('FAKE GitHub: discovery/create/lookup/comment drift is checked before the next mutation and manual PASS', async t => {
  for (const phase of ['list', 'create', 'lookup', 'pull-api', 'comment']) await t.test(phase, async t => {
    const f = await fixture(t, { merge: 'manual' }); process.env.FAKE_GH_DRIFT = phase;
    const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
    assert.match(result.deliveries[0].error, /committed tree|drifted/);
    const github = await f.gh(); assert.equal(github.prs.length, phase === 'list' ? 0 : 1);
    assert.equal(github.prs[0]?.comments.length ?? 0, phase === 'comment' ? 1 : 0);
    assert.ok(!github.calls.some(call => ['ready', 'merge'].includes(call[1])));
    assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'BLOCKED');
  });
});

test('FAKE provider: automated approval requires the separate gate and never uses GitHub self-approval/admin', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const delivery = (await deliveryStatus(f.root)).deliveries[0]; assert.ok(delivery.approval.independentReviewId);
  const approved = await readJson(path.join(f.root, `.protoflow/reviews/${delivery.approval.reviewId}.json`));
  assert.equal(approved.reviewerKind, 'automated'); assert.match(approved.reviewer, /^ai:codex-independent-review:/);
  assert.equal(approved.independentReview.id, delivery.independentReviewId);
  const baseline = await readJson(path.join(f.root, `.protoflow/baselines/${delivery.approval.baselineId}.json`)), report = await readJson(path.join(f.root, '.protoflow/verifications/VER-1.json'));
  assert.equal(approved.independentReview.commit, delivery.commit); assert.equal(approved.independentReview.tree, await git(f.worktree, 'rev-parse', 'HEAD^{tree}')); assert.equal(approved.independentReview.baseSha, delivery.baseSha);
  assert.equal(baseline.application.git, delivery.commit); assert.equal(baseline.application.verificationGit, report.git.head); assert.notEqual(baseline.application.git, report.git.head);
  assert.ok((await f.gh()).calls.every(call => !call.includes('--admin') && !(call[0] === 'pr' && call[1] === 'review')));
  delete f.config.adapters.independentReview; assert.equal((await syncDeliveries(f.root, f.config)).status, 'IDLE');
});

test('FAKE provider: under autoApprove a version that passed with maintainer waivers waits for a person, then merges with the human approval', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  // FAKE waiver usage recorded on the synthetic PASS (proposal 0005 D).
  const waivers = [{ id: 'WVR-fixture-1', target: null, scene: 'nav.sidebar.initial', variant: null, tier: 'structure', findings: ['nav.sidebar: text "Inbox" vs "Settings"'], reason: 'FAKE engine limit', engineIssue: null }];
  for (const dir of [f.root, f.worktree]) {
    const file = path.join(dir, '.protoflow/verifications/VER-1.json');
    await writeJson(file, { ...await readJson(file), waivers });
  }
  const blocked = await syncDeliveries(f.root, f.config);
  assert.equal(blocked.status, 'BLOCKED', JSON.stringify(blocked));
  assert.deepEqual([blocked.deliveries[0].status, blocked.deliveries[0].reasonCode], ['BLOCKED', 'WAIVER_APPROVAL_REQUIRED']);
  assert.match(blocked.deliveries[0].error, /VER-1, waivers WVR-fixture-1\) passed with maintainer waivers; under policy\.autoApprove a person approves it on the dashboard/);
  assert.ok(!(await f.gh()).calls.some(call => call[0] === 'pr' && call[1] === 'merge'));
  assert.equal((await deliveryStatus(f.root)).deliveries[0].approval, undefined);
  // A person's approval of exactly this verification, made in the runner worktree and copied to the project as the dashboard does.
  const review = await createReview(f.worktree, f.config, `git-${f.shas[0]}`, 'VER-1');
  await decideReview(f.worktree, f.config, review.id, { status: 'approved', reviewer: 'FAKE fixture human', notes: 'FAKE waiver approval fixture only' });
  await writeJson(path.join(f.root, `.protoflow/reviews/${review.id}.json`), await readJson(path.join(f.worktree, `.protoflow/reviews/${review.id}.json`)));
  const merged = await syncDeliveries(f.root, f.config);
  assert.equal(merged.status, 'PASS', JSON.stringify(merged));
  const delivery = (await deliveryStatus(f.root)).deliveries[0];
  assert.deepEqual([delivery.status, delivery.approval.kind, delivery.approval.reviewId, delivery.approval.reviewer, delivery.approval.waivers], ['MERGED', 'human', review.id, 'FAKE fixture human', ['WVR-fixture-1']]);
  assert.ok(delivery.approval.independentReviewId);
  const call = (await f.gh()).calls.find(item => item[0] === 'pr' && item[1] === 'comment') ?? [];
  const comment = call[call.indexOf('--body') + 1] ?? '';
  assert.match(comment, /PASS with waivers WVR-fixture-1 \(nav\.sidebar\.initial structure\)/);
  assert.match(comment, /Acceptance: 0 passed, 1 passed with maintainer waivers/);
  assert.match(comment, /Approval: \*\*human\*\* by FAKE fixture human/);
  const report = await deliveryReport(f.root, f.config);
  assert.deepEqual(report.deliveries[0].counts, { passed: 0, passedWithWaivers: 1, waivers: ['WVR-fixture-1'] });
});

test('FAKE provider: main/base delivery scope is blocked before committing application files', async t => {
  const f = await fixture(t), before = await git(f.worktree, 'rev-parse', 'HEAD'); f.config.runner.delivery.branch = 'main';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), before);
  await assertNoPublication(f);
});

test('FAKE provider: delivery paths preserve an existing index outside scope and reject protected prefixes', async t => {
  const f = await fixture(t), head = await git(f.worktree, 'rev-parse', 'HEAD'); f.config.runner.delivery.paths = ['app'];
  await fs.appendFile(path.join(f.worktree, 'README.md'), 'staged user change'); await git(f.worktree, 'add', 'README.md');
  const index = await git(f.worktree, 'write-tree');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); assert.equal(await git(f.worktree, 'write-tree'), index); assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), head);
  await assertNoPublication(f);
  for (const prefix of ['../outside', '/absolute', '.', '.git', '.protoflow', 'node_modules', 'app/.env', 'prototype', 'app/private.pem']) {
    f.config.runner.delivery.paths = [prefix]; const result = await syncDeliveries(f.root, f.config);
    assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, /Unsafe delivery allowlist/);
  }
});

test('FAKE provider: allowlisted v1 draft stays manual and v2 readies/merges the same PR after its own gate', async t => {
  const f = await fixture(t, { versions: 2, merge: 'manual' }); f.config.runner.delivery.paths = ['app']; f.config.runner.delivery.draft = true;
  const source = await sourceStatus(f.root); source.entries[1].status = 'PENDING'; await saveSourceState(f.root, source);
  const first = await syncDeliveries(f.root, f.config); assert.equal(first.status, 'PASS', JSON.stringify(first)); assert.equal(first.deliveries[0].status, 'PR_OPEN_MANUAL');
  assert.equal((await f.gh()).prs[0].isDraft, true); assert.ok(!(await f.gh()).calls.some(call => call[1] === 'ready' || call[1] === 'merge'));
  await fs.appendFile(path.join(f.worktree, 'app/index.html'), '<section>fake v2</section>');
  const project = await fingerprint(f.worktree, { exclude: ['prototype'], gitIgnore: true });
  for (const root of [f.root, f.worktree]) { const file = path.join(root, '.protoflow/verifications/VER-2.json'), report = await readJson(file); report.project = project; report.git.head = await git(f.worktree, 'rev-parse', 'HEAD'); await writeJson(file, report); }
  const current = await sourceStatus(f.root); current.entries[1].status = 'PASS'; await saveSourceState(f.root, current); f.config.runner.delivery.merge = 'auto';
  const second = await syncDeliveries(f.root, f.config); assert.equal(second.status, 'PASS', JSON.stringify(second)); assert.equal(second.deliveries[0].status, 'MERGED');
  const db = await f.gh(); assert.equal(db.prs.length, 1); assert.equal(db.prs[0].isDraft, false); assert.equal(db.prs[0].comments.length, 2);
  assert.ok(db.calls.findIndex(call => call[1] === 'ready') < db.calls.findIndex(call => call[1] === 'merge'));
  assert.equal((await deliveryStatus(f.root)).deliveries.length, 2);
  assert.deepEqual((await git(f.worktree, 'show', '--name-only', '--format=', second.deliveries[0].commit)).split('\n'), ['app/index.html']);
});

test('FAKE provider: a newer remote base outside HEAD ancestry cannot be reviewed as integrated', async t => {
  const f = await committedFixture(t), baseTree = await git(f.root, 'rev-parse', 'HEAD^{tree}');
  const newerBase = await git(f.root, 'commit-tree', baseTree, '-p', 'HEAD', '-m', 'FAKE newer main');
  await git(f.root, 'push', '-q', 'origin', `${newerBase}:refs/heads/main`);
  const review = await requestIndependentReview(f.root, f.config, f.reviewOptions); assert.equal(review.status, 'BLOCKED'); assert.match(review.reason, /not an ancestor/);
  await assertNoPublication(f);
});

test('FAKE provider: explicit failed-review retry creates a fresh attempt without overwriting raw evidence', async t => {
  // The provider exited without a verdict; a reviewer FAIL is never retried (see the next test).
  const f = await fixture(t); process.env.FAKE_REVIEW_MODE = 'exit';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
  const first = (await deliveryStatus(f.root)).deliveries[0], oldFile = path.join(f.root, `.protoflow/delivery/independent-reviews/${first.independentReviewId}.json`), bytes = await fs.readFile(oldFile), record = JSON.parse(bytes), traceBytes = await fs.readFile(path.join(f.root, record.processFile));
  assert.equal(record.runFile, undefined); assert.equal(record.retryable, undefined);
  process.env.FAKE_REVIEW_MODE = 'pass';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); assert.equal((await deliveryStatus(f.root)).deliveries[0].independentReviewId, first.independentReviewId);
  assert.equal((await syncDeliveries(f.root, f.config, { retryIndependentReview: { deliveryId: first.id, reviewId: 'AIR-stale-attempt' } })).status, 'BLOCKED'); await assertNoPublication(f);
  const result = await syncDeliveries(f.root, f.config, { retryIndependentReview: { deliveryId: first.id, reviewId: first.independentReviewId } }); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const second = (await deliveryStatus(f.root)).deliveries[0]; assert.equal(second.commit, first.commit); assert.notEqual(second.independentReviewId, first.independentReviewId);
  assert.deepEqual(second.independentReviewAttempts.map(attempt => attempt.status), ['BLOCKED', 'PASS']); assert.equal(second.independentReviewAttempts[1].supersedes, first.independentReviewId);
  assert.deepEqual(await fs.readFile(oldFile), bytes); assert.deepEqual(await fs.readFile(path.join(f.root, record.processFile)), traceBytes);
  assert.equal((await syncDeliveries(f.root, f.config, { retryIndependentReview: { deliveryId: second.id, reviewId: second.independentReviewId } })).status, 'BLOCKED');
});

test('transient classification covers proxy, network and HTTP 5xx failures but not review or permission errors', () => {
  for (const text of ['Canonical GitHub repository lookup failed: Get "https://api.github.com/repos/o/r": EOF', 'Get "https://api.github.com/repos/o/r": context deadline exceeded', 'Post "https://api.github.com/graphql": net/http: request canceled (Client.Timeout exceeded while awaiting headers)', "fatal: unable to access 'https://github.com/o/r.git/': Recv failure: Connection reset by peer", "fatal: unable to access 'https://github.com/o/r.git/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443", "fatal: unable to access 'https://github.com/o/r.git/': CONNECT tunnel failed, response 503", 'CONNECT tunnel failed, response 0', 'Post "https://api.github.com/graphql": Service Unavailable', 'HTTP 502: Bad Gateway (https://api.github.com/repos/o/r)', 'error: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504', 'fatal: unable to access: Could not resolve host: github.com', 'read tcp: connection reset by peer'])
    assert.equal(transientFailure(text), true, text);
  for (const text of ['Independent review FAIL; bound verificationHash differs', 'HTTP 404: Not Found (https://api.github.com/repos/o/r)', 'HTTP 422: Validation Failed', 'remote: Permission to o/r.git denied', 'Current delivery base SHA is unavailable', '', undefined])
    assert.equal(transientFailure(text), false, String(text));
});

test('FAKE transport: a published delivery stranded by transient GitHub/proxy failures is revalidated and resumed explicitly', async t => {
  // Dual acceptance, electron 06cc5de: approval and push succeeded, then GitHub answered 503 to pr create.
  const f = await fixture(t); f.config.policy.autoApprove = true;
  Object.assign(process.env, { FAKE_GH_FAIL: 'create', FAKE_GH_FAIL_MESSAGE: 'Post "https://api.github.com/graphql": Service Unavailable' });
  const failed = await syncDeliveries(f.root, f.config);
  assert.equal(failed.status, 'FAIL'); assert.equal(failed.deliveries[0].retryable, true, JSON.stringify(failed));
  const first = (await deliveryStatus(f.root)).deliveries[0];
  assert.ok(first.approval && first.steps.pushedAt && !first.pr);
  delete process.env.FAKE_GH_FAIL; delete process.env.FAKE_GH_FAIL_MESSAGE;
  // After a restart: the revalidation's provider runs, then the canonical repository lookup answers 503 once.
  // The next retry meets a proxy failure of ls-remote before the provider runs.
  const trigger = path.join(f.base, 'outage-trigger');
  const restarted = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram(`
    results.push(await syncDeliveries(root, config));
    process.env.FAKE_REVIEW_TRIGGER = trigger; process.env.FAKE_GH_UNAVAILABLE_AFTER = trigger; await retry();
    delete process.env.FAKE_REVIEW_TRIGGER; delete process.env.FAKE_GH_UNAVAILABLE_AFTER;
    await fs.writeFile(trigger, 'armed'); process.env.FAKE_DELIVERY_GIT_UNAVAILABLE = trigger; await retry();`), f.root, JSON.stringify(f.config), trigger])).stdout);
  const [unattested, postProvider, preProvider] = restarted.results;
  assert.equal(unattested.status, 'BLOCKED'); assert.match(unattested.deliveries[0].error, /live engine attestation/);
  assert.equal(postProvider.status, 'BLOCKED'); assert.equal(postProvider.deliveries[0].retryable, true, JSON.stringify(postProvider));
  assert.equal(preProvider.status, 'BLOCKED', JSON.stringify(restarted)); assert.equal(preProvider.deliveries[0].retryable, true);
  const stranded = restarted.state.deliveries[0], [, afterProvider, beforeProvider] = stranded.independentReviewAttempts;
  const ranRecord = await reviewRecord(f, afterProvider.id), proxyRecord = await reviewRecord(f, beforeProvider.id);
  assert.match(ranRecord.reason, /Canonical GitHub repository lookup failed: .*Service Unavailable/); assert.ok(ranRecord.sessionId, 'the provider ran before the outage');
  assert.match(proxyRecord.reason, /CONNECT tunnel failed, response 503/); assert.equal(proxyRecord.processFile, undefined);
  for (const record of [ranRecord, proxyRecord]) { assert.equal(record.status, 'BLOCKED'); assert.equal(record.retryable, true); assert.equal(record.reasonCode, 'TRANSIENT_INFRASTRUCTURE'); }
  assert.deepEqual(stranded.approval, first.approval); assert.equal(stranded.independentReviewId, beforeProvider.id);
  const recordBytes = await Promise.all([afterProvider.id, beforeProvider.id].map(id => fs.readFile(path.join(f.root, `.protoflow/delivery/independent-reviews/${id}.json`))));
  // The documented CLI retry, again in a new process: fresh provider PASS, full re-assert, new approval, then publication.
  await writeJson(path.join(f.root, 'protoflow.config.json'), f.config);
  const cli = fileURLToPath(new URL('../bin/protoflow.js', import.meta.url));
  const resumed = JSON.parse((await exec(process.execPath, [cli, 'delivery', 'sync', '--retry-review', '--delivery', stranded.id, '--review', stranded.independentReviewId, '--project', f.root])).stdout);
  assert.equal(resumed.status, 'PASS', JSON.stringify(resumed));
  const done = (await deliveryStatus(f.root)).deliveries[0];
  assert.equal(done.status, 'MERGED'); assert.equal(done.commit, first.commit); assert.equal(done.retryable, undefined);
  assert.deepEqual(done.independentReviewAttempts.map(attempt => attempt.status), ['PASS', 'BLOCKED', 'BLOCKED', 'PASS']);
  assert.equal(done.independentReviewAttempts[3].supersedes, beforeProvider.id);
  assert.equal(done.approval.independentReviewId, done.independentReviewId); assert.notEqual(done.independentReviewId, first.independentReviewId);
  assert.deepEqual(done.approvalHistory, [first.approval]);
  const prs = (await f.gh()).prs; assert.equal(prs.length, 1); assert.equal(prs[0].state, 'MERGED'); assert.equal(prs[0].comments.length, 1);
  assert.deepEqual(await Promise.all([afterProvider.id, beforeProvider.id].map(id => fs.readFile(path.join(f.root, `.protoflow/delivery/independent-reviews/${id}.json`)))), recordBytes);
});

test('FAKE provider: a reviewer FAIL verdict is never retried, before or after approval, even if its record is edited to look transient', async t => {
  const unpublished = await fixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(unpublished.root, unpublished.config)).status, 'BLOCKED');
  const blocked = (await deliveryStatus(unpublished.root)).deliveries[0];
  process.env.FAKE_REVIEW_MODE = 'pass';
  const refused = await syncDeliveries(unpublished.root, unpublished.config, { retryIndependentReview: { deliveryId: blocked.id, reviewId: blocked.independentReviewId } });
  assert.equal(refused.status, 'BLOCKED'); assert.match(refused.reason, /returned FAIL with 1 finding\(s\); a reviewer verdict is never retried/);
  assert.equal((await deliveryStatus(unpublished.root)).deliveries[0].independentReviewAttempts.length, 1); await assertNoPublication(unpublished);

  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'create';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
  const first = (await deliveryStatus(f.root)).deliveries[0];
  // A restarted engine revalidates; the fresh reviewer now returns FAIL.
  const failed = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram(`process.env.FAKE_REVIEW_MODE = 'fail'; await retry();`), f.root, JSON.stringify(f.config), ''])).stdout);
  assert.equal(failed.results[0].status, 'BLOCKED'); assert.equal(failed.results[0].deliveries[0].retryable, false);
  const failedId = failed.state.deliveries[0].independentReviewId, file = path.join(f.root, `.protoflow/delivery/independent-reviews/${failedId}.json`), record = await readJson(file);
  assert.equal(record.retryable, undefined); assert.match(record.reason, /Independent review FAIL/);
  for (const edit of [false, true]) {
    if (edit) await writeJson(file, { ...record, retryable: true, reasonCode: 'TRANSIENT_INFRASTRUCTURE' });
    const again = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram(`await retry();`), f.root, JSON.stringify(f.config), ''])).stdout);
    assert.equal(again.results[0].status, 'BLOCKED'); assert.match(again.results[0].reason, /a reviewer verdict is never retried/);
    assert.equal(again.state.deliveries[0].independentReviewId, failedId); assert.equal(again.state.deliveries[0].independentReviewAttempts.length, 2);
  }
  assert.deepEqual((await deliveryStatus(f.root)).deliveries[0].approval, first.approval); assert.deepEqual((await f.gh()).prs, []);
});
