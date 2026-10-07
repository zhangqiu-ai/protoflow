import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createContext, executeContext, verify, loadArtifact } from './workflow.js';
import { versionQueue } from './queue.js';
import { loadVersion } from './versions.js';
import { git, scanSource, sourceStatus, saveSourceState, validateSource } from './source.js';
import { assertDelivered, syncDeliveries } from './delivery.js';
import { fingerprint, hash, projectPath, readJson, writeJson, runCommand, withLock, id, processGroupAlive } from './util.js';

const runnerPath = '.protoflow/runner/state.json';
export async function runnerStatus(root) {
  return { source: await sourceStatus(root), runner: await readJson(await projectPath(root, runnerPath), null) };
}
async function saveRunner(root, runner) { await writeJson(await projectPath(root, runnerPath), runner); }
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
async function ensureWorktree(root, config, { signal } = {}) {
  let runner = await readJson(await projectPath(root, runnerPath), null);
  if (runner && ['INITIALIZING', 'SETUP_FAILED'].includes(runner.status) && !runner.setupCompletedAt && (runner.setupStartedAt || runner.setupPid !== undefined)) {
    if (!Number.isSafeInteger(runner.setupPid) || runner.setupPid <= 0) throw new Error('Runner setup launch has unknown PID; inspect possible subprocesses before manual recovery');
    if (processGroupAlive(runner.setupPgid ?? runner.setupPid)) throw new Error(`Runner setup process group ${runner.setupPid} is still active; stop it and inspect its evidence before recovery`);
  }
  const worktree = await projectPath(root, `.protoflow/runner/worktree-${hash(config.source).slice(0, 12)}`);
  if (runner && !['INITIALIZING', 'SETUP_FAILED'].includes(runner.status)) {
    if (runner.worktree !== worktree) throw new Error('Runner worktree identity changed');
    const current = (await git(worktree, ['rev-parse', '--show-toplevel'])).trim();
    if (await fs.realpath(current) !== await fs.realpath(worktree)) throw new Error('Runner checkout is not its recorded worktree');
    if (hash(config) !== runner.configHash) throw new Error('Runner config changed; run runner configure after inspecting the failure');
    return runner;
  }
  const base = runner?.base ?? (await git(root, ['rev-parse', `${config.runner?.applicationRef ?? 'HEAD'}^{commit}`])).trim();
  const seed = await fingerprint(root, { exclude: [config.prototypeDir] });
  const branch = runner?.branch ?? `protoflow-runner-${id('local').toLowerCase()}`;
  runner = { schemaVersion: 1, worktree, branch, base, configHash: hash(config), seedHash: seed.hash, status: 'INITIALIZING', createdAt: new Date().toISOString() };
  await saveRunner(root, runner);
  try { await fs.access(path.join(worktree, '.git')); }
  catch { await git(root, ['worktree', 'add', '-b', branch, worktree, base]); }
  // Preserve the user's dirty index and files: copy the current content into an isolated checkout.
  for (const relative of Object.keys(seed.files).filter(file => !file.endsWith(':target'))) {
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
    if (!(relative in seed.files)) await fs.rm(await projectPath(worktree, relative), { force: true });
  }
  await fs.mkdir(await projectPath(worktree, config.prototypeDir), { recursive: true });
  if (config.runner?.setup) {
    const result = await runCommand(worktree, config.runner.setup, null, {
      signal, onBeforeSpawn: async () => {
        runner.setupStatus = 'STARTING'; runner.setupStartedAt = new Date().toISOString();
        runner.setupPid = null; runner.setupPgid = null; runner.setupSpawned = null; runner.setupCompletedAt = null;
        await saveRunner(root, runner);
      },
      onStart: async pid => { runner.setupStatus = 'RUNNING'; runner.setupPid = pid; runner.setupPgid = pid; runner.setupSpawned = true; await saveRunner(root, runner); }
    });
    runner.setup = result; runner.setupStatus = result.status; runner.setupSpawned = result.spawned;
    if (!result.processGroupActive) runner.setupCompletedAt = new Date().toISOString();
    if (result.processGroupActive || result.status !== 'PASS') { runner.status = 'SETUP_FAILED'; await saveRunner(root, runner); throw new Error(`Runner setup failed: ${result.stderr || result.error}`); }
  }
  runner.status = 'IDLE'; await saveRunner(root, runner);
  return runner;
}
async function syncCheckpoints(root, worktree, state, config) {
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
async function exportEvidence(root, worktree, report) {
  for (const [relative, expected] of Object.entries(report.artifactHashes)) {
    const source = await projectPath(worktree, relative);
    if (hash(await fs.readFile(source)) !== expected) throw new Error(`Verification artifact changed: ${relative}`);
    const target = await projectPath(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
  }
  await writeJson(await projectPath(root, `.protoflow/verifications/${report.id}.json`), { ...report, runnerWorktree: worktree });
}

/** One source stream, one isolated application worktree, one bounded FIFO executor. No implicit commits or approval. */
export async function runOnce(root, config, { signal, onEvent = () => {} } = {}) {
  if (config.policy?.sequentialVersions === false) throw new Error('Git runner requires sequentialVersions');
  if (signal?.aborted) return { status: 'STOPPED' };
  // Commit earlier accepted versions first (before reading state) so every commit holds a single version.
  try { await assertDelivered(root, config); }
  catch (error) { return { status: 'BLOCKED', reason: error.message }; }
  const state = await sourceStatus(root);
  if (state.status === 'HISTORY_REWRITTEN') throw new Error(state.error);
  if (!state.entries.length) return { status: 'IDLE', reason: 'No scanned checkpoints' };
  const entry = state.entries.find(item => item.status !== 'PASS');
  // Old unfinished browser/process rows must block setup and PASS reconciliation too.
  try { for (const previous of state.entries) assertNoActiveProcesses(previous); }
  catch (error) {
    if (entry) { entry.status = 'BLOCKED'; entry.error = error.message; await saveSourceState(root, state); }
    return { status: 'BLOCKED', manifestId: entry?.manifestId, sha: entry?.sha, reason: error.message };
  }
  if (!entry) {
    // A crash can save source PASS just before the runner's final state write.
    const runner = await readJson(await projectPath(root, runnerPath), null);
    if (runner?.status === 'RUNNING') {
      runner.status = 'IDLE'; runner.current = null; await saveRunner(root, runner);
    }
    // Retry pending pushes, pull requests and merges while idle.
    const delivery = runner?.worktree ? await syncDeliveries(root, config, { worktree: runner.worktree }) : undefined;
    return { status: 'IDLE', completedSha: state.completedSha, ...(delivery && { delivery }) };
  }
  if (['BLOCKED', 'STOPPED', 'RUNNING'].includes(entry.status)) return { status: 'BLOCKED', manifestId: entry.manifestId, reason: entry.status === 'RUNNING' ? 'Interrupted execution; inspect evidence and run runner retry' : entry.error };
  if (!config.adapters?.codex?.command) return { status: 'NOT_RUN', reason: 'Codex adapter is not configured' };
  let runner;
  try { runner = await ensureWorktree(root, config, { signal }); }
  catch (error) { if (signal?.aborted) return { status: 'STOPPED', reason: error.message }; throw error; }
  if (signal?.aborted) return { status: 'STOPPED' };
  if (runner.status === 'SETUP_FAILED' || runner.status === 'INITIALIZING') throw new Error(`Runner requires initialization recovery: ${runner.status}`);
  await syncCheckpoints(root, runner.worktree, state, config);
  const queue = await versionQueue(runner.worktree, config);
  // Reconcile a crash after independent verification passed but before source progress was saved.
  const version = queue.versions.find(item => item.id === entry.manifestId);
  if (version?.acceptedBy) {
    const report = await loadArtifact(runner.worktree, 'verifications', version.acceptedBy);
    if (report.project.hash !== (await fingerprint(runner.worktree, { exclude: [config.prototypeDir] })).hash) throw new Error('Interrupted PASS evidence has stale application content');
    await loadVersion(runner.worktree, config, await loadArtifact(root, 'manifests', entry.manifestId));
    await exportEvidence(root, runner.worktree, report);
    entry.status = 'PASS'; entry.verificationId = report.id; entry.completedAt = new Date().toISOString(); entry.error = null;
    state.completedSha = entry.sha; runner.status = 'IDLE'; runner.current = null;
    await saveSourceState(root, state); await saveRunner(root, runner);
    const delivery = await syncDeliveries(root, config, { worktree: runner.worktree });
    return { status: 'PASS', manifestId: entry.manifestId, sha: entry.sha, verificationId: report.id, recovered: true, delivery };
  }
  if (queue.current?.id !== entry.manifestId) throw new Error(`Runner queue mismatch: expected ${entry.manifestId}, got ${queue.current?.id}`);
  entry.status = 'RUNNING'; entry.startedAt = new Date().toISOString();
  runner.status = 'RUNNING'; runner.current = entry.manifestId;
  await saveSourceState(root, state); await saveRunner(root, runner);
  let report = null, currentAttempt = null;
  try {
    const maximum = config.policy?.maxRepairAttempts ?? 3;
    for (let attempt = 0; attempt <= maximum; attempt++) {
      if (signal?.aborted) throw new Error('STOPPED: runner was interrupted');
      assertNoActiveProcesses(entry);
      const context = await createContext(runner.worktree, config, entry.manifestId, { spec: config.runner?.spec, adr: config.runner?.adr });
      const record = { attempt, contextId: context.id, startedAt: new Date().toISOString(), status: 'RUNNING', processes: [] };
      currentAttempt = record;
      entry.attempts.push(record); await saveSourceState(root, state);
      await onEvent({ event: attempt ? 'repair' : 'execute', sha: entry.sha, manifestId: entry.manifestId, attempt, worktree: runner.worktree });
      const processStarting = async phase => {
        record.processes.push({ phase, pid: null, pgid: null, spawned: null, status: 'STARTING', startedAt: new Date().toISOString() });
        await saveSourceState(root, state);
      };
      const processStarted = async (phase, pid) => {
        const child = record.processes.find(item => item.phase === phase && item.status === 'STARTING' && !item.completedAt);
        if (!child) throw new Error(`Missing ${phase} launch intent`);
        child.pid = pid; child.pgid = pid; child.spawned = true; child.status = 'RUNNING';
        await saveSourceState(root, state);
      };
      const processFinished = async (phase, pid, result) => {
        const child = record.processes.find(item => item.phase === phase && item.pid === (pid ?? null) && !item.completedAt);
        if (child) {
          if (!result.processGroupActive) child.completedAt = new Date().toISOString();
          child.status = result.status; child.spawned = result.spawned ?? child.spawned; child.error = result.error ?? null; child.processGroupActive = result.processGroupActive ?? false;
        }
        await saveSourceState(root, state);
      };

      const execution = await executeContext(runner.worktree, config, context.id, {
        execute: true, repair: attempt ? { attempt, verification: report } : null, signal,
        onBeforeSpawn: () => processStarting('execute'),
        onStart: async pid => { record.pid = pid; await processStarted('execute', pid); }
      });
      record.executionId = execution.id; record.executionStatus = execution.status;
      await processFinished('execute', record.pid, { ...execution.result, status: execution.status });
      if (execution.result.processGroupActive) {
        const error = new Error('Executor subprocess group remains active; stop it before verification or repair');
        error.code = 'PROCESS_GROUP_ACTIVE'; error.phase = 'execute'; error.result = execution.result;
        throw error;
      }

      await saveSourceState(root, state);
      if (signal?.aborted) throw new Error('STOPPED: runner was interrupted');
      if (execution.status !== 'PASS') {
        let diagnostic = execution.result.error;
        for (const line of execution.result.stdout.split('\n')) {
          try { const event = JSON.parse(line); if (event.type === 'turn.failed' || event.type === 'error') diagnostic = event.error?.message ?? event.message; } catch { /* retain execution evidence */ }
        }
        throw new Error(`Codex execution ${execution.status} (${execution.id}, exit ${execution.result.exitCode}): ${(diagnostic || execution.result.stderr || 'see execution evidence').slice(-1000)}`);
      }
      report = await verify(runner.worktree, config, entry.manifestId, { signal, onBeforeSpawn: processStarting, onStart: processStarted, onFinish: processFinished });
      record.verificationId = report.id; record.status = report.status; record.completedAt = new Date().toISOString();
      await saveSourceState(root, state);
      await onEvent({ event: 'verified', sha: entry.sha, manifestId: entry.manifestId, verificationId: report.id, status: report.status });
      if (signal?.aborted) throw new Error('STOPPED: runner was interrupted');
      if (report.status === 'PASS') break;
      if (report.status === 'NOT_RUN') throw new Error('Verification NOT_RUN; configure all checks before retry');
    }
    if (report?.status !== 'PASS') throw new Error(`Repair limit exhausted (${config.policy?.maxRepairAttempts ?? 3})`);
    await exportEvidence(root, runner.worktree, report);
    entry.status = 'PASS'; entry.verificationId = report.id; entry.completedAt = new Date().toISOString(); entry.error = null;
    state.completedSha = entry.sha; runner.status = 'IDLE'; runner.current = null;
    await saveSourceState(root, state); await saveRunner(root, runner);
    const delivery = await syncDeliveries(root, config, { worktree: runner.worktree });
    await onEvent({ event: 'delivered', sha: entry.sha, ...delivery });
    return { status: 'PASS', manifestId: entry.manifestId, sha: entry.sha, verificationId: report.id, worktree: runner.worktree, delivery };
  } catch (error) {
    if (currentAttempt) {
      if (currentAttempt.status === 'RUNNING' || signal?.aborted) currentAttempt.status = signal?.aborted ? 'STOPPED' : 'FAIL';
      currentAttempt.completedAt ??= new Date().toISOString();
      currentAttempt.error = error.message;
      if (['PROCESS_GROUP_ACTIVE', 'PROCESS_START_UNKNOWN'].includes(error.code)) currentAttempt.processFailure = { code: error.code, phase: error.phase, result: error.result ?? null };
    }
    entry.status = signal?.aborted ? 'STOPPED' : 'BLOCKED'; entry.error = error.message;
    runner.status = entry.status;
    await saveSourceState(root, state); await saveRunner(root, runner);
    return { status: 'BLOCKED', manifestId: entry.manifestId, sha: entry.sha, reason: error.message, worktree: runner.worktree };
  }
}
export async function retryRunner(root) {
  const state = await sourceStatus(root);
  const current = state.entries.find(entry => entry.status !== 'PASS');
  if (!current || !['BLOCKED', 'STOPPED', 'RUNNING'].includes(current.status)) throw new Error('No blocked/interrupted current version to retry');
  for (const previous of state.entries) assertNoActiveProcesses(previous);
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
  current.retries = [...(current.retries ?? []), { previousStatus: current.status, reason: current.error ?? 'Interrupted', at: new Date().toISOString() }];
  current.status = 'PENDING'; current.error = null;
  await saveSourceState(root, state);
  return { status: 'PASS', current: current.manifestId, next: 'runner start --once' };
}
/** Explicit operational configuration recovery; frozen source/routing ownership stays fixed. */
export async function configureRunner(root, config) {
  const runner = await readJson(await projectPath(root, runnerPath), null);
  if (!runner) return { status: 'PASS', reason: 'No worktree yet; next start uses the current config' };
  const state = await sourceStatus(root);
  if (runner.status === 'RUNNING' || state.entries.some(entry => entry.status === 'RUNNING')) throw new Error('Stop the runner and inspect interrupted execution before reconfiguring');
  for (const previous of state.entries) assertNoActiveProcesses(previous);
  const old = await readJson(await projectPath(runner.worktree, 'protoflow.config.json'));
  const routing = value => ({ source: value.source, prototypeDir: value.prototypeDir, mappings: value.mappings.map(mapping => ({ id: mapping.id, prototypeFiles: mapping.prototypeFiles })) });
  if (hash(routing(old)) !== hash(routing(config))) throw new Error('Cannot change source/prototypeDir/mapping ownership in an existing stream');
  const current = state.entries.find(entry => entry.status !== 'PASS');
  if (current && (await versionQueue(runner.worktree, old)).versions.find(version => version.id === current.manifestId)?.acceptedBy) throw new Error('Recover the interrupted PASS with the original config before reconfiguring');
  runner.configurationHistory = [...(runner.configurationHistory ?? []), { previousHash: runner.configHash, configHash: hash(config), previousConfig: old, updatedAt: new Date().toISOString() }];
  await writeJson(await projectPath(runner.worktree, 'protoflow.config.json'), config);
  runner.configHash = hash(config); await saveRunner(root, runner);
  return { status: 'PASS', worktree: runner.worktree, configHash: runner.configHash, next: current ? 'runner retry, then runner start' : 'runner start' };
}
export async function startRunner(root, config, { once = false, signal, onEvent = () => {} } = {}) {
  return withLock(root, async () => {
    let last = { status: 'IDLE' };
    while (!signal?.aborted) {
      let scanError = null;
      try { const scan = await withLock(root, () => scanSource(root, config)); await onEvent({ event: 'scanned', tip: scan.tip, added: scan.added }); }
      catch (error) { scanError = error.message; await onEvent({ event: 'scan-failed', error: error.message }); if (error.code === 'SOURCE_HISTORY_REWRITTEN') throw error; }
      if (signal?.aborted) return { status: 'STOPPED' };
      do { last = await withLock(root, () => runOnce(root, config, { signal, onEvent })); }
      while (last.status === 'PASS' && !signal?.aborted);
      if (once || last.status === 'BLOCKED' || last.status === 'NOT_RUN') return scanError && last.status === 'IDLE' ? { ...last, status: 'SCAN_FAILED', reason: scanError } : last;
      try { await delay(config.runner?.pollMs ?? 15000, undefined, { signal }); } catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    return { status: 'STOPPED' };
  }, 'runner');
}

export async function doctor(root, config) {
  const checks = [];
  const check = async (name, action) => { try { checks.push({ name, status: 'PASS', detail: await action() }); } catch (error) { checks.push({ name, status: 'FAIL', detail: error.message }); } };
  await check('source', () => { validateSource(config.source); return `${config.source.repository}#${config.source.branch}:${config.source.path}`; });
  await check('git', () => git(root, ['rev-parse', 'HEAD']));
  await check('codex', async () => {
    if (!config.adapters?.codex?.command) throw new Error('Configure adapters.codex.command argv; built-in adapter: scripts/codex-adapter.js');
    const result = await runCommand(root, { argv: ['codex', '--version'] });
    if (result.status !== 'PASS') throw new Error(result.stderr || 'Codex unavailable'); return result.stdout.trim();
  });
  await check('verification', () => {
    if (!config.verification?.build || !config.verification?.functional || !config.visual?.scenes?.length) throw new Error('Build, functional (Playwright), and visual scenes are required');
    if (!config.mappings.length) throw new Error('Configure prototype/application mappings');
    if (config.policy?.sequentialVersions === false) throw new Error('Runner requires FIFO');
    return 'build + functional + visual configured';
  });
  await check('chromium', async () => { const browser = await chromium.launch(); await browser.close(); return 'launch OK'; });
  await check('skill', async () => { await fs.access(await projectPath(root, '.agents/skills/protoflow/SKILL.md')); return 'installed'; });
  return { status: checks.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL', checks, engine: fileURLToPath(new URL('../', import.meta.url)), progress: await runnerStatus(root) };
}
