import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus, assertDelivered } from '../src/delivery.js';
import { runOnce } from '../src/runner.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { writeJson, readJson } from '../src/util.js';
import { snapshot } from '../src/sessions.js';
import { assertIndependentReview, requestIndependentReview } from '../src/delivery-review.js';
import { git, fixture, acceptVersion, rejectAcceptance, acceptRepair, crashDeliverySync } from './helpers/delivery-fixture.js';

test('a reopened version is delivered from the executions after its reopening; a missing record names itself', async t => {
  const { root, config } = await fixture(t);
  const state = await sourceStatus(root);
  // An execution before the reopening ran in a worktree that was archived when its stream was rebuilt.
  const archived = { executionId: 'EXEC-archived', executionStatus: 'PASS', status: 'FAIL', startedAt: '2026-01-01T00:00:00.000Z' };
  state.entries[0].attempts = [archived, { ...state.entries[0].attempts[0], startedAt: '2026-01-03T00:00:00.000Z' }];
  await saveSourceState(root, state);
  const missing = await syncDeliveries(root, config);
  assert.equal(missing.status, 'BLOCKED');
  assert.match(JSON.stringify(missing), /Executor provenance \.protoflow\/contexts\/EXEC-archived\.json is missing from the runner worktree; restore it unchanged/);
  // After the reopening, only the repair's executions are this delivery's provenance.
  const reopened = await fixture(t);
  const later = await sourceStatus(reopened.root);
  later.entries[0].attempts = [archived, { ...later.entries[0].attempts[0], startedAt: '2026-01-03T00:00:00.000Z' }];
  later.entries[0].reopenings = [{ at: '2026-01-02T00:00:00.000Z', previousStatus: 'PASS' }];
  await saveSourceState(reopened.root, later);
  const result = await syncDeliveries(reopened.root, reopened.config);
  assert.equal(result.status, 'PASS', JSON.stringify(result).slice(0, 1500));
});

test('delivery commits only application files, pushes, opens a PR with evidence and merges the exact head', async t => {
  const { root, worktree, remote, config, shas, gh } = await fixture(t);
  const result = await syncDeliveries(root, config);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const [delivery] = result.deliveries;
  assert.equal(delivery.status, 'MERGED');
  assert.equal(delivery.mergeCommit, 'merge-1');

  const files = (await git(worktree, 'show', '--name-only', '--format=', delivery.commit)).split('\n');
  assert.deepEqual(files, ['app/index.html']);
  const message = await git(worktree, 'log', '-1', '--format=%B', delivery.commit);
  assert.match(message, new RegExp(`ProtoFlow: implement prototype ${shas[0].slice(0, 7)}`));
  assert.match(message, new RegExp(`Prototype-Commit: ${shas[0]}`));
  assert.match(message, /Approved-By: none \(human review required\)/);
  assert.match(message, /Delivery-Base: [a-f0-9]{40}/); assert.match(message, /Verification-Hash: [a-f0-9]{64}/); assert.match(message, /Application-Hash: [a-f0-9]{64}/);
  assert.equal(await git(remote, 'rev-parse', 'refs/heads/protoflow/delivery'), delivery.commit);

  const db = await gh();
  assert.equal(db.prs.length, 1);
  assert.equal(db.prs[0].base, 'main');
  assert.equal(db.prs[0].comments.length, 1);
  assert.match(db.prs[0].comments[0], /VER-1/);
  assert.ok(db.calls.some(call => call[1] === 'merge' && call.includes('--match-head-commit') && call.includes(delivery.commit)));
  assert.equal((await sourceStatus(root)).entries[0].deliveryId, delivery.id);

  // Nothing new: no extra commit, comment or merge.
  const again = await syncDeliveries(root, config);
  assert.equal(again.status, 'IDLE');
  assert.equal((await gh()).prs[0].comments.length, 1);
});

test('git-ignored generated native sources are outside the bound application, so the gated delivery merges', async t => {
  const { root, worktree, config } = await fixture(t, { generated: true });
  const generated = 'app/ios/build/generated/ios/RCTAppDependencyProvider.h';
  const report = await readJson(path.join(root, '.protoflow/verifications/VER-1.json'));
  assert.ok(!Object.hasOwn(report.project.files, generated));
  assert.ok(Object.hasOwn(report.project.files, 'app/.gitignore'));
  const result = await syncDeliveries(root, config);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const [delivery] = result.deliveries;
  assert.equal(delivery.status, 'MERGED');
  assert.deepEqual((await git(worktree, 'show', '--name-only', '--format=', delivery.commit)).split('\n'), ['app/.gitignore', 'app/index.html']);
  await fs.access(path.join(worktree, generated));
});

