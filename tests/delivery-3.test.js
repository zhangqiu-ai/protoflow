import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDeliveries, deliveryStatus } from '../src/delivery.js';
import { writeJson, hash, fingerprint, readJson } from '../src/util.js';
import { assertIndependentReview, requestIndependentReview } from '../src/delivery-review.js';
import { deliveryGit } from '../src/delivery-scope.js';
import { exec, git, fixtureUrl, fixtureRepository, fixture, committedFixture, assertNoPublication, rejectAcceptance, openSpecLines } from './helpers/delivery-fixture.js';

test('FAKE provider: a restarted engine cannot revalidate rejected acceptance to replace an existing approval', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'merge';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'FAIL'); delete process.env.FAKE_GH_FAIL;
  const old = (await deliveryStatus(f.root)).deliveries[0];
  const receivedFile = path.join(f.worktree, '.protoflow/fixture-review/received.json'), receivedBytes = await fs.readFile(receivedFile);
  await rejectAcceptance(f, f.root);
  const beforeCalls = (await f.gh()).calls.length;
  const program = `import { syncDeliveries, deliveryStatus } from ${JSON.stringify(new URL('../src/delivery.js', import.meta.url).href)}; const root = process.argv[1], config = JSON.parse(process.argv[2]), old = (await deliveryStatus(root)).deliveries[0]; console.log(JSON.stringify({ result: await syncDeliveries(root, config, { retryIndependentReview: { deliveryId: old.id, reviewId: old.independentReviewId } }), state: await deliveryStatus(root) }));`;
  const retry = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', program, f.root, JSON.stringify(f.config)])).stdout);
  assert.equal(retry.result.status, 'BLOCKED', JSON.stringify(retry)); assert.match(retry.result.deliveries[0].error, /revoked/);
  assert.deepEqual(retry.state.deliveries[0].approval, old.approval);
  assert.deepEqual(await fs.readFile(receivedFile), receivedBytes);
  assert.equal((await f.gh()).prs[0].state, 'OPEN');
  assert.ok((await f.gh()).calls.slice(beforeCalls).every(call => !['create', 'comment', 'ready', 'merge'].includes(call[1])));
});

test('FAKE transport: differing fetch/push URLs bind base, refs, push and PR to the one push destination', async t => {
  const f = await fixture(t), pushRemote = path.join(f.base, 'push.git'), pushUrl = 'https://github.com/protoflow-fixture/destination.git';
  await git(f.base, 'clone', '-q', '--bare', f.remote, pushRemote);
  const transport = await readJson(f.transport); transport.urls[pushUrl] = pushRemote; await writeJson(f.transport, transport);
  await git(f.worktree, 'remote', 'set-url', '--add', '--push', 'origin', pushUrl);
  const intendedBase = await git(pushRemote, 'rev-parse', 'main');
  // A different fetch base is outside the delivery HEAD ancestry. Reading it would block or bind the wrong repository.
  await git(f.root, 'commit', '-q', '--allow-empty', '-m', 'FAKE fetch destination base advanced');
  await git(f.root, 'push', '-q', fixtureUrl, 'HEAD:main');
  assert.notEqual(await git(f.remote, 'rev-parse', 'main'), intendedBase);
  const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const delivery = (await deliveryStatus(f.root)).deliveries[0], review = await assertIndependentReview(f.root, f.config, delivery.independentReviewId, { published: true });
  assert.equal(review.binding.remote.url, pushUrl); assert.equal(review.binding.remote.baseSha, intendedBase); assert.equal(review.binding.remote.repository.id, 202);
  assert.equal(await git(pushRemote, 'rev-parse', 'refs/heads/protoflow/delivery'), delivery.commit);
  await assert.rejects(git(f.remote, 'rev-parse', '--verify', 'refs/heads/protoflow/delivery'));
  assert.equal((await f.gh()).prs[0].repository, 'github.com/protoflow-fixture/destination');
  const commands = (await f.gitCalls()).filter(call => call.args.includes('core.hooksPath=/dev/null'));
  const push = commands.find(call => call.args.includes('push'));
  assert.ok(push.args.includes(pushUrl) && !push.args.includes('origin') && push.args.includes('--no-follow-tags'));
  assert.ok(commands.filter(call => call.args.includes('ls-remote')).every(call => call.args.includes(pushUrl) && !call.args.includes('origin')));
  assert.ok(commands.every(call => call.args.includes('--no-replace-objects') && ['', 'GIT_GRAFT_FILE'].includes(call.gitEnvironment.join(','))));
});

