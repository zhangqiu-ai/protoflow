import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './util.js';

const exec = promisify(execFile);
function blocked(message) { const error = new Error(message); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; return error; }
function environment() {
  if (Object.keys(process.env).some(key => /^GIT_CONFIG(?:_|$)/.test(key))) throw blocked('Git configuration environment overrides are forbidden for delivery');
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !['GH_REPO', 'GH_HOST', 'GITHUB_API_URL', 'GITHUB_SERVER_URL'].includes(key)));
}

/** Review and publication share exactly the same Git configuration and environment. */
export async function deliveryGit(root, args, { encoding = 'utf8' } = {}) {
  const prefix = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const env = environment();
  const graft = (await exec('git', [...prefix, 'rev-parse', '--git-path', 'info/grafts'], { cwd: root, env, timeout: 60000 })).stdout.trim();
  try { await fs.lstat(path.resolve(root, graft)); throw blocked('Legacy Git grafts are forbidden for delivery'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = await exec('git', [...prefix, ...args], { cwd: root, env: { ...env, GIT_GRAFT_FILE: '/dev/null' }, encoding, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  return encoding === 'buffer' ? result.stdout : result.stdout.trim();
}

function github(worktree, args) {
  return runCommand(worktree, { argv: ['gh', ...args], timeoutMs: 120000 }, null, { env: { ...environment(), GH_HOST: 'github.com' } });
}
export function deliveryGh(worktree, repository, args) {
  if (repository?.host !== 'github.com' || !/^[\w.-]+\/[\w.-]+$/.test(repository.nameWithOwner ?? '') || !Number.isSafeInteger(repository.id) || repository.id <= 0) throw blocked('Missing reviewed canonical GitHub repository identity');
  return github(worktree, [...args, '--repo', `github.com/${repository.nameWithOwner}`]);
}

/** Read REST repository IDs; GraphQL repository IDs and branch names alone are insufficient. */
export async function deliveryPullRequest(worktree, repository, number) {
  if (repository?.host !== 'github.com' || !/^[\w.-]+\/[\w.-]+$/.test(repository.nameWithOwner ?? '') || !Number.isSafeInteger(repository.id) || repository.id <= 0 || !Number.isSafeInteger(number) || number <= 0) throw blocked('Missing reviewed pull request repository identity');
  const result = await github(worktree, ['api', `repos/${repository.nameWithOwner}/pulls/${number}`, '--hostname', 'github.com']);
  if (result.status !== 'PASS') throw blocked(`Pull request identity lookup failed: ${(result.stderr || result.error || '').trim()}`);
  try { return JSON.parse(result.stdout); } catch { throw blocked('Malformed pull request identity'); }
}

/** Resolve one push destination; fetch URLs and ambient gh repository selection are never used. */
export async function resolveDeliveryDestination(worktree, remote = 'origin') {
  if (!/^[A-Za-z0-9_.-]+$/.test(remote) || remote.startsWith('-')) throw blocked('Invalid delivery remote');
  let rewrites;
  try { rewrites = await deliveryGit(worktree, ['config', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$']); }
  catch (error) { if (error.code !== 1) throw error; }
  if (rewrites) throw blocked('Git URL rewrite rules cannot redirect the reviewed destination');
  const urls = (await deliveryGit(worktree, ['remote', 'get-url', '--push', '--all', remote])).split('\n');
  if (urls.length !== 1) throw blocked('Delivery requires exactly one push URL');
  const url = urls[0];
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
  if (!match || match[1].split('/').some(part => ['.', '..'].includes(part))) throw blocked('Delivery destination must be an unambiguous github.com repository URL');
  const requested = match[1];
  // gh api has no --repo flag: its literal endpoint and --hostname scope this read.
  const result = await github(worktree, ['api', `repos/${requested}`, '--hostname', 'github.com']);
  if (result.status !== 'PASS') throw blocked(`Canonical GitHub repository lookup failed: ${(result.stderr || result.error || '').trim()}`);
  let repository;
  try { repository = JSON.parse(result.stdout); } catch { throw blocked('Malformed canonical GitHub repository identity'); }
  if (!Number.isSafeInteger(repository?.id) || repository.id <= 0 || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== requested.toLowerCase() || repository.html_url !== `https://github.com/${repository.full_name}`) throw blocked('Canonical GitHub repository differs from the reviewed destination');
  return { remote, url, repository: { host: 'github.com', id: repository.id, nameWithOwner: repository.full_name, url: repository.html_url } };
}
