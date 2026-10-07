import { createReview, decideReview, createBaseline, loadArtifact } from './workflow.js';
import { git, sourceStatus, saveSourceState } from './source.js';
import { projectPath, readJson, writeJson, runCommand, id } from './util.js';

const deliveryPath = '.protoflow/delivery/state.json';
// The automated approver is recorded as such; it never stands in for a named human.
export const AUTOMATED_REVIEWER = 'ai:protoflow-runner';
// Runner state, dependencies and test output never belong in an application commit; node_modules may be a symlink.
const EXCLUDED = ['.protoflow', 'node_modules', 'test-results', 'playwright-report'];

export async function deliveryStatus(root) {
  return readJson(await projectPath(root, deliveryPath), { schemaVersion: 1, deliveries: [] });
}
async function saveDelivery(root, state) { await writeJson(await projectPath(root, deliveryPath), state); }

async function copyRecord(worktree, root, kind, recordId) {
  const record = await loadArtifact(worktree, kind, recordId);
  await writeJson(await projectPath(root, `.protoflow/${kind}/${recordId}.json`), record);
}

/** Automated approval of the newest accepted version, bound to its verification exactly like a human review. */
async function approve(root, config, worktree, entry) {
  const review = await createReview(worktree, config, entry.manifestId, entry.verificationId);
  const decided = await decideReview(worktree, config, review.id, {
    status: 'approved', reviewer: AUTOMATED_REVIEWER, reviewerKind: 'automated',
    notes: `Automated approval (policy.autoApprove): build, functional and visual verification ${entry.verificationId} passed for prototype ${entry.sha}.`,
  });
  const baseline = await createBaseline(worktree, config, decided.id);
  await copyRecord(worktree, root, 'reviews', decided.id);
  await copyRecord(worktree, root, 'baselines', baseline.id);
  await writeJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: baseline.id });
  return { reviewId: decided.id, baselineId: baseline.id };
}

function gh(worktree, args) { return runCommand(worktree, { argv: ['gh', ...args], timeoutMs: 120000 }); }
async function ghJson(worktree, args) {
  const result = await gh(worktree, args);
  if (result.status !== 'PASS') throw new Error(`gh ${args[0]} ${args[1]} failed: ${(result.stderr || result.error || '').trim()}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function summary(delivery, entries, config) {
  const lines = entries.map(entry => `| \`${entry.sha.slice(0, 7)}\` | ${entry.manifestId} | ${entry.verificationId} | PASS |`);
  return [
    `### ProtoFlow delivery ${delivery.id}`,
    '',
    '| Prototype commit | Manifest | Verification | Build / functional / visual |',
    '|---|---|---|---|',
    ...lines,
    '',
    delivery.approval?.reviewId
      ? `Approval: **automated** by \`${AUTOMATED_REVIEWER}\` (review ${delivery.approval.reviewId}, baseline ${delivery.approval.baselineId}). No human reviewed this change.`
      : 'Approval: none recorded (policy.autoApprove is off); a human must review before merging.',
    `Application commit: ${delivery.commit}`,
    `Source: ${config.source.repository}#${config.source.branch}:${config.source.path}`,
  ].join('\n');
}

/**
 * Deliver accepted versions from the isolated worktree: optional automated approval, one commit,
 * push to the delivery branch, a pull request with the evidence, and merge when configured.
 * Versions accepted since the last commit share it; in steady state that is exactly one version.
 */
