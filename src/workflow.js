import path from 'node:path';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { readJson, writeJson, id, hash, projectPath, fingerprint, gitInfo, runCommand } from './util.js';
import { snapshot } from './sessions.js';
import { verifyVisual } from './visual.js';
import { loadVersion } from './versions.js';
import { assertCurrentVersion } from './queue.js';

const date = () => new Date().toISOString();
const validId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error('Invalid artifact id');
  return value;
};
export async function loadArtifact(root, kind, artifactId) {
  if (!['manifests', 'contexts', 'verifications', 'reviews', 'baselines', 'repairs'].includes(kind)) throw new Error('Invalid artifact kind');
  return readJson(await projectPath(root, `.protoflow/${kind}/${validId(artifactId)}.json`));
}
async function persist(root, kind, data) {
  await writeJson(await projectPath(root, `.protoflow/${kind}/${validId(data.id)}.json`), data);
  return data;
}
// The prototype is its own version stream; the application hash excludes it so design work can continue.
const applicationFingerprint = (root, config) => fingerprint(root, { exclude: [config.prototypeDir] });
/** Load a manifest with its frozen prototype version; the live prototype may already be newer. */
async function manifestVersion(root, config, manifestId) {
  const manifest = await loadArtifact(root, 'manifests', manifestId);
  return { manifest, version: await loadVersion(root, config, manifest) };
}
const versionReference = version => ({ manifestId: version.manifestId, hash: version.hash, prototypeDir: version.prototypeDir });
const versionInstructions = version => `Read the prototype for this version from ${version.prototypeDir}/ (a frozen copy). The live prototype directory may already contain newer versions; do not implement them.`;
async function evidenceFile(root, relative) {
  const file = await projectPath(root, relative);
  const content = await readFile(file, 'utf8');
  if (!content.trim()) throw new Error(`Empty evidence: ${relative}`);
  return { path: relative, hash: hash(content), content };
}
async function selectPlanning(root, manifest) {
  const { readdir } = await import('node:fs/promises');
  const directory = await projectPath(root, '.protoflow/contexts');
  let selected = null;
  try {
    for (const filename of (await readdir(directory)).sort()) {
      if (!filename.startsWith('CTX-') || !filename.endsWith('.json')) continue;
      const context = await readJson(await projectPath(root, `.protoflow/contexts/${filename}`));
      if (context.manifestId === manifest.id && context.manifestHash === hash(manifest)) selected = context;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return selected ? { contextId: selected.id, contextHash: hash(selected), spec: selected.spec && { path: selected.spec.path, hash: selected.spec.hash }, adr: selected.adr && { path: selected.adr.path, hash: selected.adr.hash } } : { contextId: null, spec: null, adr: null };
}
async function assertPlanningFresh(root, manifest, planning) {
  if (['L2', 'L3'].includes(manifest.level) && !planning?.spec) throw new Error('Approval requires planning context for this level');
  if (manifest.level === 'L3' && !planning?.adr) throw new Error('Approval requires approved architecture context');
  if (planning?.contextId && hash(await loadArtifact(root, 'contexts', planning.contextId)) !== planning.contextHash) throw new Error('Planning context changed; create a new review');
  for (const evidence of [planning?.spec, planning?.adr].filter(Boolean)) {
    if ((await evidenceFile(root, evidence.path)).hash !== evidence.hash) throw new Error('Planning evidence changed; regenerate context and verification');
  }
}
export async function createContext(root, config, manifestId, { spec, adr } = {}) {
  await assertCurrentVersion(root, config, manifestId);
  const { manifest, version } = await manifestVersion(root, config, manifestId);
  const unmapped = manifest.changes.filter(change => !change.mappings.length).map(change => change.path);
  if (unmapped.length) throw new Error(`Map changed prototype files before execution: ${unmapped.join(', ')}`);
  const specEvidence = spec ? await evidenceFile(root, spec) : null;
  const adrEvidence = adr ? await evidenceFile(root, adr) : null;
  if (['L2', 'L3'].includes(manifest.level) && !specEvidence) throw new Error(`${manifest.level} requires --spec evidence from Spec Kit or an equivalent reviewed specification`);
  if (manifest.level === 'L3') {
    if (!adrEvidence) throw new Error('L3 requires --adr evidence');
    let decision;
    try { decision = JSON.parse(adrEvidence.content); } catch { throw new Error('L3 ADR must be JSON with status, reviewer, manifestHash and decision'); }
    if (decision.status !== 'approved' || !decision.reviewer?.trim() || decision.manifestHash !== hash(manifest) || !decision.decision?.trim()) throw new Error('L3 architecture decision requires human approval bound to this manifestHash');
  }
  return persist(root, 'contexts', {
    schemaVersion: 1, id: id('CTX'), createdAt: date(), manifestId, manifestHash: hash(manifest), manifest,
    prototypeHash: manifest.afterHash, prototypeVersion: versionReference(version), project: await applicationFingerprint(root, config), git: await gitInfo(root),
    mappings: config.mappings.filter(mapping => manifest.mappings.includes(mapping.id)),
    spec: specEvidence, adr: adrEvidence,
    instructions: `${versionInstructions(version)} Implement only mapped application changes. Preserve prototype and unrelated user changes. Maintain and run repeatable Playwright regression tests. Return execution evidence; ProtoFlow performs independent verification. Do not commit, push or deploy.`,
    verification: config.verification ?? {}, visual: config.visual ?? {}
  });
}
export async function prepareIntegration(root, config, manifestId, adapter) {
  if (!['specKit', 'bmad'].includes(adapter)) throw new Error('Adapter must be specKit or bmad');
  await assertCurrentVersion(root, config, manifestId);
  const { manifest, version } = await manifestVersion(root, config, manifestId);
  const request = { schemaVersion: 1, kind: adapter, manifest, manifestHash: hash(manifest), prototypeVersion: versionReference(version), mappings: config.mappings, expected: adapter === 'bmad' ? 'ADR with explicit human decision; do not implement application code' : 'Specification, acceptance criteria, plan and tasks; do not implement application code' };
  const result = await runCommand(root, config.adapters?.[adapter]?.command, request);
  let response = null;
  if (result.status === 'PASS') {
    try {
      response = JSON.parse(result.stdout);
      if (response.status !== 'ready' || !Array.isArray(response.artifacts) || !response.artifacts.length) throw new Error('Expected {status:"ready",artifacts:[relative paths]}');
      response.evidence = await Promise.all(response.artifacts.map(file => evidenceFile(root, file)));
    } catch (error) { result.status = 'FAIL'; result.error = error.message; }
  }
  return persist(root, 'contexts', { schemaVersion: 1, id: id('INT'), createdAt: date(), request, result, response, status: result.status });
}
export async function executeContext(root, config, contextId, { execute = false, repair = null, signal, onBeforeSpawn, onStart } = {}) {
  const context = await loadArtifact(root, 'contexts', contextId);
  await assertCurrentVersion(root, config, context.manifestId);
  const { manifest } = await manifestVersion(root, config, context.manifestId);
  if (context.manifestHash !== hash(manifest)) throw new Error('Context manifest changed');
  if (context.project.hash !== (await applicationFingerprint(root, config)).hash) throw new Error('Context is stale; regenerate it before execution');
  for (const evidence of [context.spec, context.adr].filter(Boolean)) {
    if ((await evidenceFile(root, evidence.path)).hash !== evidence.hash) throw new Error('Planning evidence changed; regenerate context');
  }
  const request = { ...context, kind: repair ? 'repair' : 'implement', repair };
  if (!execute) return { status: 'NOT_RUN', contextId, request, reason: 'Use --execute after configuring the Codex adapter' };
  const command = config.adapters?.codex?.command;
  const before = await snapshot(root, config);
  const result = await runCommand(root, command, request, { signal, onBeforeSpawn, onStart });
  try { await loadVersion(root, config, manifest); }
  catch (error) { result.status = 'FAIL'; result.error = `Executor changed the frozen prototype version: ${error.message}`; }
  // Designers may checkpoint concurrently, so a live prototype change is recorded, not attributed to the executor.
  const livePrototypeChanged = (await snapshot(root, config)).hash !== before.hash;
  return persist(root, 'contexts', { schemaVersion: 1, id: id('EXEC'), createdAt: date(), contextId, request, result, status: result.status, livePrototypeChanged, projectAfter: await applicationFingerprint(root, config) });
}
export async function verify(root, config, manifestId, { signal, onBeforeSpawn, onStart, onFinish } = {}) {
  await assertCurrentVersion(root, config, manifestId);
  const { manifest, version } = await manifestVersion(root, config, manifestId);
  const verificationId = id('VER');
  const directory = await projectPath(root, `.protoflow/artifacts/${verificationId}`);
  await mkdir(directory, { recursive: true });
  const runPhase = async (phase, command) => {
    let pid = null, started = false;
    const result = await runCommand(root, command, null, {
      signal, onBeforeSpawn: async () => { started = true; await onBeforeSpawn?.(phase); },
      onStart: async childPid => { pid = childPid; await onStart?.(phase, childPid); }
    });
    if (started) await onFinish?.(phase, pid, result);
    if (result.processGroupActive) {
      const error = new Error(`Verification ${phase} subprocess group remains active; stop it before further verification or repair`);
      error.code = 'PROCESS_GROUP_ACTIVE'; error.phase = phase; error.result = result;
      throw error;
    }
    if (signal?.aborted) {
      const error = new Error(`STOPPED: verification ${phase} was interrupted`);
      error.code = 'RUNNER_STOPPED'; error.phase = phase; error.result = result;
      throw error;
    }

    return result;
  };
  // Build may produce project assets. Bind evidence after build, before acceptance.
  const build = await runPhase('build', config.verification?.build);
  const before = await applicationFingerprint(root, config);
  const functional = await runPhase('functional', config.verification?.functional);
  const liveMatches = (await snapshot(root, config)).hash === manifest.afterHash;
  if (signal?.aborted) throw new Error('STOPPED: verification was interrupted before visual');
  const visual = await verifyVisual(root, config, directory, { version, liveMatches, signal, onBeforeSpawn, onStart, onFinish });
  const covered = new Set(visual.scenes.flatMap(scene => scene.mappings ?? []).filter(mapping => mapping.status === 'PASS').map(mapping => mapping.id));
  const missing = manifest.mappings.filter(mapping => !covered.has(mapping));
  const unmapped = manifest.changes.filter(change => !change.mappings.length).map(change => change.path);
  if (visual.status === 'PASS' && (missing.length || unmapped.length)) {
    visual.status = 'FAIL'; visual.reason = `Changed prototype mappings lack visual coverage: ${[...missing, ...unmapped].join(', ')}`;
  }
  const artifactHashes = {};
  for (const artifact of visual.artifacts ?? []) {
    const relative = path.relative(await realpath(root), await realpath(artifact));
    artifactHashes[relative] = hash(await readFile(await projectPath(root, relative)));
  }
  const after = await applicationFingerprint(root, config);
  let versionIntact = true;
  try { await loadVersion(root, config, manifest); } catch { versionIntact = false; }
  const liveChanged = visual.prototypeSource === 'live' && (await snapshot(root, config)).hash !== manifest.afterHash;
  const changedDuringVerification = before.hash !== after.hash || !versionIntact || liveChanged;
  const checks = [build.status, functional.status, visual.status];
  const status = changedDuringVerification || checks.includes('FAIL') ? 'FAIL' : checks.every(x => x === 'PASS') ? 'PASS' : 'NOT_RUN';
  const record = { schemaVersion: 1, id: verificationId, createdAt: date(), manifestId, manifestHash: hash(manifest), prototypeHash: manifest.afterHash, prototypeVersion: versionReference(version), project: after, git: await gitInfo(root), build, functional, visual, artifactHashes, changedDuringVerification, status };
  return persist(root, 'verifications', record);
}
export async function createReview(root, config, manifestId, verificationId) {
  // Pending review can preserve a failed/stale attempt; approval still checks freshness.
  await assertCurrentVersion(root, config, manifestId, { allowAccepted: true });
  const manifest = await loadArtifact(root, 'manifests', manifestId);
  const verification = await loadArtifact(root, 'verifications', verificationId);
  if (verification.manifestId !== manifestId || verification.manifestHash !== hash(manifest)) throw new Error('Verification does not belong to this manifest');
  return persist(root, 'reviews', {
    schemaVersion: 1, id: id('REV'), createdAt: date(), manifestId, manifestHash: hash(manifest), verificationId, verificationHash: hash(verification), projectHash: verification.project.hash,
    status: 'pending', reviewer: null, reviewedAt: null, notes: '', findings: [],
    planning: await selectPlanning(root, manifest),
    evidence: { build: verification.build.status, functional: verification.functional.status, visual: verification.visual.status, artifacts: verification.visual.artifacts ?? [] }
  });
}
async function assertReviewFresh(root, config, review) {
  const { manifest } = await manifestVersion(root, config, review.manifestId);
  const verification = await loadArtifact(root, 'verifications', review.verificationId);
  if (hash(manifest) !== review.manifestHash || hash(verification) !== review.verificationHash || verification.manifestHash !== hash(manifest)) throw new Error('Review evidence changed');
  if (verification.status !== 'PASS') throw new Error('Review approval requires PASS build, functional and visual verification');
  if (!Object.keys(verification.artifactHashes ?? {}).length) throw new Error('Missing visual evidence hashes');
  for (const [relative, expected] of Object.entries(verification.artifactHashes)) {
    if (hash(await readFile(await projectPath(root, relative))) !== expected) throw new Error('Visual evidence changed; rerun verification');
  }
  if ((await applicationFingerprint(root, config)).hash !== review.projectHash) throw new Error('Project changed since verification; rerun verify and review');
  await assertPlanningFresh(root, manifest, review.planning);
  return { manifest, verification };
}
export async function decideReview(root, config, reviewId, { status, reviewer, reviewerKind = 'human', notes = '', findings = [] }) {
  if (!['approved', 'rejected', 'changes_requested'].includes(status)) throw new Error('Invalid review decision');
  if (!reviewer?.trim()) throw new Error('--reviewer is required');
  if (!['human', 'automated'].includes(reviewerKind)) throw new Error('reviewerKind must be human or automated');
  // Automated approval is an explicit project policy and is always recorded as automated, never as a person.
  if (reviewerKind === 'automated' && (config.policy?.autoApprove !== true || status !== 'approved')) throw new Error('Automated review decisions require policy.autoApprove and may only approve verified changes');
  if (!Array.isArray(findings)) throw new Error('findings must be an array');
  if (findings.some(finding => !finding || typeof finding !== 'object' || typeof finding.description !== 'string' || !finding.description.trim() || !['critical', 'high', 'normal', 'low'].includes(finding.severity))) throw new Error('Each finding requires description and severity (critical|high|normal|low)');
  const review = await loadArtifact(root, 'reviews', reviewId);
  if (review.status !== 'pending') throw new Error('Review already decided; create a new review');
  if (status === 'approved') await assertReviewFresh(root, config, review);
  return persist(root, 'reviews', { ...review, status, reviewer, reviewerKind, reviewedAt: date(), notes, findings });
}
export async function createBaseline(root, config, reviewId) {
  const review = await loadArtifact(root, 'reviews', reviewId);
  if (review.status !== 'approved') throw new Error('Baseline requires an approved review');
  const { manifest, verification } = await assertReviewFresh(root, config, review);
  const latest = await readJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: null });
  if (latest.id) {
    const previous = await loadArtifact(root, 'baselines', latest.id);
    if (previous.reviewId === reviewId) return previous;
  }
  const data = { schemaVersion: 1, id: id('UI'), createdAt: date(), parent: latest.id, status: 'approved', manifestId: manifest.id, manifestHash: hash(manifest), reviewId, reviewHash: hash(review), reviewer: review.reviewer, reviewerKind: review.reviewerKind ?? 'human',
    prototype: { hash: manifest.afterHash, git: manifest.git?.head ?? null }, application: { hash: verification.project.hash, git: verification.git.head }, verificationId: verification.id, verificationHash: hash(verification),
    spec: review.planning?.spec ?? null, adr: review.planning?.adr ?? null, changed: manifest.mappings, evidence: { build: verification.build.status, functional: verification.functional.status, visual: verification.visual.status, scenes: verification.visual.scenes, artifacts: verification.visual.artifacts } };
  await persist(root, 'baselines', data);
  await writeJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: data.id });
  return data;
}
export async function repair(root, config, manifestId, { execute = false, spec, adr } = {}) {
  const reports = [];
  const executions = [];
  let blockingReason = null;
  let report = await verify(root, config, manifestId);
  reports.push(report.id);
  const maximum = config.policy?.maxRepairAttempts ?? 3;
  for (let attempt = 1; report.status === 'FAIL' && execute && attempt <= maximum; attempt++) {
    try {
      const context = await createContext(root, config, manifestId, { spec, adr });
      const execution = await executeContext(root, config, context.id, { execute, repair: { attempt, verification: report } });
      executions.push(execution.id);
      if (execution.status !== 'PASS') { blockingReason = execution.result.error ?? execution.result.status; break; }
      report = await verify(root, config, manifestId);
      reports.push(report.id);
    } catch (error) { blockingReason = error.message; break; }
  }
  const review = await createReview(root, config, manifestId, report.id);
  return persist(root, 'repairs', { schemaVersion: 1, id: id('LOOP'), createdAt: date(), manifestId, maximum, reports, executions, blockingReason, status: report.status === 'PASS' ? 'READY_FOR_REVIEW' : 'NEEDS_REVIEW', reviewId: review.id });
}
