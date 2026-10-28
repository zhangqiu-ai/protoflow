import fs from 'node:fs/promises';
import path from 'node:path';
import { createReview, decideReview, createBaseline, loadArtifact, applicationFingerprint } from './workflow.js';
import { loadProgress, saveProgress, deliveryStatePath, deliveryBranch, runnerStatePath, isMultiTarget } from './streams.js';
import { projectPath, readJson, writeJson, id, hash, RUNTIME_DIRS } from './util.js';
import { requestIndependentReview, assertIndependentReview, recordedVerdict, isRejectingVerdict, interruptedProvider } from './delivery-review.js';
import { alignDeliveredRunner } from './runner-alignment.js';
import { deliveryGit as git, deliveryGh as gh, deliveryPullRequest, resolveDeliveryDestination, markTransient, transientFailure } from './delivery-scope.js';
import { verificationRevocation } from './queue.js';
import { carriedAnswers } from './source.js';

// The automated approver is recorded as such; it never stands in for a named human.
export const AUTOMATED_REVIEWER = 'ai:codex-independent-review';
// Runner state, dependencies and test output never belong in an application commit; node_modules may be a symlink.
const EXCLUDED = RUNTIME_DIRS;
const settled = delivery => ['MERGED', 'PR_OPEN_MANUAL', 'REVOKED'].includes(delivery.status);
const protectedPath = /(?:^|\/)(?:\.git|\.protoflow|\.agents|\.codex|\.aws|\.ssh|node_modules|test-results|playwright-report|secrets?|credentials|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))(?:\/|$)/i;
function allowPath(value, config) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /[\s\\\0:*?\[\]]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') || protectedPath.test(value) || value === config.prototypeDir || value.startsWith(`${config.prototypeDir}/`) || config.prototypeDir.startsWith(`${value}/`)) throw new Error(`Unsafe delivery allowlist path: ${value}`);
}
const inScope = (file, paths) => !paths || paths.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
const under = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
// With several targets, each target delivers only its own root and shared top-level files, never a sibling's root.
const siblingRoots = (config, target) => isMultiTarget(config) ? config.targets.filter(item => item.id !== target).map(item => item.root.replace(/\/+$/, '')) : [];
export async function currentBase(worktree, options) {
  const destination = await resolveDeliveryDestination(worktree, options.remote);
  const output = await git(worktree, ['ls-remote', destination.url, `refs/heads/${options.baseBranch}`]);
  const match = /^([a-f0-9]{40})\s+refs\/heads\/(.+)$/.exec(output);
  if (!match || match[2] !== options.baseBranch) throw new Error('Current delivery base SHA is unavailable');
  return { sha: match[1], url: destination.url };
}

/**
 * Stage the application change for a delivery commit: everything Git can commit inside the allowlist, without runtime
 * output, and never a sibling target's root or (with an allowlist) a protected path. Returns the staged files.
 */
