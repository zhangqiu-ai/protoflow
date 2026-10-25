import fs from 'node:fs/promises';
import path from 'node:path';
import { projectPath, runCommand, withLock, readJson, writeJson } from './util.js';
import { loadConfig } from './config.js';
import { retryRunner } from './runner.js';
import { createReview, decideReview } from './workflow.js';
import { deliveryStatus, ghJson } from './delivery.js';
import { recordedVerdict } from './delivery-review.js';
import { deliveryStatePath, runnerStatePath, loadProgress } from './streams.js';
import { resolveDeliveryDestination, deliveryGit as git, deliveryGh as gh } from './delivery-scope.js';
import { openIssues, issuesStatus } from './issues.js';
import { decideWaiver, findVerification } from './waivers.js';
import { runnerHealth, runnerAlive } from './dashboard-data.js';
import { runnerStopped } from './dashboard-diagnosis.js';

/**
 * Proposal 0004 D3: what a person may do from the dashboard. Every action is an existing engine operation under its
 * existing binding (the reviewed delivery commit, the verification hash, the person's own GitHub identity), and each
 * attempt is appended to .protoflow/dashboard/actions.jsonl. The dashboard user is the local person; an AI never
 * approves as a person here.
 */
export const ACTIONS = ['merge', 'handback', 'answer-issue', 'close-issue', 'approve', 'request-changes', 'retry', 'approve-waiver', 'reject-waiver', 'revoke-waiver'];
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

