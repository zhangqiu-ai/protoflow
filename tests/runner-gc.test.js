import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectRunnerWorktrees, parseWorktrees } from '../src/runner-gc.js';

const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', args, { cwd }).then(result => result.stdout.trim());

/**
 * A project with four runner worktrees: the current runner's, an unused clean one, an unused dirty one and an unused
 * one whose branch carries a commit that exists nowhere else; plus a worktree outside .protoflow/runner.
 */
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-gc-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(await fs.realpath(base), 'app');
  await fs.mkdir(root);
  await git(root, 'init', '-q', '-b', 'main');
  await git(root, 'config', 'user.email', 'gc@example.test');
  await git(root, 'config', 'user.name', 'gc');
  await fs.writeFile(path.join(root, '.gitignore'), '.protoflow/\nnode_modules/\n');
  await fs.writeFile(path.join(root, 'app.js'), 'export const app = 1;\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-qm', 'app');
  const add = async (name, branch) => {
    const directory = path.join(root, '.protoflow/runner', name);
    await git(root, 'worktree', 'add', '-q', '-b', branch, directory, 'main');
    return directory;
  };
  const active = await add('worktree-aaaaaaaaaaaa', 'protoflow-runner-active');
  const stale = await add('worktree-bbbbbbbbbbbb', 'protoflow-runner-stale');
  const dirty = await add('worktree-cccccccccccc', 'protoflow-runner-dirty');
  const unmerged = await add('worktree-dddddddddddd-old', 'protoflow-runner-unmerged');
  await fs.writeFile(path.join(unmerged, 'app.js'), 'export const app = 2;\n');
  await git(unmerged, 'commit', '-qam', 'codex change never delivered');
  // Ignored evidence inside a stale worktree must be archived before removal.
  await fs.mkdir(path.join(stale, '.protoflow/verifications'), { recursive: true });
  await fs.writeFile(path.join(stale, '.protoflow/verifications/VER-1.json'), '{"status":"PASS"}\n');
  await fs.mkdir(path.join(stale, 'node_modules/pkg'), { recursive: true });
  await fs.writeFile(path.join(stale, 'node_modules/pkg/index.js'), '');
  await fs.writeFile(path.join(dirty, 'app.js'), 'export const app = 3;\n');
  const outside = path.join(base, 'elsewhere');
  await git(root, 'worktree', 'add', '-q', '-b', 'elsewhere', outside, 'main');
  // Runner state: the current single stream uses the active worktree; an old route still points at the dirty one.
  await fs.writeFile(path.join(root, '.protoflow/runner/state.json'), JSON.stringify({ worktree: active, status: 'IDLE' }));
  await fs.mkdir(path.join(root, '.protoflow/runner/old'), { recursive: true });
  await fs.writeFile(path.join(root, '.protoflow/runner/old/state.json'), JSON.stringify({ worktree: dirty, status: 'BLOCKED' }));
  return { root, active, stale, dirty, unmerged, outside };
}
const config = { schemaVersion: 1 };
const byPath = result => Object.fromEntries(result.worktrees.map(item => [path.basename(item.path), item]));

test('parseWorktrees reads git porcelain blocks', () => {
  const parsed = parseWorktrees('worktree /a\nHEAD 1111\nbranch refs/heads/main\n\nworktree /b\nHEAD 2222\ndetached\nlocked busy\n\nworktree /c\nHEAD 3333\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(parsed, [
    { path: '/a', head: '1111', branch: 'main', locked: false, prunable: false },
    { path: '/b', head: '2222', branch: null, locked: true, prunable: false },
    { path: '/c', head: '3333', branch: 'x', locked: false, prunable: true }
  ]);
});

