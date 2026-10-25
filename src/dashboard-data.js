import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash, readJson, writeJson, projectPath } from './util.js';
import { loadConfig } from './config.js';
import { streamTargets, loadProgress, runnerStatePath } from './streams.js';
import { deliveryStatus } from './delivery.js';
import { recordedVerdict } from './delivery-review.js';
import { HEARTBEAT, EVENTS } from './runner.js';
import { serviceStatus, STALLED_AFTER_SECONDS } from './runner-service.js';
import { diagnose, runnerStopped } from './dashboard-diagnosis.js';
import { listWaivers, waiverReviewers } from './waivers.js';

/**
 * Proposal 0004: everything the dashboard shows, read from a project's own engine state. Nothing here writes to a
 * project or depends on a Claude session; a snapshot is plain data (protoflow.dashboard/1) for any viewer.
 */
const ENGINE_VERSION = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const registryFile = home => path.join(home, '.protoflow', 'projects.json');

export async function projectId(root) { return hash(await fs.realpath(root)).slice(0, 12); }

/** The projects this machine's dashboard shows (~/.protoflow/projects.json). */
export async function listProjects({ home = os.homedir() } = {}) {
  return (await readJson(registryFile(home), { projects: [] })).projects;
}
export async function addProject(root, { home = os.homedir(), name = null } = {}) {
  const real = await fs.realpath(root);
  const config = await loadConfig(real);
  const file = registryFile(home), registry = await readJson(file, { schemaVersion: 1, projects: [] });
  const entry = { id: await projectId(real), root: real, name: name ?? config.dashboard?.name ?? path.basename(real), addedAt: new Date().toISOString() };
  registry.projects = [...registry.projects.filter(project => project.root !== real), entry].sort((a, b) => a.name.localeCompare(b.name));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, { schemaVersion: 1, projects: registry.projects });
  return { status: 'PASS', project: entry, projects: registry.projects.length };
}
export async function removeProject(root, { home = os.homedir() } = {}) {
  const real = await fs.realpath(root).catch(() => path.resolve(root));
  const file = registryFile(home), registry = await readJson(file, { schemaVersion: 1, projects: [] });
  const before = registry.projects.length;
  registry.projects = registry.projects.filter(project => project.root !== real);
  await writeJson(file, { schemaVersion: 1, projects: registry.projects });
  return { status: 'PASS', removed: before - registry.projects.length };
}

async function tail(file, bytes = 256 * 1024) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - bytes), buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      return lines.filter(Boolean);
    } finally { await handle.close(); }
  } catch { return []; }
}
const parseLines = lines => lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const short = (text, max = 160) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

/**
 * What an executor did, from its raw trace (Claude stream-json or Codex JSONL): reads, edits, commands and its own
 * words, newest last, plus totals. Unknown events are ignored, so a newer provider format degrades to fewer actions.
 */
export function traceActivity(events, { root = null } = {}) {
  const actions = [], files = new Set();
  const rel = file => root && typeof file === 'string' && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
  for (const event of events) {
    if (event.type === 'assistant') {
      for (const item of event.message?.content ?? []) {
        if (item.type === 'text' && item.text?.trim()) actions.push({ kind: 'say', text: short(item.text, 240) });
        if (item.type !== 'tool_use') continue;
        const input = item.input ?? {}, name = item.name;
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) { const file = rel(input.file_path ?? input.notebook_path); files.add(file); actions.push({ kind: name === 'Write' ? 'write' : 'edit', text: file }); }
        else if (name === 'Read') actions.push({ kind: 'read', text: rel(input.file_path) });
        else if (name === 'Bash') actions.push({ kind: 'run', text: short(input.description ? `${input.description}: ${input.command}` : input.command) });
        else if (['Grep', 'Glob'].includes(name)) actions.push({ kind: 'search', text: short(input.pattern) });
        else actions.push({ kind: 'tool', text: name });
      }
    } else if (event.type === 'item.completed' || event.type === 'item.started') {
      const item = event.item ?? {};
      if (item.type === 'command_execution' && event.type === 'item.completed') actions.push({ kind: 'run', text: short(item.command), ok: item.exit_code === undefined ? undefined : item.exit_code === 0 });
      else if (item.type === 'file_change' && event.type === 'item.completed') for (const change of item.changes ?? []) { const file = rel(change.path); files.add(file); actions.push({ kind: change.kind === 'add' ? 'write' : 'edit', text: file }); }
      else if (item.type === 'agent_message' && event.type === 'item.completed' && item.text?.trim()) actions.push({ kind: 'say', text: short(item.text, 240) });
    } else if (event.type === 'result') {
      actions.push({ kind: 'done', text: event.is_error ? short(event.result ?? 'failed') : 'finished', ok: !event.is_error });
    } else if (event.type === 'turn.completed') actions.push({ kind: 'done', text: 'finished', ok: true });
    else if (event.type === 'turn.failed') actions.push({ kind: 'done', text: short(event.error?.message ?? 'failed'), ok: false });
  }
  const count = kind => actions.filter(action => action.kind === kind).length;
  return { actions: actions.slice(-30), totals: { edits: count('edit') + count('write'), commands: count('run'), reads: count('read'), searches: count('search') }, files: [...files].filter(Boolean).slice(-20) };
}

