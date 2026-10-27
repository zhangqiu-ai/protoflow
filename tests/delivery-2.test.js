import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus, assertDelivered } from '../src/delivery.js';
import { runOnce } from '../src/runner.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { writeJson, readJson } from '../src/util.js';
import { assertIndependentReview, requestIndependentReview } from '../src/delivery-review.js';
import { git, fixture, acceptVersion, committedFixture, assertNoPublication, rejectAcceptance, acceptRepair } from './helpers/delivery-fixture.js';

test('FAKE recovery: a resolved historical revocation permits later normal versions to reuse the accepted manual PR', async t => {
  const f = await fixture(t, { merge: 'none' });
  assert.equal((await syncDeliveries(f.root, f.config)).deliveries[0].status, 'PR_OPEN_MANUAL');
  await rejectAcceptance(f, f.root);
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  const github = await f.gh(); github.prs[0].state = 'CLOSED'; await writeJson(path.join(f.base, 'gh.json'), github);
  await acceptRepair(f);
  const replacement = await syncDeliveries(f.root, f.config);
  assert.equal(replacement.status, 'PASS', JSON.stringify(replacement)); assert.equal(replacement.deliveries[0].status, 'PR_OPEN_MANUAL');
  const manual = (await deliveryStatus(f.root)).deliveries.at(-1), sha = '3'.repeat(40);
  await fs.writeFile(path.join(f.worktree, 'app/index.html'), '<main>normal next version</main>\n');
  await acceptVersion({ ...f, sha, ordinal: 2, verificationId: 'VER-normal-next', executionId: 'EXEC-fixture-normal-next' });
  const source = await sourceStatus(f.root);
  source.entries.push({ sha, manifestId: `git-${sha}`, ordinal: 2, status: 'PASS', verificationId: 'VER-normal-next', attempts: [{ executionId: 'EXEC-fixture-normal-next', executionStatus: 'PASS', status: 'PASS' }] });
  await saveSourceState(f.root, source);
  const next = await syncDeliveries(f.root, f.config);
  assert.equal(next.status, 'PASS', JSON.stringify(next)); assert.equal(next.deliveries[0].status, 'PR_OPEN_MANUAL');
  const latest = (await deliveryStatus(f.root)).deliveries.at(-1);
  assert.equal(latest.pr.number, manual.pr.number); assert.equal(latest.pr.url, manual.pr.url); assert.notEqual(latest.commit, manual.commit);
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/protoflow/delivery'), latest.commit);
  assert.deepEqual((await f.gh()).prs.map(pr => [pr.state, pr.comments.length]), [['CLOSED', 1], ['OPEN', 2]]);

  await t.test('lookup failure after a successful shared-PR push retains a durable association for retry', async () => {
    const witness = path.join(f.base, 'at-shared-pr-push.json'), failure = path.join(f.base, 'lookup-failed-once');
    const gitFile = path.join(f.base, 'bin/git-transport.cjs'), ghFile = path.join(f.base, 'bin/gh');
    const transport = await fs.readFile(gitFile, 'utf8');
    await fs.writeFile(gitFile, transport.replace('process.exit(result.status ?? 2);', `
      if (result.status === 0 && args[command] === 'push') fs.writeFileSync(${JSON.stringify(witness)}, JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.root, '.protoflow/delivery/state.json'))}, 'utf8')).deliveries.at(-1)));
      process.exit(result.status ?? 2);
    `));
    const provider = await fs.readFile(ghFile, 'utf8');
    await fs.writeFile(ghFile, provider.replace('#!/usr/bin/env node', `#!/usr/bin/env node
      { const fs = require('node:fs'); const args = process.argv.slice(2);
        if (args[0] === 'pr' && args[1] === 'list' && fs.existsSync(${JSON.stringify(witness)}) && !fs.existsSync(${JSON.stringify(failure)})) {
          fs.writeFileSync(${JSON.stringify(failure)}, 'FAKE post-push lookup failure'); console.error('FAKE post-push lookup failure'); process.exit(7);
        }
      }
    `));
    const sha = '4'.repeat(40);
    await fs.writeFile(path.join(f.worktree, 'app/index.html'), '<main>normal version with lookup failure</main>\n');
    await acceptVersion({ ...f, sha, ordinal: 3, verificationId: 'VER-lookup-retry', executionId: 'EXEC-fixture-lookup-retry' });
    const source = await sourceStatus(f.root);
    source.entries.push({ sha, manifestId: `git-${sha}`, ordinal: 3, status: 'PASS', verificationId: 'VER-lookup-retry', attempts: [{ executionId: 'EXEC-fixture-lookup-retry', executionStatus: 'PASS', status: 'PASS' }] });
    await saveSourceState(f.root, source);
    const first = await syncDeliveries(f.root, f.config);
    if (first.status === 'FAIL') assert.match(first.deliveries[0].error, /FAKE post-push lookup failure/);
    else assert.equal(first.status, 'PASS', JSON.stringify(first));
    const retry = await syncDeliveries(f.root, f.config);
    assert.ok(['PASS', 'IDLE'].includes(retry.status), JSON.stringify(retry));
    const atPush = await readJson(witness), delivered = (await deliveryStatus(f.root)).deliveries.at(-1);
    assert.equal(atPush.pr?.number, manual.pr.number); assert.equal(atPush.pr?.url, manual.pr.url);
    assert.equal(delivered.status, 'PR_OPEN_MANUAL'); assert.equal(delivered.pr.number, manual.pr.number);
    assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/protoflow/delivery'), delivered.commit);
    assert.deepEqual((await f.gh()).prs.map(pr => [pr.state, pr.comments.length]), [['CLOSED', 1], ['OPEN', 3]]);
  });
});

