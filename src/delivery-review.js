import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { readClaudeTrace, resolveClaudeExecutable } from './claude.js';
import { hash, id, fingerprint, projectPath, readJson, writeJson, runCommand, RUNTIME_DIRS } from './util.js';
import { loadArtifact, applicationFingerprint } from './workflow.js';
import { loadProgress, deliveryBranch, isMultiTarget } from './streams.js';
import { loadVersion } from './versions.js';
import { verificationRevocation } from './queue.js';
import { deliveryGit as git, resolveDeliveryDestination } from './delivery-scope.js';
import { defaultIssueTarget } from './issues.js';

const directory = '.protoflow/delivery/independent-reviews';
// Proposal 0003: Claude is the primary acceptor, Codex remains available; both answer the same bound protocol.
const ADAPTERS = { codex: fileURLToPath(new URL('../scripts/codex-review-adapter.js', import.meta.url)), claude: fileURLToPath(new URL('../scripts/claude-review-adapter.js', import.meta.url)) };
const OPTIONS = { codex: ['--model'], claude: ['--model', '--max-budget-usd'] };
export const reviewProvider = config => config.adapters?.independentReview?.provider ?? 'codex';
const providerOf = binding => binding.provider ?? 'codex';
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const session = /^[A-Za-z0-9_-]{8,100}$/;
// File hashes describe evidence, but only this engine's witnessed provider completion authorizes it.
// This state cannot be restored from application-writable files after a process restart.
const attestations = new Map();
const attestationKey = async (root, reviewId) => `${await fs.realpath(root)}\0${reviewId}`;
export async function resolveCodexExecutable() {
  for (const prefix of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(prefix)) continue;
    const candidate = path.join(prefix, 'codex');
    try {
      await fs.access(candidate, constants.X_OK);
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      return { path: resolved, hash: hash(await fs.readFile(resolved)) };
    } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  }
  throw blocked('Independent review Codex executable is unavailable on the trusted PATH');
}
export const reviewVerdictSchema = {
  type: 'object', additionalProperties: false,
  required: ['protocol', 'requestId', 'bindingHash', 'status', 'findings', 'summary'],
  properties: {
    protocol: { type: 'string', const: 'protoflow.independent-review/1' }, requestId: { type: 'string', pattern: '^AIR-[A-Za-z0-9-]+$' },
    bindingHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, status: { type: 'string', enum: ['PASS', 'FAIL', 'NOT_RUN'] },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'file', 'line', 'description'], properties: {
      severity: { type: 'string', enum: ['critical', 'high', 'normal', 'low'] }, file: { type: 'string', minLength: 1 }, line: { type: 'integer', minimum: 1 }, description: { type: 'string', minLength: 1 }
    } } }, summary: { type: 'string', minLength: 1, maxLength: 4000 }
  }
};
const validVerdict = new Ajv({ strict: false, allErrors: true }).compile(reviewVerdictSchema);
function blocked(message) { const error = new Error(message); error.code = 'INDEPENDENT_REVIEW_BLOCKED'; return error; }
function keepTransient(error, cause) { if (cause.transient === true) error.transient = true; return error; }
const verdictAllowsRetry = verdict => verdict === undefined || verdict === null || (verdict.status === 'PASS' && Array.isArray(verdict.findings) && !verdict.findings.length);
/**
 * The verdict a recorded attempt's provider returned, read from its run or, when the adapter rejected the output,
 * from every agent message in the raw trace. null means no provider verdict exists. Inconsistent records throw.
 */
export async function recordedVerdict(root, record) {
  if (record.runFile) {
    const run = await readJson(await projectPath(root, record.runFile));
    if ((record.runHash && hash(run) !== record.runHash) || (record.verdictHash && hash(run.verdict) !== record.verdictHash)) throw blocked('Independent review run evidence changed');
    if (run.verdict) return run.verdict;
  }
  if (!record.processFile) return null;
  const process = await readJson(await projectPath(root, record.processFile));
  if (record.processHash && hash(process) !== record.processHash) throw blocked('Independent review process evidence changed');
  let envelope;
  try { envelope = JSON.parse(process.stdout); } catch { return null; }
  const verdicts = [envelope?.verdict, ...String(envelope?.trace ?? '').split(/\r?\n/).flatMap(line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && event.structured_output) return [event.structured_output];
      return event.type === 'item.completed' && event.item?.type === 'agent_message' ? [JSON.parse(event.item.text)] : [];
    }
    catch { return []; }
  })].filter(value => value && typeof value === 'object' && 'status' in value);
  return verdicts.find(verdict => !verdictAllowsRetry(verdict)) ?? verdicts.at(-1) ?? null;
}
/**
 * A recorded attempt whose provider was stopped or killed before answering: the process has no exit code and printed
 * nothing. Records written before this was marked retryable are recognized from their process evidence.
 */