test('a symlink inside the project is reviewed by the file it reaches, so the gated delivery merges', async t => {
  const { root, worktree, config } = await fixture(t, { internalLink: true });
  const report = await readJson(path.join(root, '.protoflow/verifications/VER-1.json'));
  assert.equal(report.project.files['app/clang:target'], 'app/wrapper.sh');
  const result = await syncDeliveries(root, config);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const [delivery] = result.deliveries;
  assert.equal(delivery.status, 'MERGED');
  assert.equal((await git(worktree, 'ls-tree', delivery.commit, 'app/clang')).split(' ')[0], '120000');
});

test('FAKE provider: regenerating git-ignored output keeps a review valid; tracked or untracked content drift still blocks', async t => {
  for (const mode of ['regenerated', 'tracked', 'untracked']) {
    await t.test(mode, async t => {
      const f = await fixture(t, { generated: true });
      await git(f.worktree, 'add', 'app'); await git(f.worktree, 'commit', '-q', '-m', 'FAKE generated binding fixture');
      const commit = await git(f.worktree, 'rev-parse', 'HEAD');
      assert.equal(await git(f.worktree, 'ls-files', 'app/ios'), '');
      const options = { worktree: f.worktree, commit, manifestIds: (await sourceStatus(f.root)).entries.map(entry => entry.manifestId) };
      const review = await requestIndependentReview(f.root, f.config, options);
      assert.equal(review.status, 'PASS', review.reason);
      if (mode === 'regenerated') {
        await fs.writeFile(path.join(f.worktree, 'app/ios/build/generated/ios/RCTAppDependencyProvider.h'), '// FAKE regenerated codegen output\n');
        await fs.writeFile(path.join(f.worktree, 'app/ios/build/generated/ios/RCTThirdPartyComponentsProvider.h'), '// FAKE new codegen output\n');
        await assertIndependentReview(f.root, f.config, review.id);
      } else {
        await fs.writeFile(path.join(f.worktree, mode === 'tracked' ? 'app/index.html' : 'app/extra.js'), 'drift\n');
        await assert.rejects(assertIndependentReview(f.root, f.config, review.id), error => error.code === 'INDEPENDENT_REVIEW_BLOCKED');
      }
    });
  }
});

test('versions accepted since the last delivery share one commit naming each prototype commit', async t => {
  const { root, worktree, config, shas } = await fixture(t, { versions: 2 });
  const { deliveries: [delivery] } = await syncDeliveries(root, config);
  const message = await git(worktree, 'log', '-1', '--format=%B', delivery.commit);
  assert.match(message, /implement prototypes 1111111\.\.2222222/);
  for (const sha of shas) assert.match(message, new RegExp(`Prototype-Commit: ${sha}`));
  assert.deepEqual((await sourceStatus(root)).entries.map(entry => entry.deliveryId), [delivery.id, delivery.id]);
});

test('merge none leaves the pull request for a person', async t => {
  const { root, config, gh } = await fixture(t, { merge: 'none' });
  const result = await syncDeliveries(root, config);
  assert.equal(result.deliveries[0].status, 'PR_OPEN_MANUAL');
  assert.equal((await gh()).prs[0].state, 'OPEN');
});

test('a failed merge is retried later without recommitting or recommenting', async t => {
  const { root, config, gh } = await fixture(t);
  process.env.FAKE_GH_FAIL = 'merge';
  const failed = await syncDeliveries(root, config);
  assert.equal(failed.status, 'FAIL');
  assert.match(failed.deliveries[0].error, /simulated gh merge failure/);
  delete process.env.FAKE_GH_FAIL;
  const retried = await syncDeliveries(root, config);
  assert.equal(retried.deliveries[0].status, 'MERGED');
  assert.equal(retried.deliveries[0].commit, failed.deliveries[0].commit);
  assert.equal((await deliveryStatus(root)).deliveries.length, 1);
  assert.equal((await gh()).prs[0].comments.length, 1);
});

