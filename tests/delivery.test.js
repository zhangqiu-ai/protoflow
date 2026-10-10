import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncDeliveries, deliveryStatus } from '../src/delivery.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { saveProgress } from '../src/streams.js';
import { writeJson, hash, fingerprint, readJson } from '../src/util.js';
import { applicationFingerprint } from '../src/workflow.js';
import { snapshot } from '../src/sessions.js';
import { freezeVersion } from '../src/versions.js';
import { assertIndependentReview, requestIndependentReview } from '../src/delivery-review.js';
import { deliveryGit } from '../src/delivery-scope.js';
import { fileURLToPath } from 'node:url';
import { FAKE_GH } from './helpers/fake-gh.js';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', args, { cwd }).then(result => result.stdout.trim());
const realGit = (await exec('which', ['git'])).stdout.trim();
const fixtureUrl = 'https://github.com/protoflow-fixture/application.git';
const fixtureRepository = 'github.com/protoflow-fixture/application';

async function fixture(t, { merge = 'auto', versions = 1 } = {}) {
  const base = await fs.mkdtemp(path.join('/tmp', 'protoflow-delivery-review-fake-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'project');
  const worktree = path.join(base, 'worktree');
  await git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(base, 'clone', '-q', remote, root);
  for (const dir of [root]) {
    await git(dir, 'config', 'user.email', 'fixture@protoflow.test');
    await git(dir, 'config', 'user.name', 'Fixture');
  }
  await fs.writeFile(path.join(root, 'README.md'), 'app\n');
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.writeFile(path.join(root, 'prototype/index.html'), '<main>fake prototype fixture</main>');
  // Mirrors real projects: runner state and test output are gitignored, but a node_modules symlink is not matched by 'node_modules/'.
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.protoflow/\ntest-results/\nplaywright-report/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'init');
  await git(root, 'push', '-q', 'origin', 'HEAD:main');
  await git(root, 'worktree', 'add', '-q', '-b', 'runner-local', worktree);
  // Application edits plus content that must never be committed.
  await fs.mkdir(path.join(worktree, 'app'));
  await fs.writeFile(path.join(worktree, 'app/index.html'), '<main>v1</main>\n');
  await fs.mkdir(path.join(worktree, '.protoflow/contexts'), { recursive: true });
  await fs.writeFile(path.join(worktree, '.protoflow/contexts/EXEC.json'), '{}');
  await fs.symlink(path.join(base, 'shared-node-modules'), path.join(worktree, 'node_modules'));
  await fs.mkdir(path.join(worktree, 'test-results'));
  await fs.writeFile(path.join(worktree, 'test-results/out.txt'), 'x');

  const shas = Array.from({ length: versions }, (_, index) => `${String(index + 1).repeat(8)}${'a'.repeat(32)}`);
  await saveSourceState(root, { schemaVersion: 1, status: 'READY', entries: shas.map((sha, index) => ({ sha, manifestId: `git-${sha}`, ordinal: index + 1, status: 'PASS', verificationId: `VER-${index + 1}`, attempts: [{ executionId: `EXEC-fixture-${index + 1}`, executionStatus: 'PASS', status: 'PASS' }] })) });
  await writeJson(path.join(root, '.protoflow/runner/state.json'), { schemaVersion: 1, worktree, status: 'IDLE' });

  const { db, transport, transportLog } = await fakeEnvironment(t, base, root, remote);
  const config = {
    schemaVersion: 1, prototypeDir: 'prototype', mappings: [], policy: { sequentialVersions: true },
    source: { kind: 'git', repository: remote, branch: 'prototypes', path: 'prototype' },
    runner: { delivery: { remote: 'origin', branch: 'protoflow/delivery', baseBranch: 'main', merge } },
    adapters: { independentReview: { command: { argv: [process.execPath, fileURLToPath(new URL('../scripts/codex-review-adapter.js', import.meta.url))], timeoutMs: 10000 } } },
  };
  for (const [index, sha] of shas.entries()) await acceptVersion({ root, worktree, config, sha, ordinal: index + 1, verificationId: `VER-${index + 1}`, executionId: `EXEC-fixture-${index + 1}` });
  const gh = async () => JSON.parse(await fs.readFile(db, 'utf8'));
  return { root, worktree, remote, config, shas, gh, base, transport, gitCalls: () => readJson(transportLog, []) };
}

/** PATH doubles for gh, git transport and codex; github.com URLs map onto local bare remotes. */
async function fakeEnvironment(t, base, root, remote) {
  const bin = path.join(base, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  await fs.copyFile(fileURLToPath(new URL('./fixtures/fake-delivery-git.cjs', import.meta.url)), path.join(bin, 'git')); await fs.chmod(path.join(bin, 'git'), 0o755);
  await fs.copyFile(fileURLToPath(new URL('./fixtures/fake-codex-review.cjs', import.meta.url)), path.join(bin, 'codex')); await fs.chmod(path.join(bin, 'codex'), 0o755);
  const db = path.join(base, 'gh.json');
  const transport = path.join(base, 'git-transport.json'), transportLog = path.join(base, 'git-calls.json');
  await writeJson(transport, { realGit, urls: { [fixtureUrl]: remote }, log: transportLog });
  await git(root, 'remote', 'set-url', 'origin', fixtureUrl);
  const previous = Object.fromEntries(['PATH', 'FAKE_GH_DB', 'FAKE_GH_FAIL', 'FAKE_GH_DRIFT', 'FAKE_REVIEW_MODE', 'FAKE_DELIVERY_GIT', 'GH_REPO', 'GH_HOST', 'FAKE_GH_CANONICAL_NAME', 'FAKE_GH_REPOSITORY_ID', 'FAKE_GH_REAL_REMOTE', 'FAKE_GH_ROOT', 'FAKE_GH_TAMPER_REVIEW', 'FAKE_GH_TAMPER_RUNNER'].map(key => [key, process.env[key]]));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_GH_DB = db;
  process.env.FAKE_DELIVERY_GIT = transport;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { db, transport, transportLog };
}

/** Synthetic PASS and executor JSONL are protocol fixtures, never real acceptance/provider evidence. */
async function acceptVersion({ root, worktree, config, sha, ordinal, verificationId, executionId, target }) {
  const manifestId = `git-${sha}`;
  const captured = await snapshot(worktree, config, { keepBytes: true }); await freezeVersion(worktree, manifestId, captured);
  // Deterministic, so several targets accepting one version share the identical manifest.
  const manifest = { id: manifestId, createdAt: '2026-01-01T00:00:00.000Z', level: 'L1', afterHash: captured.hash, mappings: [], changes: [], source: { ...config.source, sha, ordinal } };
  const artifact = `.protoflow/artifacts/${verificationId}/fixture.txt`; await fs.mkdir(path.dirname(path.join(worktree, artifact)), { recursive: true }); await fs.writeFile(path.join(worktree, artifact), 'FAKE ACCEPTANCE FIXTURE ONLY');
  const report = { id: verificationId, createdAt: new Date().toISOString(), ...(target && { target }), manifestId, manifestHash: hash(manifest), prototypeHash: manifest.afterHash, status: 'PASS', project: await applicationFingerprint(worktree, config, target), git: { head: await git(worktree, 'rev-parse', 'HEAD') }, build: { status: 'PASS' }, functional: { status: 'PASS' }, visual: { status: 'PASS', scenes: [], artifacts: [path.join(worktree, artifact)] }, artifactHashes: { [artifact]: hash('FAKE ACCEPTANCE FIXTURE ONLY') }, changedDuringVerification: false };
  for (const dir of [root, worktree]) { await writeJson(path.join(dir, `.protoflow/manifests/${manifestId}.json`), manifest); await writeJson(path.join(dir, `.protoflow/verifications/${verificationId}.json`), report); }
  const trace = [{ type: 'thread.started', thread_id: executionId.replace(/^EXEC-/, 'executor-') }, { type: 'turn.started' }, { type: 'test.fixture', providerRun: false }, { type: 'turn.completed' }].map(event => JSON.stringify(event)).join('\n') + '\n';
  await writeJson(path.join(worktree, `.protoflow/contexts/${executionId}.json`), { id: executionId, status: 'PASS', request: { kind: 'implement', manifest, manifestHash: hash(manifest) }, result: { status: 'PASS', exitCode: 0, stdout: trace, processGroupActive: false } });
}

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

async function committedFixture(t) {
  const f = await fixture(t);
  await git(f.worktree, 'add', 'app'); await git(f.worktree, 'commit', '-q', '-m', 'FAKE review binding fixture');
  f.commit = await git(f.worktree, 'rev-parse', 'HEAD');
  f.reviewOptions = { worktree: f.worktree, commit: f.commit, manifestIds: (await sourceStatus(f.root)).entries.map(entry => entry.manifestId) };
  return f;
}
async function assertNoPublication(f) {
  await assert.rejects(git(f.remote, 'rev-parse', '--verify', 'refs/heads/protoflow/delivery'));
  const github = await readJson(path.join(f.base, 'gh.json'), { calls: [], prs: [] });
  assert.deepEqual(github.prs, []); assert.ok(github.calls.every(call => call[0] === 'api'));
}

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
  assert.equal(checked.binding.contentHash, (await fingerprint(f.worktree)).hash);
  assert.equal(checked.binding.applicationHash, (await fingerprint(f.worktree, { exclude: ['prototype'] })).hash);
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
  const project = await fingerprint(f.worktree, { exclude: ['prototype'] });
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
  const f = await fixture(t); process.env.FAKE_REVIEW_MODE = 'fail';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED');
  const first = (await deliveryStatus(f.root)).deliveries[0], oldFile = path.join(f.root, `.protoflow/delivery/independent-reviews/${first.independentReviewId}.json`), bytes = await fs.readFile(oldFile), record = JSON.parse(bytes), traceBytes = await fs.readFile(path.join(f.root, record.runFile));
  process.env.FAKE_REVIEW_MODE = 'pass';
  assert.equal((await syncDeliveries(f.root, f.config)).status, 'BLOCKED'); assert.equal((await deliveryStatus(f.root)).deliveries[0].independentReviewId, first.independentReviewId);
  assert.equal((await syncDeliveries(f.root, f.config, { retryIndependentReview: { deliveryId: first.id, reviewId: 'AIR-stale-attempt' } })).status, 'BLOCKED'); await assertNoPublication(f);
  const result = await syncDeliveries(f.root, f.config, { retryIndependentReview: { deliveryId: first.id, reviewId: first.independentReviewId } }); assert.equal(result.status, 'PASS', JSON.stringify(result));
  const second = (await deliveryStatus(f.root)).deliveries[0]; assert.equal(second.commit, first.commit); assert.notEqual(second.independentReviewId, first.independentReviewId);
  assert.deepEqual(second.independentReviewAttempts.map(attempt => attempt.status), ['BLOCKED', 'PASS']); assert.equal(second.independentReviewAttempts[1].supersedes, first.independentReviewId);
  assert.deepEqual(await fs.readFile(oldFile), bytes); assert.deepEqual(await fs.readFile(path.join(f.root, record.runFile)), traceBytes);
  assert.equal((await syncDeliveries(f.root, f.config, { retryIndependentReview: { deliveryId: second.id, reviewId: second.independentReviewId } })).status, 'BLOCKED');
});

