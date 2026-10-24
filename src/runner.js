import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createContext, executeContext, executorPlan, executorCommand, verify, loadArtifact, applicationFingerprint, createReview, decideReview } from './workflow.js';
import { versionQueue, REJECTING } from './queue.js';
import { loadVersion } from './versions.js';
import { git, reclassifyVersion, scanSource, sourceStatus, supersedeVersions, validateSource } from './source.js';
import { isMultiTarget, streamTargets, loadProgress, saveProgress, runnerStatePath, worktreeSuffix, progressSummary, sourceView } from './streams.js';
import { assertDelivered, syncDeliveries, deliveryStatus, AUTOMATED_REVIEWER } from './delivery.js';
import { recordedVerdict, isRejectingVerdict, assertIndependentReview, interruptedProvider } from './delivery-review.js';
import { transientFailure } from './delivery-scope.js';
import { snapshot } from './sessions.js';
import { staticContract } from './anchors.js';
import { fingerprint, hash, projectPath, readJson, writeJson, runCommand, withLock, id, processGroupAlive, isSymlinkKey } from './util.js';
import { collectRunnerWorktrees } from './runner-gc.js';
import { planVersion } from './planner.js';
import { syncIssues } from './issues.js';
import { runIssues } from './issue-runner.js';
import { notifyDesktop } from './notify.js';

/**
 * Source progress and runner state; with several targets, one { summary, progress, runner } per target and the source
 * entries' status combined from those targets (see sourceView).
 */
