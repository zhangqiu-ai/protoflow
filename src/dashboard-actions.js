import fs from 'node:fs/promises';
import path from 'node:path';
import { projectPath, runCommand, withLock, readJson, writeJson } from './util.js';
import { loadConfig } from './config.js';
import { retryRunner } from './runner.js';
import { createReview, decideReview } from './workflow.js';
import { deliveryStatus, ghJson } from './delivery.js';
import { deliveryStatePath, runnerStatePath } from './streams.js';
import { resolveDeliveryDestination, deliveryGit as git, deliveryGh as gh } from './delivery-scope.js';
import { openIssues, issuesStatus } from './issues.js';

/**
 * Proposal 0004 D3: what a person may do from the dashboard. Every action is an existing engine operation under its
 * existing binding (the reviewed delivery commit, the verification hash, the person's own GitHub identity), and each
 * attempt is appended to .protoflow/dashboard/actions.jsonl. The dashboard user is the local person; an AI never
 * approves as a person here.
 */
export const ACTIONS = ['merge', 'handback', 'approve', 'retry'];
const LOG = '.protoflow/dashboard/actions.jsonl';

async function audit(root, record) {
  const file = await projectPath(root, LOG);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`);
}

/** The person acting: their GitHub login for GitHub writes, their configured or Git name for local reviews. */
export async function githubLogin(root) {
  const result = await runCommand(root, { argv: ['gh', 'api', 'user', '--jq', '.login'], timeoutMs: 30000 });
  if (result.status !== 'PASS' || !result.stdout.trim()) throw new Error(`Cannot read your GitHub login: ${(result.stderr || result.error || '').trim().slice(0, 200)}`);
  return result.stdout.trim();
}
async function reviewerName(root, config) {
  if (config.dashboard?.reviewer?.trim()) return config.dashboard.reviewer.trim();
  const name = await git(root, ['config', 'user.name']).catch(() => '');
  if (!name) throw new Error('Set dashboard.reviewer in protoflow.config.json or git config user.name before approving from the dashboard');
  return name;
}

/** Merge a manual delivery PR exactly at the commit the independent review approved. */
async function mergeDelivery(root, config, { target = null, deliveryId }) {
  const options = config.runner?.delivery;
  if (!options) throw new Error('This project has no runner.delivery');
  const state = await deliveryStatus(root, config, target);
  const delivery = state.deliveries.find(item => item.id === deliveryId);
  if (!delivery || delivery.status !== 'PR_OPEN_MANUAL' || !delivery.pr?.number || !/^[a-f0-9]{40}$/.test(delivery.commit ?? '')) throw new Error(`Delivery ${deliveryId} is not a manual PR waiting to be merged`);
  if (delivery.manualMerge) return { status: 'PASS', already: true, pr: delivery.pr.url, mergeCommit: delivery.manualMerge.mergeCommit };
  const { repository } = await resolveDeliveryDestination(root, options.remote);
  const view = await ghJson(root, repository, ['pr', 'view', String(delivery.pr.number), '--json', 'state,headRefOid,baseRefName,mergeCommit']);
  if (view.headRefOid !== delivery.commit) throw new Error(`PR #${delivery.pr.number} head ${view.headRefOid?.slice(0, 7)} is not the reviewed delivery commit ${delivery.commit.slice(0, 7)}; review it again before merging`);
  if (view.baseRefName !== options.baseBranch) throw new Error(`PR #${delivery.pr.number} targets ${view.baseRefName}, not ${options.baseBranch}`);
  const mergedBy = await githubLogin(root);
  if (view.state === 'OPEN') {
    const merged = await gh(root, repository, ['pr', 'merge', String(delivery.pr.number), '--merge', '--match-head-commit', delivery.commit]);
    if (merged.status !== 'PASS') throw new Error(`gh pr merge failed: ${(merged.stderr || merged.error || '').trim().slice(0, 300)}`);
  } else if (view.state !== 'MERGED') throw new Error(`PR #${delivery.pr.number} is ${view.state}`);
  const after = await ghJson(root, repository, ['pr', 'view', String(delivery.pr.number), '--json', 'state,mergeCommit,headRefOid']);
  if (after.state !== 'MERGED' || after.headRefOid !== delivery.commit) throw new Error(`PR #${delivery.pr.number} is ${after.state}, not a merge of ${delivery.commit}`);
  delivery.manualMerge = { mergedBy: `human:${mergedBy}`, mergedAt: new Date().toISOString(), mergeCommit: after.mergeCommit?.oid ?? null, via: 'dashboard' };
  const file = await projectPath(root, deliveryStatePath(config, target));
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  Object.assign(saved.deliveries.find(item => item.id === deliveryId), { manualMerge: delivery.manualMerge });
  await fs.writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
  return { status: 'PASS', pr: delivery.pr.url, commit: delivery.commit, mergeCommit: delivery.manualMerge.mergeCommit, actor: delivery.manualMerge.mergedBy };
}

