import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus, assertDelivered, deliveryReport } from '../src/delivery.js';
import { runOnce } from '../src/runner.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { loadProgress } from '../src/streams.js';
import { writeJson, hash, readJson } from '../src/util.js';
import { assertIndependentReview, requestIndependentReview } from '../src/delivery-review.js';
import { git, fixtureRepository, fixture, acceptVersion, committedFixture, assertNoPublication, rejectAcceptance, acceptRepair, reviewRecord, multiFixture } from './helpers/delivery-fixture.js';

test('FAKE provider: the bound VER hash is recomputable from the reviewer checkout, also for a legacy main-root copy with runnerWorktree', async t => {
  // Dual acceptance VER-1791730921977-18acc548: ProtoFlow 0.2.0 exported the main-root VER with runnerWorktree.
  const f = await committedFixture(t), file = path.join(f.root, '.protoflow/verifications/VER-1.json');
  await writeJson(file, { ...await readJson(file), runnerWorktree: f.worktree });
  const review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
  assert.equal(review.status, 'PASS', review.reason);
  const [version] = (await assertIndependentReview(f.root, f.config, review.id)).binding.versions;
  assert.equal(version.verificationHash, hash(await readJson(file)));
  assert.equal(version.verificationFile, '.protoflow/verifications/VER-1.json');
  assert.equal(version.verificationFileHash, hash(await readJson(path.join(f.worktree, version.verificationFile))));
  assert.notEqual(version.verificationHash, version.verificationFileHash);
  const { input } = await readJson(path.join(f.worktree, '.protoflow/fixture-review/received.json'));
  assert.match(input, /verificationHash = hash\(parsed main-root \.protoflow\/verifications\/<verificationId>\.json\)/);
  assert.match(input, /verificationFileHash = hash\(parsed verificationFile\)/);
  // A worktree copy that differs in evidence, not only in runnerWorktree, never reaches the provider.
  const local = path.join(f.worktree, version.verificationFile);
  await writeJson(local, { ...await readJson(local), createdAt: 'changed worktree copy' });
  const drifted = await requestIndependentReview(f.root, f.config, f.reviewOptions);
  assert.equal(drifted.status, 'BLOCKED'); assert.match(drifted.reason, /VER evidence binding changed/); assert.equal(drifted.retryable, undefined);
});

for (const mode of ['success', 'tampered review', 'substituted primary']) test(`FAKE provider: managed post-merge alignment ${mode}`, async t => {
  const f = await fixture(t);
  f.config.policy.autoApprove = true;
  const worktree = path.join(await fs.realpath(f.root), '.protoflow/runner', `worktree-${hash(f.config.source).slice(0, 12)}`);
  await fs.mkdir(path.dirname(worktree), {recursive:true});
  await git(f.root,'worktree','move',f.worktree,worktree);
  await writeJson(path.join(f.root,'.protoflow/runner/state.json'), {schemaVersion:1,status:'IDLE',worktree,branch:await git(worktree,'branch','--show-current'),configHash:hash(f.config),afterMergeAlignment:true});
  const primaryHead = await git(f.root,'rev-parse','HEAD');
  const primaryIndex = hash(await fs.readFile(path.join(f.root,'.git/index')));
  process.env.FAKE_GH_REAL_REMOTE=f.remote;process.env.FAKE_GH_ROOT=f.root;
  if(mode==='tampered review')process.env.FAKE_GH_TAMPER_REVIEW='1';
  if(mode==='substituted primary')process.env.FAKE_GH_TAMPER_RUNNER='1';
  const result=await syncDeliveries(f.root,f.config,{worktree});
  assert.equal(await git(f.root,'rev-parse','HEAD'),primaryHead);
  assert.equal(hash(await fs.readFile(path.join(f.root,'.git/index'))),primaryIndex);
  const delivery=result.deliveries[0];assert.equal(delivery.status,'MERGED');
  if(mode==='success'){
    assert.equal(result.status,'PASS',JSON.stringify(result));assert.equal(delivery.alignment.status,'PASS');
    assert.equal(await git(worktree,'rev-parse','HEAD'),delivery.mergeCommit);
    assert.equal((await syncDeliveries(f.root,f.config,{worktree})).status,'IDLE');
    await fs.appendFile(path.join(worktree,'app/index.html'),'next version');await git(worktree,'add','app');await git(worktree,'commit','-qm','next version');
    await git(worktree,'merge-base','--is-ancestor',delivery.mergeCommit,'HEAD');await git(worktree,'push','-q','origin','HEAD:protoflow/delivery');
  }else{
    assert.equal(result.status,'BLOCKED',JSON.stringify(result));assert.equal(delivery.alignment.status,'BLOCKED');assert.equal(await git(worktree,'rev-parse','HEAD'),delivery.commit);
    assert.match(delivery.alignment.reason,mode==='tampered review'?/engine-witnessed/:/identity/);
  }
});

