import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { hash, id, fingerprint, projectPath, readJson, writeJson, runCommand } from './util.js';
import { loadArtifact, applicationFingerprint } from './workflow.js';
import { loadProgress, deliveryBranch, isMultiTarget } from './streams.js';
import { loadVersion } from './versions.js';
import { deliveryGit as git, resolveDeliveryDestination } from './delivery-scope.js';

const directory = '.protoflow/delivery/independent-reviews';
const adapter = fileURLToPath(new URL('../scripts/codex-review-adapter.js', import.meta.url));
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
export function assertStructuredVerdict(verdict, request) {
  if (!validVerdict(verdict) || verdict.requestId !== request.id || verdict.bindingHash !== request.bindingHash) throw blocked('Independent review verdict is malformed or bound to another request');
  return verdict;
}
function checkVerdict(verdict, request) {
  assertStructuredVerdict(verdict, request);
  if (verdict.status !== 'PASS' || verdict.findings.length) throw blocked(`Independent review ${verdict.status}; ${verdict.summary}`);
}
export function readCodexTrace(trace, { finalVerdict = false } = {}) {
  if (typeof trace !== 'string' || !trace.trim()) throw blocked('Missing raw Codex trace');
  let events;
  try { events = trace.trim().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { throw blocked('Malformed raw Codex JSONL trace'); }
  const threads = events.filter(event => event.type === 'thread.started');
  if (threads.length !== 1 || !session.test(threads[0].thread_id ?? '') || events.filter(event => event.type === 'turn.started').length !== 1 || events.filter(event => event.type === 'turn.completed').length !== 1 || events.findIndex(event => event.type === 'thread.started') >= events.findIndex(event => event.type === 'turn.started') || events.findIndex(event => event.type === 'turn.started') >= events.findIndex(event => event.type === 'turn.completed') || events.some(event => ['error', 'turn.failed'].includes(event.type))) throw blocked('Codex trace has no single completed fresh session');
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
  const [node, script, ...options] = command.argv;
  if (!script || (node !== 'node' && await fs.realpath(node) !== await fs.realpath(process.execPath)) || await fs.realpath(script) !== await fs.realpath(adapter)) throw blocked('Independent review must use the shared read-only Codex review adapter');
  if (options.length && (options.length !== 2 || options[0] !== '--model' || !options[1] || options[1].startsWith('-'))) throw blocked('Unsupported independent review adapter options');
  return { argv: [process.execPath, adapter, ...options], timeoutMs: command.timeoutMs ?? 600000 };
}
async function remoteState(worktree, config, target) {
  const options = config.runner?.delivery;
  if (!options) throw blocked('Independent review requires a dedicated delivery branch and base');
  // With several targets each target reviews and publishes its own branch <branch>/<target>.
  const branch = deliveryBranch(config, target);
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
const contentReport = ({ runnerWorktree, ...report }) => report;
async function executorRecords(root, worktree, entries, external) {
  const locations = external ?? entries.flatMap(entry => (entry.attempts ?? []).filter(attempt => attempt.executionStatus === 'PASS' && attempt.executionId).map(attempt => ({ path: `.protoflow/contexts/${attempt.executionId}.json`, manifestId: entry.manifestId })));
  if (!locations.length) throw blocked('Missing executor session provenance; bare session IDs do not authorize review');
  const records = [];
  for (const reference of locations) {
    if (!reference || Object.keys(reference).some(key => !['path', 'hash', 'manifestId'].includes(key)) || typeof reference.path !== 'string' || (external && !digest.test(reference.hash ?? ''))) throw blocked('Executor evidence must contain private record path and complete file SHA256');
    if (!reference.path.startsWith('.protoflow/')) throw blocked('Executor evidence must remain in private project evidence');
    const location = await projectPath(external ? root : worktree, reference.path), bytes = await fs.readFile(location);
    if (external && hash(bytes) !== reference.hash) throw blocked('Executor provenance file changed');
    const record = JSON.parse(bytes), manifestId = record.request?.manifest?.id;
    if (!/^EXEC-[A-Za-z0-9-]+$/.test(record.id ?? '') || record.status !== 'PASS' || record.result?.status !== 'PASS' || record.result?.exitCode !== 0 || record.result?.spawned === false || record.result?.processGroupActive || !['implement', 'repair'].includes(record.request?.kind) || record.request.manifestHash !== hash(record.request.manifest) || !entries.some(entry => entry.manifestId === manifestId) || (reference.manifestId && reference.manifestId !== manifestId)) throw blocked('Executor provenance is not a successful execution of the accepted manifest');
    if (hash(record.request.manifest) !== hash(await loadArtifact(root, 'manifests', manifestId))) throw blocked('Executor provenance manifest changed');
    records.push({ path: reference.path, origin: external ? 'root' : 'worktree', hash: hash(bytes), manifestId, executionId: record.id, ...readCodexTrace(record.result.stdout) });
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
  const content = await fingerprint(worktree);
  const treeFiles = new Map((await git(worktree, ['ls-tree', '-r', '-z', head])).split('\0').filter(Boolean).map(row => {
    const [meta, file] = row.split('\t'); return [file, meta.split(' ')];
  }));
  for (const [file, expected] of Object.entries(application.files)) {
    const entry = treeFiles.get(file);
    if (!entry || !['100644', '100755'].includes(entry[0]) || ((await fs.lstat(await projectPath(worktree, file))).mode & 0o111 ? '100755' : '100644') !== entry[0] || hash(await gitBytes(worktree, ['cat-file', 'blob', entry[2]])) !== expected) throw blocked('Reviewed application bytes/modes do not match the committed tree');
  }
  for (const file of treeFiles.keys()) if (!file.split('/').some(part => ['.protoflow', 'node_modules', 'test-results', 'playwright-report'].includes(part)) && !outside.some(prefix => file === prefix || file.startsWith(`${prefix}/`)) && !Object.hasOwn(application.files, file)) throw blocked('Committed application content was removed after commit');
  const source = await loadProgress(root, config, target);
  if (!Array.isArray(options.manifestIds) || !options.manifestIds.length || new Set(options.manifestIds).size !== options.manifestIds.length) throw blocked('Independent review requires exact accepted manifest IDs');
  const entries = options.manifestIds.map(manifestId => source.entries.find(entry => entry.manifestId === manifestId));
  if (entries.some(entry => !entry || entry.status !== 'PASS' || !entry.verificationId)) throw blocked('Accepted source/verification is FAIL or NOT_RUN');
  const versions = [];
  for (const entry of entries) {
    const manifest = await loadArtifact(root, 'manifests', entry.manifestId), report = await loadArtifact(root, 'verifications', entry.verificationId);
    const localManifest = await loadArtifact(worktree, 'manifests', entry.manifestId), localReport = await loadArtifact(worktree, 'verifications', entry.verificationId);
    if (manifest.id !== entry.manifestId || manifest.source?.sha !== entry.sha || manifest.source.repository !== config.source.repository || report.id !== entry.verificationId || report.manifestId !== entry.manifestId || report.manifestHash !== hash(manifest) || report.prototypeHash !== manifest.afterHash || hash(report.project?.files) !== report.project?.hash || hash(localManifest) !== hash(manifest) || hash(contentReport(localReport)) !== hash(contentReport(report))) throw blocked('Source, manifest or new VER evidence binding changed');
    if (report.status !== 'PASS' || report.build?.status !== 'PASS' || report.functional?.status !== 'PASS' || report.visual?.status !== 'PASS' || report.changedDuringVerification) throw blocked('Delivery acceptance FAIL or NOT_RUN; complete PASS is required');
    if ((entry.manifestHash && entry.manifestHash !== hash(manifest)) || (entry.verificationHash && entry.verificationHash !== hash(report))) throw blocked('Accepted source hashes changed');
    await loadVersion(worktree, config, manifest);
    if (!Object.keys(report.artifactHashes ?? {}).length) throw blocked('Missing hashed acceptance artifacts');
    for (const [file, expected] of Object.entries(report.artifactHashes)) if (hash(await fs.readFile(await projectPath(worktree, file))) !== expected) throw blocked('Acceptance artifact changed');
    versions.push({ sha: entry.sha, entryHash: hash(entry), manifestId: manifest.id, manifestHash: hash(manifest), verificationId: report.id, verificationHash: hash(report), applicationHash: report.project.hash, artifactsHash: hash(report.artifactHashes) });
  }
  if (application.hash !== versions.at(-1).applicationHash) throw blocked('Full application content drifted since the newest PASS verification');
  const executors = await executorRecords(root, worktree, entries, options.executorEvidence);
  const ambientAuthorIds = [...new Set(options.ambientAuthorIds ?? [process.env.CODEX_THREAD_ID].filter(Boolean))];
  if (ambientAuthorIds.some(value => !session.test(value))) throw blocked('Invalid ambient author thread identity');
  const remote = await remoteState(worktree, config, target);
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
    schemaVersion: 1, target, commit: head, tree: await git(worktree, ['rev-parse', `${head}^{tree}`]), rootHead: await git(root, ['rev-parse', 'HEAD']),
    checkout: { gitDir: await fs.realpath(await git(worktree, ['rev-parse', '--absolute-git-dir'])), commonDir: await fs.realpath(path.resolve(worktree, await git(worktree, ['rev-parse', '--git-common-dir']))), branch: await git(worktree, ['symbolic-ref', '--quiet', 'HEAD']) },
    applicationHash: application.hash, contentHash: content.hash, filesHash: hash(content.files), configHash: hash(config),
    versions, executors, ambientAuthorIds, remote, providerExecutable: await resolveCodexExecutable()
  };
}
function checkRun(run, request) {
  if (!run || Object.keys(run).sort().join(',') !== ['protocol', 'requestId', 'bindingHash', 'provider', 'providerExecutable', 'sandbox', 'freshSession', 'sessionId', 'trace', 'traceHash', 'verdict'].sort().join(',') || run.protocol !== 'protoflow.independent-review-run/1' || run.provider !== 'codex' || hash(run.providerExecutable) !== hash(request.binding.providerExecutable) || run.sandbox !== 'read-only' || run.freshSession !== true || run.requestId !== request.id || run.bindingHash !== request.bindingHash || hash(run.trace) !== run.traceHash) throw blocked('Missing genuine structured Codex review run evidence');
  const parsed = readCodexTrace(run.trace, { finalVerdict: true });
  if (parsed.sessionId !== run.sessionId || hash(parsed.verdict) !== hash(run.verdict) || request.binding.executors.some(record => record.sessionId === run.sessionId) || [...request.binding.ambientAuthorIds, process.env.CODEX_THREAD_ID].includes(run.sessionId)) throw blocked('Review must be a separate fresh session from every executor and author');
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
  try {
    const command = await commandFor(config), binding = await capture(root, config, options);
    const worktree = options.worktree ?? root;
    const diff = await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', binding.remote.baseSha, binding.commit, '--', '.']);
    if (diff.length > 2 * 1024 * 1024) throw blocked('Review diff exceeds the bounded request limit');
    const request = { protocol: 'protoflow.independent-review-request/1', id: reviewId, binding, bindingHash: hash(binding), diff };
    const requestFile = `${directory}/${reviewId}/request.json`, runFile = `${directory}/${reviewId}/run.json`;
    await writeJson(await projectPath(root, requestFile), request);
    Object.assign(record, { requestFile, requestHash: hash(request), commandHash: hash(command), adapterHash: hash(await fs.readFile(adapter)), options: { worktree, target: binding.target, commit: options.commit, manifestIds: options.manifestIds, executorEvidence: options.executorEvidence ?? null, ambientAuthorIds: binding.ambientAuthorIds, expectedBaseSha: binding.remote.baseSha } });
    const result = await runCommand(worktree, command, request, { signal: options.signal });
    const processFile = `${directory}/${reviewId}/process.json`;
    await writeJson(await projectPath(root, processFile), result);
    Object.assign(record, { processFile, processHash: hash(result) });
    if (result.status !== 'PASS' || result.processGroupActive) throw blocked(`Independent review ${result.status}: provider did not complete safely`);
    let run;
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
    await writeJson(await projectPath(root, recordPath(reviewId)), record);
    return record;
  }
}
/** Recompute all evidence before each approval, push or merge; a legal push changes only the reviewed tip. */
export async function assertIndependentReview(root, config, reviewId, options = {}) {
  try { return await assertRecordedReview(root, config, reviewId, options); }
  catch (error) { if (error.code === 'INDEPENDENT_REVIEW_BLOCKED') throw error; throw blocked(`Independent review evidence unavailable: ${error.message}`); }
}
/** For byte-preserving post-merge alignment only; still requires this process's live provider attestation. */
export async function assertMergedIndependentReview(root, config, reviewId, mergeCommit) {
  try { return await assertRecordedReview(root, config, reviewId, { published: true }, mergeCommit); }
  catch (error) { if (error.code === 'INDEPENDENT_REVIEW_BLOCKED') throw error; throw blocked(`Merged review evidence unavailable: ${error.message}`); }
}
async function assertRecordedReview(root, config, reviewId, options, mergeCommit = null) {
  const record = await readJson(await projectPath(root, recordPath(reviewId)));
  if (record.status !== 'PASS') throw blocked(`Independent review ${record.status}: ${record.reason ?? 'PASS evidence required'}`);
  const attestation = attestations.get(await attestationKey(root, reviewId));
  if (!attestation) { const error = blocked('Independent review lacks a live engine attestation; explicitly select a fresh provider revalidation after restart'); error.reasonCode = 'ENGINE_ATTESTATION_MISSING'; throw error; }
  const request = await readJson(await projectPath(root, record.requestFile)), run = await readJson(await projectPath(root, record.runFile)), process = await readJson(await projectPath(root, record.processFile));
  if (hash({ record, request, run, process }) !== attestation) throw blocked('Independent review differs from the engine-witnessed provider completion');
  if (hash(process) !== record.processHash || process.status !== 'PASS' || process.exitCode !== 0 || !process.spawned || process.processGroupActive || hash(JSON.parse(process.stdout)) !== hash(run)) throw blocked('Independent provider process evidence changed or was NOT_RUN');
  if (hash(request) !== record.requestHash || hash(request.binding) !== request.bindingHash || hash(run) !== record.runHash || hash(run.verdict) !== record.verdictHash || run.traceHash !== record.traceHash || run.sessionId !== record.sessionId || record.commandHash !== hash(await commandFor(config)) || record.adapterHash !== hash(await fs.readFile(adapter))) throw blocked('Independent review request, adapter, verdict or raw trace evidence changed');
  checkRun(run, request);
  const expected = record.options;
  if ((Object.hasOwn(options, 'target') && (options.target ?? null) !== (expected.target ?? null)) || (options.commit && options.commit !== expected.commit) || (options.expectedBaseSha && options.expectedBaseSha !== expected.expectedBaseSha) || (options.manifestIds && hash(options.manifestIds) !== hash(expected.manifestIds)) || (options.worktree && await fs.realpath(options.worktree) !== await fs.realpath(expected.worktree))) throw blocked('Independent review belongs to another delivery');
  const live = await capture(root, config, { ...expected, executorEvidence: expected.executorEvidence ?? undefined }, mergeCommit ? { mergeCommit, reviewedBaseSha: request.binding.remote.baseSha } : null);
  const remoteHeads = options.published === 'either' ? [expected.commit, request.binding.remote.headSha] : [options.published ? expected.commit : request.binding.remote.headSha];
  if (!remoteHeads.includes(live.remote.headSha)) throw blocked('Remote delivery head drifted from the reviewed push state');
  const observedRemoteHead = live.remote.headSha;
  live.remote.headSha = request.binding.remote.headSha;
  if (hash(live) !== request.bindingHash) throw blocked('HEAD, full content, source, manifest, VER or current base drifted since independent review');
  return { ...record, binding: request.binding, verdict: run.verdict, observedRemoteHead };
}