const modelOf = argv => { const at = (argv ?? []).indexOf('--model'); return at >= 0 ? argv[at + 1] : null; };
/** Who does what: planner, executors by area and acceptor, with their models as configured. */
export function roles(config) {
  const adapters = config.adapters ?? {}, executor = config.policy?.executor ?? {};
  const executorModel = provider => modelOf(adapters[provider]?.command?.argv);
  const frontend = executor.routes?.frontend ?? executor.primary ?? 'codex', backend = executor.routes?.backend ?? executor.primary ?? 'codex';
  return {
    planner: adapters.planner?.command ? { provider: 'claude', model: modelOf(adapters.planner.command.argv) } : null,
    executors: { frontend: { provider: frontend, model: executorModel(frontend) }, backend: { provider: backend, model: executorModel(backend) }, fallback: executor.fallback ?? null },
    acceptor: adapters.independentReview?.command ? { provider: adapters.independentReview.provider ?? 'codex', model: modelOf(adapters.independentReview.command.argv) } : null
  };
}

const PHASE_STAGE = phase => phase === 'execute' ? 'execute' : /^(build|functional|visual)/.test(phase ?? '') ? 'verify' : null;
const EVENT_STAGE = { planned: 'execute', 'plan-failed': 'execute', execute: 'execute', repair: 'execute', 'execute-failed': 'execute', 'execute-retry': 'execute', 'executor-fallback': 'execute', 'issue-started': 'execute', 'issue-execute': 'execute', 'issue-repair': 'execute', 'issue-reviewed': 'deliver', 'issue-merged': 'deliver', delivered: 'deliver', reopened: 'plan', reverify: 'verify' };

async function latestVerification(roots, verificationId) {
  if (!verificationId) return null;
  for (const root of roots) {
    const report = await readJson(path.join(root, `.protoflow/verifications/${verificationId}.json`), null);
    if (report) return { report, root };
  }
  return null;
}