export async function runnerStatus(root, config = null) {
  if (!config || !isMultiTarget(config)) {
    const source = await sourceStatus(root);
    return { ...blockedSummary(source), source, runner: await readJson(await projectPath(root, runnerStatePath(config ?? {}, null)), null) };
  }
  const targets = {};
  for (const stream of streamTargets(config)) {
    const progress = await loadProgress(root, config, stream);
    targets[stream] = { ...blockedSummary(progress), summary: progressSummary(progress), progress, runner: await readJson(await projectPath(root, runnerStatePath(config, stream)), null) };
  }
  const source = await sourceView(root, config, Object.fromEntries(Object.entries(targets).map(([stream, item]) => [stream, item.progress])));
  return { source, targets };
}
/** The blocked current version first, so runner status shows why it waits without reading every attempt. */
function blockedSummary(progress) {
  const current = (progress?.entries ?? []).find(entry => entry.status !== 'PASS');
  if (!current || !['BLOCKED', 'STOPPED'].includes(current.status)) return {};
  return { blocked: { manifestId: current.manifestId, status: current.status, reasonCode: current.reasonCode ?? null, since: current.blockedAt ?? current.attempts?.at(-1)?.completedAt ?? null, reason: errorHead(current.error) } };
}
async function saveRunner(root, runner, statePath) { await writeJson(await projectPath(root, statePath), runner); }
function assertNoActiveProcesses(entry) {
  for (const attempt of entry.attempts ?? []) {
    const children = [...(attempt.processes ?? [])];
    if (attempt.status === 'RUNNING' && !attempt.completedAt && !children.some(child => child.phase === 'execute')) children.push({ phase: 'execute', pid: attempt.pid });
    for (const child of children) {
      if (child.completedAt) continue;
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        const error = new Error(`Runner ${child.phase} launch has unknown PID; inspect possible subprocesses before manual recovery`);
        error.code = 'PROCESS_START_UNKNOWN'; error.phase = child.phase; throw error;
      }
      if (processGroupAlive(child.pgid ?? child.pid)) {
        const error = new Error(`Runner ${child.phase} process group ${child.pid} is still active; stop it and inspect its evidence before retry`);
        error.code = 'PROCESS_GROUP_ACTIVE'; error.phase = child.phase;
        throw error;
      }
    }
  }
}
async function ensureWorktree(root, config, { signal, stream = null } = {}) {
  const statePath = runnerStatePath(config, stream);
  let runner = await readJson(await projectPath(root, statePath), null);
  if (runner && ['INITIALIZING', 'SETUP_FAILED'].includes(runner.status) && !runner.setupCompletedAt && (runner.setupStartedAt || runner.setupPid !== undefined)) {
    if (!Number.isSafeInteger(runner.setupPid) || runner.setupPid <= 0) throw new Error('Runner setup launch has unknown PID; inspect possible subprocesses before manual recovery');
    if (processGroupAlive(runner.setupPgid ?? runner.setupPid)) throw new Error(`Runner setup process group ${runner.setupPid} is still active; stop it and inspect its evidence before recovery`);
  }
  const worktree = await projectPath(root, `.protoflow/runner/worktree-${hash(config.source).slice(0, 12)}${worktreeSuffix(config, stream)}`);
  if (runner && !['INITIALIZING', 'SETUP_FAILED'].includes(runner.status)) {
    if (runner.worktree !== worktree) throw new Error('Runner worktree identity changed');
    const current = (await git(worktree, ['rev-parse', '--show-toplevel'])).trim();
    if (await fs.realpath(current) !== await fs.realpath(worktree)) throw new Error('Runner checkout is not its recorded worktree');
    if (hash(config) !== runner.configHash) throw new Error('Runner config changed; run runner configure after inspecting the failure');
    return runner;
  }
  const base = runner?.base ?? (await git(root, ['rev-parse', `${config.runner?.applicationRef ?? 'HEAD'}^{commit}`])).trim();
  // Committable content only: Git-ignored build output and local files (.env, native builds) are rebuilt by setup, not copied.
  const seed = await fingerprint(root, { exclude: [config.prototypeDir], gitIgnore: true });
  const branch = runner?.branch ?? `protoflow-runner-${id('local').toLowerCase()}`;
  runner = { schemaVersion: 1, worktree, branch, base, configHash: hash(config), seedHash: seed.hash, status: 'INITIALIZING', afterMergeAlignment: true, createdAt: new Date().toISOString() };
  await saveRunner(root, runner, statePath);
  try { await fs.access(path.join(worktree, '.git')); }
  catch { await git(root, ['worktree', 'add', '-b', branch, worktree, base]); }
  // Preserve the user's dirty index and files: copy the current content into an isolated checkout.
  for (const relative of Object.keys(seed.files).filter(file => !isSymlinkKey(file))) {
    const source = await projectPath(root, relative);
    const target = await projectPath(worktree, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    await fs.chmod(target, (await fs.stat(source)).mode);
  }
  // Reflect deleted tracked files as well, without touching the primary checkout.
  const tracked = (await git(worktree, ['ls-files', '-z'])).split('\0').filter(Boolean);
  for (const relative of tracked) {
    if (relative === config.prototypeDir || relative.startsWith(`${config.prototypeDir}/`)) continue;
    // A symlink leaving the project is recorded as `<path>:link` and comes with the checkout; it is not a deletion.
    if (!(relative in seed.files) && !(`${relative}:link` in seed.files)) await fs.rm(await projectPath(worktree, relative), { force: true });
  }
  await fs.mkdir(await projectPath(worktree, config.prototypeDir), { recursive: true });
  if (config.runner?.setup) {
    const result = await runCommand(worktree, config.runner.setup, null, {
      signal, onBeforeSpawn: async () => {
        runner.setupStatus = 'STARTING'; runner.setupStartedAt = new Date().toISOString();
        runner.setupPid = null; runner.setupPgid = null; runner.setupSpawned = null; runner.setupCompletedAt = null;
        await saveRunner(root, runner, statePath);
      },
      onStart: async pid => { runner.setupStatus = 'RUNNING'; runner.setupPid = pid; runner.setupPgid = pid; runner.setupSpawned = true; await saveRunner(root, runner, statePath); }
    });
    runner.setup = result; runner.setupStatus = result.status; runner.setupSpawned = result.spawned;
    if (!result.processGroupActive) runner.setupCompletedAt = new Date().toISOString();
    if (result.processGroupActive || result.status !== 'PASS') { runner.status = 'SETUP_FAILED'; await saveRunner(root, runner, statePath); throw new Error(`Runner setup failed: ${result.stderr || result.error}`); }
  }
  runner.status = 'IDLE'; await saveRunner(root, runner, statePath);
  return runner;
}
/**
 * A rebuilt runner worktree starts from committed content only, so it lacks the verifications that accepted earlier
 * versions. Without them its queue would treat those versions as unaccepted: an old rejection could reopen a version
 * that was already repaired and delivered, and the next version would not be current. Each PASS entry's accepted
 * verification is copied back from the project, where exportEvidence keeps it.
 */
async function shareAcceptedEvidence(root, worktree, state) {
  for (const entry of state.entries) {
    if (entry.status !== 'PASS' || !/^VER-[A-Za-z0-9-]+$/.test(entry.verificationId ?? '')) continue;
    const target = await projectPath(worktree, `.protoflow/verifications/${entry.verificationId}.json`);
    if (await readJson(target, null)) continue;
    const report = await readJson(await projectPath(root, `.protoflow/verifications/${entry.verificationId}.json`), null);
    if (report?.id === entry.verificationId && report.manifestId === entry.manifestId) await writeJson(target, report);
  }
}
async function syncCheckpoints(root, worktree, state, config) {
  await shareAcceptedEvidence(root, worktree, state);
  for (const entry of state.entries) {
    const manifest = await loadArtifact(root, 'manifests', entry.manifestId);
    await loadVersion(root, config, manifest);
    const target = await projectPath(worktree, `.protoflow/manifests/${entry.manifestId}.json`);
    const existing = await readJson(target, null);
    if (existing && hash(existing) !== hash(manifest)) throw new Error('Runner manifest changed');
    if (!existing) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(await projectPath(root, `.protoflow/versions/${entry.manifestId}`), await projectPath(worktree, `.protoflow/versions/${entry.manifestId}`), { recursive: true });
      await writeJson(target, manifest);
    }
  }
}
export async function exportEvidence(root, worktree, report) {
  for (const [relative, expected] of Object.entries(report.artifactHashes)) {
    const source = await projectPath(worktree, relative);
    if (hash(await fs.readFile(source)) !== expected) throw new Error(`Verification artifact changed: ${relative}`);
    const target = await projectPath(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
  }
  // Export the exact record: the independent review binds this main-root copy and its reviewer reads the worktree copy.
  // The worktree is recorded in runner state, never inside the VER.
  await writeJson(await projectPath(root, `.protoflow/verifications/${report.id}.json`), report);
}

/** Copy decided rejections (and their model evidence) between the project and the runner worktree so both queues agree. */
async function shareRejections(root, worktree) {
  const list = async base => {
    const directory = await projectPath(base, '.protoflow/reviews');
    try { return (await fs.readdir(directory)).filter(name => /^[a-zA-Z0-9_.-]+\.json$/.test(name)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  for (const [from, to] of [[root, worktree], [worktree, root]]) {
    const existing = new Set(await list(to));
    for (const name of await list(from)) {
      if (existing.has(name)) continue;
      const review = await readJson(await projectPath(from, `.protoflow/reviews/${name}`));
      if (!REJECTING.includes(review.status) || !review.reviewedAt) continue;
      if (review.model?.path) {
        const target = await projectPath(to, review.model.path);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(await projectPath(from, review.model.path), target);
      }
      await writeJson(await projectPath(to, `.protoflow/reviews/${name}`), review);
    }
  }
}
/**
 * A rejection recorded after a version passed reopens it for this stream: its PASS entry returns to PENDING and the
 * previous verification, delivery and completion are kept in `reopenings`. Other targets' progress is not touched.
 */
/** A verification as recorded in the runner worktree or exported to the project. */
async function recordedVerification(root, worktree, id) {
  for (const base of [worktree, root].filter(Boolean)) {
    const found = await readJson(await projectPath(base, `.protoflow/verifications/${id}.json`), null);
    if (found) return found;
  }
  return null;
}
async function reopenRejected(root, config, stream) {
  const worktree = (await readJson(await projectPath(root, runnerStatePath(config, stream)), null))?.worktree ?? null;
  if (worktree) await shareRejections(root, worktree);
  const state = await loadProgress(root, config, stream);
  if (worktree) await shareAcceptedEvidence(root, worktree, state);
  const queue = await versionQueue(worktree ?? root, config, { target: stream ?? undefined });
  const reopened = [];
  for (const entry of state.entries) {
    if (entry.status !== 'PASS') continue;
    const version = queue.versions.find(item => item.id === entry.manifestId);
    if (!version || version.acceptedBy || !version.rejections?.length) continue;
    // A rejection reopens the verification it judged, or one made before it. When the entry already records a newer
    // PASS (the repair after that rejection), the old rejection is spent: a rebuilt runner worktree that lacks the newer
    // verification must not send an accepted, delivered version back.
    const recorded = /^VER-[A-Za-z0-9-]+$/.test(entry.verificationId ?? '') ? await recordedVerification(root, worktree, entry.verificationId) : null;
    if (recorded && !version.rejections.some(rejection => rejection.verificationId === recorded.id || !(recorded.createdAt > rejection.at))) continue;
    entry.reopenings = [...(entry.reopenings ?? []), { at: new Date().toISOString(), previousStatus: entry.status, verificationId: entry.verificationId ?? null, deliveryId: entry.deliveryId ?? null, completedAt: entry.completedAt ?? null, rejections: version.rejections }];
    Object.assign(entry, { status: 'PENDING', verificationId: null, deliveryId: null, completedAt: null, error: null });
    reopened.push(entry.manifestId);
  }
  if (!reopened.length) return reopened;
  const open = state.entries.findIndex(entry => entry.status !== 'PASS');
  state.completedSha = open > 0 ? state.entries[open - 1].sha : null;
  await saveProgress(root, config, stream, state);
  return reopened;
}

/** Provider-side failures that say nothing about the version: capacity, rate limits, 5xx, a dropped connection. */
/** The executor provider has no capacity for us right now; with a fallback configured, the other executor takes over. */
export const EXECUTOR_QUOTA = /usage limit|rate.?limit|quota|credit balance|overloaded|\b(?:429|529)\b|too many requests|model is at capacity/i;
export const TRANSIENT_PROVIDER = /model is at capacity|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service unavailable|overloaded|temporarily unavailable|stream disconnected/i;
/**
 * An execution that failed because of the machine, not the version: an expired or missing login, or a network that
 * cannot be reached at all (DNS, refused connection, proxy tunnel). Another repair attempt cannot fix either, so the
 * version blocks at once with reasonCode `environment` instead of using up maxRepairAttempts.
 */
export const EXECUTOR_ENVIRONMENT = /OAuth|session expired|not logged in|log ?in again|please run \/login|Failed to authenticate|authentication (?:failed|required)|invalid (?:x-)?api[ -]?key|\b401\b|Unauthorized|Could not resolve host|Temporary failure in name resolution|getaddrinfo|network is unreachable|CONNECT tunnel failed|\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b/i;
/** What a verification failed on: one key per failing check, build variant or scene. */
export function failureKeys(report) {
  const keys = ['build', 'functional', 'hygiene'].filter(section => report?.[section]?.status && report[section].status !== 'PASS');
  for (const [name, result] of Object.entries(report?.build?.variants ?? {})) if (result?.status !== 'PASS') keys.push(`build:${name}`);
  const scenes = (report?.visual?.scenes ?? []).filter(scene => scene.status !== 'PASS').map(scene => `scene:${scene.variant ? `${scene.variant}/` : ''}${scene.id}`);
  keys.push(...scenes);
  if (report?.visual?.status && report.visual.status !== 'PASS' && !scenes.length) keys.push('visual');
  if (report?.changedDuringVerification) keys.push('changedDuringVerification');
  return keys;
}
/**
 * A repair round makes progress only when it fails fewer checks than the round before. Equal counts, a superset and a
 * same-size swap (one fixed, another broken) all count as no progress; after policy.stallRounds such rounds in a row
 * (default 2, 0 turns it off) the version blocks with reasonCode `stalled`, so the remaining attempts are not spent on
 * an executor that keeps failing the same way.
 */
export function stalledRounds(counts) {
  let rounds = 0;
  for (let index = counts.length - 1; index > 0 && counts[index] >= counts[index - 1]; index--) rounds++;
  return rounds;
}
const failure = (message, reasonCode, detail) => Object.assign(new Error(message), { reasonCode, ...(detail && { detail }) });
/** The first lines of a raw error, for runner status and the dashboard. */
export const errorHead = text => String(text ?? '').split('\n').map(line => line.trimEnd()).filter(Boolean).slice(0, 5).join('\n').slice(0, 800);
export function executionDiagnostic(execution) {
  let diagnostic = execution.result.error;
  for (const line of execution.result.stdout.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.failed' || event.type === 'error') diagnostic = event.error?.message ?? event.message;
      // Claude stream-json ends with one result event; a failed one carries the reason.
      if (event.type === 'result' && (event.is_error || event.subtype !== 'success')) diagnostic = String(event.result ?? event.subtype);
    } catch { /* retain execution evidence */ }
  }
  return String(diagnostic || execution.result.stderr || '');
}
export const MAX_AUTOMATED_REOPENINGS = 3;
const MAX_REVIEW_ATTEMPTS = 6;
/**
 * Under policy.autoApprove the runner settles a blocked delivery the way an operator would, without weakening a gate:
 * a reviewer FAIL with findings becomes the decided model rejection of the accepted verification, so the version reopens
 * for repair (status REOPENED; its findings are claims the executor checks against evidence); a review that lost its in-process
 * attestation on a restart, or was BLOCKED by a transient failure, gets a fresh provider review. A verdict is never
 * re-rolled; NOT_RUN, a version rejected MAX_AUTOMATED_REOPENINGS times and every other block stay for a person.
 */
async function automateBlockedDelivery(root, config, stream, runner, { onEvent }) {
  if (!config.policy?.autoApprove || !config.runner?.delivery || !runner?.worktree) return null;
  const state = await deliveryStatus(root, config, stream);
  const delivery = state.deliveries.filter(item => !['MERGED', 'PR_OPEN_MANUAL', 'REVOKED'].includes(item.status) && item.independentReviewId).at(-1);
  if (!delivery) return null;
  const record = await readJson(await projectPath(root, `.protoflow/delivery/independent-reviews/${delivery.independentReviewId}.json`), null);
  if (!record) return null;
  let verdict;
  try { verdict = await recordedVerdict(root, record); } catch { return null; }
  if (verdict?.status === 'FAIL' && verdict.findings?.length) return rejectAutomatically(root, config, stream, runner, delivery, record, verdict, { onEvent });
  if (isRejectingVerdict(verdict)) return null;
  let retry = false;
  if (record.status === 'PASS') {
    try { await assertIndependentReview(root, config, record.id); }
    catch (error) { retry = error.reasonCode === 'ENGINE_ATTESTATION_MISSING'; }
  } else {
    // The budget counts reviews the provider actually ran; a network failure before the provider costs nothing and
    // the runner's own cadence spaces those retries.
    let ran = 0;
    for (const attempt of delivery.independentReviewAttempts ?? [{ id: record.id }]) {
      const previous = await readJson(await projectPath(root, `.protoflow/delivery/independent-reviews/${attempt.id}.json`), null);
      if (previous?.processFile) ran += 1;
    }
    retry = transientReviewBlock(record, verdict, ran) || (!verdict && ran < MAX_REVIEW_ATTEMPTS && await interruptedProvider(root, record));
  }
  if (!retry) return null;
  await onEvent({ event: 'review-retry', deliveryId: delivery.id, reviewId: record.id, reason: record.status === 'PASS' ? 'attestation lost on restart' : record.reason });
  const result = await syncDeliveries(root, config, { worktree: runner.worktree, target: stream, retryIndependentReview: { deliveryId: delivery.id, reviewId: record.id } });
  await onEvent({ event: 'delivered', automated: 'review-retry', ...result });
  return { status: result.status === 'PASS' ? 'PASS' : 'BLOCKED', reason: result.reason ?? result.deliveries?.find(item => item.error)?.error, delivery: result };
}
/**
 * A review attempt BLOCKED by the network without a rejecting verdict, within the budget of provider runs. Records written
 * before a network signature was classified transient carry only their reason text, so that is checked as well.
 */
export function transientReviewBlock(record, verdict, attempts) {
  // A PASS without findings may be re-reviewed after a network failure; FAIL, NOT_RUN or a finding never is.
  if (record?.status !== 'BLOCKED' || isRejectingVerdict(verdict)) return false;
  const transient = (record.retryable === true && record.reasonCode === 'TRANSIENT_INFRASTRUCTURE') || transientFailure(record.reason);
  return transient && attempts < MAX_REVIEW_ATTEMPTS;
}
async function rejectAutomatically(root, config, stream, runner, delivery, record, verdict, { onEvent }) {
  const progress = await loadProgress(root, config, stream);
  const entry = progress.entries.find(item => item.manifestId === delivery.versions.at(-1));
  if (!entry?.verificationId) return null;
  const reopened = entry.reopenings?.length ?? 0;
  if (reopened >= MAX_AUTOMATED_REOPENINGS) return { status: 'BLOCKED', reason: `Independent review ${record.id} FAIL; version ${entry.manifestId} was already reopened ${reopened} times, so a person decides on further rejections` };
  const verification = await loadArtifact(runner.worktree, 'verifications', entry.verificationId);
  const evidence = `.protoflow/delivery/automated-rejections/${record.id}.json`;
  await writeJson(await projectPath(runner.worktree, evidence), {
    kind: 'independent-model-review', status: 'FAIL', reviewExecuted: true, sessionId: record.sessionId, independentReviewId: record.id, traceHash: record.traceHash ?? null,
    verificationId: entry.verificationId, verificationHash: hash(verification), manifestId: entry.manifestId, ...(verification.target && { target: verification.target }),
    applicationHash: verification.project.hash, findings: verdict.findings, summary: verdict.summary, completedAt: record.completedAt ?? record.createdAt
  });
  const review = await createReview(runner.worktree, config, entry.manifestId, entry.verificationId);
  const decided = await decideReview(runner.worktree, config, review.id, {
    status: 'changes_requested', reviewer: `${AUTOMATED_REVIEWER}:${record.sessionId}`, reviewerKind: 'model', model: { evidence, session: record.sessionId },
    notes: `Automated rejection of independent AI review ${record.id} under policy.autoApprove; findings are claims to check against the evidence.`
  });
  await onEvent({ event: 'auto-rejected', deliveryId: delivery.id, reviewId: record.id, rejection: decided.id, findings: verdict.findings.length });
  // Progress, not a block: the next pass reopens the version, so a single-target runner must not stop here.
  return { status: 'REOPENED', reason: `Independent review ${record.id} FAIL; recorded automated rejection ${decided.id}, the version reopens for repair`, rejection: decided.id };
}
/** Durable launch intent, PID and completion of each child process of an attempt. */
function processHooks(root, config, stream, state, record) {
  const processStarting = async phase => {
    record.processes.push({ phase, pid: null, pgid: null, spawned: null, status: 'STARTING', startedAt: new Date().toISOString() });
    await saveProgress(root, config, stream, state);
  };
  const processStarted = async (phase, pid) => {
    const child = record.processes.find(item => item.phase === phase && item.status === 'STARTING' && !item.completedAt);
    if (!child) throw new Error(`Missing ${phase} launch intent`);
    child.pid = pid; child.pgid = pid; child.spawned = true; child.status = 'RUNNING';
    await saveProgress(root, config, stream, state);
  };
  const processFinished = async (phase, pid, result) => {
    const child = record.processes.find(item => item.phase === phase && item.pid === (pid ?? null) && !item.completedAt);
    if (child) {
      if (!result.processGroupActive) child.completedAt = new Date().toISOString();
      child.status = result.status; child.spawned = result.spawned ?? child.spawned; child.error = result.error ?? null; child.processGroupActive = result.processGroupActive ?? false;
    }
    await saveProgress(root, config, stream, state);
  };
  return { processStarting, processStarted, processFinished };
}
/**
 * A sibling target merged changes to files this target verified (a shared top-level file) after this target's worktree
 * forked. Merge that base into the worktree and verify the accepted version again on it; only a PASS on the merged
 * content may be delivered. A conflict or a failing verification blocks for repair.
 */
export async function reverifyOnBase(root, config, stream, runner, state, divergence, { signal, onEvent = () => {}, verifyVersion = verify } = {}) {
  const entry = state.entries.filter(item => item.status === 'PASS' && !item.deliveryId).at(-1);
  if (!entry) return null;
  const statePath = runnerStatePath(config, stream), base = divergence.baseSha;
  const blocked = async reason => {
    entry.status = 'BLOCKED'; entry.error = reason; entry.blockedAt = new Date().toISOString(); runner.status = 'BLOCKED';
    await saveProgress(root, config, stream, state); await saveRunner(root, runner, statePath);
    await onEvent({ event: 'blocked', sha: entry.sha, manifestId: entry.manifestId, reasonCode: null, reason: errorHead(reason) });
    return { status: 'BLOCKED', manifestId: entry.manifestId, sha: entry.sha, reason };
  };
  try { await git(runner.worktree, ['merge', '--no-ff', '--no-edit', '-m', `ProtoFlow: integrate ${base.slice(0, 7)} into target ${stream} for reverification`, base]); }
  catch (error) {
    try { await git(runner.worktree, ['merge', '--abort']); } catch { /* nothing to abort */ }
    return blocked(`Base ${base} does not merge cleanly into target ${stream}; resolve the merge in the runner worktree, then runner retry: ${String(error.stderr || error.message).trim().slice(-500)}`);
  }
  const record = { attempt: entry.attempts.length, reverify: { baseSha: base, previousVerificationId: entry.verificationId }, startedAt: new Date().toISOString(), status: 'RUNNING', processes: [] };
  entry.attempts.push(record); await saveProgress(root, config, stream, state);
  await onEvent({ event: 'reverify', sha: entry.sha, manifestId: entry.manifestId, baseSha: base });
  const hooks = processHooks(root, config, stream, state, record);
  let report;
  try { report = await verifyVersion(runner.worktree, config, entry.manifestId, { target: stream ?? undefined, reverify: true, signal, onBeforeSpawn: hooks.processStarting, onStart: hooks.processStarted, onFinish: hooks.processFinished }); }
  catch (error) { record.status = 'FAIL'; record.completedAt = new Date().toISOString(); record.error = error.message; return blocked(`Reverification on base ${base.slice(0, 7)} failed: ${error.message}`); }
  record.verificationId = report.id; record.status = report.status; record.completedAt = new Date().toISOString();
  await onEvent({ event: 'verified', sha: entry.sha, manifestId: entry.manifestId, verificationId: report.id, status: report.status, reverify: true });
  if (report.status !== 'PASS') return blocked(`Reverification on base ${base.slice(0, 7)} is ${report.status} (${report.id}); the merged base changes this target's accepted result and needs a repair`);
  await exportEvidence(root, runner.worktree, report);
  entry.verificationId = report.id; await saveProgress(root, config, stream, state);
  const delivery = await syncDeliveries(root, config, { worktree: runner.worktree, target: stream });
  await onEvent({ event: 'delivered', sha: entry.sha, reverified: true, ...delivery });
  return { status: delivery.status === 'PASS' ? 'PASS' : 'BLOCKED', manifestId: entry.manifestId, sha: entry.sha, verificationId: report.id, reverified: true, delivery };
}

/** One source stream, one isolated application worktree, one bounded FIFO executor. No implicit commits or approval. */
export async function runOnce(root, config, { signal, onEvent = () => {}, target: stream = null } = {}) {
  if (config.policy?.sequentialVersions === false) throw new Error('Git runner requires sequentialVersions');
  if (signal?.aborted) return { status: 'STOPPED' };
  const statePath = runnerStatePath(config, stream);
  const target = stream ?? undefined;
  // Rejected versions reopen before delivery, so a rejected PASS is never committed or counted as done.
  let reopened;
  try { reopened = await reopenRejected(root, config, stream); }
  catch (error) { return { status: 'BLOCKED', reason: `Review reconciliation failed: ${error.message}` }; }
  if (reopened.length) await onEvent({ event: 'reopened', versions: reopened });
  // Reconcile revoked delivery history, then commit earlier accepted versions so every commit holds its own version.
  let diverged = null;
  try { await assertDelivered(root, config, stream); }
  catch (error) {
    if (error.code !== 'BASE_DIVERGED') {
      const automated = await automateBlockedDelivery(root, config, stream, await readJson(await projectPath(root, statePath), null), { onEvent })
        .catch(failure => ({ status: 'BLOCKED', reason: `${error.message}; automated recovery failed: ${failure.message}` }));
      return automated ?? { status: 'BLOCKED', reason: error.message };
    }
    diverged = { code: error.code, baseSha: error.baseSha, reason: error.message };
  }
  const state = await loadProgress(root, config, stream);
  if (diverged) {
    const runner = await readJson(await projectPath(root, statePath), null);
    if (!runner?.worktree) return { status: 'BLOCKED', reason: diverged.reason };
    return await reverifyOnBase(root, config, stream, runner, state, diverged, { signal, onEvent }) ?? { status: 'BLOCKED', reason: diverged.reason };
  }
  if (state.status === 'HISTORY_REWRITTEN') throw new Error(state.error);
  if (!state.entries.length) return { status: 'IDLE', reason: 'No scanned checkpoints' };
  const entry = state.entries.find(item => item.status !== 'PASS');
  // Old unfinished browser/process rows must block setup and PASS reconciliation too.
  try { for (const previous of state.entries) assertNoActiveProcesses(previous); }
  catch (error) {
    if (entry) { entry.status = 'BLOCKED'; entry.error = error.message; await saveProgress(root, config, stream, state); }
    return { status: 'BLOCKED', manifestId: entry?.manifestId, sha: entry?.sha, reason: error.message };
  }
  if (!entry) {
    // A crash can save source PASS just before the runner's final state write.
    const runner = await readJson(await projectPath(root, statePath), null);
    if (runner?.status === 'RUNNING') {
      runner.status = 'IDLE'; runner.current = null; await saveRunner(root, runner, statePath);
    }
    // Retry pending pushes, pull requests and merges while idle.
    const delivery = runner?.worktree ? await syncDeliveries(root, config, { worktree: runner.worktree, target: stream }) : undefined;
    if (delivery?.code === 'BASE_DIVERGED') return await reverifyOnBase(root, config, stream, runner, state, delivery, { signal, onEvent }) ?? { status: 'BLOCKED', reason: delivery.reason };
    return { status: 'IDLE', completedSha: state.completedSha, ...(delivery && { delivery }) };
  }
  if (['BLOCKED', 'STOPPED', 'RUNNING'].includes(entry.status)) return { status: 'BLOCKED', manifestId: entry.manifestId, reason: entry.status === 'RUNNING' ? 'Interrupted execution; inspect evidence and run runner retry' : entry.error };
  if (!executorCommand(config, executorPlan(config).primary)) return { status: 'NOT_RUN', reason: `The ${executorPlan(config).primary} executor adapter is not configured` };
  let runner;
  try { runner = await ensureWorktree(root, config, { signal, stream }); }
  catch (error) { if (signal?.aborted) return { status: 'STOPPED', reason: error.message }; throw error; }
  if (signal?.aborted) return { status: 'STOPPED' };
  if (runner.status === 'SETUP_FAILED' || runner.status === 'INITIALIZING') throw new Error(`Runner requires initialization recovery: ${runner.status}`);
  await syncCheckpoints(root, runner.worktree, state, config);
  const queue = await versionQueue(runner.worktree, config, { target });
  // Reconcile a crash after independent verification passed but before source progress was saved.
  const version = queue.versions.find(item => item.id === entry.manifestId);
  if (version?.acceptedBy) {
    const report = await loadArtifact(runner.worktree, 'verifications', version.acceptedBy);
    if (report.project.hash !== (await applicationFingerprint(runner.worktree, config, target)).hash) throw new Error('Interrupted PASS evidence has stale application content');
    await loadVersion(runner.worktree, config, await loadArtifact(root, 'manifests', entry.manifestId));
    await exportEvidence(root, runner.worktree, report);
    entry.status = 'PASS'; entry.verificationId = report.id; entry.completedAt = new Date().toISOString(); entry.error = null;
    state.completedSha = entry.sha; runner.status = 'IDLE'; runner.current = null;
    await saveProgress(root, config, stream, state); await saveRunner(root, runner, statePath);
    const delivery = await syncDeliveries(root, config, { worktree: runner.worktree, target: stream });
    return { status: 'PASS', manifestId: entry.manifestId, sha: entry.sha, verificationId: report.id, recovered: true, delivery };
  }
  if (queue.current?.id !== entry.manifestId) throw new Error(`Runner queue mismatch: expected ${entry.manifestId}, got ${queue.current?.id}`);
  entry.status = 'RUNNING'; entry.startedAt = new Date().toISOString();
  runner.status = 'RUNNING'; runner.current = entry.manifestId;
  await saveProgress(root, config, stream, state); await saveRunner(root, runner, statePath);
  let report = null, currentAttempt = null, executionFailure = null;
  try {
    const maximum = config.policy?.maxRepairAttempts ?? 3;
    // Proposal 0003: Claude plans the version first; a planner that cannot answer leaves the version unplanned.
    let plan = null;
    if (config.adapters?.planner?.command) {
      const planning = await createContext(runner.worktree, config, entry.manifestId, { spec: config.runner?.spec, adr: config.runner?.adr, target });
      // A version that runs again (blocked, reopened by a rejection) is replanned with its earlier plan as evidence.
      const earlier = entry.planId && /^PLN-[A-Za-z0-9-]+$/.test(entry.planId) ? await readJson(await projectPath(runner.worktree, `.protoflow/plans/${entry.planId}.json`), null) : null;
      const previous = earlier ? { id: earlier.id, summary: earlier.plan.summary, steps: earlier.plan.steps, acceptanceCriteria: earlier.plan.acceptanceCriteria, attempts: entry.attempts.length, lastError: (entry.error ?? entry.retries?.at(-1)?.reason ?? null)?.slice(0, 1000) ?? null } : null;
      try { plan = await planVersion(runner.worktree, config, planning, { previous, signal }); }
      catch (error) {
        if (!error.planner) throw error;
        entry.planError = { reason: error.message.slice(0, 500), reasonCode: error.reasonCode, at: new Date().toISOString() };
        await saveProgress(root, config, stream, state);
        await onEvent({ event: 'plan-failed', sha: entry.sha, manifestId: entry.manifestId, reason: error.message.slice(0, 200) });
      }
      if (plan) {
        entry.planId = plan.id; await saveProgress(root, config, stream, state);
        await onEvent({ event: 'planned', sha: entry.sha, manifestId: entry.manifestId, planId: plan.id, decision: plan.plan.decision, criteria: plan.plan.acceptanceCriteria.length, costUsd: plan.costUsd });
        if (plan.plan.decision === 'needs-human') throw failure(`Planner ${plan.id} needs a person: ${plan.plan.summary}${plan.plan.questions.length ? ` Questions: ${plan.plan.questions.join(' ')}` : ''}`, 'needs-human');
      }
    }
    const stallRounds = config.policy?.stallRounds ?? 2, failureCounts = [];
    for (let attempt = 0; attempt <= maximum; attempt++) {
      if (signal?.aborted) throw new Error('STOPPED: runner was interrupted');
      assertNoActiveProcesses(entry);
      const context = await createContext(runner.worktree, config, entry.manifestId, { spec: config.runner?.spec, adr: config.runner?.adr, target, plan });
      const record = { attempt, contextId: context.id, startedAt: new Date().toISOString(), status: 'RUNNING', processes: [] };
      currentAttempt = record;
      entry.attempts.push(record); await saveProgress(root, config, stream, state);
      await onEvent({ event: attempt ? 'repair' : 'execute', sha: entry.sha, manifestId: entry.manifestId, attempt, worktree: runner.worktree });
      const { processStarting, processStarted, processFinished } = processHooks(root, config, stream, state, record);

      // Provider capacity, rate limits and 5xx responses are not the version's fault: retry the attempt after a backoff.
      const retries = config.policy?.transientRetries ?? 3, retryDelayMs = config.policy?.transientRetryDelayMs ?? 60000;
      let execution, diagnostic = '', executionContext = context;
      const executors = executorPlan(config);
      let provider = executors.primary;
      for (let retry = 0; ; retry++) {
        execution = await executeContext(runner.worktree, config, executionContext.id, {
          provider, execute: true, repair: attempt ? { attempt, verification: report, ...(executionFailure && { execution: executionFailure }) } : null, signal,
          onBeforeSpawn: () => processStarting('execute'),
          onStart: async pid => { record.pid = pid; await processStarted('execute', pid); }
        });
        record.executionId = execution.id; record.executionStatus = execution.status;
        await processFinished('execute', record.pid, { ...execution.result, status: execution.status });
        await reapLeftovers(root, runner.worktree, record, 'execute', onEvent);
        if (execution.result.processGroupActive) {
          const error = new Error('Executor subprocess group remains active; stop it before verification or repair');
          error.code = 'PROCESS_GROUP_ACTIVE'; error.phase = 'execute'; error.result = execution.result;
          throw error;
        }
        await saveProgress(root, config, stream, state);
        if (signal?.aborted) throw new Error('STOPPED: runner was interrupted');
        record.executor = provider;
        if (execution.status === 'PASS') break;
        diagnostic = executionDiagnostic(execution);
        // The primary executor has no capacity for us (quota, rate limit): the fallback redoes this attempt, once.
        if (provider === executors.primary && executors.fallback && executorCommand(config, executors.fallback) && EXECUTOR_QUOTA.test(diagnostic)) {
          record.executorFallback = { from: provider, to: executors.fallback, executionId: execution.id, reason: diagnostic.slice(-300), at: new Date().toISOString() };
          provider = executors.fallback;
          await saveProgress(root, config, stream, state);
          await onEvent({ event: 'executor-fallback', sha: entry.sha, manifestId: entry.manifestId, attempt, from: record.executorFallback.from, to: provider, reason: diagnostic.slice(-200) });
          executionContext = await createContext(runner.worktree, config, entry.manifestId, { spec: config.runner?.spec, adr: config.runner?.adr, target, plan });
          record.contextId = executionContext.id; retry -= 1;
          continue;
        }
        if (!execution.result.timedOut && EXECUTOR_ENVIRONMENT.test(diagnostic.slice(-2000))) {
          record.status = 'FAIL'; record.completedAt = new Date().toISOString(); record.reasonCode = 'environment';
          throw failure(`${provider === 'claude' ? 'Claude' : 'Codex'} execution cannot run in this environment (${execution.id}, exit ${execution.result.exitCode}); fix the login or network, then runner retry: ${diagnostic.slice(-1000)}`, 'environment', diagnostic);
        }
        if (retry >= retries || !TRANSIENT_PROVIDER.test(diagnostic)) break;
        record.transientRetries = [...(record.transientRetries ?? []), { executionId: execution.id, reason: diagnostic.slice(-300), at: new Date().toISOString() }];
        await saveProgress(root, config, stream, state);
        await onEvent({ event: 'execute-retry', sha: entry.sha, manifestId: entry.manifestId, attempt, retry: retry + 1, reason: diagnostic.slice(-200) });
        try { await delay(retryDelayMs * 2 ** retry, undefined, { signal }); }
        catch { throw new Error('STOPPED: runner was interrupted'); }
        // The failed run may have edited files; a fresh context binds the current application content.
        executionContext = await createContext(runner.worktree, config, entry.manifestId, { spec: config.runner?.spec, adr: config.runner?.adr, target, plan });
        record.contextId = executionContext.id;
      }
      if (execution.status !== 'PASS') {
        const reason = `${provider === 'claude' ? 'Claude' : 'Codex'} execution ${execution.status} (${execution.id}, exit ${execution.result.exitCode}${execution.result.timedOut ? ', timed out' : ''}): ${(diagnostic || 'see execution evidence').slice(-1000)}`;
        if (attempt >= maximum) throw failure(reason, 'execution', diagnostic);
        // A failed or timed-out run is one bounded attempt; the next one is told why, like a failed verification.
        record.status = 'FAIL'; record.completedAt = new Date().toISOString(); record.error = reason;
        executionFailure = { attempt, executionId: execution.id, exitCode: execution.result.exitCode, timedOut: execution.result.timedOut === true, reason };
        await saveProgress(root, config, stream, state);
        await onEvent({ event: 'execute-failed', sha: entry.sha, manifestId: entry.manifestId, attempt, reason: reason.slice(0, 300) });
        continue;
      }
      executionFailure = null;
      report = await verify(runner.worktree, config, entry.manifestId, { target, signal, onBeforeSpawn: processStarting, onStart: processStarted, onFinish: processFinished });
      record.verificationId = report.id; record.status = report.status; record.completedAt = new Date().toISOString();
      const failed = failureKeys(report);
      record.failures = { count: failed.length, keys: failed.slice(0, 100) };
      await reapLeftovers(root, runner.worktree, record, 'verify', onEvent);
      await saveProgress(root, config, stream, state);
      await onEvent({ event: 'verified', sha: entry.sha, manifestId: entry.manifestId, verificationId: report.id, status: report.status });
      if (signal?.aborted) throw new Error('STOPPED: runner was interrupted');
      if (report.status === 'PASS') break;
      if (report.status === 'NOT_RUN') throw failure('Verification NOT_RUN; configure all checks before retry', 'not-run');
      failureCounts.push(failed.length);
      const rounds = stalledRounds(failureCounts);
      if (stallRounds > 0 && rounds >= stallRounds && attempt < maximum) {
        throw failure(`Repair made no progress: ${rounds} rounds in a row did not reduce the failures (${failureCounts.slice(-rounds - 1).join(' → ')}); ${report.id} still fails ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? ` and ${failed.length - 8} more` : ''}`, 'stalled');
      }
    }
    if (report?.status !== 'PASS') throw failure(`Repair limit exhausted (${config.policy?.maxRepairAttempts ?? 3})`, 'repair-limit');
    await exportEvidence(root, runner.worktree, report);
    entry.status = 'PASS'; entry.verificationId = report.id; entry.completedAt = new Date().toISOString(); entry.error = null; delete entry.reasonCode; delete entry.blockedAt;
    state.completedSha = entry.sha; runner.status = 'IDLE'; runner.current = null;
    await saveProgress(root, config, stream, state); await saveRunner(root, runner, statePath);
    const delivery = await syncDeliveries(root, config, { worktree: runner.worktree, target: stream });
    await onEvent({ event: 'delivered', sha: entry.sha, ...delivery });
    if (delivery?.code === 'BASE_DIVERGED') return await reverifyOnBase(root, config, stream, runner, state, delivery, { signal, onEvent }) ?? { status: 'BLOCKED', reason: delivery.reason };
    return { status: 'PASS', manifestId: entry.manifestId, sha: entry.sha, verificationId: report.id, worktree: runner.worktree, delivery };
  } catch (error) {
    if (currentAttempt) {
      if (currentAttempt.status === 'RUNNING' || signal?.aborted) currentAttempt.status = signal?.aborted ? 'STOPPED' : 'FAIL';
      currentAttempt.completedAt ??= new Date().toISOString();
      currentAttempt.error = error.message;
      if (['PROCESS_GROUP_ACTIVE', 'PROCESS_START_UNKNOWN'].includes(error.code)) currentAttempt.processFailure = { code: error.code, phase: error.phase, result: error.result ?? null };
    }
    entry.status = signal?.aborted ? 'STOPPED' : 'BLOCKED'; entry.error = error.message; entry.blockedAt = new Date().toISOString();
    if (error.reasonCode) entry.reasonCode = error.reasonCode; else delete entry.reasonCode;
    runner.status = entry.status;
    await saveProgress(root, config, stream, state); await saveRunner(root, runner, statePath);
    if (!signal?.aborted) await onEvent({ event: 'blocked', sha: entry.sha, manifestId: entry.manifestId, reasonCode: error.reasonCode ?? null, reason: errorHead(error.detail ?? error.message) });
    return { status: 'BLOCKED', manifestId: entry.manifestId, sha: entry.sha, reason: error.message, ...(error.reasonCode && { reasonCode: error.reasonCode }), worktree: runner.worktree };
  }
}
/** Live processes whose working directory is inside, or whose command line names, the runner worktree. */
/** Device services may have been started from a worktree by an older driver; they are shared, never leftovers. */
// Everything under the Android SDK emulator directory belongs to the device: qemu, netsimd, crashpad_handler.
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SDK_EMULATOR = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const DEVICE_SERVICE = new RegExp(`qemu-system|${SDK_EMULATOR ? escape(path.join(SDK_EMULATOR, 'emulator')) : '/Android/sdk/emulator'}/|Simulator\\.app|CoreSimulator|launchd_sim`);
/**
 * An executor's sandbox can start commands in their own process groups that outlive it (a Gradle build of a killed
 * Codex run kept downloading for 40 minutes), and Xcode helpers keep a worktree as their directory. After each phase,
 * whatever still works in the runner worktree belongs to that phase: stop it and record it in the attempt.
 */
export async function reapLeftovers(root, worktree, record, phase, onEvent) {
  let leftovers;
  try { leftovers = await processesUsing(root, worktree, { commandLines: false }); }
  catch (error) { record.leftoverCheck = { phase, error: error.message }; return []; }
  const commands = new Map();
  for (const item of leftovers) {
    try { commands.set(item.pid, (await runCommand(root, { argv: ['ps', '-o', 'command=', '-p', String(item.pid)], timeoutMs: 10000 })).stdout.trim()); } catch { commands.set(item.pid, ''); }
  }
  const stray = leftovers.filter(item => !DEVICE_SERVICE.test(commands.get(item.pid) ?? '')).map(item => ({ ...item, command: (commands.get(item.pid) ?? '').slice(0, 200) }));
  if (!stray.length) return [];
  for (const item of stray) { try { process.kill(item.pid, 'SIGTERM'); } catch { /* already gone */ } }
  await delay(3000);
  for (const item of stray) { try { process.kill(item.pid, 0); process.kill(item.pid, 'SIGKILL'); item.forced = true; } catch { /* exited */ } }
  record.leftoverProcesses = [...(record.leftoverProcesses ?? []), ...stray.map(item => ({ ...item, phase, at: new Date().toISOString() }))];
  await onEvent({ event: 'leftover-processes', phase, processes: stray.map(item => ({ pid: item.pid, command: item.command.slice(0, 120) })) });
  return stray;
}
async function processesUsing(root, worktree, { commandLines = true } = {}) {
  const real = await fs.realpath(worktree);
  const inside = value => value === real || value.startsWith(`${real}${path.sep}`) || value === worktree || value.startsWith(`${worktree}${path.sep}`);
  const found = new Map();
  // Listed from the project root: a lister started inside the worktree would report itself.
  const cwd = await runCommand(root, { argv: ['lsof', '-n', '-w', '-d', 'cwd', '-F', 'pn'], timeoutMs: 60000 });
  if (cwd.spawned === false || cwd.timedOut || cwd.overflow || (cwd.status !== 'PASS' && !cwd.stdout)) throw new Error('lsof is unavailable or incomplete; cannot confirm that no executor runs in the runner worktree');
  let pid = null;
  for (const line of cwd.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && inside(line.slice(1)) && pid !== process.pid) found.set(pid, `cwd ${line.slice(1)}`);
  }
  if (!commandLines) return [...found].map(([id, detail]) => ({ pid: id, detail }));
  const listed = await runCommand(root, { argv: ['ps', '-Ao', 'pid=,command='], timeoutMs: 60000 });
  if (listed.status !== 'PASS' || listed.overflow) throw new Error('ps failed; cannot confirm that no executor runs in the runner worktree');
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[1]) !== process.pid && (match[2].includes(real) || match[2].includes(worktree))) found.set(Number(match[1]), match[2].slice(0, 200));
  }
  return [...found].map(([id, detail]) => ({ pid: id, detail }));
}
/**
 * Launch intents the runner recorded (onBeforeSpawn) without a PID: the runner died between recording the intent and
 * the spawn returning. With --recover-unknown-start, retry checks that no live process uses the runner worktree and
 * records that check on the intent instead of a PID; it never applies to a recorded PID or to earlier versions.
 */