test('a second delivery on the same branch opens and merges its own PR, not the earlier merged one', async t => {
  const f = await fixture(t);
  const first = await syncDeliveries(f.root, f.config);
  assert.equal(first.deliveries[0].status, 'MERGED', JSON.stringify(first));
  // Next accepted version: new application content with its own verification and executor provenance.
  await fs.writeFile(path.join(f.worktree, 'app/index.html'), '<main>v2</main>\n');
  const sha = '3'.repeat(40);
  await acceptVersion({ root: f.root, worktree: f.worktree, config: f.config, sha, ordinal: 2, verificationId: 'VER-2', executionId: 'EXEC-fixture-2' });
  const state = await sourceStatus(f.root);
  state.entries.push({ sha, manifestId: `git-${sha}`, ordinal: 2, status: 'PASS', verificationId: 'VER-2', attempts: [{ executionId: 'EXEC-fixture-2', executionStatus: 'PASS', status: 'PASS' }] });
  await saveSourceState(f.root, state);
  const second = await syncDeliveries(f.root, f.config);
  assert.equal(second.status, 'PASS', JSON.stringify(second));
  const delivery = second.deliveries.at(-1);
  assert.equal(delivery.status, 'MERGED');
  assert.equal(delivery.pr, `https://${fixtureRepository}/pull/2`);
  assert.equal(delivery.mergeCommit, 'merge-2');
  assert.deepEqual((await f.gh()).prs.map(pr => [pr.number, pr.state]), [[1, 'MERGED'], [2, 'MERGED']]);
});

test('multi-target FAKE provider: rejection blocks its delivery while the sibling target remains deliverable', async t => {
  const f = await multiFixture(t);
  await rejectAcceptance(f, f.root, { verificationId: 'VER-web', status: 'changes_requested' });
  const result = await syncDeliveries(f.root, f.config);
  assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
  assert.equal(result.targets.web.status, 'BLOCKED'); assert.match(result.targets.web.deliveries[0].error, /revoked/);
  assert.equal(result.targets.desktop.status, 'PASS'); assert.equal(result.targets.desktop.deliveries[0].status, 'MERGED');
  await assert.rejects(git(f.remote, 'rev-parse', '--verify', 'refs/heads/protoflow/delivery/web'));
  assert.deepEqual((await f.gh()).prs.map(pr => [pr.head, pr.state]), [['protoflow/delivery/desktop', 'MERGED']]);
});

test('multi-target FAKE provider: retiring a reopened delivery leaves sibling progress and delivery independent', async t => {
  const f = await multiFixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config, { target: 'web' })).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  const sibling = await loadProgress(f.root, f.config, 'desktop');
  await rejectAcceptance(f, f.root, { verificationId: 'VER-web', status: 'changes_requested' });
  assert.equal((await runOnce(f.root, f.config, { target: 'web' })).status, 'NOT_RUN');
  assert.equal((await deliveryStatus(f.root, f.config, 'web')).deliveries[0].status, 'REVOKED');
  assert.equal((await loadProgress(f.root, f.config, 'web')).entries[0].status, 'PENDING');
  assert.deepEqual(await loadProgress(f.root, f.config, 'desktop'), sibling);
  assert.equal((await syncDeliveries(f.root, f.config, { target: 'desktop' })).status, 'PASS');
  assert.equal((await deliveryStatus(f.root, f.config, 'desktop')).deliveries[0].status, 'MERGED');
  await assert.rejects(git(f.remote, 'rev-parse', '--verify', 'refs/heads/protoflow/delivery/web'));
  assert.deepEqual((await f.gh()).prs.map(pr => pr.head), ['protoflow/delivery/desktop']);
});