/** Scenes as rows: screen, state, variant, the three gating tiers plus advisory visual, reasons and screenshots. */
export function verificationSummary(report) {
  if (!report) return null;
  const images = Object.keys(report.artifactHashes ?? {}).filter(file => /\.(png|jpe?g)$/i.test(file));
  const scenes = (report.visual?.scenes ?? []).map(scene => {
    const folder = images.find(file => file.includes(`/${scene.id}/`))?.replace(/\/[^/]+$/, '') ?? null;
    const variantFolder = scene.variant ? images.find(file => file.includes(`/${scene.variant}/${scene.id}/`))?.replace(/\/[^/]+$/, '') : null;
    const dir = variantFolder ?? folder;
    const shot = name => dir && images.includes(`${dir}/${name}`) ? `${dir}/${name}` : null;
    const tiers = Object.fromEntries(['structure', 'tokens', 'layout', 'visual'].map(tier => [tier, scene.tiers?.[tier]?.status ?? 'NOT_RUN']));
    const reasons = ['structure', 'tokens', 'layout'].flatMap(tier => (scene.tiers?.[tier]?.reasons ?? []).slice(0, 2).map(reason => `${tier}: ${short(reason, 140)}`));
    // Proposal 0005: a tier that failed but passed the gate under a maintainer waiver is shown apart from PASS and FAIL.
    const waived = Object.fromEntries(['structure', 'tokens', 'layout'].filter(tier => scene.tiers?.[tier]?.waiver).map(tier => [tier, scene.tiers[tier].waiver.id]));
    return { id: scene.id, screen: scene.screen, state: scene.state, variant: scene.variant ?? null, status: scene.status, tiers, waived, waiverSkipped: (scene.waiverSkipped ?? []).map(item => ({ id: item.id, tier: item.tier, why: short(item.why, 200) })), reasons: [...(scene.reason ? [short(scene.reason, 140)] : []), ...reasons].slice(0, 3), prototype: shot('prototype.png'), application: shot('application.png') };
  });
  const variants = report.build?.variants ? Object.fromEntries(Object.entries(report.build.variants).map(([name, result]) => [name, result.status])) : null;
  return { id: report.id, createdAt: report.createdAt, manifestId: report.manifestId, status: report.status, waivers: (report.waivers ?? []).map(item => ({ id: item.id, scene: item.scene, variant: item.variant ?? null, tier: item.tier, reason: short(item.reason ?? '', 300), engineIssue: item.engineIssue ?? null })), build: report.build?.status ?? 'NOT_RUN', variants, functional: report.functional?.status ?? 'NOT_RUN', visual: report.visual?.status ?? 'NOT_RUN', scenes };
}

