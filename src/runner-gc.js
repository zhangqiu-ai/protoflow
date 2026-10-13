import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { git } from './source.js';
import { streamTargets, runnerStatePath } from './streams.js';
import { processGroupAlive } from './util.js';

const exec = promisify(execFile);

/*
 * Runner worktree garbage collection. The runner keeps one worktree per source route (and per target); a changed
 * source, a removed target or a superseded acceptance run leaves the old ones behind. Only registered worktrees named
 * .protoflow/runner/worktree-* of this project are considered. A worktree is removed only when no current stream's
 * runner state uses it, git has not locked it, it has no uncommitted changes and no process may still run in it.
 * Its ignored .protoflow evidence is archived first; its branch is deleted only when the commits live on elsewhere.
 */

const ACTIVE_STATUSES = new Set(['RUNNING', 'INITIALIZING', 'STARTING']);

/** Parse `git worktree list --porcelain`. */
export function parseWorktrees(porcelain) {
  return porcelain.split('\n\n').map(block => block.trim()).filter(Boolean).map(block => {
    const item = { path: null, head: null, branch: null, locked: false, prunable: false };
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') item.path = value;
      else if (key === 'HEAD') item.head = value;
      else if (key === 'branch') item.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'locked') item.locked = true;
      else if (key === 'prunable') item.prunable = true;
    }
    return item;
  });
}

const realpathOr = async file => { try { return await fs.realpath(file); } catch { return path.resolve(file); } };
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

async function runnerStates(root) {
  const directory = path.join(root, '.protoflow/runner');
  const files = ['state.json'];
  for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (item.isDirectory() && await exists(path.join(directory, item.name, 'state.json'))) files.push(`${item.name}/state.json`);
  }
  const states = [];
  for (const file of files) {
    const state = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8').catch(() => 'null'));
    if (state?.worktree) states.push({ file: `.protoflow/runner/${file}`, state, worktree: await realpathOr(state.worktree) });
  }
  return states;
}

async function sizeOf(directory) {
  try { return Number((await exec('du', ['-sk', directory])).stdout.split(/\s/)[0]) * 1024; } catch { return null; }
}

/** True when another ref (any branch, tag or remote-tracking ref) already contains the branch tip. */
async function containedElsewhere(root, branch, head) {
  if (!branch || !head) return false;
  const refs = (await git(root, ['for-each-ref', '--contains', head, '--format=%(refname)'])).split('\n').filter(Boolean);
  return refs.some(ref => ref !== `refs/heads/${branch}`);
}

/** Classify this project's runner worktrees: active, stale (removable), unsafe (kept, with reasons) or missing. */
export async function runnerWorktrees(root, config) {
  root = await fs.realpath(root);
  const runnerDir = path.join(root, '.protoflow', 'runner');
  const current = new Set(streamTargets(config).map(stream => runnerStatePath(config, stream)));
  const states = await runnerStates(root);
  const items = [];
  for (const entry of parseWorktrees(await git(root, ['worktree', 'list', '--porcelain']))) {
    const real = await realpathOr(entry.path);
    if (path.dirname(real) !== runnerDir || !path.basename(real).startsWith('worktree-')) continue;
    const refs = states.filter(item => item.worktree === real);
    const item = { path: path.relative(root, real), branch: entry.branch, head: entry.head, states: refs.map(ref => ref.file), reasons: [] };
    if (!await exists(real)) { items.push({ ...item, classification: 'missing', reasons: ['directory no longer exists; git worktree prune removes the registration'] }); continue; }
    if (refs.some(ref => current.has(ref.file))) { items.push({ ...item, classification: 'active', size: await sizeOf(real) }); continue; }
    if (entry.locked) item.reasons.push('locked by git worktree lock');
    const dirty = (await git(real, ['status', '--porcelain', '--untracked-files=normal'])).split('\n').filter(Boolean);
    if (dirty.length) item.reasons.push(`${dirty.length} uncommitted path(s)`);
    for (const ref of refs) {
      if (ACTIVE_STATUSES.has(ref.state.status)) item.reasons.push(`${ref.file} is ${ref.state.status}`);
      for (const pid of [ref.state.setupPgid ?? ref.state.setupPid]) if (Number.isSafeInteger(pid) && pid > 0 && processGroupAlive(pid)) item.reasons.push(`setup process group ${pid} is alive`);
    }
    item.branchContainedElsewhere = await containedElsewhere(root, entry.branch, entry.head);
    items.push({ ...item, classification: item.reasons.length ? 'unsafe' : 'stale', size: await sizeOf(real) });
  }
  return items;
}

/**
 * `protoflow runner gc [--apply]`: report runner worktrees; with apply, archive and remove the stale ones.
 * Never forces a removal and never deletes a branch whose commits exist nowhere else.
 */
export async function collectRunnerWorktrees(root, config, { apply = false, now = new Date() } = {}) {
  root = await fs.realpath(root);
  const worktrees = await runnerWorktrees(root, config);
  let freed = 0;
  if (apply) {
    const archiveDir = path.join(root, '.protoflow/runner/archive');
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    for (const item of worktrees) {
      if (item.classification === 'missing') { await git(root, ['worktree', 'prune']); item.removed = true; continue; }
      if (item.classification !== 'stale') continue;
      const directory = path.join(root, item.path);
      try {
        if (await exists(path.join(directory, '.protoflow'))) {
          await fs.mkdir(archiveDir, { recursive: true });
          const archive = path.join(archiveDir, `${path.basename(directory)}-${stamp}.tar.gz`);
          await exec('tar', ['-czf', archive, '--exclude', 'node_modules', '-C', directory, '.protoflow']);
          item.archive = path.relative(root, archive);
        }
        await git(root, ['worktree', 'remove', directory]);
        item.removed = true;
        freed += item.size ?? 0;
        if (item.branch && item.branchContainedElsewhere) { await git(root, ['branch', '-D', item.branch]); item.branchDeleted = true; }
        else if (item.branch) item.branchKept = 'its commits exist only on this branch';
      } catch (error) { item.error = error.stderr?.trim() || error.message; }
    }
  }
  const counts = {};
  for (const item of worktrees) counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  const removable = worktrees.filter(item => item.classification === 'stale').reduce((sum, item) => sum + (item.size ?? 0), 0);
  return { status: worktrees.some(item => item.error) ? 'FAIL' : 'PASS', applied: apply, counts, ...(apply ? { freedBytes: freed } : { removableBytes: removable }), worktrees };
}