for (const mode of ['success', 'tampered review', 'substituted primary']) test(`FAKE provider: managed post-merge alignment ${mode}`, async t => {
  const f = await fixture(t);
  f.config.policy.autoApprove = true;
  const worktree = path.join(f.root, '.protoflow/runner', `worktree-${hash(f.config.source).slice(0, 12)}`);
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

/** schemaVersion 2 with two targets: separate roots, worktrees, progress and runner state over one accepted version. */
async function multiFixture(t) {
  const base = await fs.mkdtemp(path.join('/tmp', 'protoflow-delivery-review-multi-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git'), root = path.join(base, 'project');
  await git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(base, 'clone', '-q', remote, root);
  await git(root, 'config', 'user.email', 'fixture@protoflow.test'); await git(root, 'config', 'user.name', 'Fixture');
  await fs.writeFile(path.join(root, 'README.md'), 'app\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.protoflow/\ntest-results/\nplaywright-report/\n');
  await fs.mkdir(path.join(root, 'prototype')); await fs.writeFile(path.join(root, 'prototype/index.html'), '<main>fake prototype fixture</main>');
  const ids = ['web', 'desktop'];
  for (const id of ids) { await fs.mkdir(path.join(root, id)); await fs.writeFile(path.join(root, id, '.gitkeep'), ''); }
  await git(root, 'add', '.'); await git(root, 'commit', '-q', '-m', 'init'); await git(root, 'push', '-q', 'origin', 'HEAD:main');
  const { db } = await fakeEnvironment(t, base, root, remote);
  const target = id => ({ id, platform: 'web', root: id, driver: { kind: 'playwright-web', urlTemplate: `${id}/{page}.html` } });
  const config = {
    schemaVersion: 2, prototypeDir: 'prototype', targets: ids.map(target), policy: { sequentialVersions: true },
    source: { kind: 'git', repository: remote, branch: 'prototypes', path: 'prototype' },
    runner: { delivery: { remote: 'origin', branch: 'protoflow/delivery', baseBranch: 'main', merge: 'auto' } },
    adapters: { independentReview: { command: { argv: [process.execPath, fileURLToPath(new URL('../scripts/codex-review-adapter.js', import.meta.url))], timeoutMs: 10000 } } },
  };
  const sha = `${'1'.repeat(8)}${'a'.repeat(32)}`, manifestId = `git-${sha}`, worktrees = {};
  await saveSourceState(root, { schemaVersion: 1, status: 'READY', entries: [{ sha, manifestId, ordinal: 1, status: 'PASS' }] });
  for (const id of ids) {
    const worktree = worktrees[id] = path.join(base, `worktree-${id}`);
    await git(root, 'worktree', 'add', '-q', '-b', `runner-${id}`, worktree);
    await fs.writeFile(path.join(worktree, id, 'index.html'), `<main>${id} v1</main>\n`);
    await saveProgress(root, config, id, { entries: [{ sha, manifestId, ordinal: 1, status: 'PASS', verificationId: `VER-${id}`, attempts: [{ executionId: `EXEC-${id}-1`, executionStatus: 'PASS', status: 'PASS' }] }], completedSha: sha });
    await writeJson(path.join(root, `.protoflow/runner/${id}/state.json`), { schemaVersion: 1, worktree, status: 'IDLE' });
    await acceptVersion({ root, worktree, config, sha, ordinal: 1, verificationId: `VER-${id}`, executionId: `EXEC-${id}-1`, target: id });
  }
  process.env.FAKE_GH_REAL_REMOTE = remote;
  return { root, remote, config, worktrees, gh: async () => JSON.parse(await fs.readFile(db, 'utf8')) };
}

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