test('multi-target: each target passes its own independent review and merges on its own branch; a sibling merge is integrated', async t => {
  const f = await multiFixture(t);
  const web = await syncDeliveries(f.root, f.config, { target: 'web' });
  assert.equal(web.status, 'PASS', JSON.stringify(web));
  const mainAfterWeb = await git(f.remote, 'rev-parse', 'main');
  assert.equal(web.deliveries[0].mergeCommit, mainAfterWeb);
  // Desktop forked before the web merge: its base moved, but only within the web root.
  const all = await syncDeliveries(f.root, f.config);
  assert.equal(all.status, 'PASS', JSON.stringify(all));
  assert.equal(all.targets.web.status, 'IDLE');
  const status = await deliveryStatus(f.root, f.config);
  const [w] = status.targets.web.deliveries, [d] = status.targets.desktop.deliveries;
  assert.equal(w.integration, null); assert.equal(d.status, 'MERGED');
  assert.equal(d.baseSha, mainAfterWeb); assert.equal(d.integration.baseSha, mainAfterWeb);
  assert.deepEqual((await git(f.remote, 'rev-list', '--parents', '-n', '1', d.commit)).split(' ').slice(1), [d.integration.previousHead, mainAfterWeb]);
  assert.notEqual(w.independentReviewId, d.independentReviewId);
  for (const [id, delivery] of [['web', w], ['desktop', d]]) {
    assert.equal(await git(f.remote, 'rev-parse', `refs/heads/protoflow/delivery/${id}`), delivery.commit);
    const { binding } = await readJson(path.join(f.root, `.protoflow/delivery/independent-reviews/${delivery.independentReviewId}/request.json`));
    assert.equal(binding.target, id); assert.equal(binding.remote.branch, `protoflow/delivery/${id}`); assert.equal(binding.commit, delivery.commit);
    // The reviewer judges this target's root; the sibling ships through its own stream.
    const sibling = id === 'web' ? 'desktop' : 'web';
    assert.deepEqual(binding.scope, { target: id, root: id, siblings: [{ target: sibling, root: sibling }] });
    assert.deepEqual(binding.versions.map(version => version.verificationId), [`VER-${id}`]);
    // What the PR adds to its base is exactly this target's root.
    assert.deepEqual((await git(f.remote, 'diff', '--name-only', delivery.baseSha, delivery.commit)).split('\n'), [`${id}/index.html`]);
  }
  const prs = (await f.gh()).prs;
  assert.deepEqual(prs.map(pr => [pr.head, pr.state]), [['protoflow/delivery/web', 'MERGED'], ['protoflow/delivery/desktop', 'MERGED']]);
  assert.match(prs[1].comments[0], /target desktop/); assert.match(prs[1].comments[0], /Integrated base/);
  // A review is bound to its target and cannot authorize a sibling's delivery.
  await assert.rejects(assertIndependentReview(f.root, f.config, d.independentReviewId, { target: 'web' }), /another delivery/);
});

test('multi-target: sibling-root changes and base changes to shared files block before review or publication', async t => {
  for (const mode of ['sibling-root', 'shared-base-file']) await t.test(mode, async t => {
    const f = await multiFixture(t);
    if (mode === 'sibling-root') await fs.writeFile(path.join(f.worktrees.desktop, 'web/stray.html'), 'not verified by desktop');
    else { await fs.writeFile(path.join(f.root, 'README.md'), 'changed on main\n'); await git(f.root, 'commit', '-qam', 'shared change'); await git(f.root, 'push', '-q', 'origin', 'HEAD:main'); }
    const result = await syncDeliveries(f.root, f.config, { target: 'desktop' });
    assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
    assert.match(result.reason, mode === 'sibling-root' ? /outside safe scope: web\/stray\.html/ : /changed files of target desktop .*\(README\.md\)/);
    await assert.rejects(git(f.remote, 'rev-parse', '--verify', 'refs/heads/protoflow/delivery/desktop'));
    assert.deepEqual((await deliveryStatus(f.root, f.config, 'desktop')).deliveries, []);
    await assert.rejects(fs.access(path.join(f.worktrees.desktop, '.protoflow/fixture-review/received.json')), { code: 'ENOENT' });
  });
});