test('delivery is NOT_RUN without configuration', async t => {
  const { root, config } = await fixture(t);
  assert.equal((await syncDeliveries(root, { ...config, runner: {} })).status, 'NOT_RUN');
});

test('FAKE crash recovery: saved delivery without progress link reopens by exact commit verification binding', async t => {
  for (const binding of ['acceptance snapshot', 'legacy commit trailers']) await t.test(binding, async t => {
    const f = await fixture(t);
    await crashDeliverySync(f, 'progress');
    const state = await deliveryStatus(f.root), old = state.deliveries[0];
    if (binding === 'legacy commit trailers') { delete old.acceptance; await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), state); }
    assert.equal(old.status, 'COMMITTED'); assert.equal((await sourceStatus(f.root)).entries[0].deliveryId, undefined);
    await rejectAcceptance(f, f.root);
    const repair = await runOnce(f.root, f.config);
    assert.equal(repair.status, 'NOT_RUN', JSON.stringify(repair));
    const source = await sourceStatus(f.root), revoked = (await deliveryStatus(f.root)).deliveries[0];
    assert.equal(source.entries[0].reopenings[0].deliveryId, null);
    assert.equal(revoked.status, 'REVOKED'); assert.equal(revoked.commit, old.commit);
    assert.deepEqual(revoked.revocation.versions, [{ manifestId: source.entries[0].manifestId, verificationId: 'VER-1' }]);
    // Matching only the manifest list cannot retire a different, unbound commit.
    const unrelated = { ...old, id: 'DLV-unrelated-commit', commit: old.baseSha, acceptance: undefined };
    await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), { schemaVersion: 1, deliveries: [revoked, unrelated] });
    await assert.rejects(assertDelivered(f.root, f.config), /Delivery is blocked/);
    assert.equal((await deliveryStatus(f.root)).deliveries[1].status, 'BLOCKED');
    await assert.rejects(git(f.remote, 'rev-parse', '--verify', 'refs/heads/protoflow/delivery'));
    const github = await f.gh(); assert.deepEqual(github.prs, []);
    assert.ok(github.calls.every(call => call[0] === 'api' || (call[0] === 'pr' && call[1] === 'list')));
  });
});

test('FAKE crash recovery: successful push without publication markers cannot update an older open PR during repair', async t => {
  const f = await fixture(t, { versions: 2, merge: 'none' });
  const source = await sourceStatus(f.root); source.entries[1].status = 'PENDING'; await saveSourceState(f.root, source);
  assert.equal((await syncDeliveries(f.root, f.config)).deliveries[0].status, 'PR_OPEN_MANUAL');
  await fs.writeFile(path.join(f.worktree, 'app/index.html'), '<main>v2 before crash</main>\n');
  await acceptVersion({ ...f, sha: f.shas[1], ordinal: 2, verificationId: 'VER-2', executionId: 'EXEC-fixture-2', reuseFrozen: true });
  const current = await sourceStatus(f.root); current.entries[1].status = 'PASS'; await saveSourceState(f.root, current);
  await crashDeliverySync(f, 'pushed');
  const uncertain = (await deliveryStatus(f.root)).deliveries[1];
  assert.equal(uncertain.status, 'COMMITTED'); assert.equal(uncertain.steps.pushedAt, undefined); assert.equal(uncertain.pr, undefined);
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/protoflow/delivery'), uncertain.commit);
  await rejectAcceptance(f, f.root, { verificationId: 'VER-2' });
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  assert.equal((await deliveryStatus(f.root)).deliveries[1].status, 'REVOKED');
  await acceptRepair(f, 1);
  const before = await f.gh(), callsBefore = (await f.gitCalls()).length;
  const repaired = await syncDeliveries(f.root, f.config);
  assert.equal(repaired.status, 'BLOCKED', JSON.stringify(repaired)); assert.match(repaired.deliveries[0].error, /revoked.*PR.*open.*resolve/i);
  assert.deepEqual((await f.gh()).prs, before.prs);
  assert.equal(await git(f.remote, 'rev-parse', 'refs/heads/protoflow/delivery'), uncertain.commit);
  assert.ok((await f.gitCalls()).slice(callsBefore).every(call => !call.args.includes('push')));
});
