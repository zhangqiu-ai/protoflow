import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus, alignWorktreeToBase, rebaseDeliveries } from '../src/delivery.js';
import { runOnce } from '../src/runner.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { writeJson, hash, readJson } from '../src/util.js';
import { exec, git, fixture, restartProgram, reviewRecord, humanCommit, acceptNext } from './helpers/delivery-fixture.js';

test('FAKE provider: after a restart the runner revalidates an unattested PASS with a fresh review and finishes the delivery', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'merge';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
  const old = (await deliveryStatus(f.root)).deliveries[0];
  const program = `import { runOnce } from ${JSON.stringify(new URL('../src/runner.js', import.meta.url).href)}; const events = []; const result = await runOnce(process.argv[1], JSON.parse(process.argv[2]), { onEvent: event => events.push(event.event) }); console.log(JSON.stringify({ status: result.status, events }));`;
  const restarted = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', program, f.root, JSON.stringify(f.config)])).stdout.trim().split('\n').at(-1));
  assert.equal(restarted.status, 'PASS', JSON.stringify(restarted)); assert.deepEqual(restarted.events, ['review-retry', 'delivered']);
  const delivery = (await deliveryStatus(f.root)).deliveries[0];
  assert.equal(delivery.status, 'MERGED'); assert.notEqual(delivery.independentReviewId, old.independentReviewId);
  assert.deepEqual(delivery.independentReviewAttempts.map(attempt => attempt.status), ['PASS', 'PASS']);
  assert.deepEqual(delivery.approvalHistory, [old.approval]);
});

test('FAKE transport: a published delivery accepts a retry of a legacy transient block known only by its reason text', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'merge';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
  const trigger = path.join(f.base, 'outage-trigger'); await fs.writeFile(trigger, 'armed');
  // A restarted engine revalidates; a proxy failure blocks that review before the provider runs.
  const blocked = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram(`
    process.env.FAKE_DELIVERY_GIT_UNAVAILABLE = trigger; await retry();`), f.root, JSON.stringify(f.config), trigger])).stdout);
  const stranded = blocked.state.deliveries[0], file = path.join(f.root, `.protoflow/delivery/independent-reviews/${stranded.independentReviewId}.json`);
  const record = await readJson(file); assert.equal(record.status, 'BLOCKED'); assert.match(record.reason, /CONNECT tunnel failed/);
  // Records written before 0.3.7 had no retryable flag for some network signatures.
  delete record.retryable; delete record.reasonCode; await writeJson(file, record);
  const resumed = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram('await retry();'), f.root, JSON.stringify(f.config), trigger])).stdout);
  assert.equal(resumed.results[0].status, 'PASS', JSON.stringify(resumed.results[0]));
  assert.equal(resumed.state.deliveries[0].status, 'MERGED');
});

test('FAKE transport: an approved delivery that never left the checkout is re-reviewed once its checkout matches again', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const trigger = path.join(f.base, 'push-reject'); await fs.writeFile(trigger, 'armed');
  process.env.FAKE_DELIVERY_GIT_PUSH_REJECT = trigger;
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_DELIVERY_GIT_PUSH_REJECT;
  const approved = (await deliveryStatus(f.root)).deliveries[0];
  assert.ok(approved.approval && !approved.steps.pushedAt && !approved.pr, JSON.stringify(approved.steps));
  // After a restart the checkout drifted (as runner configure once rewrote a worktree config): the fresh review blocks.
  const file = path.join(f.worktree, 'app/index.html'), original = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, `${original}<!-- drift -->\n`);
  const drifted = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram('await retry();'), f.root, JSON.stringify(f.config), trigger])).stdout);
  assert.equal(drifted.results[0].status, 'BLOCKED');
  const record = await reviewRecord(f, drifted.state.deliveries[0].independentReviewId);
  assert.match(record.reason, /do not match the committed tree/); assert.notEqual(record.retryable, true);
  // Restored bytes: nothing was published, so a fresh review may replace the local approval.
  await fs.writeFile(file, original);
  const resumed = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram('await retry();'), f.root, JSON.stringify(f.config), trigger])).stdout);
  assert.equal(resumed.results[0].status, 'PASS', JSON.stringify(resumed.results[0]));
  const delivery = resumed.state.deliveries[0];
  assert.equal(delivery.status, 'MERGED'); assert.deepEqual(delivery.approvalHistory, [approved.approval]);
  assert.notEqual(delivery.approval.independentReviewId, approved.approval.independentReviewId);
});