test('multi-target: a base change to a shared file that the target already verified byte for byte integrates', async t => {
  const f = await multiFixture(t);
  const sha = `${'1'.repeat(8)}${'a'.repeat(32)}`;
  // A config-style edit on main that the desktop worktree already holds (runner configure syncs it) and verified.
  await fs.writeFile(path.join(f.worktrees.desktop, 'README.md'), 'shared edit\n');
  await acceptVersion({ root: f.root, worktree: f.worktrees.desktop, config: f.config, sha, ordinal: 1, verificationId: 'VER-desktop', executionId: 'EXEC-desktop-1', target: 'desktop', reuseFrozen: true });
  await fs.writeFile(path.join(f.root, 'README.md'), 'shared edit\n'); await git(f.root, 'commit', '-qam', 'shared edit'); await git(f.root, 'push', '-q', 'origin', 'HEAD:main');
  const result = await syncDeliveries(f.root, f.config, { target: 'desktop' });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const [delivery] = (await deliveryStatus(f.root, f.config, 'desktop')).deliveries;
  assert.equal(delivery.status, 'MERGED');
  assert.ok(delivery.integration, 'the moved base was merged into the target before review');
  assert.equal(await git(f.remote, 'show', 'main:README.md'), 'shared edit');
});

test('FAKE provider: a revoked unpublished commit never reaches the remote through the repaired delivery history', async t => {
  const f = await fixture(t);
  // The rejected attempt committed a cache the repair later deletes.
  await fs.mkdir(path.join(f.worktree, 'app/cache'), { recursive: true }); await fs.writeFile(path.join(f.worktree, 'app/cache/blob.bin'), 'cache fixture');
  await acceptVersion({ ...f, sha: f.shas[0], ordinal: 1, verificationId: 'VER-1', executionId: 'EXEC-fixture-1', reuseFrozen: true });
  process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  const old = (await deliveryStatus(f.root)).deliveries[0];
  assert.equal(await git(f.worktree, 'show', `${old.commit}:app/cache/blob.bin`), 'cache fixture');
  await rejectAcceptance(f, f.root);
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  await fs.rm(path.join(f.worktree, 'app/cache'), { recursive: true });
  await acceptRepair(f);

  // A delivery committed on top of the revoked commit (as engines before this rule did) is retired unpublished.
  await git(f.worktree, 'add', '-A'); await git(f.worktree, 'commit', '-qm', 'tainted delivery');
  const tainted = { id: 'DLV-tainted', status: 'FAIL', versions: old.versions, shas: old.shas, commit: await git(f.worktree, 'rev-parse', 'HEAD'), baseSha: old.baseSha, steps: { committedAt: new Date().toISOString() } };
  const state = await deliveryStatus(f.root); state.deliveries.push(tainted); await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), state);
  const source = await sourceStatus(f.root); source.entries[0].deliveryId = tainted.id; await saveSourceState(f.root, source);

  const delivered = await syncDeliveries(f.root, f.config);
  assert.equal(delivered.status, 'PASS', JSON.stringify(delivered));
  const deliveries = (await deliveryStatus(f.root)).deliveries;
  assert.deepEqual(deliveries.map(item => item.status), ['REVOKED', 'REVOKED', 'MERGED']);
  assert.deepEqual(deliveries[1].revocation.revokedHistory, [old.id]);
  assert.deepEqual(deliveries[2].discardedHistory.revokedDeliveries, [old.id, 'DLV-tainted']);
  // Neither the cache nor either retired commit exists anywhere on the remote.
  for (const commit of [old.commit, tainted.commit]) await assert.rejects(git(f.remote, 'cat-file', '-e', `${commit}^{commit}`));
  assert.equal(await git(f.remote, 'log', '--all', '--format=%H', '--', 'app/cache/blob.bin'), '');
  assert.equal(await git(f.remote, 'show', `${deliveries[2].commit}:app/index.html`), '<main>repaired v1</main>');
});

