import { createReview, decideReview, createBaseline, loadArtifact, applicationFingerprint } from './workflow.js';
import { loadProgress, saveProgress, deliveryStatePath, deliveryBranch, runnerStatePath, isMultiTarget } from './streams.js';
import { projectPath, readJson, writeJson, id, hash } from './util.js';
import { requestIndependentReview, assertIndependentReview } from './delivery-review.js';
import { alignDeliveredRunner } from './runner-alignment.js';
import { deliveryGit as git, deliveryGh as gh, deliveryPullRequest, resolveDeliveryDestination } from './delivery-scope.js';

// The automated approver is recorded as such; it never stands in for a named human.
export const AUTOMATED_REVIEWER = 'ai:codex-independent-review';
// Runner state, dependencies and test output never belong in an application commit; node_modules may be a symlink.
const EXCLUDED = ['.protoflow', 'node_modules', 'test-results', 'playwright-report'];
const protectedPath = /(?:^|\/)(?:\.git|\.protoflow|\.agents|\.codex|\.aws|\.ssh|node_modules|test-results|playwright-report|secrets?|credentials|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))(?:\/|$)/i;
function allowPath(value, config) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /[\s\\\0:*?\[\]]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') || protectedPath.test(value) || value === config.prototypeDir || value.startsWith(`${config.prototypeDir}/`) || config.prototypeDir.startsWith(`${value}/`)) throw new Error(`Unsafe delivery allowlist path: ${value}`);
}
const inScope = (file, paths) => !paths || paths.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
const under = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
// With several targets, each target delivers only its own root and shared top-level files, never a sibling's root.
const siblingRoots = (config, target) => isMultiTarget(config) ? config.targets.filter(item => item.id !== target).map(item => item.root.replace(/\/+$/, '')) : [];
async function currentBase(worktree, options) {
  const destination = await resolveDeliveryDestination(worktree, options.remote);
  const output = await git(worktree, ['ls-remote', destination.url, `refs/heads/${options.baseBranch}`]);
  const match = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/.exec(output);
  if (!match || match[2] !== options.baseBranch) throw new Error('Current delivery base SHA is unavailable');
  return { sha: match[1], url: destination.url };
}

/**
 * Sibling targets merge their own deliveries into the shared base, so a target's HEAD falls behind it. Merge the
 * current base into this target's history only when the base changed nothing this target verified: files outside
 * its application (sibling roots, prototype, runtime output). The reviewed HEAD then contains the base it is
 * reviewed against. Single-target streams keep blocking on a moved base.
 */
async function integrateBase(config, worktree, target, options, base) {
  try { await git(worktree, ['cat-file', '-e', `${base.sha}^{commit}`]); }
  catch { await git(worktree, ['fetch', '--no-tags', '--no-write-fetch-head', base.url, base.sha]); }
  try { await git(worktree, ['merge-base', '--is-ancestor', base.sha, 'HEAD']); return null; }
  catch (error) { if (error.code !== 1) throw error; }
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  const fork = await git(worktree, ['merge-base', head, base.sha]);
  const outside = [config.prototypeDir, ...siblingRoots(config, target)];
  const touched = (await git(worktree, ['diff', '--name-only', '-z', fork, base.sha])).split('\0').filter(Boolean)
    .filter(file => !outside.some(prefix => under(file, prefix)) && !file.split('/').some(part => EXCLUDED.includes(part)));
  if (touched.length) throw new Error(`Base ${options.baseBranch} changed files of target ${target} since its worktree forked (${touched.slice(0, 5).join(', ')}); reverify on the current base`);
  const before = await applicationFingerprint(worktree, config, target);
  try { await git(worktree, ['merge', '--no-ff', '--no-edit', '-m', `ProtoFlow: integrate ${options.baseBranch} ${base.sha.slice(0, 7)} into target ${target}`, base.sha]); }
  catch (error) {
    try { await git(worktree, ['merge', '--abort']); } catch { /* nothing to abort */ }
    throw new Error(`Base ${base.sha} does not merge cleanly into target ${target}: ${(error.stderr || error.message).trim()}`);
  }
  if ((await applicationFingerprint(worktree, config, target)).hash !== before.hash) {
    // --keep never discards local changes; it only undoes the merge commit.
    await git(worktree, ['reset', '-q', '--keep', head]);
    throw new Error(`Integrating base ${base.sha} changed target ${target} application content; reverify on the current base`);
  }
  return { baseSha: base.sha, previousHead: head, commit: await git(worktree, ['rev-parse', 'HEAD']) };
}

