import { setTimeout as delay } from 'node:timers/promises';
import { projectPath, readJson, writeJson, hash, withLock } from './util.js';
import { createContext, executeContext, executorPlan, executorCommand, verify } from './workflow.js';
import { loadProgress, runnerStatePath } from './streams.js';
import { deliveryStatus, stageApplication, currentBase, ghJson, ghFailure, AUTOMATED_REVIEWER, withPullRequestTrailers, ensurePullRequestTrailers, trailerError } from './delivery.js';
import { requestIndependentReview, assertIndependentReview, recordedVerdict, isRejectingVerdict, issueBranch } from './delivery-review.js';
import { deliveryGit as git, deliveryGh as gh } from './delivery-scope.js';
import { alignDeliveredRunner } from './runner-alignment.js';
import { openIssues, issueSettings, defaultIssueTarget } from './issues.js';
import { exportEvidence, reapLeftovers, executionDiagnostic, EXECUTOR_QUOTA, TRANSIENT_PROVIDER } from './runner.js';

/**
 * Proposal 0003 §6.3: implement one planned GitHub issue for one target. The prototype stream has priority: an issue
 * runs only while the target's runner is idle with every accepted version delivered and merged, in the target's own
 * runner worktree fast-forwarded to the current base. The executor follows the planner's plan; the fix is verified by
 * re-checking the target's latest accepted prototype version (build, functional, tiers) with bounded repair; an
 * independent review checks the plan's criteria; then the fix is approved automatically, pushed to its own branch,
 * merged by PR and the runner is aligned to the merge. A blocked fix is rolled back so the prototype stream continues.
 */
// Test sources in the platforms ProtoFlow targets: test directories and *_test, *.test, *.spec, *Test(s) files.
export const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|androidTest|integration_test|test_driver|[A-Za-z0-9]*Tests)\/|(?:_test|\.test|\.spec|Tests?)\.[A-Za-z]+$/;
const MAX_REVIEW_ATTEMPTS = 3, MAX_RESTARTS = 3;

export async function runIssues(root, config, stream, { signal, onEvent = () => {}, verifyVersion = verify } = {}) {
  const settings = issueSettings(config);
  if (!settings) return { status: 'DISABLED' };
  const targetId = stream ?? defaultIssueTarget(config);
  if (!settings.targets.some(target => target.id === targetId)) return { status: 'IDLE' };
  if (!config.policy?.autoApprove || config.runner?.delivery?.merge !== 'auto') return { status: 'NOT_RUN', reason: 'Issue fixes need policy.autoApprove and runner.delivery.merge "auto"' };
  const invalidTrailers = trailerError(config.runner.delivery.prBodyTrailers);
  if (invalidTrailers) return { status: 'BLOCKED', reason: invalidTrailers };
  return withLock(root, () => withLock(root, () => runLocked(root, config, stream, targetId, { signal, onEvent, verifyVersion }), 'issues'));
}