export async function interruptedProvider(root, record) {
  if (record?.status !== 'BLOCKED' || !record.processFile) return false;
  const process = await readJson(await projectPath(root, record.processFile), null);
  return Boolean(process) && process.exitCode === null && !String(process.stdout ?? '').trim();
}
/** A FAIL, NOT_RUN or finding from the reviewer is a judgment, never an infrastructure failure to retry. */
export const isRejectingVerdict = verdict => Boolean(verdict) && !verdictAllowsRetry(verdict);
export function assertStructuredVerdict(verdict, request) {
  if (!validVerdict(verdict) || verdict.requestId !== request.id || verdict.bindingHash !== request.bindingHash) throw blocked('Independent review verdict is malformed or bound to another request');
  return verdict;
}
function checkVerdict(verdict, request) {
  assertStructuredVerdict(verdict, request);
  if (verdict.status !== 'PASS' || verdict.findings.length) throw blocked(`Independent review ${verdict.status}; ${verdict.summary}`);
}
const RECONNECT = /^Reconnecting\.\.\. \d+\/\d+\b/;
export function readCodexTrace(trace, { finalVerdict = false } = {}) {
  if (typeof trace !== 'string' || !trace.trim()) throw blocked('Missing raw Codex trace');
  let events;
  try { events = trace.trim().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { throw blocked('Malformed raw Codex JSONL trace'); }
  const threads = events.filter(event => event.type === 'thread.started');
  const started = events.findIndex(event => event.type === 'turn.started'), completed = events.findIndex(event => event.type === 'turn.completed');
  // Codex reports a dropped model stream it retried as an `error` event ("Reconnecting... 1/5"); inside a turn that still completes it is not a failure.
  const fatal = (event, index) => event.type === 'turn.failed' || (event.type === 'error' && !(index > started && index < completed && RECONNECT.test(event.message ?? '')));
  if (threads.length !== 1 || !session.test(threads[0].thread_id ?? '') || events.filter(event => event.type === 'turn.started').length !== 1 || events.filter(event => event.type === 'turn.completed').length !== 1 || events.findIndex(event => event.type === 'thread.started') >= started || started >= completed || events.some(fatal)) throw blocked('Codex trace has no single completed fresh session');
  const result = { sessionId: threads[0].thread_id, traceHash: hash(trace) };
  if (finalVerdict) {
    const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
    try { result.verdict = JSON.parse(messages.at(-1)?.item.text); }
    catch { throw blocked('Codex trace has no structured final review verdict'); }
  }
  return result;
}
const gitBytes = (root, args) => git(root, args, { encoding: 'buffer' });
async function commandFor(config) {
  const command = config.adapters?.independentReview?.command;
  if (!command?.argv) throw blocked('Independent review NOT_RUN: configure adapters.independentReview.command');
  const provider = reviewProvider(config), adapter = ADAPTERS[provider];
  if (!adapter) throw blocked(`Unknown independent review provider ${provider}`);
  const [node, script, ...options] = command.argv;
  if (!script || (node !== 'node' && await fs.realpath(node) !== await fs.realpath(process.execPath)) || await fs.realpath(script) !== await fs.realpath(adapter)) throw blocked(`Independent review must use the shared read-only ${provider === 'claude' ? 'Claude' : 'Codex'} review adapter`);
  // Only `--flag value` pairs this provider's adapter knows; no flag can widen the reviewer's permissions.
  const pairs = options.length % 2 === 0 ? Array.from({ length: options.length / 2 }, (_, index) => options.slice(index * 2, index * 2 + 2)) : null;
  if (!pairs || new Set(pairs.map(([flag]) => flag)).size !== pairs.length || pairs.some(([flag, value]) => !OPTIONS[provider].includes(flag) || !value || value.startsWith('-'))) throw blocked('Unsupported independent review adapter options');
  return { argv: [process.execPath, adapter, ...options], timeoutMs: command.timeoutMs ?? 600000 };
}
async function remoteState(worktree, config, target, issue = null) {
  const options = config.runner?.delivery;
  if (!options) throw blocked('Independent review requires a dedicated delivery branch and base');
  // With several targets each target reviews and publishes its own branch <branch>/<target>; an issue fix its own issue branch.
  const branch = issue ? issueBranch(config, issue.number, target) : deliveryBranch(config, target);
  if (branch === options.baseBranch || ['main', 'master'].includes(branch)) throw blocked('Independent review requires a dedicated delivery branch and base');
  for (const name of [branch, options.baseBranch]) await git(worktree, ['check-ref-format', '--branch', name]);
  const destination = await resolveDeliveryDestination(worktree, options.remote);
  const refs = (await git(worktree, ['ls-remote', destination.url, `refs/heads/${options.baseBranch}`, `refs/heads/${branch}`])).split('\n').filter(Boolean).map(line => line.split(/\s+/));
  if (refs.some(([value]) => !sha.test(value)) || new Set(refs.map(row => row[1])).size !== refs.length) throw blocked('Invalid remote ref evidence');
  const baseSha = refs.find(row => row[1] === `refs/heads/${options.baseBranch}`)?.[0];
  if (!baseSha) throw blocked('Delivery base ref is missing');
  return { ...destination, baseBranch: options.baseBranch, branch, baseSha, headSha: refs.find(row => row[1] === `refs/heads/${branch}`)?.[0] ?? null };
}
/** The stream a review belongs to: null for single-target projects, otherwise a configured target id. */
function reviewTarget(config, target) {
  if (!isMultiTarget(config)) { if (target) throw blocked('Single-target delivery review takes no target'); return null; }
  if (!config.targets.some(item => item.id === target)) throw blocked('Independent review requires the delivering target');
  return target;
}
/** What a multi-target review judges: the delivering target's root; sibling roots ship through their own streams. */
const reviewScope = (config, target) => ({
  target, root: config.targets.find(item => item.id === target).root.replace(/\/+$/, ''),
  siblings: config.targets.filter(item => item.id !== target).map(item => ({ target: item.id, root: item.root.replace(/\/+$/, '') }))
});
// ProtoFlow <= 0.2.0 exported the main-root VER with a top-level runnerWorktree path; that key is not evidence.
const contentReport = ({ runnerWorktree, ...report }) => report;
async function executorRecords(root, worktree, entries, external, issue = null) {
  const locations = external ?? (issue ? issue.executionIds.map(executionId => ({ path: `.protoflow/contexts/${executionId}.json`, manifestId: issue.manifestId })) : null) ?? entries.flatMap(entry => (entry.attempts ?? []).filter(attempt => attempt.executionStatus === 'PASS' && attempt.executionId).map(attempt => ({ path: `.protoflow/contexts/${attempt.executionId}.json`, manifestId: entry.manifestId })));
  if (!locations.length) throw blocked('Missing executor session provenance; bare session IDs do not authorize review');
  const records = [];
  for (const reference of locations) {
    if (!reference || Object.keys(reference).some(key => !['path', 'hash', 'manifestId'].includes(key)) || typeof reference.path !== 'string' || (external && !digest.test(reference.hash ?? ''))) throw blocked('Executor evidence must contain private record path and complete file SHA256');
    if (!reference.path.startsWith('.protoflow/')) throw blocked('Executor evidence must remain in private project evidence');
    const location = await projectPath(external ? root : worktree, reference.path), bytes = await fs.readFile(location);
    if (external && hash(bytes) !== reference.hash) throw blocked('Executor provenance file changed');
    const record = JSON.parse(bytes), manifestId = record.request?.manifest?.id;
    if (!/^EXEC-[A-Za-z0-9-]+$/.test(record.id ?? '') || record.status !== 'PASS' || record.result?.status !== 'PASS' || record.result?.exitCode !== 0 || record.result?.spawned === false || record.result?.processGroupActive || !['implement', 'repair'].includes(record.request?.kind) || record.request.manifestHash !== hash(record.request.manifest) || !entries.some(entry => entry.manifestId === manifestId) || (reference.manifestId && reference.manifestId !== manifestId)) throw blocked('Executor provenance is not a successful execution of the accepted manifest');
    // An issue fix's executions must carry this issue's snapshot; version executions never count for an issue.
    if (Boolean(issue) !== Boolean(record.request.issue) || (issue && (record.request.issue.number !== issue.number || record.request.issue.snapshotId !== issue.snapshotId))) throw blocked('Executor provenance belongs to another issue or version');
    if (hash(record.request.manifest) !== hash(await loadArtifact(root, 'manifests', manifestId))) throw blocked('Executor provenance manifest changed');
    // The executor that produced this record (proposal 0003); records before it were all Codex.
    const executor = record.executor ?? 'codex';
    if (!['codex', 'claude'].includes(executor)) throw blocked(`Unknown executor ${executor}`);
    const trace = executor === 'claude' ? readClaudeTrace(record.result.stdout, { executor: true }) : readCodexTrace(record.result.stdout);
    records.push({ path: reference.path, origin: external ? 'root' : 'worktree', hash: hash(bytes), manifestId, executionId: record.id, ...(executor !== 'codex' && { executor }), sessionId: trace.sessionId, traceHash: trace.traceHash });
  }
  if (entries.some(entry => !records.some(record => record.manifestId === entry.manifestId))) throw blocked('Executor provenance is missing an accepted source version');
  return records;
}
async function capture(root, config, options, ownedMerge = null) {
  const worktree = options.worktree ?? root;
  const target = reviewTarget(config, options.target ?? null);
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  if (!sha.test(options.commit ?? '') || head !== options.commit) throw blocked('Application HEAD differs from the delivery commit');
  try { await git(worktree, ['diff', '--cached', '--quiet']); }
  catch { throw blocked('Application index changed after delivery commit'); }
  // Same scope as the target's verification: sibling targets' roots are not this target's application.
  const application = await applicationFingerprint(worktree, config, target ?? undefined);
  const outside = [config.prototypeDir, ...(target ? config.targets.filter(item => item.id !== target).map(item => item.root.replace(/\/+$/, '')) : [])];
  // Full workspace content as Git can commit it; ignored build output is the build's, not the binding's.
  const content = await fingerprint(worktree, { gitIgnore: true });
  const treeFiles = new Map((await git(worktree, ['ls-tree', '-r', '-z', head])).split('\0').filter(Boolean).map(row => {
    const [meta, file] = row.split('\t'); return [file, meta.split(' ')];
  }));
  for (const [key, expected] of Object.entries(application.files)) {
    // A symlink that leaves the project is bound by its link text; the committed tree must hold the same symlink.
    if (key.endsWith(':link')) {
      const entry = treeFiles.get(key.slice(0, -':link'.length));
      if (!entry || entry[0] !== '120000' || (await gitBytes(worktree, ['cat-file', 'blob', entry[2]])).toString() !== expected) throw blocked('Reviewed application bytes/modes do not match the committed tree');
      continue;
    }
    const file = key;
    const entry = treeFiles.get(file);
    if (!entry || !['100644', '100755'].includes(entry[0]) || ((await fs.lstat(await projectPath(worktree, file))).mode & 0o111 ? '100755' : '100644') !== entry[0] || hash(await gitBytes(worktree, ['cat-file', 'blob', entry[2]])) !== expected) throw blocked('Reviewed application bytes/modes do not match the committed tree');
  }
  for (const file of treeFiles.keys()) if (!file.split('/').some(part => RUNTIME_DIRS.includes(part)) && !outside.some(prefix => file === prefix || file.startsWith(`${prefix}/`)) && !Object.hasOwn(application.files, file) && !Object.hasOwn(application.files, `${file}:link`)) throw blocked('Committed application content was removed after commit');
  const source = await loadProgress(root, config, target);
  let versions = [], entries, issue = null;
  if (options.issue) ({ entries, versions, issue } = await issueEvidence(root, worktree, config, target, source, options.issue));
  else {
    if (!Array.isArray(options.manifestIds) || !options.manifestIds.length || new Set(options.manifestIds).size !== options.manifestIds.length) throw blocked('Independent review requires exact accepted manifest IDs');
    entries = options.manifestIds.map(manifestId => source.entries.find(entry => entry.manifestId === manifestId));
    if (entries.some(entry => !entry || entry.status !== 'PASS' || !entry.verificationId)) throw blocked('Accepted source/verification is FAIL or NOT_RUN');
    for (const entry of entries) {
      const manifest = await loadArtifact(root, 'manifests', entry.manifestId), report = await loadArtifact(root, 'verifications', entry.verificationId);
      const localManifest = await loadArtifact(worktree, 'manifests', entry.manifestId), localReport = await loadArtifact(worktree, 'verifications', entry.verificationId);
      if (manifest.id !== entry.manifestId || manifest.source?.sha !== entry.sha || manifest.source.repository !== config.source.repository || report.id !== entry.verificationId || report.manifestId !== entry.manifestId || report.manifestHash !== hash(manifest) || report.prototypeHash !== manifest.afterHash || hash(report.project?.files) !== report.project?.hash || hash(localManifest) !== hash(manifest) || hash(contentReport(localReport)) !== hash(contentReport(report))) throw blocked('Source, manifest or new VER evidence binding changed');
      if (report.status !== 'PASS' || report.build?.status !== 'PASS' || report.functional?.status !== 'PASS' || report.visual?.status !== 'PASS' || report.changedDuringVerification) throw blocked('Delivery acceptance FAIL or NOT_RUN; complete PASS is required');
      // Progress may still say PASS until the runner reopens it; rejection already withdraws delivery authority.
      for (const evidenceRoot of new Set([root, worktree])) {
        const revocation = await verificationRevocation(evidenceRoot, config, report);
        if (revocation) throw blocked(`Delivery acceptance ${report.id} revoked by ${revocation.reviewId} (${revocation.status}); verify again after rejection`);
      }
      if ((entry.manifestHash && entry.manifestHash !== hash(manifest)) || (entry.verificationHash && entry.verificationHash !== hash(report))) throw blocked('Accepted source hashes changed');
      await loadVersion(worktree, config, manifest);
      if (!Object.keys(report.artifactHashes ?? {}).length) throw blocked('Missing hashed acceptance artifacts');
      for (const [file, expected] of Object.entries(report.artifactHashes)) if (hash(await fs.readFile(await projectPath(worktree, file))) !== expected) throw blocked('Acceptance artifact changed');
      // verificationHash binds the authoritative main-root VER; the reviewer reads verificationFile in this checkout.
      versions.push({ sha: entry.sha, entryHash: hash(entry), manifestId: manifest.id, manifestHash: hash(manifest), verificationId: report.id, verificationHash: hash(report), verificationFile: `.protoflow/verifications/${report.id}.json`, verificationFileHash: hash(localReport), applicationHash: report.project.hash, artifactsHash: hash(report.artifactHashes), ...(entry.planId && { plan: await boundPlan(worktree, entry.planId, manifest.id) }) });
    }
  }
  if (application.hash !== versions.at(-1).applicationHash) throw blocked('Full application content drifted since the newest PASS verification');
  const executors = await executorRecords(root, worktree, entries, options.executorEvidence, options.issue ?? null);
  const ambientAuthorIds = [...new Set(options.ambientAuthorIds ?? [process.env.CODEX_THREAD_ID].filter(Boolean))];
  if (ambientAuthorIds.some(value => !session.test(value))) throw blocked('Invalid ambient author thread identity');
  const remote = await remoteState(worktree, config, target, options.issue ?? null);
  if (ownedMerge) {
    if (!sha.test(ownedMerge.mergeCommit) || remote.baseSha !== ownedMerge.mergeCommit) throw blocked('Current main differs from the completed reviewed merge');
    try { await git(worktree, ['cat-file', '-e', `${remote.baseSha}^{commit}`]); }
    catch { await git(worktree, ['fetch', '--no-tags', '--no-write-fetch-head', remote.url, remote.baseSha]); }
    const parents = (await git(worktree, ['rev-list', '--parents', '-n', '1', remote.baseSha])).split(' ');
    if (hash(parents) !== hash([remote.baseSha, ownedMerge.reviewedBaseSha, head]) || await git(worktree, ['rev-parse', `${remote.baseSha}^{tree}`]) !== await git(worktree, ['rev-parse', `${head}^{tree}`])) throw blocked('Completed merge differs from the reviewed parents or application tree');
    remote.baseSha = ownedMerge.reviewedBaseSha;
  }
  if (options.expectedBaseSha && remote.baseSha !== options.expectedBaseSha) throw blocked('Current base differs from the committed delivery base SHA');
  try { await git(worktree, ['cat-file', '-e', `${remote.baseSha}^{commit}`]); }
  catch { await git(worktree, ['fetch', '--no-tags', '--no-write-fetch-head', remote.url, remote.baseSha]); }
  try { await git(worktree, ['merge-base', '--is-ancestor', remote.baseSha, head]); }
  catch { throw blocked('Current remote base is not an ancestor of the reviewed application HEAD'); }
  return {
    schemaVersion: 1, target, ...(target && { scope: reviewScope(config, target) }), commit: head, tree: await git(worktree, ['rev-parse', `${head}^{tree}`]), rootHead: await git(root, ['rev-parse', 'HEAD']),
    checkout: { gitDir: await fs.realpath(await git(worktree, ['rev-parse', '--absolute-git-dir'])), commonDir: await fs.realpath(path.resolve(worktree, await git(worktree, ['rev-parse', '--git-common-dir']))), branch: await git(worktree, ['symbolic-ref', '--quiet', 'HEAD']) },
    applicationHash: application.hash, contentHash: content.hash, filesHash: hash(content.files), configHash: hash(config),
    versions, ...(issue && { issue }), executors, ambientAuthorIds, remote, ...(reviewProvider(config) !== 'codex' && { provider: reviewProvider(config) }), providerExecutable: reviewProvider(config) === 'claude' ? await resolveClaudeExecutable() : await resolveCodexExecutable()
  };
}
/** The branch an issue fix publishes to (proposal 0003 §6.3): protoflow/issue-<n>, plus /<target> with several targets. */
export function issueBranch(config, number, target) {
  if (!Number.isSafeInteger(number) || number <= 0) throw blocked('Invalid issue number');
  return `protoflow/issue-${number}${isMultiTarget(config) ? `/${target}` : ''}`;
}
/**
 * Evidence for an issue fix (proposal 0003 §6.3): the issue snapshot and its implement plan for this target, the
 * target's fully delivered prototype stream, and a fresh PASS verification of its latest accepted version on the fixed
 * application, so the fix is reviewed as a regression-checked change, never as a new prototype version.
 */
async function issueEvidence(root, worktree, config, target, source, reference) {
  const keys = ['number', 'snapshotId', 'planId', 'manifestId', 'verificationId', 'executionIds'];
  if (!reference || Object.keys(reference).sort().join(',') !== [...keys].sort().join(',') || !Array.isArray(reference.executionIds) || !reference.executionIds.length || reference.executionIds.some(value => !/^EXEC-[A-Za-z0-9-]+$/.test(value))) throw blocked('Issue review requires the exact issue, plan, verification and executions');
  const snapshot = await readJson(await projectPath(root, `.protoflow/issues/snapshots/${reference.snapshotId}.json`), null);
  const { schemaVersion, id: snapshotId, capturedAt, hash: snapshotHash, ...content } = snapshot ?? {};
  if (!snapshot || snapshotId !== reference.snapshotId || content.number !== reference.number || hash(content) !== snapshotHash || !/^ISS-\d+-[a-f0-9]{12}$/.test(snapshotId)) throw blocked('Issue snapshot is missing or changed');
  // The reviewer reads the snapshot in the checkout it reviews; that copy must be the engine's.
  if (hash(await readJson(await projectPath(worktree, `.protoflow/issues/snapshots/${snapshotId}.json`), null)) !== hash(snapshot)) throw blocked('Issue snapshot in the reviewed checkout differs from the engine copy');
  if (!/^PLN-[A-Za-z0-9-]+$/.test(reference.planId)) throw blocked('Invalid plan id');
  const plan = await readJson(await projectPath(root, `.protoflow/plans/${reference.planId}.json`), null);
  if (!plan || plan.id !== reference.planId || plan.issue !== reference.number || plan.snapshotId !== snapshotId || plan.planHash !== hash(plan.plan) || plan.plan.decision !== 'implement' || !plan.plan.targets.includes(target ?? defaultIssueTarget(config))) throw blocked(`Plan ${reference.planId} is missing, changed or does not implement this issue for this target`);
  const entries = source.entries;
  if (!entries.length || entries.some(entry => entry.status !== 'PASS' || !entry.deliveryId) || entries.at(-1).manifestId !== reference.manifestId) throw blocked('An issue fix needs an idle target whose accepted versions are all delivered, checked against its latest version');
  const entry = entries.at(-1);
  const manifest = await loadArtifact(root, 'manifests', entry.manifestId), report = await loadArtifact(root, 'verifications', reference.verificationId), localReport = await loadArtifact(worktree, 'verifications', reference.verificationId);
  if (report.id !== reference.verificationId || report.manifestId !== manifest.id || report.manifestHash !== hash(manifest) || hash(contentReport(localReport)) !== hash(contentReport(report)) || hash(report.project?.files) !== report.project?.hash) throw blocked('Issue verification is not bound to the latest accepted version');
  if (report.status !== 'PASS' || report.build?.status !== 'PASS' || report.functional?.status !== 'PASS' || report.visual?.status !== 'PASS' || report.changedDuringVerification) throw blocked('Issue verification FAIL or NOT_RUN; complete PASS is required');
  await loadVersion(worktree, config, manifest);
  if (!Object.keys(report.artifactHashes ?? {}).length) throw blocked('Missing hashed acceptance artifacts');
  for (const [file, expected] of Object.entries(report.artifactHashes)) if (hash(await fs.readFile(await projectPath(worktree, file))) !== expected) throw blocked('Acceptance artifact changed');
  return {
    entries: [entry],
    versions: [{ sha: entry.sha, regression: true, manifestId: manifest.id, manifestHash: hash(manifest), verificationId: report.id, verificationHash: hash(report), verificationFile: `.protoflow/verifications/${report.id}.json`, verificationFileHash: hash(localReport), applicationHash: report.project.hash, artifactsHash: hash(report.artifactHashes) }],
    issue: {
      number: snapshot.number, title: snapshot.title, snapshotId, snapshotHash, snapshotFile: `.protoflow/issues/snapshots/${snapshotId}.json`,
      plan: { id: plan.id, planHash: plan.planHash, sessionId: plan.sessionId, summary: plan.plan.summary, acceptanceCriteria: plan.plan.acceptanceCriteria, tests: plan.plan.tests }
    }
  };
}
/** The planner's acceptance criteria for a version (proposal 0003), bound by hash so the acceptor checks exactly them. */
async function boundPlan(worktree, planId, manifestId) {
  if (!/^PLN-[A-Za-z0-9-]+$/.test(planId)) throw blocked('Invalid plan id');
  const record = await readJson(await projectPath(worktree, `.protoflow/plans/${planId}.json`), null);
  if (!record || record.id !== planId || record.manifestId !== manifestId || record.planHash !== hash(record.plan)) throw blocked(`Plan ${planId} is missing, changed or belongs to another version`);
  return { id: record.id, planHash: record.planHash, sessionId: record.sessionId, acceptanceCriteria: record.plan.acceptanceCriteria };
}
/** A Claude acceptor trace as the gate binds it: the session, the trace hash and the structured verdict. */
function claudeReview(trace) {
  try { const parsed = readClaudeTrace(trace); return { sessionId: parsed.sessionId, traceHash: parsed.traceHash, verdict: parsed.output }; }
  catch (error) { throw blocked(`Claude review trace rejected: ${error.message}`); }
}
function checkRun(run, request) {
  if (!run || Object.keys(run).sort().join(',') !== ['protocol', 'requestId', 'bindingHash', 'provider', 'providerExecutable', 'sandbox', 'freshSession', 'sessionId', 'trace', 'traceHash', 'verdict'].sort().join(',') || run.protocol !== 'protoflow.independent-review-run/1' || run.provider !== providerOf(request.binding) || hash(run.providerExecutable) !== hash(request.binding.providerExecutable) || run.sandbox !== 'read-only' || run.freshSession !== true || run.requestId !== request.id || run.bindingHash !== request.bindingHash || hash(run.trace) !== run.traceHash) throw blocked('Missing genuine structured Codex review run evidence');
  const parsed = providerOf(request.binding) === 'claude' ? claudeReview(run.trace) : readCodexTrace(run.trace, { finalVerdict: true });
  if (parsed.sessionId !== run.sessionId || hash(parsed.verdict) !== hash(run.verdict) || request.binding.executors.some(record => record.sessionId === run.sessionId) || request.binding.versions.some(version => version.plan?.sessionId === run.sessionId) || request.binding.issue?.plan.sessionId === run.sessionId || [...request.binding.ambientAuthorIds, process.env.CODEX_THREAD_ID].includes(run.sessionId)) throw blocked('Review must be a separate fresh session from every planner, executor and author');
  checkVerdict(run.verdict, request);
}
function recordPath(reviewId) {
  if (!/^AIR-[A-Za-z0-9-]+$/.test(reviewId ?? '')) throw blocked('Invalid independent review ID');
  return `${directory}/${reviewId}.json`;
}
/** Run the pinned shared adapter; caller-supplied PASS/session IDs are never accepted. */
export async function requestIndependentReview(root, config, options) {
  const reviewId = id('AIR');
  const record = { schemaVersion: 1, id: reviewId, status: 'BLOCKED', createdAt: new Date().toISOString() };
  let run;
  try {
    const command = await commandFor(config), binding = await capture(root, config, options);
    const worktree = options.worktree ?? root;
    let diff;
    try { diff = await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', binding.remote.baseSha, binding.commit, '--', '.']); }
    catch (error) { if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error; diff = null; }
    if (diff === null || diff.length > 2 * 1024 * 1024) throw blocked(`Review diff exceeds the bounded request limit (${(await git(worktree, ['diff', '--shortstat', binding.remote.baseSha, binding.commit, '--', '.'])).trim()})`);
    const request = { protocol: 'protoflow.independent-review-request/1', id: reviewId, binding, bindingHash: hash(binding), diff };
    const requestFile = `${directory}/${reviewId}/request.json`, runFile = `${directory}/${reviewId}/run.json`;
    await writeJson(await projectPath(root, requestFile), request);
    Object.assign(record, { requestFile, requestHash: hash(request), commandHash: hash(command), adapterHash: hash(await fs.readFile(ADAPTERS[providerOf(binding)])), options: { worktree, target: binding.target, commit: options.commit, manifestIds: options.manifestIds, ...(options.issue && { issue: options.issue }), executorEvidence: options.executorEvidence ?? null, ambientAuthorIds: binding.ambientAuthorIds, expectedBaseSha: binding.remote.baseSha } });
    const result = await runCommand(worktree, command, request, { signal: options.signal });
    const processFile = `${directory}/${reviewId}/process.json`;
    await writeJson(await projectPath(root, processFile), result);
    Object.assign(record, { processFile, processHash: hash(result) });
    if (result.status !== 'PASS' || result.processGroupActive) {
      const error = blocked(`Independent review ${result.status}: provider did not complete safely`);
      // Stopped or killed before it answered (exit null, no output): infrastructure, never a judgment.
      if (result.aborted || (result.exitCode === null && !String(result.stdout ?? '').trim())) error.transient = true;
      throw error;
    }
    try { run = JSON.parse(result.stdout); } catch { throw blocked('Independent review returned no strict structured run evidence'); }
    await writeJson(await projectPath(root, runFile), run);
    if (run?.verdict) Object.assign(record, { runFile, runHash: hash(run), sessionId: run.sessionId, traceHash: run.traceHash, verdictHash: hash(run.verdict) });
    checkRun(run, request);
    Object.assign(record, { status: 'PASS', runFile, runHash: hash(run), sessionId: run.sessionId, traceHash: run.traceHash, verdictHash: hash(run.verdict), completedAt: new Date().toISOString() });
    await writeJson(await projectPath(root, recordPath(reviewId)), record);
    attestations.set(await attestationKey(root, reviewId), hash({ record, request, run, process: result }));
    await assertIndependentReview(root, config, reviewId, { ...options, published: false });
    return record;
  } catch (error) {
    attestations.delete(await attestationKey(root, reviewId));
    record.status = 'BLOCKED'; record.reason = error.message;
    // A network failure outside the provider's verdict may be retried explicitly; any FAIL/finding verdict never is.
    if (error.transient === true && verdictAllowsRetry(run?.verdict)) Object.assign(record, { retryable: true, reasonCode: 'TRANSIENT_INFRASTRUCTURE' });
    await writeJson(await projectPath(root, recordPath(reviewId)), record);
    return record;
  }
}
/** Recompute all evidence before each approval, push or merge; a legal push changes only the reviewed tip. */
export async function assertIndependentReview(root, config, reviewId, options = {}) {
  try { return await assertRecordedReview(root, config, reviewId, options); }
  catch (error) { if (error.code === 'INDEPENDENT_REVIEW_BLOCKED') throw error; throw keepTransient(blocked(`Independent review evidence unavailable: ${error.message}`), error); }
}
/** For byte-preserving post-merge alignment only; still requires this process's live provider attestation. */
export async function assertMergedIndependentReview(root, config, reviewId, mergeCommit) {
  try { return await assertRecordedReview(root, config, reviewId, { published: true }, mergeCommit); }
  catch (error) { if (error.code === 'INDEPENDENT_REVIEW_BLOCKED') throw error; throw keepTransient(blocked(`Merged review evidence unavailable: ${error.message}`), error); }
}
async function assertRecordedReview(root, config, reviewId, options, mergeCommit = null) {
  const record = await readJson(await projectPath(root, recordPath(reviewId)));
  if (record.status !== 'PASS') { const error = blocked(`Independent review ${record.status}: ${record.reason ?? 'PASS evidence required'}`); error.transient = record.retryable === true; throw error; }
  const attestation = attestations.get(await attestationKey(root, reviewId));
  if (!attestation) { const error = blocked('Independent review lacks a live engine attestation; explicitly select a fresh provider revalidation after restart'); error.reasonCode = 'ENGINE_ATTESTATION_MISSING'; throw error; }
  const request = await readJson(await projectPath(root, record.requestFile)), run = await readJson(await projectPath(root, record.runFile)), process = await readJson(await projectPath(root, record.processFile));
  if (hash({ record, request, run, process }) !== attestation) throw blocked('Independent review differs from the engine-witnessed provider completion');
  if (hash(process) !== record.processHash || process.status !== 'PASS' || process.exitCode !== 0 || !process.spawned || process.processGroupActive || hash(JSON.parse(process.stdout)) !== hash(run)) throw blocked('Independent provider process evidence changed or was NOT_RUN');
  if (hash(request) !== record.requestHash || hash(request.binding) !== request.bindingHash || hash(run) !== record.runHash || hash(run.verdict) !== record.verdictHash || run.traceHash !== record.traceHash || run.sessionId !== record.sessionId || record.commandHash !== hash(await commandFor(config)) || record.adapterHash !== hash(await fs.readFile(ADAPTERS[providerOf(request.binding)]))) throw blocked('Independent review request, adapter, verdict or raw trace evidence changed');
  checkRun(run, request);
  const expected = record.options;
  if ((Object.hasOwn(options, 'target') && (options.target ?? null) !== (expected.target ?? null)) || (options.commit && options.commit !== expected.commit) || (options.expectedBaseSha && options.expectedBaseSha !== expected.expectedBaseSha) || (options.manifestIds && hash(options.manifestIds) !== hash(expected.manifestIds)) || (options.issue && hash(options.issue) !== hash(expected.issue)) || (options.worktree && await fs.realpath(options.worktree) !== await fs.realpath(expected.worktree))) throw blocked('Independent review belongs to another delivery');
  const live = await capture(root, config, { ...expected, executorEvidence: expected.executorEvidence ?? undefined }, mergeCommit ? { mergeCommit, reviewedBaseSha: request.binding.remote.baseSha } : null);
  const remoteHeads = options.published === 'either' ? [expected.commit, request.binding.remote.headSha] : [options.published ? expected.commit : request.binding.remote.headSha];
  if (!remoteHeads.includes(live.remote.headSha)) throw blocked('Remote delivery head drifted from the reviewed push state');
  const observedRemoteHead = live.remote.headSha;
  live.remote.headSha = request.binding.remote.headSha;
  if (hash(live) !== request.bindingHash) throw blocked('HEAD, full content, source, manifest, VER or current base drifted since independent review');
  return { ...record, binding: request.binding, verdict: run.verdict, observedRemoteHead };
}