async function recoverUnknownStarts(root, config, target, current) {
  const runner = await readJson(await projectPath(root, runnerStatePath(config, target)), null);
  if (!runner?.worktree) throw new Error('Unknown-PID recovery requires the runner worktree record');
  const unknown = [];
  for (const attempt of current.attempts ?? []) {
    if (attempt.status === 'RUNNING' && !attempt.completedAt && !(attempt.processes ?? []).some(child => child.phase === 'execute') && !Number.isSafeInteger(attempt.pid)) {
      attempt.processes = [...(attempt.processes ?? []), { phase: 'execute', pid: null, pgid: null, spawned: null, status: 'STARTING', startedAt: attempt.startedAt }];
    }
    for (const child of attempt.processes ?? []) if (!child.completedAt && !(Number.isSafeInteger(child.pid) && child.pid > 0)) unknown.push(child);
  }
  if (!unknown.length) return null;
  const live = await processesUsing(root, runner.worktree);
  if (live.length) throw new Error(`Unknown-PID recovery refused: live processes use the runner worktree: ${live.map(item => `${item.pid} (${item.detail})`).join('; ')}`);
  const recovery = { by: 'runner retry --recover-unknown-start', checkedAt: new Date().toISOString(), worktree: runner.worktree, method: 'lsof cwd and ps command lines', liveProcesses: [] };
  for (const child of unknown) { child.status = 'NOT_STARTED'; child.spawned = false; child.completedAt = recovery.checkedAt; child.error = 'Launch intent without a PID; no live process used the runner worktree'; child.recovery = recovery; }
  return { phases: unknown.map(child => child.phase), ...recovery };
}
/**
 * A person decided that a later prototype version fixes the blocked current one: fold them into the later version
 * (supersedeVersions) and keep the runner worktree, so the next run plans and verifies the combined change on top of
 * the implementation already there. Single-target streams only; the version must be blocked or stopped, with nothing
 * running.
 */