test('FAKE transport: multiple push destinations and effective URL rewrites block before publication', async t => {
  for (const mode of ['multiple-push-urls', 'multiple-fallback-urls', 'insteadOf', 'pushInsteadOf']) await t.test(mode, async t => {
    const f = await committedFixture(t), second = 'https://github.com/protoflow-fixture/secondary.git';
    if (mode === 'multiple-push-urls') {
      await git(f.worktree, 'remote', 'set-url', '--add', '--push', 'origin', fixtureUrl);
      await git(f.worktree, 'remote', 'set-url', '--add', '--push', 'origin', second);
    } else if (mode === 'multiple-fallback-urls') await git(f.worktree, 'remote', 'set-url', '--add', 'origin', second);
    else await git(f.worktree, 'config', `url.${second}.${mode}`, fixtureUrl);
    const review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
    assert.equal(review.status, 'BLOCKED'); assert.match(review.reason, /exactly one push URL|URL rewrite rules/);
    assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); await assertNoPublication(f);
    await assert.rejects(fs.access(path.join(f.worktree, '.protoflow/fixture-review/received.json')), { code: 'ENOENT' });
  });
});

test('FAKE transport: Git configuration environment overrides cannot alter review or publication', async t => {
  for (const overrides of [
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GIT_CONFIG_VALUE_0: 'https://github.com/protoflow-fixture/secondary.git' },
    { GIT_CONFIG_PARAMETERS: "'remote.origin.pushurl=https://github.com/protoflow-fixture/secondary.git'" },
    { GIT_CONFIG_GLOBAL: '/nonexistent/override.gitconfig' },
    { GIT_CONFIG_SYSTEM: '/nonexistent/override.gitconfig' },
  ]) await t.test(Object.keys(overrides)[0], async t => {
    const f = await committedFixture(t), previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, overrides);
      const review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
      assert.equal(review.status, 'BLOCKED'); assert.match(review.reason, /configuration environment overrides/);
      assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
    } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    await assertNoPublication(f);
  });
});

test('FAKE transport: replacement commits/blobs cannot substitute the objects reviewed for push', async t => {
  for (const kind of ['commit', 'blob']) await t.test(kind, async t => {
    const f = await committedFixture(t), goodCommit = f.commit, goodBlob = await git(f.worktree, 'rev-parse', 'HEAD:app/index.html');
    await fs.writeFile(path.join(f.worktree, 'app/index.html'), 'FAKE unreviewed original blob');
    await git(f.worktree, 'add', 'app'); await git(f.worktree, 'commit', '-q', '-m', 'FAKE unreviewed original commit');
    f.commit = await git(f.worktree, 'rev-parse', 'HEAD'); f.reviewOptions.commit = f.commit;
    const badBlob = await git(f.worktree, 'rev-parse', 'HEAD:app/index.html');
    await git(f.worktree, 'replace', kind === 'commit' ? f.commit : badBlob, kind === 'commit' ? goodCommit : goodBlob);
    if (kind === 'commit') await git(f.worktree, 'read-tree', goodCommit);
    await fs.writeFile(path.join(f.worktree, 'app/index.html'), '<main>v1</main>\n');
    assert.equal(await git(f.worktree, 'show', 'HEAD:app/index.html'), '<main>v1</main>');
    assert.equal(await deliveryGit(f.worktree, ['show', 'HEAD:app/index.html']), 'FAKE unreviewed original blob');
    const review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
    assert.equal(review.status, 'BLOCKED'); assert.match(review.reason, /index changed|committed tree/);
    await assertNoPublication(f);
  });
});

test('FAKE transport: legacy grafts are rejected before review or delivery', async t => {
  const f = await committedFixture(t), graft = await git(f.worktree, 'rev-parse', '--git-path', 'info/grafts');
  await fs.mkdir(path.dirname(path.resolve(f.worktree, graft)), { recursive: true });
  await fs.writeFile(path.resolve(f.worktree, graft), `${f.commit}\n`);
  const review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
  assert.equal(review.status, 'BLOCKED'); assert.match(review.reason, /Legacy Git grafts/);
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); await assertNoPublication(f);
});