test('FAKE provider: reopened rejected deliveries are retained as revoked history and permit a fresh same-version delivery', async t => {
  for (const status of ['COMMITTED', 'FAIL', 'BLOCKED']) await t.test(status, async t => {
    const f = await fixture(t, { versions: 2 });
    const source = await sourceStatus(f.root); source.entries[1].status = 'PENDING'; await saveSourceState(f.root, source);
    process.env.FAKE_REVIEW_MODE = 'fail';
    assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
    const state = await deliveryStatus(f.root), old = state.deliveries[0]; old.status = status;
    await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), state);
    const before = structuredClone(old), rejection = await rejectAcceptance(f, f.root);
    const reviewFile = path.join(f.root, `.protoflow/delivery/independent-reviews/${old.independentReviewId}.json`), reviewBytes = await fs.readFile(reviewFile);

    const reopened = await runOnce(f.root, f.config);
    assert.equal(reopened.status, 'NOT_RUN', JSON.stringify(reopened));
    const progress = await sourceStatus(f.root);
    assert.deepEqual(progress.entries.map(entry => entry.status), ['PENDING', 'PENDING']);
    assert.equal(progress.entries[0].reopenings[0].deliveryId, old.id);
    assert.equal(progress.entries[0].reopenings[0].verificationId, 'VER-1');
    const revoked = (await deliveryStatus(f.root)).deliveries[0];
    assert.equal(revoked.status, 'REVOKED'); assert.equal(revoked.revocation.previousStatus, status);
    assert.deepEqual(revoked.revocation.rejections.map(item => item.reviewId), [rejection.id]);
    for (const field of ['id', 'commit', 'versions', 'shas', 'steps', 'independentReviewId', 'independentReviewAttempts']) assert.deepEqual(revoked[field], before[field]);
    await assertDelivered(f.root, f.config); await assertNoPublication(f);
    assert.equal((await syncDeliveries(f.root, f.config, { retryIndependentReview: { deliveryId: old.id, reviewId: old.independentReviewId } })).status, 'BLOCKED');

    await acceptRepair(f);
    const repaired = await syncDeliveries(f.root, f.config);
    assert.equal(repaired.status, 'PASS', JSON.stringify(repaired));
    const deliveries = (await deliveryStatus(f.root)).deliveries;
    assert.equal(deliveries.length, 2); assert.equal(deliveries[0].status, 'REVOKED'); assert.equal(deliveries[1].status, 'MERGED');
    assert.notEqual(deliveries[1].commit, old.commit); assert.notEqual(deliveries[1].independentReviewId, old.independentReviewId);
    assert.deepEqual(deliveries[1].versions, old.versions);
    assert.equal((await sourceStatus(f.root)).entries[0].deliveryId, deliveries[1].id);
    assert.equal((await sourceStatus(f.root)).entries[1].status, 'PENDING');
    assert.deepEqual(await fs.readFile(reviewFile), reviewBytes);
    const request = await readJson(path.join(f.root, `.protoflow/delivery/independent-reviews/${deliveries[1].independentReviewId}/request.json`));
    assert.deepEqual(request.binding.versions.map(item => item.verificationId), ['VER-repaired']);
  });
});