async function blockedCurrent(root, config, target, command, verb) {
  if (isMultiTarget(config)) throw new Error(`runner ${command} supports single-target streams only`);
  const state = await loadProgress(root, config, target);
  const current = state.entries.find(entry => entry.status !== 'PASS');
  if (!current || !['BLOCKED', 'STOPPED'].includes(current.status)) throw new Error(`runner ${command} needs a blocked or stopped current version`);
  for (const entry of state.entries) assertNoActiveProcesses(entry);
  const statePath = runnerStatePath(config, target);
  const runner = await readJson(await projectPath(root, statePath), null);
  if (runner?.status === 'RUNNING') throw new Error(`Stop the runner before ${verb} its current version`);
  return { current, runner, statePath };
}
// The worktree keeps its application changes; its frozen copies of the replaced manifests are synced again.
async function resyncManifests(root, runner, statePath, ids) {
  if (!runner?.worktree) return;
  for (const id of ids) {
    await fs.rm(await projectPath(runner.worktree, `.protoflow/manifests/${id}.json`), { force: true });
    await fs.rm(await projectPath(runner.worktree, `.protoflow/versions/${id}`), { recursive: true, force: true });
  }
  runner.status = 'IDLE'; runner.current = null;
  await saveRunner(root, runner, statePath);
}
export async function supersedeRunner(root, config = {}, { target = null } = {}) {
  const { current, runner, statePath } = await blockedCurrent(root, config, target, 'supersede', 'superseding');
  const result = await supersedeVersions(root, config, { from: current.manifestId });
  await resyncManifests(root, runner, statePath, [...result.superseded, result.manifest.id]);
  return { status: 'PASS', superseded: result.superseded, manifestId: result.manifest.id, level: result.manifest.level,
    manifestHash: hash(result.manifest), archive: result.archive,
    next: result.manifest.requires?.architecture ? 'bind the ADR to manifestHash, then runner start' : 'runner start' };
}
/**
 * A version's level is fixed when it is scanned. When a later engine classifies it differently (a misread change
 * blocked it on a spec or ADR it does not need), a person reclassifies the blocked current version: the manifest is
 * rebuilt from the same frozen prototype, the old one archived, and the worktree kept. The levels and the engine
 * version are recorded in the source state and as a `reclassified` event.
 */