/** An issue waiting for a person, read locally first so nothing reaches GitHub for an issue that is not waiting. */
async function waitingIssue(root, config, number) {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('An issue number is required');
  const local = (await issuesStatus(root)).issues?.[number];
  if (!local || !['needs-human', 'blocked', 'rejected'].includes(local.status)) throw new Error(`Issue #${number} is not waiting for a person (status ${local?.status ?? 'unknown'})`);
  if (!config.issues?.enabled) throw new Error('GitHub issues are not enabled for this project (issues.enabled)');
  const session = await openIssues(root, config);
  const entry = session.state.issues[number];
  if (!entry || entry.status !== local.status) throw new Error(`Issue #${number} changed while you were deciding; reload the dashboard`);
  return { session, entry };
}
async function removeStatusLabel(session, entry, number) {
  const label = `${session.settings.label}:${entry.status}`;
  try { await session.api(`${session.base}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' }); }
  catch (error) { if (!/HTTP 404|Label does not exist/.test(error.message)) throw error; }
  return label;
}

/** Hand an issue a person had to decide back to the AI: remove its status label as that person on GitHub. */
async function handBack(root, config, { number }) {
  const { session, entry } = await waitingIssue(root, config, number);
  const actor = await githubLogin(root);
  const label = await removeStatusLabel(session, entry, number);
  return { status: 'PASS', number, removedLabel: label, actor: `human:${actor}`, next: 'The runner triages the issue again on its next pass once it confirms your write access' };
}

/** A person answers the issue's questions as themself: their GitHub comment, then the issue goes back to triage with it. */
async function answerIssue(root, config, { number, text }) {
  const answer = typeof text === 'string' ? text.trim() : '';
  if (!answer) throw new Error('Write your answer first');
  if (answer.length > 20000) throw new Error('The answer is longer than 20000 characters');
  // ProtoFlow ignores its own comments (they start with its marker); a person's answer must never look like one.
  if (answer.startsWith('<!-- protoflow:')) throw new Error('The answer cannot start with a ProtoFlow marker');
  const { session, entry } = await waitingIssue(root, config, number);
  const actor = await githubLogin(root);
  const comment = await session.api(`${session.base}/issues/${number}/comments`, { method: 'POST', body: { body: `${answer}\n\n<sub>Answered from the ProtoFlow dashboard.</sub>` } });
  const label = await removeStatusLabel(session, entry, number);
  return { status: 'PASS', number, commentId: comment.id ?? null, comment: comment.html_url ?? null, removedLabel: label, actor: `human:${actor}`, next: 'The runner triages the issue again with your answer on its next pass' };
}

/** A person decides not to do an issue: close it on GitHub as not planned, with a note saying who decided. */
async function closeIssue(root, config, { number, note = '' }) {
  const { session } = await waitingIssue(root, config, number);
  const actor = await githubLogin(root);
  const extra = typeof note === 'string' && note.trim() ? `\n\n${note.trim().slice(0, 5000)}` : '';
  await session.api(`${session.base}/issues/${number}/comments`, { method: 'POST', body: { body: `Closed from the ProtoFlow dashboard by @${actor}: not planned.${extra}` } });
  await session.api(`${session.base}/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
  return { status: 'PASS', number, closed: true, actor: `human:${actor}`, next: 'The runner records the issue as closed on its next sync' };
}

/**
 * A person approves a verified version, bound to the verification hash: in projects without policy.autoApprove, and
 * under autoApprove for a version that passed with maintainer waivers (proposal 0005 D).
 */
async function approveVersion(root, config, { target = null, manifestId, verificationId }) {
  if (config.policy?.autoApprove && !await findVerification(root, config, verificationId).then(found => found.report.waivers?.length > 0, () => false)) throw new Error('This project approves automatically (policy.autoApprove); only a version that passed with maintainer waivers is approved here');
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

/**
 * A person agrees with the independent review that rejected a delivery and sends the version back for repair: a human
 * changes_requested review bound to the version's verification, carrying the reviewer's findings. The runner reopens
 * the version on its next pass and the executor repairs it with those findings (under policy.autoApprove the runner
 * records this on its own as a model rejection).
 */
async function requestChanges(root, config, { target = null, deliveryId }) {
  const reviewer = await reviewerName(root, config);
  const delivery = (await deliveryStatus(root, config, target)).deliveries.find(item => item.id === deliveryId);
  if (!delivery || !['BLOCKED', 'FAIL'].includes(delivery.status) || !/^AIR-[A-Za-z0-9-]+$/.test(delivery.independentReviewId ?? '')) throw new Error(`Delivery ${deliveryId} is not blocked by an independent review`);
  const record = await readJson(await projectPath(root, `.protoflow/delivery/independent-reviews/${delivery.independentReviewId}.json`), null);
  const verdict = record ? await recordedVerdict(root, record).catch(() => null) : null;
  if (verdict?.status !== 'FAIL' || !verdict.findings?.length) throw new Error(`Independent review ${delivery.independentReviewId} did not reject the delivery with findings`);
  const entry = (await loadProgress(root, config, target)).entries.find(item => item.manifestId === delivery.versions?.at(-1));
  if (!entry?.verificationId) throw new Error(`Version ${delivery.versions?.at(-1)} has no verification to send back; it may already be reopened`);
  const findings = verdict.findings.map(item => ({ severity: ['critical', 'high', 'normal', 'low'].includes(item.severity) ? item.severity : 'normal', description: [item.file && (item.line ? `${item.file}:${item.line}` : item.file), item.description ?? item.reason].filter(Boolean).join(': ') }));
  const runner = await readJson(await projectPath(root, runnerStatePath(config, target)), null);
  const where = runner?.worktree ?? root;
  const review = await createReview(where, config, entry.manifestId, entry.verificationId);
  const decided = await decideReview(where, config, review.id, { status: 'changes_requested', reviewer, reviewerKind: 'human', findings, notes: `Sent back for repair from the ProtoFlow dashboard, agreeing with independent review ${delivery.independentReviewId}.` });
  if (where !== root) await writeJson(await projectPath(root, `.protoflow/reviews/${decided.id}.json`), await readJson(path.join(where, `.protoflow/reviews/${decided.id}.json`)));
  return { status: 'PASS', reviewId: decided.id, reviewer: decided.reviewer, manifestId: entry.manifestId, findings: findings.length, next: 'The runner reopens the version and repairs it on its next pass' };
}

/** Proposal 0005: a maintainer listed in policy.waivers.reviewers approves, rejects or revokes a waiver as themself. */
async function waiverDecision(root, config, status, { waiverId, notes = '' }) {
  const reviewer = await reviewerName(root, config);
  const decided = await decideWaiver(root, config, waiverId, { status, reviewer, notes: notes || { approved: 'Approved from the ProtoFlow dashboard after reviewing the findings and screenshots.', rejected: 'Rejected from the ProtoFlow dashboard.', revoked: 'Revoked from the ProtoFlow dashboard.' }[status] });
  return { status: 'PASS', waiverId: decided.id, waiver: decided.status, reviewer, ...(decided.decision?.waiverHash && status === 'approved' && { waiverHash: decided.decision.waiverHash }), next: status === 'approved' ? 'The next verification of this version applies the waiver while its findings stay the same' : status === 'revoked' ? 'The next verification no longer applies the waiver; verifications that already used it keep their record' : 'The version keeps failing on these findings' };
}

async function retry(root, config, { target = null, answer = null }) {
  // An answer to the planner's questions is recorded as the dashboard reviewer's; a plain retry needs no name.
  const by = typeof answer === 'string' && answer.trim() ? await reviewerName(root, config) : null;
  return withLock(root, () => retryRunner(root, config, { target, answer, via: 'dashboard', by }));
}

/** Run one dashboard action and record it, success or not. */
// Actions whose effect the runner carries out on its next pass or sync.
const RUNNER_ACTIONS = { retry: 'version', 'request-changes': 'version', handback: 'issue', 'answer-issue': 'issue', 'close-issue': 'issue' };
export async function runAction(root, request, { now = () => new Date().toISOString(), service = process.platform === 'darwin' } = {}) {
  const config = await loadConfig(root);
  const { action, ...args } = request ?? {};
  if (!ACTIONS.includes(action)) throw Object.assign(new Error(`Unknown action ${action}`), { statusCode: 400 });
  const record = { at: now(), action, args, via: 'dashboard' };
  try {
    const result = action === 'merge' ? await mergeDelivery(root, config, args)
      : action === 'handback' ? await handBack(root, config, { number: Number(args.number) })
      : action === 'answer-issue' ? await answerIssue(root, config, { number: Number(args.number), text: args.text })
      : action === 'close-issue' ? await closeIssue(root, config, { number: Number(args.number), note: args.note })
      : action === 'approve' ? await approveVersion(root, config, args)
      : action === 'request-changes' ? await requestChanges(root, config, args)
      : action === 'approve-waiver' ? await waiverDecision(root, config, 'approved', args)
      : action === 'reject-waiver' ? await waiverDecision(root, config, 'rejected', args)
      : action === 'revoke-waiver' ? await waiverDecision(root, config, 'revoked', args)
      : await retry(root, config, args);
    // Done, but nothing runs it while no runner is running: say so, and how to start one, instead of a next step that never comes.
    if (RUNNER_ACTIONS[action]) {
      const { heartbeat, summary } = await runnerHealth(root, { service });
      if (!runnerAlive({ heartbeat, ...summary })) { const stopped = runnerStopped(summary.status, RUNNER_ACTIONS[action]); Object.assign(result, { runner: 'stopped', next: `Runner 沒在跑，要等它啟動才會處理：執行 ${stopped.command}` }); }
    }
    await audit(root, { ...record, status: result.status ?? 'PASS', result });
    return result;
  } catch (error) {
    await audit(root, { ...record, status: 'FAIL', error: error.message.slice(0, 500) });
    throw error;
  }
}