test('runner gc reports without changing anything by default', async t => {
  const { root, outside } = await fixture(t);
  const result = await collectRunnerWorktrees(root, config);
  const items = byPath(result);
  assert.equal(result.applied, false);
  assert.deepEqual(result.counts, { active: 1, stale: 2, unsafe: 1 });
  assert.equal(items['worktree-aaaaaaaaaaaa'].classification, 'active');
  assert.equal(items['worktree-bbbbbbbbbbbb'].classification, 'stale');
  assert.equal(items['worktree-bbbbbbbbbbbb'].branchContainedElsewhere, true);
  assert.equal(items['worktree-dddddddddddd-old'].branchContainedElsewhere, false);
  assert.deepEqual(items['worktree-cccccccccccc'].reasons, ['1 uncommitted path(s)']);
  assert.deepEqual(items['worktree-cccccccccccc'].states, ['.protoflow/runner/old/state.json']);
  assert.ok(result.removableBytes > 0);
  assert.equal(result.worktrees.some(item => item.path.includes('elsewhere')), false);
  assert.equal((await git(root, 'worktree', 'list')).split('\n').length, 6);
  await fs.access(outside);
});

test('runner gc --apply archives evidence, removes only clean unused worktrees and keeps unique commits', async t => {
  const { root, active, stale, dirty, unmerged, outside } = await fixture(t);
  const result = await collectRunnerWorktrees(root, config, { apply: true, now: new Date('2026-10-13T00:00:00Z') });
  const items = byPath(result);
  assert.equal(result.status, 'PASS');
  assert.ok(result.freedBytes > 0);

  // Removed, evidence archived (without node_modules), branch deleted because main already contains its commit.
  assert.equal(items['worktree-bbbbbbbbbbbb'].removed, true);
  assert.equal(items['worktree-bbbbbbbbbbbb'].branchDeleted, true);
  await assert.rejects(fs.access(stale));
  const archive = path.join(root, items['worktree-bbbbbbbbbbbb'].archive);
  const listing = (await exec('tar', ['-tzf', archive])).stdout;
  assert.match(listing, /\.protoflow\/verifications\/VER-1\.json/);
  assert.doesNotMatch(listing, /node_modules/);
  assert.equal(await git(root, 'branch', '--list', 'protoflow-runner-stale'), '');

  // Removed, but the branch with the only copy of a commit stays.
  assert.equal(items['worktree-dddddddddddd-old'].removed, true);
  assert.equal(items['worktree-dddddddddddd-old'].branchKept, 'its commits exist only on this branch');
  await assert.rejects(fs.access(unmerged));
  assert.match(await git(root, 'log', '-1', '--format=%s', 'protoflow-runner-unmerged'), /codex change never delivered/);

  // Active, dirty and unrelated worktrees are untouched.
  await fs.access(active);
  await fs.access(dirty);
  await fs.access(outside);
  assert.equal(await fs.readFile(path.join(dirty, 'app.js'), 'utf8'), 'export const app = 3;\n');
  assert.equal((await git(root, 'worktree', 'list')).split('\n').length, 4);

  // A second run finds nothing more to remove.
  const again = await collectRunnerWorktrees(root, config, { apply: true });
  assert.deepEqual(again.counts, { active: 1, unsafe: 1 });
});

test('runner gc keeps a worktree that git locked or whose runner may still be running', async t => {
  const { root, stale, unmerged } = await fixture(t);
  await git(root, 'worktree', 'lock', '--reason', 'manual inspection', stale);
  await fs.mkdir(path.join(root, '.protoflow/runner/legacy'), { recursive: true });
  await fs.writeFile(path.join(root, '.protoflow/runner/legacy/state.json'), JSON.stringify({ worktree: unmerged, status: 'RUNNING' }));
  const items = byPath(await collectRunnerWorktrees(root, config, { apply: true }));
  assert.deepEqual(items['worktree-bbbbbbbbbbbb'].reasons, ['locked by git worktree lock']);
  assert.deepEqual(items['worktree-dddddddddddd-old'].reasons, ['.protoflow/runner/legacy/state.json is RUNNING']);
  await fs.access(stale);
  await fs.access(unmerged);
});