export async function stageApplication(worktree, config, target) {
  const options = config.runner.delivery;
  // Stage, then unstage exclusions: naming a gitignored path in an add pathspec makes git exit non-zero.
  // `add -A` leaves Git-ignored files out, matching applicationFingerprint, which binds only committable content.
  await git(worktree, ['add', '-A', '--', ...(options.paths ?? ['.'])]);
  await git(worktree, ['reset', '-q', '--', ...EXCLUDED]);
  const included = (await git(worktree, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  const runtime = included.filter(file => file.split('/').some(part => EXCLUDED.includes(part)));
  if (runtime.length) await git(worktree, ['reset', '-q', '--', ...runtime]);
  const siblings = siblingRoots(config, target);
  for (const file of included.filter(file => !runtime.includes(file))) if (!inScope(file, options.paths) || (options.paths && protectedPath.test(file)) || siblings.some(prefix => under(file, prefix))) throw new Error(`Staged delivery file is outside safe scope: ${file}`);
  return (await git(worktree, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
}

/**
 * Sibling targets merge their own deliveries into the shared base, so a target's HEAD falls behind it. Merge the
 * current base into this target's history only when the base changed nothing this target verified: files outside
 * its application (sibling roots, prototype, runtime output), or files this HEAD already has with identical content. The reviewed HEAD then contains the base it is
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
  // A base change this HEAD already holds byte for byte (e.g. a config edit that runner configure synced) was verified here.
  const differs = new Set((await git(worktree, ['diff', '--name-only', '-z', head, base.sha])).split('\0').filter(Boolean));
  const touched = (await git(worktree, ['diff', '--name-only', '-z', fork, base.sha])).split('\0').filter(Boolean)
    .filter(file => differs.has(file) && !outside.some(prefix => under(file, prefix)) && !file.split('/').some(part => EXCLUDED.includes(part)));
  const diverged = message => Object.assign(new Error(message), { code: 'BASE_DIVERGED', baseSha: base.sha });
  if (touched.length) throw diverged(`Base ${options.baseBranch} changed files of target ${target} since its worktree forked (${touched.slice(0, 5).join(', ')}); reverify on the current base`);
  const before = await applicationFingerprint(worktree, config, target);
  try { await git(worktree, ['merge', '--no-ff', '--no-edit', '-m', `ProtoFlow: integrate ${options.baseBranch} ${base.sha.slice(0, 7)} into target ${target}`, base.sha]); }
  catch (error) {
    try { await git(worktree, ['merge', '--abort']); } catch { /* nothing to abort */ }
    throw new Error(`Base ${base.sha} does not merge cleanly into target ${target}: ${(error.stderr || error.message).trim()}`);
  }
  if ((await applicationFingerprint(worktree, config, target)).hash !== before.hash) {
    // --keep never discards local changes; it only undoes the merge commit.
    await git(worktree, ['reset', '-q', '--keep', head]);
    throw diverged(`Integrating base ${base.sha} changed target ${target} application content; reverify on the current base`);
  }
  return { baseSha: base.sha, previousHead: head, commit: await git(worktree, ['rev-parse', 'HEAD']) };
}

/** Files `git add -A` could commit that differ from HEAD (tracked or untracked-but-not-ignored), without runtime output. */
async function pendingChanges(worktree) {
  const tracked = (await git(worktree, ['diff', '--name-only', '-z', 'HEAD'])).split('\0');
  const untracked = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0');
  return [...new Set([...tracked, ...untracked])].filter(file => file && !file.split('/').some(part => EXCLUDED.includes(part)));
}

/**
 * A single-target stream builds each version on the base its delivery will be reviewed against. When people moved
 * the base after the last delivery merged, a worktree whose commits are all in the base and which holds no other
 * change fast-forwards to it. Otherwise the version would be built on a stale base and its delivery could never be
 * reviewed, so it blocks before anything runs (`runner rebase` starts the undelivered versions over on the base).
 * The exceptions are work the base did not touch: uncommitted executor changes, and the work of a version reopened
 * after its delivery was rejected, move onto the base (see carryWork). Several targets integrate or reverify at
 * delivery instead.
 */
export async function alignWorktreeToBase(worktree, config, root = null) {
  const options = config.runner?.delivery;
  if (!options || isMultiTarget(config)) return null;
  const base = await currentBase(worktree, options);
  await ensureCommit(worktree, base);
  if (await isAncestor(worktree, base.sha, 'HEAD')) return null;
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  const ahead = (await git(worktree, ['rev-list', '--count', `${base.sha}..${head}`])).trim();
  const changes = await pendingChanges(worktree);
  if (ahead !== '0' || changes.length) {
    const carried = root ? await carryWork(root, config, worktree, base, head) : null;
    if (carried?.to) return carried;
    const detail = [ahead !== '0' && `${ahead} commit(s) not in the base`, changes.length && `uncommitted changes in ${changes.slice(0, 5).join(', ')}`, carried?.overlap && `files the base also changed (${carried.overlap.slice(0, 5).join(', ')})`].filter(Boolean).join(' and ');
    throw Object.assign(new Error(`Base ${options.baseBranch} moved to ${base.sha.slice(0, 7)} but the runner worktree has ${detail}; a version built there could not be delivered. Merge or retire its delivery, or run runner rebase to start the undelivered versions over on the current base`), { code: 'BASE_MOVED', baseSha: base.sha });
  }
  await git(worktree, ['merge', '--ff-only', base.sha]);
  return { from: head, to: base.sha };
}

/**
 * Work the base did not touch moves onto the moved base instead of blocking for a person: the uncommitted changes of
 * an attempt in progress (a base moved mid-round was the most common block in practice), and the rejected commit a
 * version reopened after its delivery was rejected keeps in the runner branch until the next delivery drops it from
 * the history and keeps its files (dropRevokedHistory). It applies when every commit not in the base belongs to
 * unpublished revoked deliveries (none at all when only uncommitted changes exist), no other delivery is unsettled,
 * and the base changed no file the worktree changed (or changed it to the same content). HEAD becomes the base, the
 * worktree keeps every file it carried, the files only the base changed take the base's content, and the commits and
 * uncommitted files are kept under an archive ref (created before anything moves, so nothing is lost).
 * Returns null when this does not apply, or { overlap } when only the files the base also changed are in the way.
 */
async function carryWork(root, config, worktree, base, head) {
  const state = await deliveryStatus(root, config, null);
  if (state.deliveries.some(item => !settled(item))) return null;
  const fork = await git(worktree, ['merge-base', head, base.sha]);
  const list = async args => (await git(worktree, args)).split(args.includes('-z') ? '\0' : '\n').filter(Boolean);
  const revoked = new Set(), deliveries = [];
  for (const delivery of state.deliveries.filter(item => item.status === 'REVOKED' && unpublished(item))) {
    for (const commit of deliveryCommits(delivery)) {
      if (!await isAncestor(worktree, commit, head) || await isAncestor(worktree, commit, base.sha)) continue;
      for (const sha of await list(['rev-list', `${fork}..${commit}`])) revoked.add(sha);
      if (!deliveries.includes(delivery.id)) deliveries.push(delivery.id);
    }
  }
  const commits = await list(['rev-list', `${fork}..${head}`]);
  const changes = await pendingChanges(worktree);
  if ((!commits.length && !changes.length) || commits.some(sha => !revoked.has(sha))) return null;
  const moved = await list(['diff', '--name-status', '--no-renames', '-z', fork, base.sha]);
  const files = [];
  for (let index = 0; index < moved.length; index += 2) files.push({ status: moved[index], file: moved[index + 1] });
  const worked = new Set([...await list(['diff', '--name-only', '--no-renames', '-z', fork]), ...await list(['ls-files', '--others', '--exclude-standard', '-z'])]);
  const baseBlob = async file => { try { return await git(worktree, ['rev-parse', `${base.sha}:${file}`]); } catch { return null; } };
  const localBlob = async file => (await fs.lstat(path.join(worktree, file)).catch(() => null)) ? git(worktree, ['hash-object', '--', file]) : null;
  const overlap = [];
  for (const { file } of files.filter(item => worked.has(item.file))) if (await baseBlob(file) !== await localBlob(file)) overlap.push(file);
  if (overlap.length) return { overlap };

  const at = new Date().toISOString(), ref = `refs/protoflow/carried/${at.replace(/[:.]/g, '-')}`;
  let archive = head;
  if (changes.length) {
    // Staging everything is what the next delivery does anyway; here it builds the archive tree.
    await git(worktree, ['add', '-A', '--', ...changes]);
    archive = await git(worktree, ['commit-tree', await git(worktree, ['write-tree']), '-p', head, '-m', `ProtoFlow: uncommitted runner changes carried onto ${base.sha.slice(0, 7)}`]);
  }
  await git(worktree, ['update-ref', ref, archive]);
  // HEAD moves to the base keeping the index and files; then the files only the base changed take its content.
  await git(worktree, ['reset', '-q', '--soft', base.sha]);
  const removed = files.filter(item => item.status === 'D').map(item => item.file);
  const updated = files.filter(item => item.status !== 'D').map(item => item.file);
  for (let index = 0; index < updated.length; index += 200) await git(worktree, ['checkout', base.sha, '--', ...updated.slice(index, index + 200)]);
  for (const file of removed) {
    await git(worktree, ['rm', '-q', '--cached', '--ignore-unmatch', '--', file]);
    await fs.rm(path.join(worktree, file), { force: true });
  }
  return { from: head, to: base.sha, carried: { archive: ref, commits: commits.length, deliveries, files: files.length, uncommitted: changes.length } };
}

/**
 * The undelivered work of a single-target stream was built on a base that has moved, so its delivery can never be
 * reviewed. Retire it: every unpublished, unsettled delivery is revoked, the worktree's commits and uncommitted
 * changes are kept under an archive ref, the worktree is reset to the current base, and the versions those changes
 * carried (delivered or accepted but undelivered, and the current one) run again from scratch.
 */
export async function rebaseDeliveries(root, config, worktree) {
  const options = config.runner?.delivery;
  if (!options) throw new Error('runner rebase needs runner.delivery');
  if (isMultiTarget(config)) throw new Error('runner rebase supports single-target streams only; several targets integrate or reverify a moved base at delivery');
  const source = await loadProgress(root, config, null);
  const state = await deliveryStatus(root, config, null);
  const base = await currentBase(worktree, options);
  await ensureCommit(worktree, base);
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  if (await isAncestor(worktree, base.sha, head)) throw new Error(`Base ${options.baseBranch} (${base.sha.slice(0, 7)}) is already in the runner worktree; nothing to rebase`);
  // The local record of a manual PR is only what the runner last saw; a person may have merged or closed it on GitHub.
  if (await reconcileManualDeliveries(worktree, config, state)) await saveDelivery(root, config, null, state);
  for (const delivery of state.deliveries.filter(item => item.status === 'MERGED' || item.manualMerge)) {
    const mergeCommit = delivery.mergeCommit ?? delivery.manualMerge?.mergeCommit;
    if (mergeCommit && delivery.manualMerge) await ensureCommit(worktree, { sha: mergeCommit, url: base.url });
    if (mergeCommit && !await isAncestor(worktree, mergeCommit, base.sha)) throw new Error(`Merged delivery ${delivery.id} is not in base ${base.sha.slice(0, 7)}; the base was rewritten, resolve it externally`);
  }
  const closed = state.deliveries.find(item => manualOpen(item) && item.manualClosed);
  if (closed) throw new Error(`Delivery ${closed.id} pull request #${closed.pr.number} was closed without merging and its commits are still on ${deliveryBranch(config, null)}; reopen and merge it, or resolve the delivery branch externally, before rebasing`);
  const open = state.deliveries.find(manualOpen);
  if (open) throw new Error(`Delivery ${open.id} has an open pull request${open.pr ? ` #${open.pr.number}` : ''}; merge or close it before rebasing`);
  const retired = state.deliveries.filter(item => !settled(item));
  const destination = await resolveDeliveryDestination(worktree, options.remote);
  const remote = /^([a-f0-9]{40})\s/.exec(await git(worktree, ['ls-remote', destination.url, `refs/heads/${deliveryBranch(config, null)}`]))?.[1] ?? null;
  if (remote) await ensureCommit(worktree, { sha: remote, url: destination.url });
  for (const delivery of retired) {
    if (!unpublished(delivery)) throw new Error(`Delivery ${delivery.id} was pushed or has a pull request; close it externally before rebasing`);
    if (remote && delivery.commit && (remote === delivery.commit || await isAncestor(worktree, delivery.commit, remote))) throw new Error(`Delivery ${delivery.id} may already be on the remote branch; resolve it externally`);
  }
  const ids = new Set(retired.map(item => item.id));
  const first = source.entries.findIndex(entry => entry.status !== 'PASS' || !entry.deliveryId || ids.has(entry.deliveryId));
  if (first === -1) throw new Error('No undelivered version to run again');
  const settledHere = source.entries.slice(first).find(entry => entry.deliveryId && !ids.has(entry.deliveryId));
  if (settledHere) throw new Error(`Version ${settledHere.manifestId} after the undelivered ones has settled delivery ${settledHere.deliveryId}; resolve it externally`);

  // Keep everything the worktree holds (commits and uncommitted, unignored files) under one archive commit.
  const at = new Date().toISOString(), ref = `refs/protoflow/rebased/${at.replace(/[:.]/g, '-')}`;
  const changes = await pendingChanges(worktree);
  let archive = head;
  if (changes.length) {
    // The index is reset with the worktree right after; staging here only builds the archive tree.
    await git(worktree, ['add', '-A', '--', ...changes]);
    archive = await git(worktree, ['commit-tree', await git(worktree, ['write-tree']), '-p', head, '-m', `ProtoFlow: uncommitted runner changes before rebasing onto ${base.sha.slice(0, 7)}`]);
  }
  await git(worktree, ['update-ref', ref, archive]);
  const untracked = (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => file && !file.split('/').some(part => EXCLUDED.includes(part)));
  await git(worktree, ['reset', '-q', '--hard', base.sha]);
  for (const file of untracked) await fs.rm(path.join(worktree, file), { force: true });

  const reason = `Base ${options.baseBranch} moved to ${base.sha} after the runner worktree forked; retired by runner rebase, the versions run again on the current base (archive ${ref})`;
  for (const delivery of retired) {
    delivery.revocation = { at, previousStatus: delivery.status, reason, staleBase: { from: delivery.baseSha ?? null, to: base.sha }, archive: ref };
    delivery.status = 'REVOKED';
  }
  const restarted = source.entries.slice(first);
  source.rebased = [...(source.rebased ?? []), { at, from: head, to: base.sha, archive: ref, deliveries: [...ids], entries: restarted }];
  source.entries = [...source.entries.slice(0, first), ...restarted.map(entry => ({ sha: entry.sha, manifestId: entry.manifestId, prototypeHash: entry.prototypeHash, ordinal: entry.ordinal, status: 'PENDING', attempts: [], ...carriedAnswers(entry, { by: 'rebase', at, archive: ref }) }))];
  source.completedSha = source.entries[first - 1]?.sha ?? null;
  await saveDelivery(root, config, null, state); await saveProgress(root, config, null, source);
  return { at, from: head, to: base.sha, archive: ref, deliveries: [...ids], versions: restarted.map(entry => entry.manifestId) };
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
/** `delivery status` for people: each delivery counts its versions that passed outright and those that passed with waivers. */
export async function deliveryReport(root, config = {}, target = null) {
  if (isMultiTarget(config) && !target) {
    const targets = {};
    for (const item of config.targets) targets[item.id] = await deliveryReport(root, config, item.id);
    return { schemaVersion: 1, targets };
  }
  const state = await deliveryStatus(root, config, target);
  const entries = (await loadProgress(root, config, target).catch(() => ({ entries: [] }))).entries ?? [];
  for (const delivery of state.deliveries ?? []) {
    const versions = entries.filter(entry => (delivery.versions ?? []).includes(entry.manifestId) && entry.deliveryId === delivery.id);
    const waived = await waivedVersions(root, versions);
    delivery.counts = { passed: versions.length - waived.length, passedWithWaivers: waived.length, waivers: waived.flatMap(item => item.waivers) };
    // Without autoApprove a rejecting independent review waits for a person: say how to send the version back.
    if (!config.policy?.autoApprove && ['BLOCKED', 'FAIL'].includes(delivery.status) && /^AIR-[A-Za-z0-9-]+$/.test(delivery.independentReviewId ?? '')) {
      const record = await readJson(await projectPath(root, `.protoflow/delivery/independent-reviews/${delivery.independentReviewId}.json`), null);
      const verdict = record ? await recordedVerdict(root, record).catch(() => null) : null;
      if (verdict?.status === 'FAIL' && verdict.findings?.length) delivery.next = `protoflow delivery reject-review --delivery ${delivery.id} --review ${delivery.independentReviewId}${target ? ` --target ${target}` : ''}, or 退回修改 on the dashboard`;
    }
  }
  return state;
}
async function saveDelivery(root, config, target, state) { await writeJson(await projectPath(root, deliveryStatePath(config, target)), state); }

/** A saved commit can precede its source link. Recover only the exact latest VER/manifest bound to that commit. */
async function bindsUnlinkedReopening(root, delivery, entry, report) {
  if (delivery.versions.at(-1) !== entry.manifestId || delivery.shas.at(-1) !== entry.sha || !/^[a-f0-9]{40}$/.test(delivery.commit ?? '')) return false;
  const manifest = await loadArtifact(root, 'manifests', entry.manifestId);
  if (manifest.source?.sha !== entry.sha || report.manifestHash !== hash(manifest)) return false;
  const acceptance = { commit: delivery.commit, manifestId: entry.manifestId, verificationId: report.id, manifestHash: hash(manifest), verificationHash: hash(report) };
  if (delivery.acceptance) return hash(delivery.acceptance) === hash(acceptance);
  // Legacy records have the same hashes in their application commit's trailers.
  let commit = delivery.commit;
  if (delivery.integration) {
    const integration = delivery.integration;
    if (integration.commit !== commit || integration.baseSha !== delivery.baseSha || await git(root, ['rev-list', '--parents', '-n', '1', commit]) !== `${commit} ${integration.previousHead} ${integration.baseSha}`) return false;
    commit = integration.previousHead;
  }
  const lines = (await git(root, ['show', '-s', '--format=%B', commit])).split('\n');
  const trailers = { Manifest: entry.manifestId, Verification: report.id, 'Manifest-Hash': hash(manifest), 'Verification-Hash': hash(report), 'Application-Hash': report.project?.hash, 'Delivery-Base': delivery.baseSha };
  return lines.includes(`Prototype-Commit: ${entry.sha}`) && Object.entries(trailers).every(([key, value]) => lines.filter(line => line.startsWith(`${key}: `)).join('\n') === `${key}: ${value}`);
}

/** Reopening withdraws only the old delivery's authority; retain every commit, review, approval and publication record. */
async function reconcileReopenedDeliveries(root, config, target, source, state) {
  let changed = false;
  for (const delivery of state.deliveries.filter(item => !['MERGED', 'REVOKED'].includes(item.status))) {
    const rejections = [], versions = [];
    for (const entry of source.entries.filter(item => delivery.versions.includes(item.manifestId))) {
      for (const reopening of entry.reopenings ?? []) {
        if ((reopening.deliveryId && reopening.deliveryId !== delivery.id) || !reopening.verificationId) continue;
        const report = await loadArtifact(root, 'verifications', reopening.verificationId);
        if (report.manifestId !== entry.manifestId) continue;
        const rejection = await verificationRevocation(root, config, report);
        if (!rejection || !reopening.rejections?.some(item => item.reviewId === rejection.reviewId)) continue;
        if (!reopening.deliveryId && !await bindsUnlinkedReopening(root, delivery, entry, report)) continue;
        versions.push({ manifestId: entry.manifestId, verificationId: report.id });
        if (!rejections.some(item => item.reviewId === rejection.reviewId)) rejections.push(rejection);
      }
    }
    if (!rejections.length) continue;
    delivery.revocation = { at: new Date().toISOString(), previousStatus: delivery.status, versions, rejections };
    delivery.status = 'REVOKED'; changed = true;
  }
  if (changed) await saveDelivery(root, config, target, state);
}

const isAncestor = async (worktree, commit, of) => {
  try { await git(worktree, ['merge-base', '--is-ancestor', commit, of]); return true; }
  catch (error) { if (error.code === 1 || /Not a valid commit|bad object/.test(String(error.stderr ?? ''))) return false; throw error; }
};
const deliveryCommits = delivery => [delivery.commit, delivery.integration?.previousHead].filter(Boolean);
const unpublished = delivery => !delivery.steps?.pushedAt && !delivery.pr;
async function ensureCommit(worktree, base) {
  try { await git(worktree, ['cat-file', '-e', `${base.sha}^{commit}`]); }
  catch { await git(worktree, ['fetch', '--no-tags', '--no-write-fetch-head', base.url, base.sha]); }
}
const manualOpen = delivery => delivery.status === 'PR_OPEN_MANUAL' && !delivery.manualMerge;

/**
 * A manual PR a person merged on GitHub (not from the dashboard) is recorded as merged once GitHub shows it merged
 * this delivery's commit: as its head, or, when a later delivery reused the PR, inside its merge commit. The record
 * is the dashboard's `manualMerge` with `via: 'github'`; the GitHub login is not presented as a reviewed person.
 * A PR closed without merging is recorded as `manualClosed` until it is reopened. Returns whether anything changed.
 */
async function reconcileManualDeliveries(worktree, config, state) {
  const waiting = state.deliveries.filter(item => manualOpen(item) && item.pr?.number);
  if (!waiting.length) return false;
  const options = config.runner.delivery;
  const destination = await resolveDeliveryDestination(worktree, options.remote);
  let changed = false;
  for (const delivery of waiting) {
    const view = await ghJson(worktree, destination.repository, ['pr', 'view', String(delivery.pr.number), '--json', 'state,headRefOid,baseRefName,mergeCommit,mergedAt,mergedBy,closedAt']);
    if (view?.state === 'CLOSED') {
      if (!delivery.manualClosed) { delivery.manualClosed = { closedAt: view.closedAt ?? null, observedAt: new Date().toISOString(), head: view.headRefOid ?? null }; changed = true; }
      continue;
    }
    if (delivery.manualClosed) { delete delivery.manualClosed; changed = true; }
    if (view?.state !== 'MERGED' || view.baseRefName !== options.baseBranch) continue;
    const mergeCommit = view.mergeCommit?.oid ?? null;
    let merged = view.headRefOid === delivery.commit;
    if (!merged && mergeCommit && delivery.commit) {
      await ensureCommit(worktree, { sha: mergeCommit, url: destination.url });
      merged = await isAncestor(worktree, delivery.commit, mergeCommit);
    }
    if (!merged) continue;
    delivery.manualMerge = { mergedBy: view.mergedBy?.login ? `github:${view.mergedBy.login}` : null, mergedAt: view.mergedAt ?? null, mergeCommit, via: 'github' };
    changed = true;
  }
  return changed;
}
/** Revoked deliveries that never left this checkout and whose commits `head` still carries above the base. */
async function revokedHistory(worktree, state, head, base, except = null) {
  const found = [];
  for (const delivery of state.deliveries.filter(item => item.status === 'REVOKED' && item !== except && unpublished(item))) {
    for (const commit of deliveryCommits(delivery)) {
      if (await isAncestor(worktree, commit, head) && !await isAncestor(worktree, commit, base.sha)) { found.push(delivery.id); break; }
    }
  }
  return found;
}
/**
 * A rejected delivery's commits stay in the runner branch after its version is reopened. They were never published and
 * must not reach the shared branch through a later delivery's ancestry (a rejected commit may hold caches or secrets the
 * repair removed). Before committing, drop them: move HEAD back to its fork point with the base, keeping index and files.
 */
async function dropRevokedHistory(worktree, state, base) {
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  await ensureCommit(worktree, base);
  const revoked = await revokedHistory(worktree, state, head, base);
  if (!revoked.length) return null;
  for (const delivery of state.deliveries.filter(item => !settled(item))) {
    for (const commit of deliveryCommits(delivery)) {
      if (await isAncestor(worktree, commit, head) && !await isAncestor(worktree, commit, base.sha)) throw new Error(`Unsettled delivery ${delivery.id} sits on revoked history; resolve it before committing a new delivery`);
    }
  }
  const anchor = await git(worktree, ['merge-base', head, base.sha]);
  await git(worktree, ['reset', '-q', '--soft', anchor]);
  return { from: head, to: anchor, revokedDeliveries: revoked };
}
/**
 * A delivery committed on top of revoked history before that history was dropped cannot be published as is. If it never
 * reached the remote branch, retire it and return its versions to the queue so the next commit is rebuilt cleanly.
 */
/** Whether the delivery's latest independent review returned a rejecting verdict (FAIL, NOT_RUN or a finding). */
async function rejectedByReviewer(root, delivery) {
  if (!delivery.independentReviewId) return false;
  const record = await readJson(await projectPath(root, `.protoflow/delivery/independent-reviews/${delivery.independentReviewId}.json`), null);
  if (!record) return false;
  try { return isRejectingVerdict(await recordedVerdict(root, record)); } catch { return true; }
}
async function retireTaintedDeliveries(root, config, target, worktree, source, state, options) {
  const tainted = [];
  for (const delivery of state.deliveries.filter(item => !settled(item) && unpublished(item) && item.commit)) {
    const base = await currentBase(worktree, options);
    await ensureCommit(worktree, base);
    const revoked = await revokedHistory(worktree, state, delivery.commit, base, delivery);
    // With several targets, a sibling's merge moving the base before this delivery was published rebuilds it on the
    // current base (integration or reverification follows); a single stream keeps blocking on a moved base. A reviewer
    // verdict is never discarded this way.
    const stale = !revoked.length && isMultiTarget(config) && delivery.baseSha && delivery.baseSha !== base.sha && !await rejectedByReviewer(root, delivery);
    if (!revoked.length && !stale) continue;
    const destination = await resolveDeliveryDestination(worktree, options.remote);
    const remote = /^([a-f0-9]{40})\s/.exec(await git(worktree, ['ls-remote', destination.url, `refs/heads/${deliveryBranch(config, target)}`]))?.[1] ?? null;
    if (remote) await ensureCommit(worktree, { sha: remote, url: destination.url });
    if (remote && (remote === delivery.commit || await isAncestor(worktree, delivery.commit, remote))) throw new Error(`Delivery ${delivery.id} ${stale ? 'has a moved base' : 'carries revoked history'} but may already be on the remote branch; resolve it externally`);
    delivery.revocation = stale
      ? { at: new Date().toISOString(), previousStatus: delivery.status, reason: `Base moved from ${delivery.baseSha} to ${base.sha} before publication; the versions are delivered again on the current base`, staleBase: { from: delivery.baseSha, to: base.sha } }
      : { at: new Date().toISOString(), previousStatus: delivery.status, reason: `Unpublished delivery carries the history of revoked deliveries ${revoked.join(', ')}`, revokedHistory: revoked };
    delivery.status = 'REVOKED';
    for (const entry of source.entries.filter(item => item.deliveryId === delivery.id)) delete entry.deliveryId;
    tainted.push(delivery.id);
  }
  if (tainted.length) { await saveDelivery(root, config, target, state); await saveProgress(root, config, target, source); }
  return tainted;
}

/** A repair may run locally, but updating the shared branch would also update an unresolved rejected PR. */
async function assertRevokedPublicationResolved(worktree, config, target, state, current) {
  // Missing pushedAt/pr is uncertain: the push may have succeeded before its state write.
  const revoked = state.deliveries.filter(item => item.status === 'REVOKED');
  if (!revoked.length) return;
  const destination = await resolveDeliveryDestination(worktree, config.runner.delivery.remote);
  const branch = deliveryBranch(config, target);
  const unresolved = pr => {
    const error = new Error(`Revoked delivery PR #${pr.number} is still open; resolve it externally before publishing the repaired delivery`);
    error.code = 'INDEPENDENT_REVIEW_BLOCKED'; return error;
  };
  for (const delivery of revoked.filter(item => item.pr)) {
    const pr = await deliveryPullRequest(worktree, destination.repository, delivery.pr.number);
    if (pr.html_url !== delivery.pr.url || pr.head?.ref !== branch || pr.base?.repo?.id !== destination.repository.id || pr.head?.repo?.id !== destination.repository.id) {
      const error = new Error(`Revoked delivery ${delivery.id} PR identity changed; resolve it externally before publishing the repaired delivery`);
      error.code = 'INDEPENDENT_REVIEW_BLOCKED'; throw error;
    }
    if (pr.state === 'open') throw unresolved(pr);
    if (pr.state !== 'closed') { const error = new Error(`Revoked delivery ${delivery.id} PR state is unknown`); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; throw error; }
  }
  // A push/PR-create may have succeeded just before its state write failed. Do not adopt that old open PR.
  const open = await ghJson(worktree, destination.repository, ['pr', 'list', '--head', branch, '--base', config.runner.delivery.baseBranch, '--state', 'open', '--json', 'number,url']);
  let reusable = null;
  for (const previous of open ?? []) {
    if (previous.number === current.pr?.number) continue;
    const live = await deliveryPullRequest(worktree, destination.repository, previous.number);
    const repository = destination.repository;
    const sameRepository = repo => repo?.id === repository.id && repo.full_name?.toLowerCase() === repository.nameWithOwner.toLowerCase() && repo.html_url === repository.url;
    // Normal later versions may reuse an accepted manual PR, but a push gap must not make its old head authoritative.
    const known = state.deliveries.find(item => item.status === 'PR_OPEN_MANUAL' && item.pr?.number === previous.number && item.pr.url === live.html_url && item.commit === live.head?.sha);
    if (!known || live.number !== previous.number || live.html_url !== previous.url || live.state !== 'open' || live.head?.ref !== branch || live.base?.ref !== config.runner.delivery.baseBranch || !sameRepository(live.head?.repo) || !sameRepository(live.base?.repo)) throw unresolved(previous);
    reusable ??= { number: live.number, url: live.html_url };
  }
  return reusable;
}

async function copyRecord(worktree, root, kind, recordId) {
  const record = await loadArtifact(worktree, kind, recordId);
  await writeJson(await projectPath(root, `.protoflow/${kind}/${recordId}.json`), record);
}

/** A person's decided approval of this exact verification, recorded in the project (dashboard approvals land there). */
async function humanApproval(root, verification) {
  const directory = await projectPath(root, '.protoflow/reviews');
  const names = await fs.readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const name of names.filter(item => /^REV-[A-Za-z0-9-]+\.json$/.test(item)).sort().reverse()) {
    const review = await readJson(path.join(directory, name), null);
    if (review?.status === 'approved' && (review.reviewerKind ?? 'human') === 'human' && !String(review.reviewer ?? '').startsWith('ai:') && review.verificationId === verification.id && review.verificationHash === hash(verification)) return review;
  }
  return null;
}
/**
 * Proposal 0005 D: the versions of a delivery whose accepted verification used maintainer waivers, each with the human
 * approval it has (or null). Under policy.autoApprove such a version is never approved automatically.
 */
export async function waivedVersions(root, entries) {
  const out = [];
  for (const entry of entries) {
    if (!/^VER-[A-Za-z0-9-]+$/.test(entry.verificationId ?? '')) continue;
    const verification = await loadArtifact(root, 'verifications', entry.verificationId).catch(() => null);
    if (!verification?.waivers?.length) continue;
    const review = await humanApproval(root, verification);
    out.push({ manifestId: entry.manifestId, verificationId: verification.id, waivers: verification.waivers.map(item => item.id), reviewId: review?.id ?? null, reviewer: review?.reviewer ?? null });
  }
  return out;
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

export function ghFailure(label, result) {
  const detail = (result.stderr || result.error || '').trim();
  return markTransient(new Error(`${label} failed: ${detail}`), detail);
}
export async function ghJson(worktree, repository, args) {
  const result = await gh(worktree, repository, args);
  if (result.status !== 'PASS') throw ghFailure(`gh ${args[0]} ${args[1]}`, result);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const trailerKey = line => line.slice(0, line.indexOf(':'));
/** `body` with each configured `Key: value` trailer exactly once at its end; earlier lines with the same key are dropped. */
export function withPullRequestTrailers(body, trailers) {
  if (!trailers?.length) return body;
  const keys = new Set(trailers.map(trailerKey));
  const kept = String(body ?? '').split(/\r?\n/).filter(line => !keys.has(/^\s*([A-Za-z][A-Za-z0-9-]*):/.exec(line)?.[1]));
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return [...kept, ...(kept.length ? [''] : []), ...trailers].join('\n');
}
export function trailerError(trailers) {
  if (trailers === undefined) return null;
  if (!Array.isArray(trailers) || !trailers.length || trailers.some(line => typeof line !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*: [^\r\n]*\S$/.test(line))) return 'runner.delivery.prBodyTrailers must be single "Key: value" lines';
  return new Set(trailers.map(trailerKey)).size === trailers.length ? null : 'runner.delivery.prBodyTrailers keys must be unique';
}
/** A reused PR (opened earlier or by hand) gets the configured trailers; the body is rewritten only when it differs. */
export async function ensurePullRequestTrailers(worktree, repository, number, trailers) {
  if (!trailers?.length) return false;
  const { body } = await ghJson(worktree, repository, ['pr', 'view', String(number), '--json', 'body']);
  const wanted = withPullRequestTrailers(body, trailers);
  if (wanted === body) return false;
  const edited = await gh(worktree, repository, ['pr', 'edit', String(number), '--body', wanted]);
  if (edited.status !== 'PASS') throw ghFailure('gh pr edit', edited);
  return true;
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

function summary(delivery, entries, config, target, waivers = {}) {
  const lines = entries.map(entry => `| \`${entry.sha.slice(0, 7)}\` | ${entry.manifestId} | ${entry.verificationId} | ${waivers[entry.verificationId]?.length ? `PASS with waivers ${waivers[entry.verificationId].map(item => `${item.id} (${item.scene}${item.variant ? `/${item.variant}` : ''} ${item.tier})`).join(', ')}` : 'PASS'} |`);
  const waived = entries.filter(entry => waivers[entry.verificationId]?.length).length;
  return [
    `### ProtoFlow delivery ${delivery.id}${target ? ` — target ${target}` : ''}`,
    '',
    '| Prototype commit | Manifest | Verification | Build / functional / visual |',
    '|---|---|---|---|',
    ...lines,
    '',
    `Acceptance: ${entries.length - waived} passed, ${waived} passed with maintainer waivers (the waived findings are listed in each verification).`,
    delivery.approval?.kind === 'human'
      ? `Approval: **human** by ${delivery.approval.reviewer} (review ${delivery.approval.reviewId}), required because the version passed with maintainer waivers.`
      : delivery.approval?.reviewId
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
  // A single-target project has one stream: naming its own target is the same as naming none.
  if (!isMultiTarget(config) && target) {
    if (target !== config.targets?.[0]?.id) return { status: 'BLOCKED', reason: `Unknown target: ${target}` };
    target = null;
  }
  const branch = deliveryBranch(config, target);
  if (branch === options.baseBranch || ['main', 'master'].includes(branch)) return { status: 'BLOCKED', reason: 'Delivery requires a dedicated branch; never push the base/main branch' };
  try { for (const name of [branch, options.baseBranch]) await git(root, ['check-ref-format', '--branch', name]); }
  catch { return { status: 'BLOCKED', reason: 'Invalid delivery branch/base' }; }
  try { if (options.paths) { if (!Array.isArray(options.paths) || !options.paths.length || new Set(options.paths).size !== options.paths.length) throw new Error('Delivery allowlist must contain unique prefixes'); for (const prefix of options.paths) allowPath(prefix, config); } }
  catch (error) { return { status: 'BLOCKED', reason: error.message }; }
  const invalidTrailers = trailerError(options.prBodyTrailers);
  if (invalidTrailers) return { status: 'BLOCKED', reason: invalidTrailers };
  worktree ??= (await readJson(await projectPath(root, runnerStatePath(config, target)), null))?.worktree;
  if (!worktree) return { status: 'NOT_RUN', reason: 'Runner worktree does not exist yet' };
  const source = await loadProgress(root, config, target);
  const state = await deliveryStatus(root, config, target);
  await reconcileReopenedDeliveries(root, config, target, source, state);
  // Best effort: an unreachable GitHub leaves the PR waiting until the next sync; runner rebase requires the answer.
  try { if (await reconcileManualDeliveries(worktree, config, state)) await saveDelivery(root, config, target, state); }
  catch {}
  try { await retireTaintedDeliveries(root, config, target, worktree, source, state, options); }
  catch (error) { return { status: 'BLOCKED', reason: error.message, retryable: error.transient === true }; }
  // An explicit retry selects the current attempt; `revalidation` lets its fresh PASS replace an existing approval.
  let revalidation = false, previousReview = null;
  if (retryIndependentReview) {
    const { deliveryId, reviewId } = retryIndependentReview;
    const previous = state.deliveries.find(item => item.id === deliveryId);
    if (Object.keys(retryIndependentReview).sort().join(',') !== 'deliveryId,reviewId' || !previous || settled(previous) || previous.independentReviewId !== reviewId) return { status: 'BLOCKED', reason: 'Review retry must explicitly select the current unfinished delivery and review attempt' };
    const record = await readJson(await projectPath(root, `.protoflow/delivery/independent-reviews/${reviewId}.json`), null);
    if (!record || record.id !== reviewId || !['PASS', 'BLOCKED'].includes(record.status)) return { status: 'BLOCKED', reason: 'Review retry requires a recorded PASS or BLOCKED attempt' };
    let verdict;
    try { verdict = await recordedVerdict(root, record); }
    catch (error) { return { status: 'BLOCKED', reason: `Review retry cannot read the recorded verdict: ${error.message}` }; }
    // The reviewer's judgment is final for this delivery: reject and repair instead of asking another session.
    if (isRejectingVerdict(verdict)) return { status: 'BLOCKED', reason: `Independent review ${reviewId} returned ${verdict.status}${verdict.findings?.length ? ` with ${verdict.findings.length} finding(s)` : ''}; a reviewer verdict is never retried. Record a rejection and repair the version` };
    // Published means it left this checkout; an approval alone is local and a fresh review replaces it.
    const published = Boolean(previous.steps?.pushedAt || previous.pr);
    if (record.status === 'PASS') {
      if (!verdict) return { status: 'BLOCKED', reason: 'Recorded PASS has no provider verdict' };
      try { await assertIndependentReview(root, config, reviewId); }
      catch (error) { revalidation = error.code === 'INDEPENDENT_REVIEW_BLOCKED' && error.reasonCode === 'ENGINE_ATTESTATION_MISSING'; }
      if (!revalidation) return { status: 'BLOCKED', reason: 'Only an unattested persisted PASS can be explicitly revalidated; live or changed evidence cannot be retried' };
    } else if (published) {
      // After approval or publication only an infrastructure failure outside the verdict can be retried.
      // Records written before a network signature was classified transient carry only their reason text.
      const transient = (record.retryable === true && record.reasonCode === 'TRANSIENT_INFRASTRUCTURE') || (!isRejectingVerdict(verdict) && transientFailure(record.reason)) || (!verdict && await interruptedProvider(root, record));
      if (!transient) return { status: 'BLOCKED', reason: 'After publication only a review attempt BLOCKED by a transient network failure can be retried' };
      revalidation = true;
    } else if (previous.approval) revalidation = true;
    if (previous.approval && !config.policy?.autoApprove) return { status: 'BLOCKED', reason: 'Revalidating an automated approval requires the current autoApprove policy' };
    previousReview = record;
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
      delivery.discardedHistory = await dropRevokedHistory(worktree, state, base) ?? undefined;
      const changed = (await stageApplication(worktree, config, target)).length > 0;
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
      delivery.acceptance = { commit: delivery.commit, manifestId: last.manifestId, verificationId: last.verificationId, manifestHash: hash(manifest), verificationHash: hash(accepted) };
      delivery.status = 'COMMITTED'; delivery.steps.committedAt = new Date().toISOString();
    } catch (error) {
      // Nothing is linked to the versions, so the next sync repeats this delivery from the same content.
      return { status: 'BLOCKED', step: 'commit', reason: error.message, retryable: error.transient === true, ...(error.code === 'BASE_DIVERGED' && { code: error.code, baseSha: error.baseSha }) };
    }
    for (const entry of pending) entry.deliveryId = delivery.id;
    state.deliveries.push(delivery);
    await saveDelivery(root, config, target, state);
    await saveProgress(root, config, target, source);
  }

  const results = [];
  for (const delivery of state.deliveries.filter(item => !settled(item))) {
    try {
      await assertRevokedPublicationResolved(worktree, config, target, state, delivery);
      const revalidatingDelivery = revalidation && retryIndependentReview?.deliveryId === delivery.id;
      const gateOptions = { worktree, target, commit: delivery.commit, manifestIds: delivery.versions, expectedBaseSha: delivery.baseSha };
      if (!delivery.independentReviewId || retryIndependentReview?.deliveryId === delivery.id) {
        const previousId = delivery.independentReviewId;
        const independent = await requestIndependentReview(root, config, gateOptions);
        delivery.independentReviewAttempts ??= previousId ? [{ id: previousId, status: previousReview?.id === previousId ? previousReview.status : 'BLOCKED' }] : [];
        delivery.independentReviewAttempts.push({ id: independent.id, status: independent.status, createdAt: independent.createdAt, supersedes: previousId ?? null });
        delivery.independentReviewId = independent.id;
        delivery.independentSessionId = independent.sessionId ?? null;
        await saveDelivery(root, config, target, state);
        if (independent.status !== 'PASS') { const error = new Error(independent.reason); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; error.transient = independent.retryable === true; throw error; }
      }
      const independent = await assertIndependentReview(root, config, delivery.independentReviewId, { ...gateOptions, published: 'either' });
      if (delivery.approval && delivery.approval.independentReviewId !== independent.id && !revalidatingDelivery) { const error = new Error('Existing automated approval lacks this independent review; inspect it manually'); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; throw error; }
      if (config.policy?.autoApprove && (!delivery.approval || revalidatingDelivery)) {
        const entries = (await loadProgress(root, config, target)).entries.filter(item => delivery.versions.includes(item.manifestId));
        const entry = entries.find(item => item.manifestId === delivery.versions.at(-1));
        // A version that passed with a maintainer waiver needs a person's approval even under autoApprove.
        const waived = await waivedVersions(root, entries);
        const waiting = waived.filter(item => !item.reviewId);
        if (waiting.length) {
          const error = new Error(`${waiting.map(item => `${item.manifestId} (${item.verificationId}, waivers ${item.waivers.join(', ')})`).join('; ')} passed with maintainer waivers; under policy.autoApprove a person approves ${waiting.length === 1 ? 'it' : 'them'} on the dashboard before the delivery continues`);
          error.code = 'INDEPENDENT_REVIEW_BLOCKED'; error.reasonCode = 'WAIVER_APPROVAL_REQUIRED'; throw error;
        }
        if (delivery.approval) { delivery.approvalHistory ??= []; delivery.approvalHistory.push(delivery.approval); }
        const human = waived.find(item => item.manifestId === entry.manifestId);
        delivery.approval = human
          ? { reviewId: human.reviewId, reviewer: human.reviewer, kind: 'human', independentReviewId: independent.id, waivers: human.waivers }
          : await approve(root, config, worktree, entry, independent);
        if (waived.length) delivery.approval.waivedVersions = waived;
        await saveDelivery(root, config, target, state);
      }
      if (!delivery.steps.pushedAt) {
        const reusable = await assertRevokedPublicationResolved(worktree, config, target, state, delivery);
        const checked = await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: 'either' });
        if (!delivery.pr && reusable) {
          // Save the validated shared-PR identity before push; a later lookup failure cannot lose this association.
          delivery.pr = reusable; await saveDelivery(root, config, target, state);
        }
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
          const created = await gh(worktree, repository, ['pr', 'create', ...(options.draft ? ['--draft'] : []), '--base', options.baseBranch, '--head', branch, '--title', `ProtoFlow delivery: prototype ${delivery.shas.at(-1).slice(0, 7)}`, '--body', withPullRequestTrailers('Automated application delivery from ProtoFlow. Each delivery is summarized in a comment below.', options.prBodyTrailers)]);
          if (created.status !== 'PASS') throw ghFailure('gh pr create', created);
          // Look the new PR up among open PRs: the branch may also have older, merged PRs.
          delivery.pr = (await ghJson(worktree, repository, ['pr', 'list', '--head', branch, '--base', options.baseBranch, '--state', 'open', '--json', 'number,url']))?.[0] ?? null;
          if (!delivery.pr) throw new Error(`gh pr create did not leave an open PR for ${branch}`);
        }
      }
      await assertPullRequestScope(worktree, independent, delivery);
      if (options.prBodyTrailers && !delivery.steps.prBodyAt) {
        await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
        await ensurePullRequestTrailers(worktree, repository, delivery.pr.number, options.prBodyTrailers);
        delivery.steps.prBodyAt = new Date().toISOString(); await saveDelivery(root, config, target, state);
      }
      if (!delivery.steps.commentedAt) {
        const entries = (await loadProgress(root, config, target)).entries.filter(entry => delivery.versions.includes(entry.manifestId));
        await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
        const waivers = {};
        for (const entry of entries) waivers[entry.verificationId] = (await loadArtifact(root, 'verifications', entry.verificationId).catch(() => null))?.waivers ?? [];
        const comment = await gh(worktree, repository, ['pr', 'comment', String(delivery.pr.number), '--body', summary(delivery, entries, config, target, waivers)]);
        if (comment.status !== 'PASS') throw ghFailure('gh pr comment', comment);
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
            if (ready.status !== 'PASS') throw ghFailure('gh pr ready', ready);
            delivery.steps.readyAt = new Date().toISOString(); await saveDelivery(root, config, target, state);
            await assertPullRequestScope(worktree, independent, delivery);
            await assertIndependentReview(root, config, independent.id, { ...gateOptions, published: true });
          }
          const merged = await gh(worktree, repository, ['pr', 'merge', String(delivery.pr.number), '--merge', '--match-head-commit', delivery.commit]);
          if (merged.status !== 'PASS') throw ghFailure('gh pr merge', merged);
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
      delivery.error = null; delete delivery.retryable; delete delivery.reasonCode;
    } catch (error) {
      delivery.status = error.code === 'INDEPENDENT_REVIEW_BLOCKED' ? 'BLOCKED' : 'FAIL'; delivery.error = error.message;
      if (error.reasonCode) delivery.reasonCode = error.reasonCode; else delete delivery.reasonCode;
      // Network/5xx failures are recorded apart from review verdicts and binding drift.
      delivery.retryable = error.transient === true;
    }
    delivery.updatedAt = new Date().toISOString();
    await saveDelivery(root, config, target, state);
    results.push({ id: delivery.id, status: delivery.status, versions: delivery.shas, commit: delivery.commit, pr: delivery.pr?.url ?? null, mergeCommit: delivery.mergeCommit ?? null, error: delivery.error ?? null, ...(delivery.error ? { retryable: delivery.retryable === true, independentReviewId: delivery.independentReviewId ?? null, ...(delivery.reasonCode && { reasonCode: delivery.reasonCode }) } : {}), ...(delivery.alignment ? { alignment: delivery.alignment } : {}) });
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
  await reconcileReopenedDeliveries(root, config, target, source, state);
  const alignment = state.deliveries.find(item => item.status === 'MERGED' && item.alignment?.status === 'BLOCKED');
  if (alignment) throw new Error(`Merged delivery ${alignment.id} requires alignment recovery: ${alignment.alignment.reason}`);
  if (source.entries.some(entry => entry.status === 'PASS' && !entry.deliveryId) || state.deliveries.some(delivery => !settled(delivery))) {
    const result = await syncDeliveries(root, config, { target });
    if (['FAIL', 'BLOCKED'].includes(result.status)) throw Object.assign(new Error(`Delivery is blocked: ${result.reason ?? result.deliveries?.find(item => item.error)?.error}`), result.code === 'BASE_DIVERGED' ? { code: result.code, baseSha: result.baseSha } : {});
  }
}