/** Hand an issue a person had to decide back to the AI: remove its status label as that person on GitHub. */
async function handBack(root, config, { number }) {
  // The local record decides first, so nothing reaches GitHub for an issue that is not waiting for a person.
  const local = (await issuesStatus(root)).issues?.[number];
  if (!local || !['needs-human', 'blocked', 'rejected'].includes(local.status)) throw new Error(`Issue #${number} is not waiting for a person (status ${local?.status ?? 'unknown'})`);
  if (!config.issues?.enabled) throw new Error('GitHub issues are not enabled for this project (issues.enabled)');
  const session = await openIssues(root, config);
  const entry = session.state.issues[number];
  if (!entry || entry.status !== local.status) throw new Error(`Issue #${number} changed while you were deciding; reload the dashboard`);
  const label = `${session.settings.label}:${entry.status}`;
  const actor = await githubLogin(root);
  try { await session.api(`${session.base}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' }); }
  catch (error) { if (!/HTTP 404|Label does not exist/.test(error.message)) throw error; }
  return { status: 'PASS', number, removedLabel: label, actor: `human:${actor}`, next: 'The runner triages the issue again on its next pass once it confirms your write access' };
}

/** A person approves a verified version (projects without policy.autoApprove), bound to the verification hash. */
async function approveVersion(root, config, { target = null, manifestId, verificationId }) {
  if (config.policy?.autoApprove) throw new Error('This project approves automatically (policy.autoApprove)');
  const reviewer = await reviewerName(root, config);
  // The verification ran in the target's runner worktree, so the review is created and decided there (its freshness
  // check compares that application) and copied to the project, exactly as the engine's own approvals are.
  const runner = await readJson(await projectPath(root, runnerStatePath(config, target)), null);
  const where = runner?.worktree ?? root;
  const review = await createReview(where, config, manifestId, verificationId);
  const decided = await decideReview(where, config, review.id, { status: 'approved', reviewer, reviewerKind: 'human', notes: 'Approved from the ProtoFlow dashboard after reviewing the bound verification.' });
  if (where !== root) await writeJson(await projectPath(root, `.protoflow/reviews/${decided.id}.json`), await readJson(path.join(where, `.protoflow/reviews/${decided.id}.json`)));
  return { status: 'PASS', reviewId: decided.id, reviewer: decided.reviewer, verificationId, verificationHash: decided.verificationHash ?? review.verificationHash };
}

async function retry(root, config, { target = null }) {
  return withLock(root, () => retryRunner(root, config, { target }));
}

/** Run one dashboard action and record it, success or not. */
export async function runAction(root, request, { now = () => new Date().toISOString() } = {}) {
  const config = await loadConfig(root);
  const { action, ...args } = request ?? {};
  if (!ACTIONS.includes(action)) throw Object.assign(new Error(`Unknown action ${action}`), { statusCode: 400 });
  const record = { at: now(), action, args, via: 'dashboard' };
  try {
    const result = action === 'merge' ? await mergeDelivery(root, config, args)
      : action === 'handback' ? await handBack(root, config, { number: Number(args.number) })
      : action === 'approve' ? await approveVersion(root, config, args)
      : await retry(root, config, args);
    await audit(root, { ...record, status: result.status ?? 'PASS', result });
    return result;
  } catch (error) {
    await audit(root, { ...record, status: 'FAIL', error: error.message.slice(0, 500) });
    throw error;
  }
}