export async function reclassifyRunner(root, config = {}, { target = null } = {}) {
  const { current, runner, statePath } = await blockedCurrent(root, config, target, 'reclassify', 'reclassifying');
  const result = await reclassifyVersion(root, config, { from: current.manifestId, engineVersion: ENGINE_VERSION });
  await resyncManifests(root, runner, statePath, [result.manifestId]);
  const manifestHash = hash(result.manifest);
  await recordEvent(root, { at: result.at, event: 'reclassified', target, sha: current.sha, manifestId: result.manifestId, from: result.from, to: result.to, previousManifestHash: result.previousManifestHash, manifestHash, engineVersion: result.engineVersion });
  return { status: 'PASS', manifestId: result.manifestId, from: result.from, to: result.to, engineVersion: result.engineVersion,
    previousManifestHash: result.previousManifestHash, manifestHash, archive: result.archive,
    next: result.manifest.requires?.architecture ? 'bind the ADR to manifestHash, then runner start' : 'runner start' };
}
export async function retryRunner(root, config = {}, { target = null, recoverUnknownStart = false } = {}) {
  const state = await loadProgress(root, config, target);
  const current = state.entries.find(entry => entry.status !== 'PASS');
  if (!current || !['BLOCKED', 'STOPPED', 'RUNNING'].includes(current.status)) throw new Error('No blocked/interrupted current version to retry');
  for (const previous of state.entries.filter(entry => entry !== current)) assertNoActiveProcesses(previous);
  const recovered = recoverUnknownStart ? await recoverUnknownStarts(root, config, target, current) : null;
  try { assertNoActiveProcesses(current); }
  catch (error) {
    if (error.code === 'PROCESS_START_UNKNOWN') error.message += '; after confirming, run runner retry --recover-unknown-start';
    throw error;
  }
  for (const attempt of current.attempts ?? []) {
    for (const child of attempt.processes ?? []) {
      if (!child.completedAt) {
        child.status = 'STOPPED'; child.completedAt = new Date().toISOString();
        child.error = 'Interrupted process recovered by runner retry';
      }
    }
    if (attempt.status === 'RUNNING' && !attempt.completedAt) {
      attempt.status = 'STOPPED'; attempt.completedAt = new Date().toISOString();
      attempt.error = current.error ?? 'Interrupted execution recovered by runner retry';
    }
  }
  current.retries = [...(current.retries ?? []), { previousStatus: current.status, reason: current.error ?? 'Interrupted', ...(current.reasonCode && { reasonCode: current.reasonCode }), at: new Date().toISOString(), ...(recovered && { recoveredUnknownStart: recovered }) }];
  current.status = 'PENDING'; current.error = null; delete current.reasonCode; delete current.blockedAt;
  await saveProgress(root, config, target, state);
  return { status: 'PASS', ...(target && { target }), current: current.manifestId, next: 'runner start --once' };
}
async function configureStream(root, config, stream) {
  const statePath = runnerStatePath(config, stream);
  const runner = await readJson(await projectPath(root, statePath), null);
  if (!runner) return { status: 'PASS', reason: 'No worktree yet; next start uses the current config' };
  const state = await loadProgress(root, config, stream);
  if (runner.status === 'RUNNING' || state.entries.some(entry => entry.status === 'RUNNING')) throw new Error('Stop the runner and inspect interrupted execution before reconfiguring');
  for (const previous of state.entries) assertNoActiveProcesses(previous);
  const old = await readJson(await projectPath(runner.worktree, 'protoflow.config.json'));
  // Anchored streams are owned by source, prototypeDir and target identities; v1 streams also by mapping ownership.
  const routing = value => value.schemaVersion === 2
    ? { schemaVersion: 2, source: value.source, prototypeDir: value.prototypeDir, targets: value.targets.map(target => ({ id: target.id, platform: target.platform })) }
    : { source: value.source, prototypeDir: value.prototypeDir, mappings: value.mappings.map(mapping => ({ id: mapping.id, prototypeFiles: mapping.prototypeFiles })) };
  if (hash(routing(old)) !== hash(routing(config))) throw new Error('Cannot change source/prototypeDir/targets or mapping ownership in an existing stream');
  const current = state.entries.find(entry => entry.status !== 'PASS');
  if (current && (await versionQueue(runner.worktree, old, { target: stream ?? undefined })).versions.find(version => version.id === current.manifestId)?.acceptedBy) throw new Error('Recover the interrupted PASS with the original config before reconfiguring');
  // A committed delivery that has not settled binds this worktree's bytes; rewriting its config file would make the
  // reviewed tree differ from the checkout. The base branch carries the change in and integration reverifies it.
  const deferred = (await deliveryStatus(root, config, stream)).deliveries.some(delivery => !['MERGED', 'PR_OPEN_MANUAL', 'REVOKED'].includes(delivery.status));
  runner.configurationHistory = [...(runner.configurationHistory ?? []), { previousHash: runner.configHash, configHash: hash(config), previousConfig: old, updatedAt: new Date().toISOString(), ...(deferred && { configSync: 'deferred' }) }];
  if (!deferred) await writeJson(await projectPath(runner.worktree, 'protoflow.config.json'), config);
  runner.configHash = hash(config); await saveRunner(root, runner, statePath);
  return { status: 'PASS', worktree: runner.worktree, configHash: runner.configHash, configSync: deferred ? 'deferred' : 'written', next: current ? 'runner retry, then runner start' : 'runner start' };
}
/** Explicit operational configuration recovery; frozen source/routing ownership stays fixed. Applies to every target. */
export async function configureRunner(root, config) {
  if (!isMultiTarget(config)) return configureStream(root, config, null);
  const targets = {};
  for (const stream of streamTargets(config)) targets[stream] = await configureStream(root, config, stream);
  return { status: 'PASS', targets };
}
/** Combine per-target results: any BLOCKED, then NOT_RUN, then PASS, otherwise IDLE. */
function aggregate(results) {
  const statuses = Object.values(results).map(result => result.status);
  const status = ['BLOCKED', 'NOT_RUN', 'STOPPED', 'PASS'].find(item => statuses.includes(item)) ?? 'IDLE';
  return { status, targets: results };
}
/**
 * The runner's liveness record: pid, engine version, mode, the last pass and the last event. A supervisor (runner
 * service status) compares it with the process it started; it is written best-effort and never stops the runner.
 */