test('FAKE transport: network failures before the provider runs do not use up the automatic review retries', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'merge';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
  const trigger = path.join(f.base, 'outage-trigger'); await fs.writeFile(trigger, 'armed');
  // A restarted engine revalidates; the proxy fails before the provider runs.
  const blocked = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', restartProgram(`
    process.env.FAKE_DELIVERY_GIT_UNAVAILABLE = trigger; await retry();`), f.root, JSON.stringify(f.config), trigger])).stdout);
  const state = blocked.state, delivery = state.deliveries[0], latest = await reviewRecord(f, delivery.independentReviewId);
  assert.equal(latest.processFile, undefined); assert.equal(latest.retryable, true);
  // Seven earlier pre-provider failures of the same kind: none ran the provider, so none counts.
  const extra = [];
  for (let index = 0; index < 7; index++) {
    const id = `AIR-preprovider-${index}`;
    await writeJson(path.join(f.root, `.protoflow/delivery/independent-reviews/${id}.json`), { ...latest, id });
    extra.push({ id, status: 'BLOCKED', createdAt: latest.createdAt, supersedes: null });
  }
  delivery.independentReviewAttempts = [...extra, ...delivery.independentReviewAttempts];
  await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), state);
  const program = `import { runOnce } from ${JSON.stringify(new URL('../src/runner.js', import.meta.url).href)}; const events = []; const result = await runOnce(process.argv[1], JSON.parse(process.argv[2]), { onEvent: event => events.push(event.event) }); console.log(JSON.stringify({ status: result.status, events }));`;
  const resumed = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', program, f.root, JSON.stringify(f.config)])).stdout.trim().split('\n').at(-1));
  assert.deepEqual(resumed.events.slice(0, 1), ['review-retry']);
  assert.equal(resumed.status, 'PASS', JSON.stringify(resumed));
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'MERGED');
});

test('single target: a base people moved after the last delivery merged is taken up before the next version runs, so that version delivers', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  const merged = (await deliveryStatus(f.root)).deliveries[0];
  assert.equal(merged.status, 'MERGED');
  // The FAKE GitHub merge records the PR only; land the reviewed commit on the base as the real merge would.
  const landed = await git(f.worktree, 'rev-parse', 'HEAD');
  await git(f.worktree, 'push', '-q', f.remote, 'HEAD:main');
  assert.equal(await alignWorktreeToBase(f.worktree, f.config), null);
  const human = await humanCommit(f, 'docs/human.md', 'TASK-078\n');
  // Uncommitted application work is not the base's: the version would be built on a stale base, so it blocks.
  await fs.writeFile(path.join(f.worktree, 'app/index.html'), '<main>half done</main>\n');
  await assert.rejects(alignWorktreeToBase(f.worktree, f.config), error => error.code === 'BASE_MOVED' && error.baseSha === human && /uncommitted changes in app\/index\.html/.test(error.message));
  await git(f.worktree, 'checkout', '--', 'app/index.html');
  const aligned = await alignWorktreeToBase(f.worktree, f.config);
  assert.deepEqual(aligned, { from: landed, to: human });
  assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), human);
  assert.equal(await fs.readFile(path.join(f.worktree, 'docs/human.md'), 'utf8'), 'TASK-078\n');
  // The next version is built on the current base and its delivery review passes.
  await acceptNext(f, { sha: `2${'b'.repeat(39)}`, ordinal: 2, verificationId: 'VER-2', executionId: 'EXEC-fixture-2', content: '<main>v2</main>\n' });
  const result = await syncDeliveries(f.root, f.config);
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const second = (await deliveryStatus(f.root)).deliveries.at(-1);
  assert.deepEqual([second.status, second.baseSha], ['MERGED', human]);
});

test('single target: the next version blocks before running when the base moved under work left in the worktree, with reasonCode base-moved', async t => {
  const f = await fixture(t, { versions: 2 }); f.config.policy.autoApprove = true;
  // The runner names its worktree by the source: move the fixture's worktree there, as runner start would create it.
  const worktree = path.join(await fs.realpath(f.root), '.protoflow/runner', `worktree-${hash(f.config.source).slice(0, 12)}`);
  await git(f.root, 'worktree', 'move', f.worktree, worktree);
  // The executor never starts: the base check blocks first.
  f.config.adapters.codex = { command: { argv: [process.execPath, '-e', 'process.exit(9)'], timeoutMs: 60000 } };
  await writeJson(path.join(f.root, '.protoflow/runner/state.json'), { schemaVersion: 1, worktree, status: 'IDLE', configHash: hash(f.config) });
  const source = await sourceStatus(f.root), { sha, manifestId, ordinal } = source.entries[1];
  source.entries[1] = { sha, manifestId, ordinal, status: 'PENDING', attempts: [] }; await saveSourceState(f.root, source);
  // Version 2 has not run yet: no acceptance evidence.
  for (const dir of [f.root, worktree]) await fs.rm(path.join(dir, '.protoflow/verifications/VER-2.json'));
  const first = await syncDeliveries(f.root, f.config);
  assert.equal(first.status, 'PASS', JSON.stringify(first));
  await git(worktree, 'push', '-q', f.remote, 'HEAD:main');
  const human = await humanCommit(f, 'docs/human.md', 'TASK-080\n');
  // Work left in the worktree is not the base's: version 2 would be built on a stale base.
  await fs.writeFile(path.join(worktree, 'app/index.html'), '<main>half done</main>\n');
  const events = [];
  const result = await runOnce(f.root, f.config, { onEvent: event => { events.push(event); } });
  assert.deepEqual([result.status, result.reasonCode], ['BLOCKED', 'base-moved'], JSON.stringify({ result, events }));
  assert.deepEqual(events.map(event => event.event), ['base-moved', 'blocked']);
  assert.equal(events[0].baseSha, human);
  assert.deepEqual([events[1].reasonCode, events[1].manifestId], ['base-moved', `git-${f.shas[1]}`]);
  assert.match(events[1].reason, /runner rebase/);
  const entry = (await sourceStatus(f.root)).entries[1];
  assert.deepEqual([entry.status, entry.reasonCode, typeof entry.blockedAt], ['BLOCKED', 'base-moved', 'string']);
});

test('single target: runner rebase retires a delivery built on a moved base and runs its versions again on the current base', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const human = await humanCommit(f, 'docs/human.md', 'TASK-079\n');
  const blocked = await syncDeliveries(f.root, f.config);
  assert.equal(blocked.status, 'BLOCKED');
  assert.match(JSON.stringify(blocked), /not an ancestor/);
  const stale = (await deliveryStatus(f.root)).deliveries[0];
  await assert.rejects(alignWorktreeToBase(f.worktree, f.config), error => error.code === 'BASE_MOVED' && /1 commit\(s\) not in the base/.test(error.message) && /runner rebase/.test(error.message));
  await fs.writeFile(path.join(f.worktree, 'app/notes.txt'), 'uncommitted\n');

  const result = await rebaseDeliveries(f.root, f.config, f.worktree);
  assert.deepEqual([result.from, result.to, result.deliveries, result.versions], [stale.commit, human, [stale.id], [`git-${f.shas[0]}`]]);
  // Nothing is lost: the archive holds the delivery commit and the uncommitted file.
  assert.equal(await git(f.worktree, 'rev-parse', `${result.archive}^`), stale.commit);
  assert.equal(await git(f.worktree, 'show', `${result.archive}:app/notes.txt`), 'uncommitted');
  assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), human);
  await assert.rejects(fs.access(path.join(f.worktree, 'app/index.html')));
  await assert.rejects(fs.access(path.join(f.worktree, 'app/notes.txt')));
  await fs.access(path.join(f.worktree, '.protoflow/contexts/EXEC.json'));
  const delivery = (await deliveryStatus(f.root)).deliveries[0];
  assert.deepEqual([delivery.status, delivery.revocation.archive, delivery.revocation.staleBase.to], ['REVOKED', result.archive, human]);
  let source = await sourceStatus(f.root);
  assert.deepEqual([source.entries[0].status, source.entries[0].attempts.length, source.completedSha], ['PENDING', 0, null]);
  assert.equal(source.rebased[0].entries[0].verificationId, 'VER-1');
  await assert.rejects(rebaseDeliveries(f.root, f.config, f.worktree), /already in the runner worktree/);

  // The version runs again from scratch on the current base and is delivered.
  await acceptNext(f, { sha: f.shas[0], ordinal: 1, verificationId: 'VER-1b', executionId: 'EXEC-fixture-1b', content: '<main>v1 on the current base</main>\n', reuseFrozen: true });
  const delivered = await syncDeliveries(f.root, f.config);
  assert.equal(delivered.status, 'PASS', JSON.stringify(delivered));
  const fresh = (await deliveryStatus(f.root)).deliveries.at(-1);
  assert.deepEqual([fresh.status, fresh.baseSha], ['MERGED', human]);
  source = await sourceStatus(f.root);
  assert.equal(source.entries[0].deliveryId, fresh.id);
});

test('single target: the work of a version reopened after its delivery was rejected moves onto a base people moved outside it, keeping every file', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true;
  const human = await humanCommit(f, 'docs/human.md', 'TASK-083\n');
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
  const state = await deliveryStatus(f.root), rejected = state.deliveries[0];
  // An unsettled delivery still binds the worktree: nothing moves.
  await assert.rejects(alignWorktreeToBase(f.worktree, f.config, f.root), error => error.code === 'BASE_MOVED' && /1 commit\(s\) not in the base/.test(error.message));
  // The reviewer rejected it and the version reopened for repair (synthetic revocation of an unpublished delivery).
  rejected.revocation = { at: new Date().toISOString(), previousStatus: rejected.status, versions: [], rejections: [{ reviewId: 'REV-fixture' }] };
  rejected.status = 'REVOKED';
  await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), state);
  const delivered = await fs.readFile(path.join(f.worktree, 'app/index.html'), 'utf8');
  await fs.writeFile(path.join(f.worktree, 'app/repair.txt'), 'repair in progress\n');
  // Without the project root (older callers) the rule is unchanged.
  await assert.rejects(alignWorktreeToBase(f.worktree, f.config), error => error.code === 'BASE_MOVED');
  // The base changed a file the worktree also changed, to other content: it stays blocked and names the file.
  await fs.mkdir(path.join(f.worktree, 'docs'), { recursive: true });
  await fs.writeFile(path.join(f.worktree, 'docs/human.md'), 'local\n');
  await assert.rejects(alignWorktreeToBase(f.worktree, f.config, f.root), error => error.code === 'BASE_MOVED' && /files the base also changed \(docs\/human\.md\)/.test(error.message));
  assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), rejected.commit);
  // The same content as the base (e.g. a config edit runner configure wrote) is not in the way.
  await fs.writeFile(path.join(f.worktree, 'docs/human.md'), 'TASK-083\n');

  const aligned = await alignWorktreeToBase(f.worktree, f.config, f.root);
  assert.deepEqual([aligned.from, aligned.to, aligned.carried.commits, aligned.carried.deliveries, aligned.carried.files], [rejected.commit, human, 1, [rejected.id], 1]);
  assert.equal(await git(f.worktree, 'rev-parse', 'HEAD'), human);
  // Every file the worktree carried stays; the rejected commit is no longer in the history a delivery would publish.
  assert.equal(await fs.readFile(path.join(f.worktree, 'app/index.html'), 'utf8'), delivered);
  assert.equal(await fs.readFile(path.join(f.worktree, 'app/repair.txt'), 'utf8'), 'repair in progress\n');
  assert.equal(await fs.readFile(path.join(f.worktree, 'docs/human.md'), 'utf8'), 'TASK-083\n');
  await assert.rejects(git(f.worktree, 'merge-base', '--is-ancestor', rejected.commit, 'HEAD'));
  const status = (await git(f.worktree, 'status', '--porcelain', '--untracked-files=all')).split('\n').filter(line => !/\.protoflow\//.test(line));
  assert.ok(status.some(line => line.endsWith('app/index.html')) && status.some(line => line.endsWith('app/repair.txt')), status.join('\n'));
  assert.ok(!status.some(line => line.endsWith('docs/human.md')), status.join('\n'));
  // Nothing is lost: the archive holds the rejected commit and the uncommitted repair.
  assert.equal(await git(f.worktree, 'rev-parse', `${aligned.carried.archive}^`), rejected.commit);
  assert.equal(await git(f.worktree, 'show', `${aligned.carried.archive}:app/repair.txt`), 'repair in progress');
  // The base is in the worktree now: the next check passes without moving anything.
  assert.equal(await alignWorktreeToBase(f.worktree, f.config, f.root), null);
});

test('single target: the runner carries a rejected delivery\'s work onto a moved base and runs the version instead of blocking', async t => {
  const f = await fixture(t, { versions: 2 }); f.config.policy.autoApprove = true;
  const worktree = path.join(await fs.realpath(f.root), '.protoflow/runner', `worktree-${hash(f.config.source).slice(0, 12)}`);
  await git(f.root, 'worktree', 'move', f.worktree, worktree);
  f.config.adapters.codex = { command: { argv: [process.execPath, '-e', 'process.exit(9)'], timeoutMs: 60000 } };
  await writeJson(path.join(f.root, '.protoflow/runner/state.json'), { schemaVersion: 1, worktree, status: 'IDLE', configHash: hash(f.config) });
  const source = await sourceStatus(f.root), { sha, manifestId, ordinal } = source.entries[1];
  source.entries[1] = { sha, manifestId, ordinal, status: 'PENDING', attempts: [] }; await saveSourceState(f.root, source);
  for (const dir of [f.root, worktree]) await fs.rm(path.join(dir, '.protoflow/verifications/VER-2.json'));
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'PASS');
  await git(worktree, 'push', '-q', f.remote, 'HEAD:main');
  // Version 2's delivery was committed, rejected and revoked before it was published (synthetic record).
  await fs.writeFile(path.join(worktree, 'app/index.html'), '<main>v2 rejected</main>\n');
  await git(worktree, 'add', 'app/index.html'); await git(worktree, 'commit', '-q', '-m', 'FAKE rejected delivery');
  const commit = await git(worktree, 'rev-parse', 'HEAD');
  const state = await deliveryStatus(f.root);
  state.deliveries.push({ id: 'DLV-rejected', status: 'REVOKED', commit, versions: [manifestId], revocation: { at: new Date().toISOString(), previousStatus: 'BLOCKED', versions: [], rejections: [{ reviewId: 'REV-fixture' }] } });
  await writeJson(path.join(f.root, '.protoflow/delivery/state.json'), state);
  const human = await humanCommit(f, 'docs/human.md', 'TASK-084\n');
  const events = [];
  const result = await runOnce(f.root, f.config, { onEvent: event => { events.push(event); } });
  assert.notEqual(result.reasonCode, 'base-moved', JSON.stringify(result));
  const aligned = events.find(event => event.event === 'base-aligned');
  assert.deepEqual([aligned.from, aligned.to, aligned.carried.deliveries], [commit, human, ['DLV-rejected']], JSON.stringify(events));
  assert.ok(!events.some(event => event.event === 'base-moved'));
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), human);
  assert.equal(await fs.readFile(path.join(worktree, 'app/index.html'), 'utf8'), '<main>v2 rejected</main>\n');
});