async function streamSnapshot(root, config, stream, events) {
  const runner = await readJson(await projectPath(root, runnerStatePath(config, stream)), null);
  const progress = await loadProgress(root, config, stream);
  const entries = progress.entries ?? [];
  const current = entries.find(entry => entry.status !== 'PASS') ?? null;
  const attempt = current?.attempts?.at(-1) ?? null;
  const running = (attempt?.processes ?? []).filter(item => item.status === 'RUNNING' && !item.completedAt).at(-1) ?? null;
  // A verification that waits for a simulator or emulator another runner holds (src/devices.js).
  const waiting = attempt?.status === 'RUNNING' && attempt.deviceWait && !attempt.deviceWait.acquiredAt ? attempt.deviceWait : null;
  const own = events.filter(event => (event.target ?? null) === stream);
  const last = own.at(-1) ?? null;
  const manifests = new Map();
  const manifestOf = async id => { if (!manifests.has(id)) manifests.set(id, await readJson(path.join(root, `.protoflow/manifests/${id}.json`), null)); return manifests.get(id); };
  // Live executor activity, read from the runner worktree while an executor runs (or just ran).
  let live = null;
  if (runner?.worktree) {
    const meta = await readJson(path.join(runner.worktree, '.protoflow/live/execute.json'), null);
    const traceFile = path.join(runner.worktree, '.protoflow/live/execute.jsonl');
    const stat = await fs.stat(traceFile).catch(() => null);
    if (meta && stat) live = { ...meta, updatedAt: stat.mtime.toISOString(), running: running?.phase === 'execute' || /issue-(execute|repair)/.test(last?.event ?? ''), ...traceActivity(parseLines(await tail(traceFile)), { root: runner.worktree }) };
  }
  let stage = 'idle';
  if (current?.status === 'BLOCKED') stage = 'blocked';
  else if (running) stage = PHASE_STAGE(running.phase) ?? 'execute';
  else if (waiting) stage = 'verify';
  else if (current || /^issue-/.test(last?.event ?? '')) stage = (last?.event === 'verified' || last?.event === 'issue-verified') ? (last.status === 'PASS' ? 'review' : 'execute') : EVENT_STAGE[last?.event] ?? (current ? 'plan' : 'idle');
  if (stage === 'deliver' && !current && last?.event !== 'issue-reviewed') stage = 'idle';
  const verificationId = attempt?.verificationId ?? current?.verificationId ?? entries.filter(entry => entry.verificationId).at(-1)?.verificationId ?? null;
  const found = await latestVerification([root, runner?.worktree].filter(Boolean), verificationId);
  const versions = [];
  for (const entry of entries.slice(-12).reverse()) {
    const manifest = await manifestOf(entry.manifestId);
    versions.push({ manifestId: entry.manifestId, sha: entry.sha, ordinal: entry.ordinal ?? null, summary: manifest?.summary ?? manifest?.source?.message ?? null, level: manifest?.level ?? null, status: entry.status, attempts: entry.attempts?.length ?? 0, planId: entry.planId ?? null, verificationId: entry.verificationId ?? null, waivers: entry.verificationId ? (await latestVerification([root, runner?.worktree].filter(Boolean), entry.verificationId))?.report.waivers?.length ?? 0 : 0, deliveryId: entry.deliveryId ?? null, completedAt: entry.completedAt ?? null, error: entry.error ? short(entry.error, 300) : null });
  }
  const deliveries = (await deliveryStatus(root, config, stream).catch(() => ({ deliveries: [] }))).deliveries.slice(-8).reverse().map(delivery => ({ id: delivery.id, status: delivery.status, pr: delivery.pr?.url ?? null, prNumber: delivery.pr?.number ?? null, commit: delivery.commit ?? null, mergeCommit: delivery.mergeCommit ?? null, versions: delivery.versions ?? [], error: delivery.error ? short(delivery.error, 300) : null, manualMerge: delivery.manualMerge ?? null, independentReviewId: delivery.independentReviewId ?? null, updatedAt: delivery.updatedAt ?? delivery.createdAt ?? null }));
  // A delivery the independent review rejected carries its findings, so a person can send the version back for repair.
  for (const delivery of deliveries) {
    const id = delivery.independentReviewId;
    if (!['BLOCKED', 'FAIL'].includes(delivery.status) || !/^AIR-[A-Za-z0-9-]+$/.test(id ?? '')) continue;
    const record = await readJson(path.join(root, `.protoflow/delivery/independent-reviews/${id}.json`), null);
    const verdict = record ? await recordedVerdict(root, record).catch(() => null) : null;
    if (verdict) delivery.review = { id, status: verdict.status, summary: verdict.summary ? short(verdict.summary, 400) : null, findings: (verdict.findings ?? []).slice(0, 8).map(item => ({ severity: item.severity ?? 'normal', file: item.file ?? null, description: short(item.description ?? item.reason ?? '', 600) })) };
  }
  return {
    target: stream, runner: runner ? { status: runner.status, worktree: runner.worktree, branch: runner.branch } : null, stage, phase: running?.phase ?? null, phaseStartedAt: running?.startedAt ?? null,
    deviceWait: waiting && !running ? { device: waiting.device, project: waiting.holder?.project ?? null, target: waiting.holder?.target ?? null, since: waiting.since } : null,
    current: current && { manifestId: current.manifestId, sha: current.sha, status: current.status, attempts: current.attempts?.length ?? 0, attemptStartedAt: attempt?.startedAt ?? null, planId: current.planId ?? null, error: current.error ? short(current.error, 400) : null, reasonCode: current.reasonCode ?? null, blockedAt: current.blockedAt ?? (current.status === 'BLOCKED' ? attempt?.completedAt ?? null : null), summary: (await manifestOf(current.manifestId))?.summary ?? null, level: (await manifestOf(current.manifestId))?.level ?? null },
    lastEvent: last, live, verification: verificationSummary(found?.report), versions, deliveries
  };
}

