import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncDeliveries, deliveryStatus } from '../src/delivery.js';
import { sourceStatus, saveSourceState } from '../src/source.js';
import { writeJson } from '../src/util.js';
import { FAKE_GH } from './helpers/fake-gh.js';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', args, { cwd }).then(result => result.stdout.trim());


async function fixture(t, { merge = 'auto', versions = 1 } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-delivery-'));
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
  await saveSourceState(root, { schemaVersion: 1, status: 'READY', entries: shas.map((sha, index) => ({ sha, manifestId: `git-${sha}`, ordinal: index + 1, status: 'PASS', verificationId: `VER-${index + 1}`, attempts: [] })) });
  await writeJson(path.join(root, '.protoflow/runner/state.json'), { schemaVersion: 1, worktree, status: 'IDLE' });

  const bin = path.join(base, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const db = path.join(base, 'gh.json');
  const previous = { PATH: process.env.PATH, FAKE_GH_DB: process.env.FAKE_GH_DB, FAKE_GH_FAIL: process.env.FAKE_GH_FAIL };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_GH_DB = db;
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const config = {
    schemaVersion: 1, prototypeDir: 'prototype', mappings: [], policy: { sequentialVersions: true },
    source: { kind: 'git', repository: remote, branch: 'prototypes', path: 'prototype' },
    runner: { delivery: { remote: 'origin', branch: 'protoflow/delivery', baseBranch: 'main', merge } },
  };
  const gh = async () => JSON.parse(await fs.readFile(db, 'utf8'));
  return { root, worktree, remote, config, shas, gh };
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

test('a second delivery on the same branch opens and merges its own PR, not the earlier merged one', async t => {
  const { root, worktree, config, gh } = await fixture(t);
  const first = await syncDeliveries(root, config);
  assert.equal(first.deliveries[0].status, 'MERGED');
  // Next accepted version: new application content and a new PASS entry.
  await fs.writeFile(path.join(worktree, 'app/index.html'), '<main>v2</main>\n');
  const state = await sourceStatus(root);
  state.entries.push({ sha: '3'.repeat(40), manifestId: `git-${'3'.repeat(40)}`, ordinal: 2, status: 'PASS', verificationId: 'VER-2', attempts: [] });
  await saveSourceState(root, state);
  const second = await syncDeliveries(root, config);
  assert.equal(second.status, 'PASS', JSON.stringify(second));
  const delivery = second.deliveries.at(-1);
  assert.equal(delivery.status, 'MERGED');
  assert.equal(delivery.pr, 'https://github.test/pr/2');
  assert.equal(delivery.mergeCommit, 'merge-2');
  assert.deepEqual((await gh()).prs.map(pr => [pr.number, pr.state]), [[1, 'MERGED'], [2, 'MERGED']]);
});