test('multi-target: a sibling change to a shared verified file is merged and the accepted version reverified before delivery', async t => {
  const { reverifyOnBase } = await import('../src/runner.js');
  const f = await multiFixture(t);
  const sha = `${'1'.repeat(8)}${'a'.repeat(32)}`;
  // Web ships a shared top-level change (e.g. a .gitignore rule) with its own verified delivery.
  await fs.writeFile(path.join(f.worktrees.web, 'README.md'), 'app\nshared web rule\n');
  await acceptVersion({ root: f.root, worktree: f.worktrees.web, config: f.config, sha, ordinal: 1, verificationId: 'VER-web', executionId: 'EXEC-web-1', target: 'web', reuseFrozen: true });
  assert.equal((await syncDeliveries(f.root, f.config, { target: 'web' })).status, 'PASS');
  // Desktop verified the old README, so integration refuses and names the divergence.
  const blocked = await syncDeliveries(f.root, f.config, { target: 'desktop' });
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.code, 'BASE_DIVERGED');
  assert.equal(blocked.baseSha, await git(f.remote, 'rev-parse', 'main')); assert.match(blocked.reason, /\(README\.md\)/);
  // The runner learns about it from assertDelivered, which must carry the divergence for reverification.
  await assert.rejects(assertDelivered(f.root, f.config, 'desktop'), error => error.code === 'BASE_DIVERGED' && error.baseSha === blocked.baseSha);

  const runner = await readJson(path.join(f.root, '.protoflow/runner/desktop/state.json'));
  const state = await loadProgress(f.root, f.config, 'desktop');
  const events = [];
  const verified = await reverifyOnBase(f.root, f.config, 'desktop', runner, state, blocked, {
    onEvent: event => events.push(event.event),
    verifyVersion: async (worktree, config, manifestId, options) => {
      assert.equal(options.reverify, true); assert.equal(options.target, 'desktop');
      // The merged base is what gets verified.
      assert.equal(await fs.readFile(path.join(worktree, 'README.md'), 'utf8'), 'app\nshared web rule\n');
      await acceptVersion({ root: f.root, worktree, config, sha, ordinal: 1, verificationId: 'VER-desktop-reverified', executionId: 'EXEC-desktop-1', target: 'desktop', reuseFrozen: true });
      return readJson(path.join(worktree, '.protoflow/verifications/VER-desktop-reverified.json'));
    }
  });
  assert.equal(verified.status, 'PASS', JSON.stringify(verified)); assert.equal(verified.reverified, true);
  assert.deepEqual(events, ['reverify', 'verified', 'delivered']);
  const entry = (await loadProgress(f.root, f.config, 'desktop')).entries[0];
  assert.equal(entry.verificationId, 'VER-desktop-reverified');
  assert.deepEqual(entry.attempts.at(-1).reverify, { baseSha: blocked.baseSha, previousVerificationId: 'VER-desktop' });
  const [delivery] = (await deliveryStatus(f.root, f.config, 'desktop')).deliveries;
  assert.equal(delivery.status, 'MERGED'); assert.equal(delivery.acceptance.verificationId, 'VER-desktop-reverified');
  assert.equal(await git(f.remote, 'show', 'main:README.md'), 'app\nshared web rule');
  assert.equal(await git(f.remote, 'show', 'main:desktop/index.html'), '<main>desktop v1</main>');
});

test('multi-target: a failing reverification on the merged base blocks the target without delivering', async t => {
  const { reverifyOnBase } = await import('../src/runner.js');
  const f = await multiFixture(t);
  const sha = `${'1'.repeat(8)}${'a'.repeat(32)}`;
  await fs.writeFile(path.join(f.worktrees.web, 'README.md'), 'app\nshared web rule\n');
  await acceptVersion({ root: f.root, worktree: f.worktrees.web, config: f.config, sha, ordinal: 1, verificationId: 'VER-web', executionId: 'EXEC-web-1', target: 'web', reuseFrozen: true });
  assert.equal((await syncDeliveries(f.root, f.config, { target: 'web' })).status, 'PASS');
  const blocked = await syncDeliveries(f.root, f.config, { target: 'desktop' });
  const runner = await readJson(path.join(f.root, '.protoflow/runner/desktop/state.json')), state = await loadProgress(f.root, f.config, 'desktop');
  const result = await reverifyOnBase(f.root, f.config, 'desktop', runner, state, blocked, { verifyVersion: async () => ({ id: 'VER-desktop-merged', status: 'FAIL' }) });
  assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, /Reverification on base [a-f0-9]{7} is FAIL \(VER-desktop-merged\).*needs a repair/);
  const entry = (await loadProgress(f.root, f.config, 'desktop')).entries[0];
  assert.equal(entry.status, 'BLOCKED'); assert.equal(entry.verificationId, 'VER-desktop');
  assert.deepEqual((await deliveryStatus(f.root, f.config, 'desktop')).deliveries, []);
  await assert.rejects(git(f.remote, 'rev-parse', '--verify', 'refs/heads/protoflow/delivery/desktop'));
});