/** Delivery records; with several targets pass a target, or omit it to get every target's records. */
export async function deliveryStatus(root, config = {}, target = null) {
  if (isMultiTarget(config) && !target) {
    const targets = {};
    for (const item of config.targets) targets[item.id] = await deliveryStatus(root, config, item.id);
    return { schemaVersion: 1, targets };
  }
  return readJson(await projectPath(root, deliveryStatePath(config, target)), { schemaVersion: 1, deliveries: [] });
}
async function saveDelivery(root, config, target, state) { await writeJson(await projectPath(root, deliveryStatePath(config, target)), state); }

async function copyRecord(worktree, root, kind, recordId) {
  const record = await loadArtifact(worktree, kind, recordId);
  await writeJson(await projectPath(root, `.protoflow/${kind}/${recordId}.json`), record);
}

/** Automated approval of the newest accepted version, bound to its verification exactly like a human review. */
async function approve(root, config, worktree, entry, independent) {
  // The verification carries its target, so the review checks that target's application hash.
  const review = await createReview(worktree, config, entry.manifestId, entry.verificationId);
  const decided = await decideReview(worktree, config, review.id, {
    status: 'approved', reviewer: `${AUTOMATED_REVIEWER}:${independent.sessionId}`, reviewerKind: 'automated',
    independentReview: { root, id: independent.id },
    notes: `Independent AI review ${independent.id}, session ${independent.sessionId}, trace SHA256 ${independent.traceHash}; this is not human or GitHub approval.`,
  });
  const baseline = await createBaseline(worktree, config, decided.id);
  await copyRecord(worktree, root, 'reviews', decided.id);
  await copyRecord(worktree, root, 'baselines', baseline.id);
  await writeJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: baseline.id });
  return { reviewId: decided.id, baselineId: baseline.id, independentReviewId: independent.id, reviewer: decided.reviewer };
}

async function ghJson(worktree, repository, args) {
  const result = await gh(worktree, repository, args);
  if (result.status !== 'PASS') throw new Error(`gh ${args[0]} ${args[1]} failed: ${(result.stderr || result.error || '').trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

async function assertPullRequestScope(worktree, independent, delivery) {
  const reviewed = independent.binding.remote, repository = reviewed.repository;
  const pr = await deliveryPullRequest(worktree, repository, delivery.pr?.number);
  const sameRepository = repo => repo?.id === repository.id && repo.full_name?.toLowerCase() === repository.nameWithOwner.toLowerCase() && repo.html_url === repository.url;
  if (pr.number !== delivery.pr.number || pr.html_url !== `${repository.url}/pull/${pr.number}` || delivery.pr.url !== pr.html_url || !sameRepository(pr.base?.repo) || !sameRepository(pr.head?.repo) || pr.head.sha !== delivery.commit || pr.base.sha !== reviewed.baseSha || pr.head.ref !== reviewed.branch || pr.base.ref !== reviewed.baseBranch) {
    const error = new Error('PR repository/base/head identity differs from the independently reviewed repository and refs'); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; throw error;
  }
  return pr;
}

function summary(delivery, entries, config, target) {
  const lines = entries.map(entry => `| \`${entry.sha.slice(0, 7)}\` | ${entry.manifestId} | ${entry.verificationId} | PASS |`);
  return [
    `### ProtoFlow delivery ${delivery.id}${target ? ` — target ${target}` : ''}`,
    '',
    '| Prototype commit | Manifest | Verification | Build / functional / visual |',
    '|---|---|---|---|',
    ...lines,
    '',
    delivery.approval?.reviewId
      ? `Approval: **automated** by \`${AUTOMATED_REVIEWER}\` (review ${delivery.approval.reviewId}, baseline ${delivery.approval.baselineId}). No human reviewed this change.`
      : 'Approval: none recorded (policy.autoApprove is off); a human must review before merging.',
    `Application commit: ${delivery.commit}`,
    ...(delivery.integration ? [`Integrated base: ${delivery.integration.baseSha} (merge of sibling target deliveries; application content of this target unchanged)`] : []),
    `Independent AI review: ${delivery.independentReviewId}; session: ${delivery.independentSessionId}. This is evidence, not GitHub or human approval.`,
    `Source: ${config.source.repository}#${config.source.branch}:${config.source.path}`,
  ].join('\n');
}