test('FAKE GitHub: a non-main base branch receives the PR and merge, and the PR body carries each trailer exactly once', async t => {
  const f = await fixture(t, { baseBranch: 'feature/mobile-rewrite' });
  f.config.runner.delivery.prBodyTrailers = ['OpenSpec-Change: rewrite-mobile-ui'];
  process.env.FAKE_GH_REAL_REMOTE = f.remote; process.env.FAKE_GH_ROOT = f.root;
  const main = await git(f.remote, 'rev-parse', 'main');
  const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const github = await f.gh(), [pr] = github.prs;
  assert.equal(pr.base, 'feature/mobile-rewrite'); assert.equal(pr.state, 'MERGED');
  assert.deepEqual(openSpecLines(pr.body), ['OpenSpec-Change: rewrite-mobile-ui']);
  assert.match(pr.body, /^Automated application delivery from ProtoFlow\.[^\n]*\n\nOpenSpec-Change: rewrite-mobile-ui$/);
  assert.ok(github.calls.filter(call => ['list', 'create'].includes(call[1])).every(call => call[call.indexOf('--base') + 1] === 'feature/mobile-rewrite'));
  assert.ok(!github.calls.some(call => call[1] === 'edit'), 'a PR created with the trailers is not edited');
  assert.equal(await git(f.remote, 'show', 'feature/mobile-rewrite:app/index.html'), '<main>v1</main>');
  assert.equal(await git(f.remote, 'rev-parse', 'main'), main, 'main is never touched');
  assert.equal((await deliveryStatus(f.root)).deliveries[0].status, 'MERGED');
});

test('FAKE GitHub: a single-target project delivers the same with --target <its target> as without, and an unknown target blocks before committing', async t => {
  const f = await fixture(t);
  process.env.FAKE_GH_REAL_REMOTE = f.remote; process.env.FAKE_GH_ROOT = f.root;
  const unknown = await syncDeliveries(f.root, f.config, { target: 'web' });
  assert.equal(unknown.status, 'BLOCKED'); assert.equal(unknown.reason, 'Unknown target: web');
  assert.deepEqual((await deliveryStatus(f.root)).deliveries, []);
  const { mappings, ...rest } = f.config;
  const config = { ...rest, schemaVersion: 2, targets: [{ id: 'web', platform: 'web', root: '.' }] };
  const result = await syncDeliveries(f.root, config, { target: 'web' }); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const [delivery] = (await deliveryStatus(f.root)).deliveries;
  assert.equal(delivery.status, 'MERGED'); assert.equal(delivery.error ?? null, null);
});

test('FAKE GitHub: a reused open PR gets its stale trailer replaced so the body keeps exactly one', async t => {
  const f = await fixture(t);
  f.config.runner.delivery.prBodyTrailers = ['OpenSpec-Change: rewrite-mobile-ui'];
  await writeJson(path.join(f.base, 'gh.json'), { calls: [], environments: [], prs: [{ number: 1, repository: fixtureRepository, head: 'protoflow/delivery', base: 'main', title: 'Opened by hand', state: 'OPEN', comments: [], body: 'Notes from a person\n\nOpenSpec-Change: old-change\nOpenSpec-Change: old-change' }] });
  const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const github = await f.gh();
  assert.equal(github.prs.length, 1); assert.ok(!github.calls.some(call => call[1] === 'create'));
  assert.equal(github.prs[0].body, 'Notes from a person\n\nOpenSpec-Change: rewrite-mobile-ui');
  assert.equal(github.calls.filter(call => call[1] === 'edit').length, 1);
  assert.ok((await deliveryStatus(f.root)).deliveries[0].steps.prBodyAt);
});