test('FAKE provider: under autoApprove the runner turns a reviewer FAIL into an automated rejection that reopens the version', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  const old = (await deliveryStatus(f.root)).deliveries[0], events = [];
  const result = await runOnce(f.root, f.config, { onEvent: event => events.push(event) });
  assert.equal(result.status, 'REOPENED'); assert.match(result.reason, /recorded automated rejection REV-.*reopens for repair/);
  assert.deepEqual(events.map(event => event.event), ['auto-rejected']);
  const review = await readJson(path.join(f.worktree, `.protoflow/reviews/${result.rejection}.json`));
  assert.equal(review.status, 'changes_requested'); assert.equal(review.reviewerKind, 'model'); assert.equal(review.verificationId, 'VER-1');
  assert.match(review.reviewer, /^ai:codex-independent-review:/); assert.match(review.findings[0].description, /Synthetic fixture finding/);
  assert.equal(review.model.sessionId, (await reviewRecord(f, old.independentReviewId)).sessionId);
  // The next cycle reopens the version and retires the rejected delivery; nothing was published.
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'REVOKED');
  assert.equal((await sourceStatus(f.root)).entries[0].status, 'PENDING');
  await assertNoPublication(f);
});

test('FAKE provider: without autoApprove a person sends a reviewer-rejected version back for repair from the dashboard', async t => {
  const { runAction } = await import('../src/dashboard-actions.js');
  const { dashboardSnapshot } = await import('../src/dashboard-data.js');
  const f = await fixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  f.config.dashboard = { reviewer: 'Fixture Person' };
  await writeJson(path.join(f.root, 'protoflow.config.json'), f.config);
  await fs.cp(path.join(f.worktree, '.protoflow/artifacts'), path.join(f.root, '.protoflow/artifacts'), { recursive: true });
  const blocked = (await deliveryStatus(f.root)).deliveries[0];
  // The dashboard offers to send it back with the reviewer's findings, and no longer offers to approve it.
  let view = await dashboardSnapshot(f.root, { service: false });
  const item = view.attention.find(entry => entry.kind === 'review-rejected');
  assert.ok(item, JSON.stringify(view.attention));
  assert.deepEqual(item.actions, ['request-changes']); assert.equal(item.deliveryId, blocked.id); assert.equal(item.reviewId, blocked.independentReviewId);
  assert.match(item.findings[0].description, /Synthetic fixture finding/);
  assert.equal(view.attention.filter(entry => entry.kind === 'review' || entry.kind === 'delivery-blocked').length, 0, JSON.stringify(view.attention));
  const result = await runAction(f.root, { action: 'request-changes', deliveryId: blocked.id, reviewer: 'ai:someone' });
  assert.equal(result.status, 'PASS'); assert.equal(result.reviewer, 'Fixture Person'); assert.equal(result.findings, 1);
  const review = await readJson(path.join(f.root, `.protoflow/reviews/${result.reviewId}.json`));
  assert.equal(review.status, 'changes_requested'); assert.equal(review.reviewerKind ?? 'human', 'human'); assert.equal(review.reviewer, 'Fixture Person'); assert.equal(review.verificationId, 'VER-1');
  assert.match(review.findings[0].description, /Synthetic fixture finding/);
  // The next pass reopens the version and retires the rejected delivery; nothing was published.
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'REVOKED');
  assert.equal((await sourceStatus(f.root)).entries[0].status, 'PENDING');
  view = await dashboardSnapshot(f.root, { service: false });
  assert.equal(view.attention.filter(entry => entry.kind === 'review-rejected').length, 0);
  await assert.rejects(runAction(f.root, { action: 'request-changes', deliveryId: blocked.id }), /not blocked by an independent review/);
  await assertNoPublication(f);
});