export async function syncDeliveries(root, config, { worktree } = {}) {
  const options = config.runner?.delivery;
  if (!options) return { status: 'NOT_RUN', reason: 'runner.delivery is not configured' };
  worktree ??= (await readJson(await projectPath(root, '.protoflow/runner/state.json'), null))?.worktree;
  if (!worktree) return { status: 'NOT_RUN', reason: 'Runner worktree does not exist yet' };
  const source = await sourceStatus(root);
  const state = await deliveryStatus(root);
  const pending = source.entries.filter(entry => entry.status === 'PASS' && !entry.deliveryId);

  if (pending.length) {
    const last = pending.at(-1);
    const delivery = { id: id('DLV'), createdAt: new Date().toISOString(), versions: pending.map(entry => entry.manifestId), shas: pending.map(entry => entry.sha), status: 'PENDING', steps: {} };
    try {
      if (config.policy?.autoApprove) delivery.approval = await approve(root, config, worktree, last);
      await git(worktree, ['add', '-A', '--', '.', ...EXCLUDED.map(entry => `:(exclude)${entry}`)]);
      const staged = await runCommand(worktree, { argv: ['git', 'diff', '--cached', '--quiet'] });
      if (staged.exitCode === 1) {
        const subject = pending.length === 1 ? `ProtoFlow: implement prototype ${last.sha.slice(0, 7)}` : `ProtoFlow: implement prototypes ${pending[0].sha.slice(0, 7)}..${last.sha.slice(0, 7)}`;
        const trailers = [
          ...pending.map(entry => `Prototype-Commit: ${entry.sha}`),
          `Manifest: ${last.manifestId}`,
          `Verification: ${last.verificationId}`,
          delivery.approval ? `Approved-By: ${AUTOMATED_REVIEWER} (automated; review ${delivery.approval.reviewId})` : 'Approved-By: none (human review required)',
        ];
        await git(worktree, ['commit', '-q', '-m', subject, '-m', trailers.join('\n')]);
        delivery.commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
      } else if (staged.exitCode === 0) delivery.commit = (await git(worktree, ['rev-parse', 'HEAD'])).trim();
      else throw new Error(`git diff --cached failed: ${staged.stderr || staged.error}`);
      delivery.status = 'COMMITTED'; delivery.steps.committedAt = new Date().toISOString();
    } catch (error) {
      // Nothing is linked to the versions, so the next sync repeats this delivery from the same content.
      return { status: 'FAIL', step: 'commit', reason: error.message };
    }
    for (const entry of pending) entry.deliveryId = delivery.id;
    state.deliveries.push(delivery);
    await saveDelivery(root, state);
    await saveSourceState(root, source);
  }

  const results = [];
  for (const delivery of state.deliveries.filter(item => !['MERGED', 'PR_OPEN_MANUAL'].includes(item.status))) {
    try {
      if (!delivery.steps.pushedAt) {
        await git(worktree, ['push', '-q', options.remote ?? 'origin', `${delivery.commit}:refs/heads/${options.branch}`]);
        delivery.steps.pushedAt = new Date().toISOString();
      }
      if (!delivery.pr) {
        const open = await ghJson(worktree, ['pr', 'list', '--head', options.branch, '--base', options.baseBranch, '--state', 'open', '--json', 'number,url']);
        delivery.pr = open?.[0] ?? null;
        if (!delivery.pr) {
          const created = await gh(worktree, ['pr', 'create', '--base', options.baseBranch, '--head', options.branch, '--title', `ProtoFlow delivery: prototype ${delivery.shas.at(-1).slice(0, 7)}`, '--body', 'Automated application delivery from ProtoFlow. Each delivery is summarized in a comment below.']);
          if (created.status !== 'PASS') throw new Error(`gh pr create failed: ${created.stderr.trim()}`);
          delivery.pr = (await ghJson(worktree, ['pr', 'view', options.branch, '--json', 'number,url']));
        }
      }
      if (!delivery.steps.commentedAt) {
        const entries = (await sourceStatus(root)).entries.filter(entry => delivery.versions.includes(entry.manifestId));
        const comment = await gh(worktree, ['pr', 'comment', String(delivery.pr.number), '--body', summary(delivery, entries, config)]);
        if (comment.status !== 'PASS') throw new Error(`gh pr comment failed: ${comment.stderr.trim()}`);
        delivery.steps.commentedAt = new Date().toISOString();
      }
      if (options.merge === 'auto') {
        const view = await ghJson(worktree, ['pr', 'view', String(delivery.pr.number), '--json', 'state,mergeCommit,headRefOid']);
        if (view.state === 'OPEN') {
          // Merge only the exact delivered head; a newer push belongs to a later delivery.
          if (view.headRefOid !== delivery.commit) throw new Error(`PR head ${view.headRefOid} is not delivery commit ${delivery.commit}`);
          const merged = await gh(worktree, ['pr', 'merge', String(delivery.pr.number), '--merge', '--match-head-commit', delivery.commit]);
          if (merged.status !== 'PASS') throw new Error(`gh pr merge failed: ${merged.stderr.trim()}`);
        }
        const after = await ghJson(worktree, ['pr', 'view', String(delivery.pr.number), '--json', 'state,mergeCommit,mergedAt']);
        if (after.state !== 'MERGED') throw new Error(`PR #${delivery.pr.number} is ${after.state}, not merged`);
        delivery.mergeCommit = after.mergeCommit?.oid ?? null; delivery.steps.mergedAt = after.mergedAt;
        delivery.status = 'MERGED';
      } else delivery.status = 'PR_OPEN_MANUAL';
      delivery.error = null;
    } catch (error) {
      delivery.status = 'FAIL'; delivery.error = error.message;
    }
    delivery.updatedAt = new Date().toISOString();
    await saveDelivery(root, state);
    results.push({ id: delivery.id, status: delivery.status, versions: delivery.shas, commit: delivery.commit, pr: delivery.pr?.url ?? null, mergeCommit: delivery.mergeCommit ?? null, error: delivery.error ?? null });
    // Later deliveries stack on this branch; keep order by stopping at the first failure.
    if (delivery.status === 'FAIL') break;
  }
  const failed = results.find(item => item.status === 'FAIL');
  return { status: failed ? 'FAIL' : results.length ? 'PASS' : 'IDLE', deliveries: results };
}

/** Pending commits must exist before the next version runs, so each commit holds only its own version. */
export async function assertDelivered(root, config) {
  if (!config.runner?.delivery) return;
  const source = await sourceStatus(root);
  if (source.entries.some(entry => entry.status === 'PASS' && !entry.deliveryId)) {
    const result = await syncDeliveries(root, config);
    if (result.status === 'FAIL' && result.step === 'commit') throw new Error(`Delivery commit failed: ${result.reason}`);
  }
}