/**
 * Deliver accepted versions from the isolated worktree: optional automated approval, one commit,
 * push to the delivery branch, a pull request with the evidence, and merge when configured.
 * Versions accepted since the last commit share it; in steady state that is exactly one version.
 */
export async function syncDeliveries(root, config, { worktree, retryIndependentReview, target = null } = {}) {
  const options = config.runner?.delivery;
  if (!options) return { status: 'NOT_RUN', reason: 'runner.delivery is not configured' };
  if (isMultiTarget(config) && !target) {
    // Every target delivers independently on its own branch, each behind its own independent review.
    if (retryIndependentReview) return { status: 'BLOCKED', reason: 'Review retry must select its target' };
    const results = {};
    for (const item of config.targets) results[item.id] = await syncDeliveries(root, config, { target: item.id });
    const statuses = Object.values(results).map(result => result.status);
    return { status: ['BLOCKED', 'FAIL', 'PASS'].find(item => statuses.includes(item)) ?? (statuses.every(item => item === 'NOT_RUN') ? 'NOT_RUN' : 'IDLE'), targets: results };
  }
  const branch = deliveryBranch(config, target);
  if (branch === options.baseBranch || ['main', 'master'].includes(branch)) return { status: 'BLOCKED', reason: 'Delivery requires a dedicated branch; never push the base/main branch' };
  try { for (const name of [branch, options.baseBranch]) await git(root, ['check-ref-format', '--branch', name]); }
  catch { return { status: 'BLOCKED', reason: 'Invalid delivery branch/base' }; }
  try { if (options.paths) { if (!Array.isArray(options.paths) || !options.paths.length || new Set(options.paths).size !== options.paths.length) throw new Error('Delivery allowlist must contain unique prefixes'); for (const prefix of options.paths) allowPath(prefix, config); } }
  catch (error) { return { status: 'BLOCKED', reason: error.message }; }
  worktree ??= (await readJson(await projectPath(root, runnerStatePath(config, target)), null))?.worktree;
  if (!worktree) return { status: 'NOT_RUN', reason: 'Runner worktree does not exist yet' };
  const source = await loadProgress(root, config, target);
  const state = await deliveryStatus(root, config, target);
  let revalidation = false;
  if (retryIndependentReview) {
    const { deliveryId, reviewId } = retryIndependentReview;
    const previous = state.deliveries.find(item => item.id === deliveryId);
    if (Object.keys(retryIndependentReview).sort().join(',') !== 'deliveryId,reviewId' || !previous || ['MERGED', 'PR_OPEN_MANUAL'].includes(previous.status) || previous.independentReviewId !== reviewId) return { status: 'BLOCKED', reason: 'Review retry must explicitly select the current unfinished delivery and review attempt' };
    const record = await readJson(await projectPath(root, `.protoflow/delivery/independent-reviews/${reviewId}.json`), null);
    if (record?.status === 'PASS') {
      try { await assertIndependentReview(root, config, reviewId); }
      catch (error) { revalidation = error.code === 'INDEPENDENT_REVIEW_BLOCKED' && error.reasonCode === 'ENGINE_ATTESTATION_MISSING'; }
      if (!revalidation) return { status: 'BLOCKED', reason: 'Only an unattested persisted PASS can be explicitly revalidated; live or changed evidence cannot be retried' };
      if (previous.approval && !config.policy?.autoApprove) return { status: 'BLOCKED', reason: 'Revalidating an automated approval requires the current autoApprove policy' };
    } else if (record?.status !== 'BLOCKED' || previous.status !== 'BLOCKED' || previous.approval || previous.steps?.pushedAt || previous.pr) return { status: 'BLOCKED', reason: 'Failed review retry requires the current blocked attempt before approval or publication' };
  }
  const pending = source.entries.filter(entry => entry.status === 'PASS' && !entry.deliveryId);

  if (pending.length) {
    const last = pending.at(-1);
    const delivery = { id: id('DLV'), createdAt: new Date().toISOString(), versions: pending.map(entry => entry.manifestId), shas: pending.map(entry => entry.sha), status: 'PENDING', steps: {} };
    try {
      const base = await currentBase(worktree, options);
      delivery.baseSha = base.sha;
      const accepted = await loadArtifact(root, 'verifications', last.verificationId), manifest = await loadArtifact(root, 'manifests', last.manifestId);
      if (accepted.status !== 'PASS' || accepted.build?.status !== 'PASS' || accepted.functional?.status !== 'PASS' || accepted.visual?.status !== 'PASS' || accepted.changedDuringVerification || accepted.manifestHash !== hash(manifest)) throw new Error('Commit requires bound complete PASS verification');
      if (options.paths) {
        for (const prefix of options.paths) await projectPath(worktree, prefix);
        const previous = (await git(worktree, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
        if (previous.some(file => !inScope(file, options.paths))) throw new Error('Existing Git index contains changes outside the delivery allowlist; preserve it for inspection');
      }
      // Stage, then unstage exclusions: naming a gitignored path in an add pathspec makes git exit non-zero.
      await git(worktree, ['add', '-A', '--', ...(options.paths ?? ['.'])]);
      await git(worktree, ['reset', '-q', '--', ...EXCLUDED]);
      const included = (await git(worktree, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
      const runtime = included.filter(file => file.split('/').some(part => EXCLUDED.includes(part)));
      if (runtime.length) await git(worktree, ['reset', '-q', '--', ...runtime]);
      const siblings = siblingRoots(config, target);
      for (const file of included.filter(file => !runtime.includes(file))) if (!inScope(file, options.paths) || (options.paths && protectedPath.test(file)) || siblings.some(prefix => under(file, prefix))) throw new Error(`Staged delivery file is outside safe scope: ${file}`);
      let changed = false;
      try { await git(worktree, ['diff', '--cached', '--quiet']); }
      catch (error) { if (error.code !== 1) throw error; changed = true; }
      if (changed) {
        const subject = pending.length === 1 ? `ProtoFlow: implement prototype ${last.sha.slice(0, 7)}` : `ProtoFlow: implement prototypes ${pending[0].sha.slice(0, 7)}..${last.sha.slice(0, 7)}`;
        const trailers = [
          ...pending.map(entry => `Prototype-Commit: ${entry.sha}`),
          `Manifest: ${last.manifestId}`,
          `Verification: ${last.verificationId}`,
          `Delivery-Base: ${delivery.baseSha}`,
          `Manifest-Hash: ${hash(manifest)}`,
          `Verification-Hash: ${hash(accepted)}`,
          `Application-Hash: ${accepted.project.hash}`,
          'Approved-By: none (human review required)',
          'Independent-Review: pending; reviewed commit evidence is recorded separately',
        ];
        await git(worktree, ['commit', '-q', '-m', subject, '-m', trailers.join('\n')]);
        delivery.commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
      } else delivery.commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
      if (isMultiTarget(config)) {
        delivery.integration = await integrateBase(config, worktree, target, options, base);
        if (delivery.integration) delivery.commit = delivery.integration.commit;
      }
      delivery.status = 'COMMITTED'; delivery.steps.committedAt = new Date().toISOString();
    } catch (error) {
      // Nothing is linked to the versions, so the next sync repeats this delivery from the same content.
      return { status: 'BLOCKED', step: 'commit', reason: error.message };
    }
    for (const entry of pending) entry.deliveryId = delivery.id;
    state.deliveries.push(delivery);
    await saveDelivery(root, config, target, state);
    await saveProgress(root, config, target, source);
  }

  const results = [];
  for (const delivery of state.deliveries.filter(item => !['MERGED', 'PR_OPEN_MANUAL'].includes(item.status))) {
    try {
      const revalidatingDelivery = revalidation && retryIndependentReview?.deliveryId === delivery.id;
      const gateOptions = { worktree, target, commit: delivery.commit, manifestIds: delivery.versions, expectedBaseSha: delivery.baseSha };
      if (!delivery.independentReviewId || retryIndependentReview?.deliveryId === delivery.id) {
        const previousId = delivery.independentReviewId;
        const independent = await requestIndependentReview(root, config, gateOptions);
        delivery.independentReviewAttempts ??= previousId ? [{ id: previousId, status: revalidatingDelivery ? 'PASS' : 'BLOCKED' }] : [];
        delivery.independentReviewAttempts.push({ id: independent.id, status: independent.status, createdAt: independent.createdAt, supersedes: previousId ?? null });
        delivery.independentReviewId = independent.id;
        delivery.independentSessionId = independent.sessionId ?? null;
        await saveDelivery(root, config, target, state);
        if (independent.status !== 'PASS') { const error = new Error(independent.reason); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; throw error; }
      }
      const independent = await assertIndependentReview(root, config, delivery.independentReviewId, { ...gateOptions, published: 'either' });
      if (delivery.approval && delivery.approval.independentReviewId !== independent.id && !revalidatingDelivery) { const error = new Error('Existing automated approval lacks this independent review; inspect it manually'); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; throw error; }
      if (config.policy?.autoApprove && (!delivery.approval || revalidatingDelivery)) {
        const entry = (await loadProgress(root, config, target)).entries.find(item => item.manifestId === delivery.versions.at(-1));
        if (delivery.approval) { delivery.approvalHistory ??= []; delivery.approvalHistory.push(delivery.approval); }
        delivery.approval = await approve(root, config, worktree, entry, independent);
        await saveDelivery(root, config, target, state);
      }
      if (!delivery.steps.pushedAt) {
        const checked = await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: 'either' });
        if (checked.observedRemoteHead !== delivery.commit) await git(worktree, ['push', '--no-follow-tags', '-q', checked.binding.remote.url, `${delivery.commit}:refs/heads/${branch}`]);
        delivery.steps.pushedAt = new Date().toISOString();
        await saveDelivery(root, config, target, state);
      }
      await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
      const repository = independent.binding.remote.repository;
      if (!delivery.pr) {
        const open = await ghJson(worktree, repository, ['pr', 'list', '--head', branch, '--base', options.baseBranch, '--state', 'open', '--json', 'number,url']);
        delivery.pr = open?.[0] ?? null;
        if (!delivery.pr) {
          await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
          const created = await gh(worktree, repository, ['pr', 'create', ...(options.draft ? ['--draft'] : []), '--base', options.baseBranch, '--head', branch, '--title', `ProtoFlow delivery: prototype ${delivery.shas.at(-1).slice(0, 7)}`, '--body', 'Automated application delivery from ProtoFlow. Each delivery is summarized in a comment below.']);
          if (created.status !== 'PASS') throw new Error(`gh pr create failed: ${created.stderr.trim()}`);
          // Look the new PR up among open PRs: the branch may also have older, merged PRs.
          delivery.pr = (await ghJson(worktree, repository, ['pr', 'list', '--head', branch, '--base', options.baseBranch, '--state', 'open', '--json', 'number,url']))?.[0] ?? null;
          if (!delivery.pr) throw new Error(`gh pr create did not leave an open PR for ${branch}`);
        }
      }
      await assertPullRequestScope(worktree, independent, delivery);
      if (!delivery.steps.commentedAt) {
        const entries = (await loadProgress(root, config, target)).entries.filter(entry => delivery.versions.includes(entry.manifestId));
        await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
        const comment = await gh(worktree, repository, ['pr', 'comment', String(delivery.pr.number), '--body', summary(delivery, entries, config, target)]);
        if (comment.status !== 'PASS') throw new Error(`gh pr comment failed: ${comment.stderr.trim()}`);
        delivery.steps.commentedAt = new Date().toISOString();
      }
      if (options.merge === 'auto') {
        await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
        const view = await ghJson(worktree, repository, ['pr', 'view', String(delivery.pr.number), '--json', 'state,mergeCommit,headRefOid,baseRefOid,baseRefName,headRefName,isDraft']);
        if (view.state === 'OPEN') {
          // Merge only the exact delivered head; a newer push belongs to a later delivery.
          if (view.headRefOid !== delivery.commit) throw new Error(`PR head ${view.headRefOid} is not delivery commit ${delivery.commit}`);
          if (view.baseRefOid !== independent.binding.remote.baseSha || view.baseRefName !== options.baseBranch || view.headRefName !== branch) throw new Error('PR base/head scope differs from the independently reviewed refs');
          await assertPullRequestScope(worktree, independent, delivery);
          await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
          if (view.isDraft) {
            const ready = await gh(worktree, repository, ['pr', 'ready', String(delivery.pr.number)]);
            if (ready.status !== 'PASS') throw new Error(`gh pr ready failed: ${ready.stderr.trim()}`);
            delivery.steps.readyAt = new Date().toISOString(); await saveDelivery(root, config, target, state);
            await assertPullRequestScope(worktree, independent, delivery);
            await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
          }
          const merged = await gh(worktree, repository, ['pr', 'merge', String(delivery.pr.number), '--merge', '--match-head-commit', delivery.commit]);
          if (merged.status !== 'PASS') throw new Error(`gh pr merge failed: ${merged.stderr.trim()}`);
        }
        const after = await ghJson(worktree, repository, ['pr', 'view', String(delivery.pr.number), '--json', 'state,mergeCommit,mergedAt,headRefOid']);
        if (after.state !== 'MERGED') throw new Error(`PR #${delivery.pr.number} is ${after.state}, not merged`);
        // A merged PR only counts when it merged this delivery's exact commit.
        if (after.headRefOid !== delivery.commit) throw new Error(`PR #${delivery.pr.number} merged ${after.headRefOid}, not delivery commit ${delivery.commit}`);
        delivery.mergeCommit = after.mergeCommit?.oid ?? null; delivery.steps.mergedAt = after.mergedAt;
        delivery.status = 'MERGED';
        try { delivery.alignment = await alignDeliveredRunner(root, config, worktree, delivery, target); }
        catch (error) { delivery.alignment = { status: 'BLOCKED', reason: error.message }; }
      } else {
        await assertPullRequestScope(worktree, independent, delivery);
        await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
        delivery.status = 'PR_OPEN_MANUAL';
      }
      delivery.error = null;
    } catch (error) {
      delivery.status = error.code === 'INDEPENDENT_REVIEW_BLOCKED' ? 'BLOCKED' : 'FAIL'; delivery.error = error.message;
    }
    delivery.updatedAt = new Date().toISOString();
    await saveDelivery(root, config, target, state);
    results.push({ id: delivery.id, status: delivery.status, versions: delivery.shas, commit: delivery.commit, pr: delivery.pr?.url ?? null, mergeCommit: delivery.mergeCommit ?? null, error: delivery.error ?? null, ...(delivery.alignment ? { alignment: delivery.alignment } : {}) });
    // Later deliveries stack on this branch; keep order by stopping at the first failure.
    if (['FAIL', 'BLOCKED'].includes(delivery.status)) break;
  }
  const failed = results.find(item => ['FAIL', 'BLOCKED'].includes(item.status) || item.alignment?.status === 'BLOCKED');
  return { status: failed ? (failed.alignment?.status === 'BLOCKED' ? 'BLOCKED' : failed.status) : results.length ? 'PASS' : 'IDLE', deliveries: results };
}

/** Pending commits must exist before the next version runs, so each commit holds only its own version. */
export async function assertDelivered(root, config, target = null) {
  if (!config.runner?.delivery) return;
  const source = await loadProgress(root, config, target);
  const state = await deliveryStatus(root, config, target);
  const alignment = state.deliveries.find(item => item.status === 'MERGED' && item.alignment?.status === 'BLOCKED');
  if (alignment) throw new Error(`Merged delivery ${alignment.id} requires alignment recovery: ${alignment.alignment.reason}`);
  if (source.entries.some(entry => entry.status === 'PASS' && !entry.deliveryId) || state.deliveries.some(delivery => !['MERGED', 'PR_OPEN_MANUAL'].includes(delivery.status))) {
    const result = await syncDeliveries(root, config, { target });
    if (['FAIL', 'BLOCKED'].includes(result.status)) throw new Error(`Delivery is blocked: ${result.reason ?? result.deliveries?.find(item => item.error)?.error}`);
  }
}