test('FAKE provider: without autoApprove an operator records the model rejection with delivery reject-review', async t => {
  const { rejectIndependentReview } = await import('../src/runner.js');
  const f = await fixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  // delivery status says how to send the version back, instead of leaving the operator to rebuild the evidence.
  const blocked = (await deliveryReport(f.root, f.config)).deliveries[0];
  assert.equal(blocked.next, `protoflow delivery reject-review --delivery ${blocked.id} --review ${blocked.independentReviewId}, or 退回修改 on the dashboard`);
  assert.equal((await deliveryReport(f.root, { ...f.config, policy: { ...f.config.policy, autoApprove: true } })).deliveries[0].next, undefined, 'under autoApprove the runner rejects it itself');
  await assert.rejects(rejectIndependentReview(f.root, f.config, { deliveryId: blocked.id, reviewId: 'AIR-other' }), /is not blocked by independent review AIR-other/);
  const result = await rejectIndependentReview(f.root, f.config, { deliveryId: blocked.id, reviewId: blocked.independentReviewId });
  assert.equal(result.status, 'PASS'); assert.match(result.rejection, /^REV-/); assert.equal(result.next, 'runner start reopens the version and repairs it');
  // The same rejection autoApprove records: model reviewer, evidence bound to the verification, the reviewer's findings.
  const review = await readJson(path.join(f.worktree, `.protoflow/reviews/${result.rejection}.json`));
  assert.deepEqual([review.status, review.reviewerKind, review.verificationId], ['changes_requested', 'model', 'VER-1']);
  assert.match(review.reviewer, /^ai:codex-independent-review:/); assert.match(review.notes, /run by an operator \(delivery reject-review\)/);
  assert.match(review.findings[0].description, /Synthetic fixture finding/);
  const evidence = await readJson(path.join(f.worktree, `.protoflow/delivery/automated-rejections/${blocked.independentReviewId}.json`));
  assert.deepEqual([evidence.kind, evidence.status, evidence.independentReviewId, evidence.verificationId], ['independent-model-review', 'FAIL', blocked.independentReviewId, 'VER-1']);
  const events = (await fs.readFile(path.join(f.root, '.protoflow/runner/events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.event === 'auto-rejected').map(event => [event.deliveryId, event.rejection, event.operator]), [[blocked.id, result.rejection, true]]);
  // The next pass reopens the version and retires the rejected delivery; nothing was published.
  assert.equal((await runOnce(f.root, f.config)).status, 'NOT_RUN');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'REVOKED');
  assert.equal((await sourceStatus(f.root)).entries[0].status, 'PENDING');
  await assert.rejects(rejectIndependentReview(f.root, f.config, { deliveryId: blocked.id, reviewId: blocked.independentReviewId }), /is not blocked by independent review/);
  await assertNoPublication(f);
});

test('FAKE provider: a single-target runner keeps going after an automated rejection instead of stopping as stuck', async t => {
  const { startRunner } = await import('../src/runner.js');
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  const events = [];
  const result = await startRunner(f.root, f.config, { once: true, onEvent: event => { if (!['scanned', 'scan-failed'].includes(event.event)) events.push(event.event); } });
  // The same pass reopens the rejected version and goes on to repair it (the fixture has no executor: NOT_RUN).
  assert.equal(result.status, 'NOT_RUN', JSON.stringify(result));
  assert.deepEqual(events.slice(0, 2), ['auto-rejected', 'reopened']);
  assert.equal((await sourceStatus(f.root)).entries[0].status, 'PENDING');
});

test('FAKE provider: automated rejection stops after repeated reopenings and without autoApprove', async t => {
  const f = await fixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); delete process.env.FAKE_REVIEW_MODE;
  const manual = await runOnce(f.root, f.config);
  assert.equal(manual.status, 'BLOCKED'); assert.equal(manual.rejection, undefined);
  f.config.policy.autoApprove = true;
  const source = await sourceStatus(f.root);
  source.entries[0].reopenings = [1, 2, 3].map(index => ({ verificationId: `VER-old-${index}`, rejections: [] }));
  await saveSourceState(f.root, source);
  const capped = await runOnce(f.root, f.config);
  assert.equal(capped.status, 'BLOCKED'); assert.match(capped.reason, /already reopened 3 times, so a person decides/);
  await assert.rejects(fs.readdir(path.join(f.worktree, '.protoflow/reviews')), { code: 'ENOENT' });
});