test('FAKE provider: a revoked published PR allows repair but blocks replacement publication until external closure', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'merge';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
  const old = (await deliveryStatus(f.root)).deliveries[0], before = await f.gh(); assert.ok(old.approval);
  await rejectAcceptance(f, f.root);
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  await acceptRepair(f);
  const replacement = await syncDeliveries(f.root, f.config);
  assert.equal(replacement.status, 'BLOCKED', JSON.stringify(replacement));
  assert.match(replacement.deliveries[0].error, /revoked.*PR.*open.*resolve/i);
  const state = await deliveryStatus(f.root);
  assert.equal(state.deliveries.length, 2); assert.equal(state.deliveries[0].status, 'REVOKED');
  assert.deepEqual(state.deliveries[0].approval, old.approval); assert.deepEqual(state.deliveries[0].pr, old.pr);
  assert.equal(state.deliveries[1].approval, undefined);
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/protoflow/delivery'), old.commit);
  const after = await f.gh(); assert.deepEqual(after.prs, before.prs);
  assert.ok(after.calls.slice(before.calls.length).every(call => !['create', 'comment', 'ready', 'merge', 'close', 'edit'].includes(call[1])));
  // A person resolves the old PR externally; the engine may now publish its newly verified delivery.
  after.prs[0].state = 'CLOSED'; await writeJson(path.join(f.base, 'gh.json'), after);
  const delivered = await syncDeliveries(f.root, f.config);
  assert.equal(delivered.status, 'PASS', JSON.stringify(delivered));
  assert.deepEqual((await f.gh()).prs.map(pr => pr.state), ['CLOSED', 'MERGED']);
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'REVOKED');
});

test('FAKE provider: a reopened manual PR becomes revoked history without authorizing replacement publication', async t => {
  const f = await fixture(t, { merge: 'none' });
  assert.equal((await syncDeliveries(f.root, f.config)).deliveries[0].status, 'PR_OPEN_MANUAL');
  const old = (await deliveryStatus(f.root)).deliveries[0], before = await f.gh();
  await rejectAcceptance(f, f.root);
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].revocation.previousStatus, 'PR_OPEN_MANUAL');
  await acceptRepair(f);
  const replacement = await syncDeliveries(f.root, f.config);
  assert.equal(replacement.status, 'BLOCKED', JSON.stringify(replacement)); assert.match(replacement.deliveries[0].error, /revoked.*PR.*open.*resolve/i);
  assert.deepEqual((await f.gh()).prs, before.prs);
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/protoflow/delivery'), old.commit);
});