/** The last dashboard action a person took on each issue (hand back, answer, close), from actions.jsonl. */
async function issueActions(root) {
  const last = {};
  for (const record of parseLines(await tail(path.join(root, '.protoflow/dashboard/actions.jsonl')))) {
    if (record.status === 'PASS' && ['handback', 'answer-issue', 'close-issue'].includes(record.action) && Number.isSafeInteger(Number(record.args?.number))) last[Number(record.args.number)] = { action: record.action, at: record.at, actor: record.result?.actor ?? null };
  }
  return last;
}
async function issueSummaries(root) {
  const state = await readJson(path.join(root, '.protoflow/issues/state.json'), null);
  if (!state) return [];
  const actions = await issueActions(root);
  const out = [];
  for (const entry of Object.values(state.issues ?? {}).sort((a, b) => b.number - a.number).slice(0, 30)) {
    const snapshot = entry.snapshotId ? await readJson(path.join(root, `.protoflow/issues/snapshots/${entry.snapshotId}.json`), null) : null;
    const plan = entry.planId ? await readJson(path.join(root, `.protoflow/plans/${entry.planId}.json`), null) : null;
    out.push({
      number: entry.number, title: snapshot?.title ?? null, url: state.repository?.nameWithOwner ? `https://github.com/${state.repository.nameWithOwner}/issues/${entry.number}` : null,
      status: entry.status, reason: entry.reason ? short(entry.reason, 300) : null, area: plan?.plan?.area ?? null, level: plan?.plan?.level ?? null, summary: plan?.plan?.summary ? short(plan.plan.summary, 300) : null,
      questions: plan?.plan?.questions ?? [], snapshotId: entry.snapshotId ?? null, decidedAt: entry.decidedAt ?? null,
      // A person acted on the issue after ProtoFlow's last decision; the runner has not synced it since.
      handedBack: actions[entry.number] && (!entry.decidedAt || Date.parse(actions[entry.number].at) > Date.parse(entry.decidedAt)) ? actions[entry.number] : null,
      targets: Object.fromEntries(Object.entries(entry.targets ?? {}).map(([target, work]) => [target, { status: work.status, pr: work.pr?.url ?? null, attempts: work.attempts?.length ?? 0, executor: work.executorRoute?.primary ?? null, error: work.error ? short(work.error, 200) : null }]))
    });
  }
  return out;
}

async function pendingReviews(root, config, streams) {
  // Under autoApprove only a version that passed with maintainer waivers waits for a person (proposal 0005 D).
  const waivedOnly = config.policy?.autoApprove === true;
  const reviews = await fs.readdir(path.join(root, '.protoflow/reviews')).catch(() => []);
  const approved = new Set();
  for (const name of reviews.filter(item => item.endsWith('.json'))) {
    const review = await readJson(path.join(root, '.protoflow/reviews', name), null);
    // Decided either way: approved needs nothing more, a rejection reopens the version on the runner's next pass.
    if (review && review.status !== 'pending') approved.add(review.verificationId);
  }
  // A version whose delivery the independent review rejected is not offered for approval: it goes back for repair.
  const rejected = stream => new Set(stream.deliveries.filter(delivery => delivery.review?.status === 'FAIL').flatMap(delivery => delivery.versions));
  return streams.flatMap(stream => { const sentBack = rejected(stream); return stream.versions.filter(version => version.status === 'PASS' && version.verificationId && !approved.has(version.verificationId) && !sentBack.has(version.manifestId) && (!waivedOnly || version.waivers > 0)).map(version => ({ ...version, target: stream.target })); });
}

/** Proposal 0005: the project's waivers for the dashboard; requests wait for a reviewer in policy.waivers.reviewers. */
async function waiverSummaries(root, config) {
  const reviewers = waiverReviewers(config);
  if (!reviewers?.length) return { enabled: false, reviewers: [], waivers: [] };
  const waivers = (await listWaivers(root).catch(() => [])).slice(-40).reverse().map(waiver => ({
    id: waiver.id, status: waiver.status, target: waiver.target ?? null, scene: waiver.scene, variant: waiver.variant ?? null, tier: waiver.tier, manifestId: waiver.manifestId, verificationId: waiver.verificationId,
    findings: waiver.findings.slice(0, 20).map(item => short(item, 400)), findingCount: waiver.findings.length, reason: short(waiver.reason ?? '', 600), engineIssue: waiver.engineIssue ?? null,
    requestedBy: waiver.requestedBy, requestedAt: waiver.requestedAt, decision: waiver.decision ?? null, revocation: waiver.revocation ?? null,
    prototype: waiver.evidence?.find(file => file.endsWith('/prototype.png')) ?? null, application: waiver.evidence?.find(file => file.endsWith('/application.png')) ?? null
  }));
  return { enabled: true, reviewers, waivers };
}

