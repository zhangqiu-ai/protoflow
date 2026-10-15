import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand } from './util.js';

const exec = promisify(execFile);
function blocked(message) { const error = new Error(message); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; return error; }
// Network, proxy and HTTP 5xx failures of Git transport or GitHub. They say nothing about the reviewed content.
const TRANSIENT = [
  /CONNECT tunnel failed/i, /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|response|returned error:?)\s+5\d\d\b/i,
  /Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error/i,
  // Go's net/http (gh) reports a connection the server or proxy dropped mid-response as `Get "<url>": EOF`.
  /\b(?:Get|Post|Put|Patch|Delete|Head) "https?:\/\/[^"]+": (?:EOF|read: connection reset by peer)/i, /Recv failure|LibreSSL SSL_connect|context deadline exceeded|Client\.Timeout exceeded/i,
  /Could not resolve host|Failed to connect to|Connection (?:timed out|refused|reset)|Operation timed out|i\/o timeout|TLS handshake timeout|unexpected EOF|early EOF|RPC failed|remote end hung up unexpectedly|SSL_ERROR_SYSCALL|Temporary failure in name resolution|network is unreachable|\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b/i,
];
export const transientFailure = text => typeof text === 'string' && TRANSIENT.some(pattern => pattern.test(text));
/** Mark an infrastructure error as retryable when its own command output shows a transient network failure. */
export function markTransient(error, detail = error.stderr ?? error.message) { if (transientFailure(detail)) error.transient = true; return error; }
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
  let result;
  for (let attempt = 0; ; attempt++) {
    try { result = await exec('git', [...prefix, ...args], { cwd: root, env: { ...env, GIT_GRAFT_FILE: '/dev/null' }, encoding, timeout: 60000, maxBuffer: 32 * 1024 * 1024 }); break; }
    catch (error) {
      markTransient(error, String(error.stderr ?? ''));
      if (!error.transient || !READ_GIT.includes(args[0]) || attempt >= networkRetries()) throw error;
      await delay(1000 * 2 ** attempt);
    }
  }
  return encoding === 'buffer' ? result.stdout : result.stdout.trim();
}

/**
 * A flaky proxy drops a share of requests; a delivery makes dozens. Reads are retried in place on a transient network
 * failure (PROTOFLOW_NETWORK_RETRIES, default 2, 1 s then 2 s apart); pushes and GitHub writes never are, because a
 * lost response may hide a completed write.
 */
const READ_GIT = ['ls-remote', 'fetch'];
const networkRetries = () => { const value = Number(process.env.PROTOFLOW_NETWORK_RETRIES ?? 2); return Number.isInteger(value) && value >= 0 && value <= 5 ? value : 2; };
const readOnlyGh = args => (args[0] === 'api' && !args.some(arg => ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'].includes(arg))) || (args[0] === 'pr' && ['list', 'view', 'checks'].includes(args[1]));
async function github(worktree, args, input = null) {
  for (let attempt = 0; ; attempt++) {
    const result = await runCommand(worktree, { argv: ['gh', ...args], timeoutMs: 120000 }, input, { env: { ...environment(), GH_HOST: 'github.com' } });
    if (result.status === 'PASS' || !readOnlyGh(args) || attempt >= networkRetries() || !transientFailure(`${result.stderr ?? ''}\n${result.error ?? ''}`)) return result;
    await delay(1000 * 2 ** attempt);
  }
}
export function deliveryGh(worktree, repository, args) {
  if (repository?.host !== 'github.com' || !/^[\w.-]+\/[\w.-]+$/.test(repository.nameWithOwner ?? '') || !Number.isSafeInteger(repository.id) || repository.id <= 0) throw blocked('Missing reviewed canonical GitHub repository identity');
  return github(worktree, [...args, '--repo', `github.com/${repository.nameWithOwner}`]);
}

/**
 * One GitHub REST call scoped to the resolved canonical repository: the literal endpoint must start with
 * repos/<owner>/<name>/. Writes send their JSON body on stdin and are never retried; reads retry like other reads.
 */
export async function githubApi(root, repository, endpoint, { method = 'GET', body = null } = {}) {
  if (repository?.host !== 'github.com' || !/^[\w.-]+\/[\w.-]+$/.test(repository.nameWithOwner ?? '')) throw blocked('Missing canonical GitHub repository identity');
  if (typeof endpoint !== 'string' || !endpoint.startsWith(`repos/${repository.nameWithOwner}/`) || /\.\.|\s/.test(endpoint)) throw blocked(`GitHub endpoint outside ${repository.nameWithOwner}: ${endpoint}`);
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw blocked(`Unsupported GitHub method ${method}`);
  const args = ['api', endpoint, '--hostname', 'github.com', ...(method === 'GET' ? [] : ['--method', method]), ...(body ? ['--input', '-'] : [])];
  const result = await github(root, args, body);
  if (result.status !== 'PASS') {
    const detail = (result.stderr || result.error || '').trim();
    throw Object.assign(markTransient(new Error(`GitHub ${method} ${endpoint} failed: ${detail.slice(0, 500)}`), detail), { status: /HTTP (\d{3})/.exec(detail)?.[1] ? Number(/HTTP (\d{3})/.exec(detail)[1]) : null });
  }
  if (!result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout); } catch { throw new Error(`Malformed GitHub response for ${method} ${endpoint}`); }
}

/** Read REST repository IDs; GraphQL repository IDs and branch names alone are insufficient. */
export async function deliveryPullRequest(worktree, repository, number) {
  if (repository?.host !== 'github.com' || !/^[\w.-]+\/[\w.-]+$/.test(repository.nameWithOwner ?? '') || !Number.isSafeInteger(repository.id) || repository.id <= 0 || !Number.isSafeInteger(number) || number <= 0) throw blocked('Missing reviewed pull request repository identity');
  const result = await github(worktree, ['api', `repos/${repository.nameWithOwner}/pulls/${number}`, '--hostname', 'github.com']);
  if (result.status !== 'PASS') { const detail = (result.stderr || result.error || '').trim(); throw markTransient(blocked(`Pull request identity lookup failed: ${detail}`), detail); }
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
  if (result.status !== 'PASS') { const detail = (result.stderr || result.error || '').trim(); throw markTransient(blocked(`Canonical GitHub repository lookup failed: ${detail}`), detail); }
  let repository;
  try { repository = JSON.parse(result.stdout); } catch { throw blocked('Malformed canonical GitHub repository identity'); }
  if (!Number.isSafeInteger(repository?.id) || repository.id <= 0 || typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== requested.toLowerCase() || repository.html_url !== `https://github.com/${repository.full_name}`) throw blocked('Canonical GitHub repository differs from the reviewed destination');
  return { remote, url, repository: { host: 'github.com', id: repository.id, nameWithOwner: repository.full_name, url: repository.html_url } };
}