test('FAKE provider: an ordinary unfinished delivery still blocks the runner without a decided rejection', async t => {
  const f = await fixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  const old = (await deliveryStatus(f.root)).deliveries[0];
  await assert.rejects(assertDelivered(f.root, f.config), /Delivery is blocked/);
  assert.equal((await runOnce(f.root, f.config)).status, 'BLOCKED');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'BLOCKED');
  assert.equal((await sourceStatus(f.root)).entries[0].deliveryId, old.id);
  // A reopening row by itself is not proof of a decided rejection.
  const source = await sourceStatus(f.root), entry = source.entries[0];
  entry.reopenings = [{ deliveryId: old.id, verificationId: entry.verificationId, rejections: [{ reviewId: 'REV-undecided' }] }];
  Object.assign(entry, { status: 'PENDING', verificationId: null, deliveryId: null }); await saveSourceState(f.root, source);
  await assert.rejects(assertDelivered(f.root, f.config), /Delivery is blocked/);
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'BLOCKED');
  await assertNoPublication(f);
});

test('FAKE provider: rejected acceptance blocks review capture in either evidence location before any provider run', async t => {
  for (const location of ['root', 'worktree']) for (const status of ['rejected', 'changes_requested']) await t.test(`${location}: ${status}`, async t => {
    const f = await committedFixture(t);
    const rejection = await rejectAcceptance(f, f[location], { status });
    const review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
    assert.equal(review.status, 'BLOCKED', JSON.stringify(review));
    assert.match(review.reason, /revoked/); assert.ok(review.reason.includes(rejection.id));
    await assert.rejects(fs.access(path.join(f.worktree, '.protoflow/fixture-review/received.json')), { code: 'ENOENT' });
    await assertNoPublication(f);
  });
});

test('FAKE provider: direct delivery sync cannot approve or publish rejected PASS before runner reopens progress', async t => {
  for (const location of ['root', 'worktree']) await t.test(location, async t => {
    const f = await fixture(t); f.config.policy.autoApprove = true;
    await rejectAcceptance(f, f[location]);
    assert.equal((await sourceStatus(f.root)).entries[0].status, 'PASS');
    const result = await syncDeliveries(f.root, f.config);
    assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
    assert.match(result.deliveries[0].error, /revoked/);
    assert.equal((await deliveryStatus(f.root)).deliveries[0].approval, undefined);
    await assertNoPublication(f);
  });
});

test('FAKE provider: rejection revokes a later PASS queued for direct delivery', async t => {
  const f = await fixture(t, { versions: 2 }); f.config.policy.autoApprove = true;
  const source = await sourceStatus(f.root); source.entries[0].deliveryId = 'DLV-fake-previous'; await saveSourceState(f.root, source);
  const rejection = await rejectAcceptance(f, f.root);
  const result = await syncDeliveries(f.root, f.config);
  assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
  assert.match(result.deliveries[0].error, /VER-2.*revoked/); assert.ok(result.deliveries[0].error.includes(rejection.id));
  await assertNoPublication(f);
});

test('FAKE provider: an existing approval cannot authorize merge after acceptance rejection in either evidence location', async t => {
  for (const location of ['root', 'worktree']) await t.test(location, async t => {
    const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'merge';
    assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
    const old = (await deliveryStatus(f.root)).deliveries[0]; assert.ok(old.approval);
    await rejectAcceptance(f, f[location], { status: 'changes_requested' });
    await assert.rejects(assertIndependentReview(f.root, f.config, old.independentReviewId, { published: true }), /revoked/);
    const beforeCalls = (await f.gh()).calls.length;
    const retry = await syncDeliveries(f.root, f.config);
    assert.equal(retry.status, 'BLOCKED', JSON.stringify(retry)); assert.match(retry.deliveries[0].error, /revoked/);
    const current = (await deliveryStatus(f.root)).deliveries[0]; assert.deepEqual(current.approval, old.approval);
    assert.equal((await f.gh()).prs[0].state, 'OPEN');
    assert.ok((await f.gh()).calls.slice(beforeCalls).every(call => !['create', 'comment', 'ready', 'merge'].includes(call[1])));
  });
});