/** What needs a person: blocked versions, manual merges, issues handed to a person, reviews and service health. */
/** A runner process works for the project: the supervised service, or a manual runner whose heartbeat is fresh. */
export function runnerAlive(service) {
  if (!service) return false;
  if (['HEALTHY', 'STARTING', 'DEGRADED'].includes(service.status)) return true;
  const at = Date.parse(service.heartbeat?.at ?? '');
  return Number.isFinite(at) && (Date.now() - at) / 1000 <= STALLED_AFTER_SECONDS && service.status !== 'STALLED';
}
function attention({ streams, issues, reviews, service, config, waivers }) {
  const items = [];
  for (const stream of streams) {
    if (stream.current?.status === 'BLOCKED') items.push({ kind: 'blocked-version', target: stream.target, manifestId: stream.current.manifestId, title: stream.current.summary ?? stream.current.manifestId, reason: stream.current.error, reasonCode: stream.current.reasonCode, since: stream.current.blockedAt, actions: ['retry'], ...(stream.current.reasonCode === 'needs-human' && config.adapters?.planner?.command && { canAnswer: true }) });
    for (const delivery of stream.deliveries) {
      if (delivery.status === 'PR_OPEN_MANUAL' && !delivery.manualMerge) items.push({ kind: 'manual-merge', target: stream.target, deliveryId: delivery.id, pr: delivery.pr, prNumber: delivery.prNumber, commit: delivery.commit, title: `PR #${delivery.prNumber ?? '?'}`, since: delivery.updatedAt, actions: ['merge'] });
      if (['BLOCKED', 'FAIL'].includes(delivery.status)) {
        const sendBack = delivery.review?.status === 'FAIL' && delivery.review.findings.length > 0;
        const version = stream.versions.find(item => item.manifestId === delivery.versions.at(-1));
        items.push({ kind: sendBack ? 'review-rejected' : 'delivery-blocked', target: stream.target, deliveryId: delivery.id, pr: delivery.pr, title: sendBack ? version?.summary ?? delivery.id : delivery.id, reason: sendBack ? delivery.review.summary : delivery.error, findings: sendBack ? delivery.review.findings : undefined, reviewId: delivery.review?.id, since: delivery.updatedAt, actions: sendBack ? ['request-changes'] : [] });
      }
    }
  }
  for (const issue of issues) {
    if (!['needs-human', 'blocked', 'rejected'].includes(issue.status)) continue;
    // Handed back, answered or closed: nothing waits for the person unless no runner is there to pick it up.
    if (issue.handedBack) {
      if (!runnerAlive(service)) items.push({ kind: 'issue', number: issue.number, url: issue.url, title: issue.title, status: issue.status, waiting: 'runner', handedBack: issue.handedBack, reason: issue.reason ?? issue.summary, questions: issue.questions, since: issue.handedBack.at, diagnosis: runnerStopped(service?.status), actions: [] });
      continue;
    }
    items.push({ kind: 'issue', number: issue.number, url: issue.url, title: issue.title, status: issue.status, reason: issue.reason ?? issue.summary, questions: issue.questions, since: issue.decidedAt, actions: ['answer-issue', 'handback', 'close-issue'] });
  }
  for (const review of reviews) items.push({ kind: 'review', target: review.target, manifestId: review.manifestId, verificationId: review.verificationId, title: review.summary ?? review.manifestId, waivers: review.waivers ?? 0, since: review.completedAt, actions: ['approve'] });
  for (const waiver of waivers?.waivers ?? []) if (waiver.status === 'requested') items.push({ kind: 'waiver', target: waiver.target, waiverId: waiver.id, title: `${waiver.scene}${waiver.variant ? ` / ${waiver.variant}` : ''} · ${waiver.tier}`, reason: waiver.reason, engineIssue: waiver.engineIssue, findings: waiver.findings, findingCount: waiver.findingCount, requestedBy: waiver.requestedBy, manifestId: waiver.manifestId, verificationId: waiver.verificationId, prototype: waiver.prototype, application: waiver.application, since: waiver.requestedAt, actions: ['approve-waiver', 'reject-waiver'] });
  if (service && ['DEGRADED', 'STALLED', 'DOWN'].includes(service.status)) items.push({ kind: 'service', status: service.status, title: `Runner ${service.status}`, reason: service.reason ?? null, since: service.heartbeat?.lastFailure?.at, actions: [] });
  // A version waits to run (retried, or stopped mid-pass) and no runner will run it: say so instead of a stage that looks live.
  const waitingStreams = streams.filter(stream => stream.stopped);
  if (waitingStreams.length && !items.some(item => item.kind === 'service')) items.push({ kind: 'service', status: service?.status ?? 'NOT_INSTALLED', title: 'Runner 沒在跑', reason: `${waitingStreams.map(stream => stream.target ?? 'application').join('、')} 有版本等 runner 執行`, since: service?.heartbeat?.at ?? null, actions: [] });
  // A blocked item says what to do about it: by its runner reasonCode first, else when its reason is a known failure.
  for (const item of items) if (['blocked-version', 'delivery-blocked', 'service'].includes(item.kind) || item.kind === 'issue' && item.status === 'blocked' && !item.waiting) item.diagnosis = diagnose(item.reason, item.reasonCode);
  for (const item of items) if (item.kind === 'service' && !item.diagnosis && !runnerAlive(service)) item.diagnosis = runnerStopped(service?.status, 'version');
  // How long each item has waited for a person, when it is known.
  for (const item of items) item.since ??= null;
  return items;
}