/** Uncommitted tracked changes split into files whose bytes equal the current base's and all others. */
async function baseIdenticalChanges(worktree, options) {
  const files = (await git(worktree, ['diff', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean);
  if (!files.length) return { identical: [], other: [] };
  const { sha: baseSha, url } = await currentBase(worktree, options);
  try { await git(worktree, ['cat-file', '-e', `${baseSha}^{commit}`]); }
  catch { await git(worktree, ['fetch', '--no-tags', '--no-write-fetch-head', url, baseSha]); }
  const identical = [], other = [];
  for (const file of files) {
    let same = false;
    try { same = (await git(worktree, ['hash-object', '--', file])) === (await git(worktree, ['rev-parse', `${baseSha}:${file}`])); }
    catch { same = false; }
    (same ? identical : other).push(file);
  }
  return { identical, other };
}

/** Why the target cannot take an issue now, or null when its prototype stream is idle and fully delivered. */
async function busy(root, config, stream, runner) {
  if (!runner || runner.status !== 'IDLE' || runner.configHash !== hash(config)) return 'the runner is not idle';
  const progress = await loadProgress(root, config, stream);
  if (!progress.entries.length || progress.entries.some(entry => entry.status !== 'PASS' || !entry.deliveryId)) return 'the prototype stream has work';
  // A rejected delivery that was retired (REVOKED) is settled as well; anything else is still on its way.
  if ((await deliveryStatus(root, config, stream)).deliveries.some(delivery => !['MERGED', 'REVOKED'].includes(delivery.status))) return 'a prototype delivery is not merged';
  return null;
}

async function runLocked(root, config, stream, targetId, { signal, onEvent, verifyVersion }) {
  const runnerFile = await projectPath(root, runnerStatePath(config, stream));
  const runner = await readJson(runnerFile, null);
  const session = await openIssues(root, config);
  const { state, save, api, base, transition } = session;
  // An issue this target already started comes first; otherwise the oldest planned issue for this target.
  const planOf = async entry => readJson(await projectPath(root, `.protoflow/plans/${entry.planId}.json`), null);
  let entry = null, plan = null;
  for (const candidate of Object.values(state.issues).filter(item => ['planned', 'in-progress'].includes(item.status) && item.planId).sort((a, b) => (b.targets?.[targetId]?.status === 'RUNNING') - (a.targets?.[targetId]?.status === 'RUNNING') || a.number - b.number)) {
    const record = await planOf(candidate);
    if (!record?.plan.targets.includes(targetId) || ['MERGED', 'BLOCKED'].includes(candidate.targets?.[targetId]?.status)) continue;
    entry = candidate; plan = record; break;
  }
  if (!entry) return { status: 'IDLE' };
  const reason = await busy(root, config, stream, runner);
  if (reason) return { status: 'IDLE', reason: `Issue #${entry.number} waits: ${reason}` };
  const worktree = runner.worktree, options = config.runner.delivery, n = entry.number;
  entry.targets ??= {};
  let work = entry.targets[targetId];
  const events = event => onEvent({ ...event, number: n, target: targetId });

  if (!work) {
    const live = await api(`${base}/issues/${n}`);
    if (live.state !== 'open') { entry.status = 'closed'; entry.history.push({ status: 'closed', at: new Date().toISOString(), reason: 'Closed on GitHub before implementation' }); await save(); return { status: 'IDLE', reason: `Issue #${n} was closed` }; }
    const dirty = await baseIdenticalChanges(worktree, options);
    if (dirty.other.length) return { status: 'IDLE', reason: `Issue #${n} waits: the runner worktree has uncommitted changes (${dirty.other.slice(0, 5).join(', ')})` };
    // `runner configure` writes the new config into the worktree; the base already has those exact bytes, so the
    // change is restored to HEAD and comes back unchanged with the fast-forward to the base.
    if (dirty.identical.length) { await git(worktree, ['checkout', '-q', 'HEAD', '--', ...dirty.identical.map(file => `:(literal)${file}`)]); await events({ event: 'issue-settled-changes', files: dirty.identical }); }
    work = entry.targets[targetId] = { status: 'RUNNING', startedAt: new Date().toISOString(), attempts: [], reviews: [] };
    await save();
  }
  /** Drop the commit and its evidence and do the fix again from the current base on the next pass (bounded). */
  const restart = async reason => {
    if ((work.restarts ?? 0) >= MAX_RESTARTS) return blockWork(`The fix had to start over ${MAX_RESTARTS} times because ${reason}`);
    await git(worktree, ['reset', '-q', '--hard', work.baseSha]); await git(worktree, ['clean', '-fdq', '-e', '.protoflow', '-e', 'node_modules']);
    work.history = [...(work.history ?? []), { restartedAt: new Date().toISOString(), reason, commit: work.commit, reviewId: work.reviewId ?? null, pr: work.pr?.url ?? null }];
    work.restarts = (work.restarts ?? 0) + 1;
    for (const key of ['commit', 'manifestId', 'verificationId', 'executionIds', 'committedAt', 'reviewId', 'approval', 'pushedAt', 'pr', 'prBodyAt']) delete work[key];
    work.previousReviews = [...(work.previousReviews ?? []), ...work.reviews]; work.reviews = [];
    await save();
    await events({ event: 'issue-restart', reason });
    return { status: 'RETRY', number: n, target: targetId, reason: `Starting over: ${reason}` };
  };
  const blockWork = async (message, findings = []) => {
    work.status = 'BLOCKED'; work.error = message; work.completedAt = new Date().toISOString(); await save();
    // Give the worktree back to the prototype stream exactly at the base this fix started from.
    if (work.baseSha) { await git(worktree, ['reset', '-q', '--hard', work.baseSha]); await git(worktree, ['clean', '-fdq', '-e', '.protoflow', '-e', 'node_modules']); }
    await events({ event: 'issue-blocked', reason: message.slice(0, 300) });
    const lines = [`<!-- protoflow:issue-blocked ${n} ${targetId} ${work.startedAt} -->`, `**ProtoFlow issue fix (AI, automated)** · target \`${targetId}\` · status \`${session.settings.label}:blocked\``, '', message, ...findings.map(finding => `- ${finding.severity} ${finding.file}:${finding.line}: ${finding.description}`), '', `The prototype stream continues and nothing was merged for this target. A maintainer decides how to proceed; removing the \`${session.settings.label}:blocked\` label has ProtoFlow triage the issue again (targets that already merged are kept).`];
    await transition(entry, { status: 'blocked', reason: message.slice(0, 500), marker: lines[0], body: lines.join('\n').slice(0, 60000) });
    return { status: 'BLOCKED', number: n, target: targetId, reason: message };
  };

  try {
    if (!work.commit) {
      // Start from the current shared base; the target's merged history is already part of it.
      const { sha: baseSha, url } = await currentBase(worktree, options);
      try { await git(worktree, ['cat-file', '-e', `${baseSha}^{commit}`]); }
      catch { await git(worktree, ['fetch', '--no-tags', '--no-write-fetch-head', url, baseSha]); }
      // An interrupted attempt starts over: its partial changes are discarded, then the work moves to the current base,
      // which other targets' merges of this issue (or anything else) may have advanced meanwhile.
      if (work.baseSha) { await git(worktree, ['reset', '-q', '--hard', work.baseSha]); await git(worktree, ['clean', '-fdq', '-e', '.protoflow', '-e', 'node_modules']); }
      try { await git(worktree, ['merge-base', '--is-ancestor', 'HEAD', baseSha]); }
      catch { return blockWork(`The runner worktree of ${targetId} has history that is not on ${options.baseBranch}; deliver or inspect it first`); }
      if (work.baseSha !== baseSha) {
        await git(worktree, ['merge', '-q', '--ff-only', baseSha]);
        runner.base = baseSha; await writeJson(runnerFile, runner);
        if (work.baseSha) work.baseMoves = [...(work.baseMoves ?? []), { from: work.baseSha, to: baseSha, at: new Date().toISOString() }];
        work.baseSha = baseSha; await save();
      }
      if (entry.status !== 'in-progress') {
        const lines = [`<!-- protoflow:issue-started ${n} -->`, `**ProtoFlow issue fix (AI, automated)** · status \`${session.settings.label}:in-progress\``, '', `Implementing plan \`${plan.id}\` for ${plan.plan.targets.join(', ')}, starting with ${targetId}. Each target is verified against its latest accepted prototype version and independently reviewed before its PR is merged.`];
        await transition(entry, { status: 'in-progress', marker: lines[0], body: lines.join('\n') });
      }
      await events({ event: 'issue-started', baseSha: work.baseSha, planId: plan.id });
      const snapshot = await readJson(await projectPath(root, `.protoflow/issues/snapshots/${entry.snapshotId}.json`));
      // The reviewer reads the snapshot and plan in the checkout it reviews.
      await writeJson(await projectPath(worktree, `.protoflow/issues/snapshots/${snapshot.id}.json`), snapshot);
      await writeJson(await projectPath(worktree, `.protoflow/plans/${plan.id}.json`), plan);
      const progress = await loadProgress(root, config, stream);
      const manifestId = progress.entries.at(-1).manifestId;
      const result = await implement(root, config, stream, worktree, { snapshot, plan, manifestId, work, save, signal, onEvent: events, verifyVersion });
      // A stopped runner is not a verdict on the fix: the work stays RUNNING and starts over on the next pass.
      if (signal?.aborted) return { status: 'STOPPED', number: n, target: targetId };
      if (result.status !== 'PASS') return blockWork(result.reason);
      await exportEvidence(root, worktree, result.report);
      const staged = await stageApplication(worktree, config, stream);
      if (!staged.length) return blockWork('The executor changed no application file');
      await git(worktree, ['commit', '-q', '-m', `Fix #${n}: ${snapshot.title}`.slice(0, 100), '-m', [`Fixes #${n}`, `Issue-Snapshot: ${snapshot.id}`, `Plan: ${plan.id}`, `Manifest: ${manifestId}`, `Verification: ${result.report.id}`, `Verification-Hash: ${hash(result.report)}`, `Delivery-Base: ${work.baseSha}`, 'Approved-By: none (human review required)', 'Independent-Review: pending; reviewed commit evidence is recorded separately'].join('\n')]);
      Object.assign(work, { commit: await git(worktree, ['rev-parse', 'HEAD']), manifestId, verificationId: result.report.id, executionIds: result.executionIds, committedAt: new Date().toISOString() });
      await save();
    }
    if (await git(worktree, ['rev-parse', 'HEAD']) !== work.commit) return blockWork(`The runner worktree moved away from the issue commit ${work.commit}`);
    // The fix is reviewed and merged against the base it was verified on; a base that moved before publication
    // (another target merged this issue, or anything else) means doing the fix again on the new base.
    if (!work.pushedAt && (await currentBase(worktree, options)).sha !== work.baseSha) return restart('the base moved before review');
    const reference = { number: n, snapshotId: entry.snapshotId, planId: plan.id, manifestId: work.manifestId, verificationId: work.verificationId, executionIds: work.executionIds };
    const gate = { worktree, target: stream, commit: work.commit, issue: reference, expectedBaseSha: work.baseSha };
    let independent = null;
    // Only a recorded PASS is re-asserted; a blocked attempt is followed by a fresh review within the bound.
    if (work.reviewId && work.reviews.at(-1)?.status === 'PASS') {
      try { independent = await assertIndependentReview(root, config, work.reviewId, { ...gate, published: 'either' }); }
      catch (error) { if (error.reasonCode !== 'ENGINE_ATTESTATION_MISSING') throw error; }
    }
    if (!independent) {
      // A restart loses the in-process attestation; a fresh provider review replaces it. A verdict is never re-rolled.
      if (work.reviews.length >= MAX_REVIEW_ATTEMPTS) return blockWork(`Independent review attempts exhausted (${work.reviews.length})`);
      const record = await requestIndependentReview(root, config, { ...gate, signal });
      work.reviews.push({ id: record.id, status: record.status, at: new Date().toISOString() }); work.reviewId = record.id; await save();
      await events({ event: 'issue-reviewed', reviewId: record.id, status: record.status });
      if (record.status !== 'PASS') {
        const verdict = await recordedVerdict(root, record).catch(() => null);
        if (isRejectingVerdict(verdict)) return blockWork(`Independent review ${record.id} returned ${verdict.status}: ${verdict.summary}`, verdict.findings ?? []);
        if (record.retryable && work.reviews.length < MAX_REVIEW_ATTEMPTS) return { status: 'RETRY', number: n, target: targetId, reason: record.reason };
        return blockWork(`Independent review ${record.id} BLOCKED: ${record.reason}`);
      }
      independent = await assertIndependentReview(root, config, record.id, { ...gate, published: 'either' });
    }
    // Automated approval is recorded as AI evidence, never as a person (policy.autoApprove).
    if (work.approval?.independentReviewId !== independent.id) { work.approval = { reviewer: `${AUTOMATED_REVIEWER}:${independent.sessionId}`, independentReviewId: independent.id, approvedAt: new Date().toISOString(), kind: 'automated' }; await save(); }
    const branch = issueBranch(config, n, stream), repository = independent.binding.remote.repository;
    if (!work.pushedAt) {
      if (independent.observedRemoteHead !== work.commit) await git(worktree, ['push', '--no-follow-tags', '-q', `--force-with-lease=refs/heads/${branch}:${independent.binding.remote.headSha ?? ''}`, independent.binding.remote.url, `${work.commit}:refs/heads/${branch}`]);
      work.pushedAt = new Date().toISOString(); await save();
    }
    await assertIndependentReview(root, config, independent.id, { ...gate, published: true });
    if (!work.pr) {
      const find = async () => (await ghJson(worktree, repository, ['pr', 'list', '--head', branch, '--base', options.baseBranch, '--state', 'open', '--json', 'number,url']))?.[0] ?? null;
      work.pr = await find();
      if (!work.pr) {
        const remaining = plan.plan.targets.filter(target => target !== targetId && entry.targets[target]?.status !== 'MERGED');
        const created = await gh(worktree, repository, ['pr', 'create', '--base', options.baseBranch, '--head', branch, '--title', `Fix #${n}: ${(await readJson(await projectPath(root, `.protoflow/issues/snapshots/${entry.snapshotId}.json`))).title}`.slice(0, 250), '--body', withPullRequestTrailers(pullRequestBody(n, targetId, plan, independent, work, remaining), options.prBodyTrailers)]);
        if (created.status !== 'PASS') throw ghFailure('gh pr create', created);
        work.pr = await find();
        if (!work.pr) throw new Error(`gh pr create did not leave an open PR for ${branch}`);
      }
      await save();
    }
    if (options.prBodyTrailers && !work.prBodyAt) {
      await ensurePullRequestTrailers(worktree, repository, work.pr.number, options.prBodyTrailers);
      work.prBodyAt = new Date().toISOString(); await save();
    }
    if (!work.mergedAt) {
      await assertIndependentReview(root, config, independent.id, { ...gate, published: true });
      const view = await ghJson(worktree, repository, ['pr', 'view', String(work.pr.number), '--json', 'state,mergeCommit,headRefOid,baseRefOid,baseRefName,headRefName,isDraft']);
      if (view.state === 'OPEN') {
        if (view.headRefOid !== work.commit || view.baseRefName !== options.baseBranch || view.headRefName !== branch) throw new Error(`PR #${work.pr.number} head or base differs from the reviewed issue fix`);
        if (view.baseRefOid !== independent.binding.remote.baseSha) return restart(`${options.baseBranch} moved to ${view.baseRefOid} after the review of ${independent.binding.remote.baseSha}`);
        const merged = await gh(worktree, repository, ['pr', 'merge', String(work.pr.number), '--merge', '--match-head-commit', work.commit]);
        if (merged.status !== 'PASS') throw ghFailure('gh pr merge', merged);
      }
      const after = await ghJson(worktree, repository, ['pr', 'view', String(work.pr.number), '--json', 'state,mergeCommit,mergedAt,headRefOid']);
      if (after.state !== 'MERGED' || after.headRefOid !== work.commit) throw new Error(`PR #${work.pr.number} is ${after.state}, not a merge of ${work.commit}`);
      Object.assign(work, { mergeCommit: after.mergeCommit?.oid ?? null, mergedAt: after.mergedAt ?? new Date().toISOString() });
      await save();
    }
    work.alignment = await alignDeliveredRunner(root, config, worktree, { id: `ISSUE-${n}-${targetId}`, status: 'MERGED', commit: work.commit, mergeCommit: work.mergeCommit, baseSha: work.baseSha, independentReviewId: independent.id, independentSessionId: independent.sessionId, approval: work.approval }, stream)
      .catch(error => ({ status: 'BLOCKED', reason: error.message }));
    work.status = 'MERGED'; work.completedAt = new Date().toISOString(); delete work.error; await save();
    await events({ event: 'issue-merged', pr: work.pr.url, mergeCommit: work.mergeCommit });
    if (plan.plan.targets.every(target => entry.targets[target]?.status === 'MERGED')) {
      const lines = [`<!-- protoflow:issue-done ${n} -->`, `**ProtoFlow issue fix (AI, automated)** · status \`${session.settings.label}:done\``, '', ...plan.plan.targets.map(target => `- ${target}: ${entry.targets[target].pr.url} merged as ${entry.targets[target].mergeCommit?.slice(0, 7) ?? 'unknown'}`), '', 'Closed automatically after every planned target merged. The changes were written, reviewed and approved by AI agents under policy.autoApprove; this is not a human approval.'];
      await transition(entry, { status: 'done', close: true, marker: lines[0], body: lines.join('\n') });
      await events({ event: 'issue-done' });
    }
    return { status: 'PASS', number: n, target: targetId, pr: work.pr.url, mergeCommit: work.mergeCommit };
  } catch (error) {
    if (signal?.aborted) return { status: 'STOPPED', number: n, target: targetId };
    // Network failures keep the work for the next pass; everything else is a block a person resolves.
    work.error = error.message.slice(0, 500); await save();
    if (error.transient) return { status: 'RETRY', number: n, target: targetId, reason: error.message };
    return blockWork(error.message);
  }
}

/** Execute the plan and verify the target's latest accepted version on the result, with bounded repair. */
async function implement(root, config, stream, worktree, { snapshot, plan, manifestId, work, save, signal, onEvent, verifyVersion }) {
  // Backend-only issues go to the backend executor (policy.executor.routes); frontend and mixed work to the frontend one.
  const maximum = config.policy?.maxRepairAttempts ?? 3, executors = executorPlan(config, plan.plan.area === 'backend' ? 'backend' : 'frontend');
  work.executorRoute = { area: executors.area, primary: executors.primary, fallback: executors.fallback };
  const executionIds = [];
  let report = null, failure = null;
  for (let attempt = 0; attempt <= maximum; attempt++) {
    if (signal?.aborted) return { status: 'STOPPED', reason: 'Stopped' };
    const context = await createContext(worktree, config, manifestId, { spec: config.runner?.spec, adr: config.runner?.adr, target: stream ?? undefined, plan, issue: snapshot });
    const record = { attempt, contextId: context.id, startedAt: new Date().toISOString() };
    work.attempts.push(record); await save();
    await onEvent({ event: attempt ? 'issue-repair' : 'issue-execute', attempt, area: executors.area, executor: executors.primary });
    let provider = executors.primary, execution;
    for (let retry = 0; ; retry++) {
      execution = await executeContext(worktree, config, context.id, { provider, execute: true, repair: attempt ? { attempt, verification: report, ...(failure && { execution: failure }) } : null, signal });
      await reapLeftovers(root, worktree, record, 'execute', onEvent);
      if (execution.status === 'PASS') break;
      const diagnostic = executionDiagnostic(execution);
      if (provider === executors.primary && executors.fallback && executorCommand(config, executors.fallback) && EXECUTOR_QUOTA.test(diagnostic)) { record.executorFallback = { from: provider, to: executors.fallback }; provider = executors.fallback; continue; }
      if (TRANSIENT_PROVIDER.test(diagnostic) && retry < (config.policy?.transientRetries ?? 3)) { await delay((config.policy?.transientRetryDelayMs ?? 60000) * 2 ** retry, undefined, { signal }).catch(() => {}); continue; }
      break;
    }
    Object.assign(record, { executionId: execution.id, executionStatus: execution.status, executor: provider });
    if (execution.status !== 'PASS') { failure = { executionId: execution.id, exitCode: execution.result.exitCode, reason: executionDiagnostic(execution).slice(-1000) }; record.status = 'FAIL'; await save(); continue; }
    executionIds.push(execution.id); failure = null;
    report = await verifyVersion(worktree, config, manifestId, { target: stream ?? undefined, reverify: true, signal, onDeviceWait: wait => onEvent(wait.acquired ? { event: 'issue-device-acquired', attempt, devices: wait.devices, waitedMs: wait.waitedMs } : { event: 'issue-device-wait', attempt, device: wait.device, holder: wait.holder }) });
    await reapLeftovers(root, worktree, record, 'verify', onEvent);
    Object.assign(record, { verificationId: report.id, verificationStatus: report.status });
    await onEvent({ event: 'issue-verified', attempt, verificationId: report.id, status: report.status });
    // The machine, not the fix: another attempt cannot help (src/environment.js).
    if (report.status === 'NOT_RUN' && report.reasonCode === 'environment') { record.status = 'NOT_RUN'; await save(); return { status: 'BLOCKED', reason: `Verification ${report.id} cannot run in this environment (${report.environment.phase}): ${report.environment.line}; fix the machine, then hand the issue back` }; }
    if (report.status !== 'PASS') { record.status = 'FAIL'; await save(); continue; }
    // The plan's tests are part of the fix: a change that adds or edits no test file is repaired, not delivered.
    const changed = [...(await git(worktree, ['diff', '--name-only', 'HEAD'])).split('\n'), ...(await git(worktree, ['ls-files', '--others', '--exclude-standard'])).split('\n')].filter(Boolean);
    if (plan.plan.tests.length && !changed.some(file => TEST_FILE.test(file))) {
      failure = { reason: `The plan lists tests to add (${plan.plan.tests.join('; ').slice(0, 500)}), but the change adds or edits no test file` };
      record.status = 'FAIL'; record.error = failure.reason; await save(); continue;
    }
    record.status = 'PASS'; record.completedAt = new Date().toISOString(); await save();
    return { status: 'PASS', report, executionIds };
  }
  return { status: 'BLOCKED', reason: `Repair attempts exhausted (${maximum + 1}): ${failure?.reason ?? `verification ${report?.id ?? 'not run'} is ${report?.status ?? 'NOT_RUN'}`}` };
}

function pullRequestBody(n, targetId, plan, independent, work, remaining) {
  const p = plan.plan;
  return [
    remaining.length ? `Part of #${n} (still to merge: ${remaining.join(', ')})` : `Fixes #${n}`, '',
    `**ProtoFlow issue fix (AI, automated)** · target \`${targetId}\``, '',
    p.summary, '',
    '**Acceptance criteria**', ...p.acceptanceCriteria.map(item => `- ${item.id} (${item.evidence}): ${item.text}`), '',
    `- Plan \`${plan.id}\` by Claude \`${plan.model ?? 'planner'}\` (session \`${plan.sessionId}\`)`,
    `- Executions: ${work.executionIds.map(value => `\`${value}\``).join(', ')}`,
    `- Verification \`${work.verificationId}\`: build, functional and prototype tiers PASS against version \`${work.manifestId}\``,
    `- Independent review \`${independent.id}\` (session \`${independent.sessionId}\`): PASS`, '',
    'Written, reviewed, approved and merged by AI agents under policy.autoApprove; this is not a human approval.'
  ].join('\n').slice(0, 60000);
}