test('runner.delivery.prBodyTrailers: the schema takes single "Key: value" lines and delivery blocks duplicate keys', async t => {
  const { default: Ajv } = await import('ajv');
  const { configSchemaV2 } = await import('../src/config.js');
  const { withPullRequestTrailers } = await import('../src/delivery.js');
  const validate = new Ajv({ strict: false }).compile(configSchemaV2);
  const config = trailers => ({ schemaVersion: 2, prototypeDir: 'prototype', targets: [{ id: 'web', platform: 'web', root: '.' }], runner: { delivery: { branch: 'protoflow/delivery', baseBranch: 'feature/mobile-rewrite', prBodyTrailers: trailers } } });
  assert.equal(validate(config(['OpenSpec-Change: rewrite-mobile-ui', 'Refs: #12'])), true, JSON.stringify(validate.errors));
  for (const trailers of [[], ['OpenSpec-Change:'], ['no colon'], ['OpenSpec-Change: a\nOpenSpec-Change: b'], ['Key: trailing '], [' Key: x'], ['A: x', 'A: x']]) assert.equal(validate(config(trailers)), false, JSON.stringify(trailers));
  assert.equal(withPullRequestTrailers('', ['A: 1']), 'A: 1');
  assert.equal(withPullRequestTrailers('Body\r\nA: 0\r\n\r\n', ['A: 1']), 'Body\n\nA: 1');
  assert.equal(withPullRequestTrailers('Body\n\nA: 1', ['A: 1']), 'Body\n\nA: 1');
  assert.equal(withPullRequestTrailers('Body', undefined), 'Body');
  const f = await fixture(t);
  f.config.runner.delivery.prBodyTrailers = ['OpenSpec-Change: a', 'OpenSpec-Change: b'];
  assert.deepEqual(await syncDeliveries(f.root, f.config), { status: 'BLOCKED', reason: 'runner.delivery.prBodyTrailers keys must be unique' });
  await assertNoPublication(f);
});

test('FAKE GitHub: every PR action has reviewed repository/host scope despite GH_REPO, GH_HOST and default remote', async t => {
  const f = await fixture(t); f.config.runner.delivery.draft = true;
  await git(f.worktree, 'remote', 'add', 'decoy', 'https://github.com/protoflow-fixture/secondary.git');
  await git(f.worktree, 'config', 'remote.decoy.gh-resolved', 'base');
  process.env.GH_REPO = 'attacker/wrong-target'; process.env.GH_HOST = 'attacker.invalid';
  const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const github = await f.gh();
  assert.equal(github.prs[0].repository, fixtureRepository);
  for (const verb of ['list', 'create', 'view', 'comment', 'ready', 'merge']) assert.ok(github.calls.some(call => call[0] === 'pr' && call[1] === verb));
  assert.ok(github.calls.filter(call => call[0] === 'pr').every(call => call[call.indexOf('--repo') + 1] === fixtureRepository));
  assert.ok(github.calls.filter(call => call[0] === 'api').every(call => /^repos\/protoflow-fixture\/application(?:\/pulls\/\d+)?$/.test(call[1]) && call[call.indexOf('--hostname') + 1] === 'github.com'));
  assert.ok(github.environments.every(env => env.GH_REPO === null && env.GH_HOST === 'github.com' && env.GIT_CONFIG_COUNT === null));
});

test('FAKE GitHub: redirected canonical identity, repository ID drift and local delivery URL are blocked', async t => {
  for (const mode of ['canonical-name', 'repository-id', 'local-url']) await t.test(mode, async t => {
    const f = await committedFixture(t);
    if (mode === 'repository-id') {
      const review = await requestIndependentReview(f.root, f.config, f.reviewOptions); assert.equal(review.status, 'PASS', review.reason);
      process.env.FAKE_GH_REPOSITORY_ID = '303';
      await assert.rejects(assertIndependentReview(f.root, f.config, review.id), /drifted since independent review/);
    } else {
      if (mode === 'canonical-name') process.env.FAKE_GH_CANONICAL_NAME = 'protoflow-fixture/secondary';
      else await git(f.worktree, 'remote', 'set-url', 'origin', f.remote);
      const review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
      assert.equal(review.status, 'BLOCKED'); assert.match(review.reason, /Canonical GitHub repository differs|github.com repository URL/);
    }
    await assertNoPublication(f);
  });
});