async function adrStatus(root, config) {
  if (!config.runner?.adr) return null;
  const text = await fs.readFile(path.join(root, config.runner.adr), 'utf8').catch(() => null);
  if (!text) return { path: config.runner.adr, status: 'missing' };
  try { const adr = JSON.parse(text); return { path: config.runner.adr, status: adr.status ?? 'unknown', reviewer: adr.reviewer ?? null, manifestHash: adr.manifestHash ?? null, decision: adr.decision ? short(adr.decision, 600) : null }; }
  catch { return { path: config.runner.adr, status: 'unreadable' }; }
}

/** The whole dashboard view of one project. `service: false` skips the launchd query (tests, other systems). */
/** The runner's health for a project: the supervised service when asked for, else its heartbeat. */
export async function runnerHealth(root, { service = process.platform === 'darwin', health: knownHealth } = {}) {
  const heartbeat = await readJson(path.join(root, HEARTBEAT), null);
  // A caller polling many projects passes the service health it already knows (launchctl is a subprocess).
  const health = knownHealth !== undefined ? knownHealth : service ? await serviceStatus(root).catch(error => ({ status: 'UNKNOWN', reason: error.message })) : null;
  return { heartbeat, summary: health ?? (heartbeat ? { status: 'HEARTBEAT', heartbeat, beatAgeSeconds: Math.round((Date.now() - Date.parse(heartbeat.at)) / 1000) } : { status: 'NOT_INSTALLED' }) };
}
export async function dashboardSnapshot(root, { service = process.platform === 'darwin', health: knownHealth, eventCount = 60 } = {}) {
  const real = await fs.realpath(root);
  const config = await loadConfig(real);
  const events = parseLines(await tail(path.join(real, EVENTS)));
  const streams = [];
  for (const stream of streamTargets(config)) streams.push(await streamSnapshot(real, config, stream, events));
  const issues = await issueSummaries(real);
  const reviews = await pendingReviews(real, config, streams);
  const waivers = await waiverSummaries(real, config);
  const { heartbeat, summary } = await runnerHealth(real, { service, health: knownHealth });
  // A stage read from the last event is not live when no runner is running: the lane says it stopped.
  if (!runnerAlive({ heartbeat, ...summary })) for (const stream of streams) if (!['idle', 'blocked'].includes(stream.stage)) stream.stopped = true;
  return {
    protocol: 'protoflow.dashboard/1', engineVersion: ENGINE_VERSION, generatedAt: new Date().toISOString(),
    project: { id: await projectId(real), root: real, name: config.dashboard?.name ?? path.basename(real), targets: (config.targets ?? [{ id: 'application', platform: 'web' }]).map(target => ({ id: target.id, platform: target.platform })), delivery: config.runner?.delivery ? { baseBranch: config.runner.delivery.baseBranch, merge: config.runner.delivery.merge ?? 'auto' } : null, autoApprove: config.policy?.autoApprove === true, issues: config.issues?.enabled === true },
    roles: roles(config),
    service: { status: summary.status, pid: summary.pid ?? summary.heartbeat?.pid ?? null, version: summary.heartbeat?.version ?? null, beatAgeSeconds: summary.beatAgeSeconds ?? null, failingPasses: summary.heartbeat?.failingPasses ?? 0, lastFailure: summary.heartbeat?.lastFailure ?? null, reason: summary.reason ?? null },
    streams, issues, adr: await adrStatus(real, config), waivers,
    attention: attention({ streams, issues, reviews, service: summary, config, waivers }),
    events: events.slice(-eventCount).reverse()
  };
}