export const HEARTBEAT = '.protoflow/runner/heartbeat.json';
/** How often a running runner refreshes its heartbeat, between and during passes. */
export const BEAT_INTERVAL_MS = 60000;
/** Every runner event with its time, for the dashboard's timeline; rotated to events.1.jsonl past EVENTS_LIMIT bytes. */
export const EVENTS = '.protoflow/runner/events.jsonl';
export const EVENTS_LIMIT = 5 * 1024 * 1024;
async function recordEvent(root, event) {
  try {
    const file = await projectPath(root, EVENTS);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const size = await fs.stat(file).then(stat => stat.size, () => 0);
    if (size > EVENTS_LIMIT) await fs.rename(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    await fs.appendFile(file, `${JSON.stringify(event)}\n`);
  } catch { /* the timeline is advisory */ }
}
const ENGINE_VERSION = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Advance every target stream, deliver, and handle issues. `service` is the resident mode a supervisor (launchd)
 * keeps alive: it never returns because every target is blocked or the source cannot be read; it keeps polling
 * until a person resolves the block, and returns only when stopped.
 */
export async function startRunner(root, config, { once = false, service = false, signal, onEvent: report = () => {}, beatIntervalMs = BEAT_INTERVAL_MS } = {}) {
  const streams = streamTargets(config);
  const waiting = new Map();
  const startedAt = new Date().toISOString();
  // Consecutive passes that could not read the source or reach GitHub: a supervisor reports them as degraded.
  let lastEvent = null, lastPass = null, failingPasses = 0, lastFailure = null, passIssueError = null;
  const beat = async () => {
    try { await writeJson(await projectPath(root, HEARTBEAT), { schemaVersion: 1, pid: process.pid, version: ENGINE_VERSION, service, startedAt, at: new Date().toISOString(), beatIntervalMs, lastPass, lastEvent, failingPasses, lastFailure }); }
    catch { /* liveness is advisory */ }
  };
  const onEvent = async event => {
    lastEvent = { event: event.event, target: event.target ?? null, at: new Date().toISOString() };
    await recordEvent(root, { at: lastEvent.at, ...event });
    // A block or a decision for a person reaches the desktop; the notification never holds up the pass.
    notifyDesktop(root, config, event).catch(() => {});
    await beat(); await report(event);
  };
  // A pass can run for an hour (execution, native visual capture); the heartbeat keeps beating while the process is
  // responsive, so a supervisor tells a long step from a hung runner.
  const pulse = setInterval(() => { beat(); }, beatIntervalMs);
  pulse.unref?.();
  return withLock(root, async () => {
    let last = { status: 'IDLE' };
    await beat();
    while (!signal?.aborted) {
      let scanError = null;
      passIssueError = null;
      try { const scan = await withLock(root, () => scanSource(root, config)); await onEvent({ event: 'scanned', tip: scan.tip, added: scan.added }); }
      catch (error) { scanError = error.message; await onEvent({ event: 'scan-failed', error: error.message }); if (error.code === 'SOURCE_HISTORY_REWRITTEN' && !service) throw error; }
      if (signal?.aborted) return { status: 'STOPPED' };
      // Each target advances through the same versions independently; one blocked target does not hold the others.
      const results = {};
      for (const stream of streams) {
        const events = stream ? event => onEvent({ ...event, target: stream }) : onEvent;
        let result;
        do { result = await withLock(root, () => runOnce(root, config, { signal, onEvent: events, target: stream })); }
        // An automated rejection (REOPENED) repairs at once; MAX_AUTOMATED_REOPENINGS bounds the loop.
        while (['PASS', 'REOPENED'].includes(result.status) && !signal?.aborted);
        // Proposal 0003: an idle, fully delivered target takes one planned GitHub issue per pass; prototypes come first.
        if (config.issues?.enabled && result.status === 'IDLE' && !signal?.aborted) {
          try {
            const issue = await runIssues(root, config, stream, { signal, onEvent: events });
            if (!['IDLE', 'DISABLED'].includes(issue.status)) await events({ event: 'issue-pass', ...issue });
            // Report why a planned issue waits once per change, so a waiting issue is never silent.
            if (waiting.get(stream) !== (issue.reason ?? null)) { waiting.set(stream, issue.reason ?? null); if (issue.status === 'IDLE' && issue.reason) await events({ event: 'issue-waiting', reason: issue.reason }); }
          }
          catch (error) { passIssueError = error.message.slice(0, 300); await events({ event: 'issues-failed', error: passIssueError, transient: Boolean(error.transient) }); }
        }
        results[stream ?? ''] = result;
      }
      last = streams[0] === null ? results[''] : aggregate(results);
      // Proposal 0003: triage labelled GitHub issues once the prototype streams have had their turn.
      if (config.issues?.enabled && !signal?.aborted) {
        try { await syncIssues(root, config, { onEvent, signal }); }
        catch (error) { passIssueError = error.message.slice(0, 300); await onEvent({ event: 'issues-failed', error: passIssueError, transient: Boolean(error.transient) }); }
      }
      const stuck = Object.values(results).every(result => ['BLOCKED', 'NOT_RUN'].includes(result.status));
      const failure = scanError ?? passIssueError;
      if (failure) { failingPasses++; lastFailure = { at: new Date().toISOString(), error: failure.slice(0, 300) }; } else failingPasses = 0;
      lastPass = { at: new Date().toISOString(), status: last.status, stuck, ...(scanError && { scanError: scanError.slice(0, 200) }), ...(passIssueError && { issuesError: passIssueError.slice(0, 200) }), targets: Object.fromEntries(Object.entries(results).map(([key, result]) => [key || 'default', result.status])) };
      await beat();
      // A resident runner waits for a person to resolve a block instead of exiting into a supervisor restart loop.
      if (once || (stuck && !service)) return scanError && last.status === 'IDLE' ? { ...last, status: 'SCAN_FAILED', reason: scanError } : last;
      try { await delay(config.runner?.pollMs ?? 15000, undefined, { signal }); } catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    return { status: 'STOPPED' };
  }, 'runner').finally(() => clearInterval(pulse));
}

export async function doctor(root, config) {
  const checks = [];
  const check = async (name, action) => { try { checks.push({ name, status: 'PASS', detail: await action() }); } catch (error) { checks.push({ name, status: 'FAIL', detail: error.message }); } };
  await check('source', () => { validateSource(config.source); return `${config.source.repository}#${config.source.branch}:${config.source.path}`; });
  await check('git', () => git(root, ['rev-parse', 'HEAD']));
  await check('codex', async () => {
    for (const provider of new Set(['frontend', 'backend'].map(area => executorPlan(config, area).primary))) {
      if (!executorCommand(config, provider)) throw new Error(`Configure adapters.${provider}.command argv; built-in adapters: scripts/codex-adapter.js, scripts/claude-exec-adapter.js`);
    }
    const result = await runCommand(root, { argv: ['codex', '--version'] });
    if (result.status !== 'PASS') throw new Error(result.stderr || 'Codex unavailable'); return result.stdout.trim();
  });
  await check('verification', () => {
    if (config.schemaVersion === 2) {
      for (const target of config.targets) {
        const builds = target.build || target.variants?.every(variant => variant.build);
        if (!builds || !target.functional) throw new Error(`Target ${target.id} requires build (on the target or every variant) and functional commands`);
      }
      if (config.policy?.sequentialVersions === false) throw new Error('Runner requires FIFO');
      const drivers = target => target.variants ? target.variants.map(variant => `${variant.id}: ${variant.driver.kind}${variant.required === false ? ', optional' : ''}`).join(', ') : target.driver.kind;
      return config.targets.map(target => `target ${target.id} (${target.platform}, ${drivers(target)})`).join('; ') + ': build + functional + anchored tiers';
    }
    if (!config.verification?.build || !config.verification?.functional || !config.visual?.scenes?.length) throw new Error('Build, functional (Playwright), and visual scenes are required');
    if (!config.mappings.length) throw new Error('Configure prototype/application mappings');
    if (config.policy?.sequentialVersions === false) throw new Error('Runner requires FIFO');
    return 'build + functional + visual configured';
  });
  await check('chromium', async () => { const browser = await chromium.launch(); await browser.close(); return 'launch OK'; });
  if (config.schemaVersion === 2) await check('anchors', async () => {
    // Git-source prototypes are linted per commit at scan time; a local prototype is linted here.
    if (config.source) return 'linted per commit during source scan';
    const contract = staticContract(await snapshot(root, config), config);
    if (contract.errors.length) throw new Error(contract.errors.join('; '));
    return `${Object.keys(contract.screens).length} screen(s), ${contract.warnings.length} warning(s)`;
  });
  await check('skill', async () => { await fs.access(await projectPath(root, '.agents/skills/protoflow/SKILL.md')); return 'installed'; });
  // Informational: unused runner worktrees only cost disk; `runner gc --apply` reclaims the clean ones.
  await check('runner worktrees', async () => {
    const { counts, removableBytes } = await collectRunnerWorktrees(root, config);
    const stale = counts.stale ?? 0, unsafe = counts.unsafe ?? 0;
    return `${counts.active ?? 0} active, ${stale} unused${stale ? ` (${Math.round(removableBytes / 1048576)} MB, runner gc --apply)` : ''}${unsafe ? `, ${unsafe} unused but kept (see runner gc)` : ''}`;
  });
  return { status: checks.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL', checks, engine: fileURLToPath(new URL('../', import.meta.url)), progress: await runnerStatus(root, config) };
}