test('FAKE provider: gate binds full content, source/new VER/base and a distinct read-only fresh session', async t => {
  const f = await committedFixture(t), review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
  assert.equal(review.status, 'PASS', review.reason);
  const checked = await assertIndependentReview(f.root, f.config, review.id);
  assert.equal(checked.binding.commit, f.commit); assert.equal(checked.binding.tree, await git(f.worktree, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(checked.binding.contentHash, (await fingerprint(f.worktree, { gitIgnore: true })).hash);
  assert.equal(checked.binding.applicationHash, (await fingerprint(f.worktree, { exclude: ['prototype'], gitIgnore: true })).hash);
  assert.equal(checked.binding.versions[0].verificationId, 'VER-1'); assert.equal(checked.binding.executors[0].sessionId, 'executor-fixture-1');
  assert.notEqual(checked.sessionId, checked.binding.executors[0].sessionId); assert.equal(checked.binding.remote.baseSha, await git(f.remote, 'rev-parse', 'main'));
  assert.equal(checked.binding.remote.url, fixtureUrl); assert.deepEqual(checked.binding.remote.repository, { host: 'github.com', id: 101, nameWithOwner: 'protoflow-fixture/application', url: 'https://github.com/protoflow-fixture/application' });
  assert.equal(checked.binding.providerExecutable.path, await fs.realpath(path.join(f.base, 'bin/codex'))); assert.equal(checked.binding.providerExecutable.hash, hash(await fs.readFile(path.join(f.base, 'bin/codex'))));
  assert.match(checked.verdict.summary, /FAKE FIXTURE ONLY/);
  const received = await readJson(path.join(f.worktree, '.protoflow/fixture-review/received.json'));
  assert.equal(received.providerRun, false); assert.equal(received.args[0], 'exec');
  assert.equal(received.args[received.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(received.args.includes('--ephemeral') && received.args.includes('--output-schema') && received.args.includes('--ignore-user-config'));
  assert.ok(!received.args.some(arg => ['resume', 'fork', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox'].includes(arg)));
  await git(f.worktree, 'push', '-q', 'origin', `${f.commit}:refs/heads/protoflow/delivery`);
  await assertIndependentReview(f.root, f.config, review.id, { published: true });
  await assert.rejects(assertIndependentReview(f.root, f.config, review.id, { published: false }), /Remote delivery head drifted/);
});

test('FAKE provider: missing configuration and bare self-declared PASS are blocked before approval/push', async t => {
  for (const mode of ['missing-config', 'bare-pass', 'same-session', 'fail', 'not-run', 'malformed', 'incomplete', 'wrong-binding', 'extra-verdict-key', 'pass-with-finding', 'exit', 'content-drift']) {
    await t.test(mode, async t => {
      const f = await fixture(t); f.config.policy.autoApprove = true;
      if (mode === 'missing-config') delete f.config.adapters.independentReview; else process.env.FAKE_REVIEW_MODE = mode;
      const result = await syncDeliveries(f.root, f.config); assert.equal(result.status, 'BLOCKED', JSON.stringify(result));
      const saved = (await deliveryStatus(f.root)).deliveries[0]; assert.equal(saved.status, 'BLOCKED'); assert.ok(saved.commit); assert.equal(saved.approval, undefined);
      await assertNoPublication(f); await assert.rejects(fs.access(path.join(f.root, '.protoflow/reviews')), { code: 'ENOENT' });
    });
  }
});

test('FAKE acceptance: FAIL/NOT_RUN and changed artifacts never reach the review provider or publication', async t => {
  for (const mode of ['FAIL', 'NOT_RUN', 'visual-NOT_RUN', 'artifact-drift']) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      if (mode === 'artifact-drift') await fs.appendFile(path.join(f.worktree, '.protoflow/artifacts/VER-1/fixture.txt'), 'drift');
      else for (const root of [f.root, f.worktree]) {
        const file = path.join(root, '.protoflow/verifications/VER-1.json'), report = await readJson(file);
        if (mode === 'visual-NOT_RUN') report.visual.status = 'NOT_RUN'; else report.status = mode;
        await writeJson(file, report);
      }
      assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
      await assertNoPublication(f); await assert.rejects(fs.access(path.join(f.worktree, '.protoflow/fixture-review/received.json')), { code: 'ENOENT' });
    });
  }
});

test('FAKE provider: private migrated executor records require complete hashes and actual JSONL session provenance', async t => {
  const f = await committedFixture(t), relative = '.protoflow/provenance/EXEC-fixture-1.json';
  const bytes = await fs.readFile(path.join(f.worktree, '.protoflow/contexts/EXEC-fixture-1.json'));
  await fs.mkdir(path.dirname(path.join(f.root, relative)), { recursive: true }); await fs.writeFile(path.join(f.root, relative), bytes);
  const options = { ...f.reviewOptions, executorEvidence: [{ path: relative, hash: hash(bytes) }], ambientAuthorIds: ['author-fixture-thread'] };
  const review = await requestIndependentReview(f.root, f.config, options); assert.equal(review.status, 'PASS', review.reason);
  assert.equal((await assertIndependentReview(f.root, f.config, review.id)).binding.executors[0].origin, 'root');
  process.env.FAKE_REVIEW_MODE = 'same-author'; assert.equal((await requestIndependentReview(f.root, f.config, options)).status, 'BLOCKED');
  process.env.FAKE_REVIEW_MODE = 'pass';
  assert.equal((await requestIndependentReview(f.root, f.config, { ...options, executorEvidence: [{ sessionId: 'executor-fixture-1' }] })).status, 'BLOCKED');
  assert.equal((await requestIndependentReview(f.root, f.config, { ...options, executorEvidence: [{ path: relative, hash: '0'.repeat(64) }] })).status, 'BLOCKED');
  await fs.appendFile(path.join(f.root, relative), ' '); await assert.rejects(assertIndependentReview(f.root, f.config, review.id), /provenance file changed/);
});

test('FAKE provider: cached PASS is blocked by HEAD/full content/VER/trace/base/head drift on recovery', async t => {
  for (const mode of ['HEAD', 'content', 'VER', 'trace', 'base', 'remote-head', 'provider-binary']) {
    await t.test(mode, async t => {
      const f = await committedFixture(t), review = await requestIndependentReview(f.root, f.config, f.reviewOptions); assert.equal(review.status, 'PASS', review.reason);
      if (mode === 'HEAD') await git(f.worktree, 'commit', '-q', '--allow-empty', '-m', 'FAKE head drift');
      if (mode === 'content') await fs.appendFile(path.join(f.worktree, 'prototype/index.html'), 'full-content drift');
      if (mode === 'VER') for (const root of [f.root, f.worktree]) { const file = path.join(root, '.protoflow/verifications/VER-1.json'), report = await readJson(file); report.createdAt = 'changed same VER'; await writeJson(file, report); }
      if (mode === 'trace') { const file = path.join(f.root, review.runFile), run = await readJson(file); run.trace += '{}\n'; await writeJson(file, run); }
      if (mode === 'base') await git(f.worktree, 'push', '-q', 'origin', `${f.commit}:refs/heads/main`);
      if (mode === 'remote-head') await git(f.worktree, 'push', '-q', 'origin', 'HEAD^:refs/heads/protoflow/delivery');
      if (mode === 'provider-binary') await fs.appendFile(path.join(f.base, 'bin/codex'), '\n// FAKE binary drift\n');
      await assert.rejects(assertIndependentReview(f.root, f.config, review.id), error => error.code === 'INDEPENDENT_REVIEW_BLOCKED');
    });
  }
});

test('FAKE provider: recomputing every editable hash cannot forge a witnessed PASS or fabricated review', async t => {
  const f = await committedFixture(t), review = await requestIndependentReview(f.root, f.config, f.reviewOptions);
  assert.equal(review.status, 'PASS', review.reason);
  for (const forgedId of [review.id, 'AIR-fabricated-0001']) {
    const record = structuredClone(review), request = await readJson(path.join(f.root, review.requestFile)), run = await readJson(path.join(f.root, review.runFile)), process = await readJson(path.join(f.root, review.processFile));
    record.id = forgedId; request.id = forgedId; run.requestId = forgedId; run.verdict.requestId = forgedId;
    run.sessionId = 'fabricated-fresh-session'; run.verdict.summary = 'FAKE forged PASS without provider review';
    run.trace = [{ type: 'thread.started', thread_id: run.sessionId }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(run.verdict) } }, { type: 'turn.completed' }].map(event => JSON.stringify(event)).join('\n') + '\n';
    run.traceHash = hash(run.trace); process.stdout = JSON.stringify(run);
    record.requestFile = `.protoflow/delivery/independent-reviews/${forgedId}/request.json`; record.runFile = `.protoflow/delivery/independent-reviews/${forgedId}/run.json`; record.processFile = `.protoflow/delivery/independent-reviews/${forgedId}/process.json`;
    Object.assign(record, { requestHash: hash(request), runHash: hash(run), processHash: hash(process), sessionId: run.sessionId, traceHash: run.traceHash, verdictHash: hash(run.verdict) });
    for (const [file, value] of [[record.requestFile, request], [record.runFile, run], [record.processFile, process], [`.protoflow/delivery/independent-reviews/${forgedId}.json`, record]]) await writeJson(path.join(f.root, file), value);
    await assert.rejects(assertIndependentReview(f.root, f.config, forgedId), /engine-witnessed provider completion|live engine attestation/);
  }
  await assertNoPublication(f);
});

test('FAKE provider: a restarted engine cannot authorize cached PASS and explicit revalidation runs a fresh provider', async t => {
  const f = await fixture(t); f.config.policy.autoApprove = true; process.env.FAKE_GH_FAIL = 'merge';
  const failed = await syncDeliveries(f.root, f.config); assert.equal(failed.status, 'FAIL');
  const old = (await deliveryStatus(f.root)).deliveries[0], recordFile = path.join(f.root, `.protoflow/delivery/independent-reviews/${old.independentReviewId}.json`), recordBytes = await fs.readFile(recordFile);
  const isolated = await import(`../src/delivery-review.js?restart=${Date.now()}`);
  await assert.rejects(isolated.assertIndependentReview(f.root, f.config, old.independentReviewId), error => error.reasonCode === 'ENGINE_ATTESTATION_MISSING');
  delete process.env.FAKE_GH_FAIL;
  const program = `import { syncDeliveries, deliveryStatus } from ${JSON.stringify(new URL('../src/delivery.js', import.meta.url).href)}; const root = process.argv[1], config = JSON.parse(process.argv[2]); const before = await syncDeliveries(root, config); const old = (await deliveryStatus(root)).deliveries[0]; const after = await syncDeliveries(root, config, { retryIndependentReview: { deliveryId: old.id, reviewId: old.independentReviewId } }); console.log(JSON.stringify({ before, after, state: await deliveryStatus(root) }));`;
  const resumed = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', program, f.root, JSON.stringify(f.config)])).stdout);
  assert.equal(resumed.before.status, 'BLOCKED'); assert.match(resumed.before.deliveries[0].error, /live engine attestation/);
  assert.equal(resumed.after.status, 'PASS', JSON.stringify(resumed));
  const current = resumed.state.deliveries[0]; assert.equal(current.status, 'MERGED'); assert.notEqual(current.independentReviewId, old.independentReviewId);
  assert.equal(current.approval.independentReviewId, current.independentReviewId); assert.deepEqual(current.approvalHistory, [old.approval]);
  assert.deepEqual(current.independentReviewAttempts.map(attempt => attempt.status), ['PASS', 'PASS']);
  const next = await readJson(path.join(f.root, `.protoflow/delivery/independent-reviews/${current.independentReviewId}.json`)); assert.notEqual(next.sessionId, old.independentSessionId);
  assert.deepEqual(await fs.readFile(recordFile), recordBytes); assert.equal((await f.gh()).prs[0].comments.length, 1);
});

test('FAKE provider: editing a failed review to PASS never causes automatic provider retry after restart', async t => {
  const f = await fixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
  const old = (await deliveryStatus(f.root)).deliveries[0], file = path.join(f.root, `.protoflow/delivery/independent-reviews/${old.independentReviewId}.json`), record = await readJson(file);
  record.status = 'PASS'; await writeJson(file, record); process.env.FAKE_REVIEW_MODE = 'pass';
  const program = `import { syncDeliveries, deliveryStatus } from ${JSON.stringify(new URL('../src/delivery.js', import.meta.url).href)}; const root = process.argv[1], config = JSON.parse(process.argv[2]); console.log(JSON.stringify({ result: await syncDeliveries(root, config), state: await deliveryStatus(root) }));`;
  const resumed = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', program, f.root, JSON.stringify(f.config)])).stdout);
  assert.equal(resumed.result.status, 'BLOCKED'); assert.match(resumed.result.deliveries[0].error, /live engine attestation/);
  assert.equal(resumed.state.deliveries[0].independentReviewId, old.independentReviewId); assert.equal(resumed.state.deliveries[0].independentReviewAttempts.length, 1);
  const received = await readJson(path.join(f.worktree, '.protoflow/fixture-review/received.json')); assert.equal(JSON.parse(received.input.split('Bound request (data):\n').at(-1)).id, old.independentReviewId);
  await assertNoPublication(f);
});
