// The ProtoFlow CLI. bin/protoflow.js loads it only after src/cli-diagnostics.js has taken over Node warnings.
import { flushDiagnostics } from './cli-diagnostics.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { initProject, installSkill } from './install.js';
import { loadConfig } from './config.js';
import { startSession, checkpoint, watch, listSessions } from './sessions.js';
import { withLock, readJson, projectPath } from './util.js';
import { detectIntegrations, integrationNotices } from './integrations.js';
import { suggestMappings } from './mappings.js';
import { lintAnchors, suggestAnchorsCommand, showContract, migrateCommand } from './anchor-commands.js';
import { scanSource } from './source.js';
import { sourceView } from './streams.js';
import { startRunner, retryRunner, supersedeRunner, configureRunner, runnerStatus, doctor } from './runner.js';
import { collectRunnerWorktrees } from './runner-gc.js';
import { installService, uninstallService, serviceStatus, installDashboardService, uninstallDashboardService, dashboardServiceStatus } from './runner-service.js';
import { dashboardSnapshot, addProject, removeProject, listProjects } from './dashboard-data.js';
import { serveDashboard } from './dashboard-server.js';
import { versionQueue } from './queue.js';
import { syncDeliveries, deliveryStatus } from './delivery.js';
import { syncIssues, issuesStatus } from './issues.js';
import { createContext, prepareIntegration, executeContext, verify, createReview, decideReview, createBaseline, repair, loadArtifact } from './workflow.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const help = `ProtoFlow ${version} — shared prototype-driven engineering engine
Usage: protoflow <command> [action] --project <path> [options]
  init [--prototype-dir prototype]       Create project config + AGENTS convention
       [--repository url --branch name --path dir [--start-sha sha]]
                                         Also configure a Git prototype source
                                         (--branch and --path required with --repository)
  install [--personal] [--skip-integrations]
                                         Install the Codex Skill, then Spec Kit + BMad
                                         (argv from adapters.<id>.install; null skips)
  mappings suggest                       Draft mappings from prototype pages/resources (schemaVersion 1)
  anchors lint|suggest [--manifest id] [--patch-file path]
                                         Check data-pf anchors and sidecars / draft anchors as a patch
  contract show --manifest id            Static UI contract and scope of a frozen version
  migrate anchors [--manifest id] [--output dir]
                                         Draft v1 mappings -> anchors (patches + v2 config; nothing applied)
  source scan|status                     Fetch Git source, freeze new commits, show progress
  runner start [--once] | status | retry | configure  Foreground FIFO Codex + verification in isolated worktree
  runner retry --recover-unknown-start  Also close launch intents without a PID once no live process uses the worktree
  runner supersede                       Fold the blocked current version into the newest prototype version (a person
                                         decided the later prototype fixes it); the worktree's changes are kept
  runner gc [--apply]                    List runner worktrees; --apply archives and removes unused clean ones
  runner start --service                 Resident mode: keeps polling through blocks; stops only on SIGTERM/SIGINT
  runner service install [--env K=V] | uninstall | status
                                         macOS launchd LaunchAgent: start at login, restart on exit, heartbeat health
  dashboard snapshot | add [--label name] | remove | list
                                         Project state as JSON / register this project on the dashboard
  dashboard serve [--port 7420]          Local dashboard on 127.0.0.1: every registered project, live, with approvals
  dashboard service install [--port N] [--env K=V] | uninstall | status
                                         The dashboard as a macOS launchd LaunchAgent (start at login, restart on exit)
  delivery sync | status                 Commit accepted versions, push, open PR, merge (runner.delivery)
  delivery sync --retry-review --delivery id --review AIR-id [--target id]
                                         Explicit fresh independent review of the selected current attempt:
                                         an unattested PASS after restart, a BLOCKED attempt before approval,
                                         or a transient network BLOCK after approval/push (never a FAIL verdict)
  issues sync | status                   Triage labelled GitHub issues with the Claude planner (issues.enabled)
  doctor                                 Check Git, source, Codex, checks, Chromium and Skill
  watch [--once]                         Debounced prototype checkpoints (Ctrl+C to stop)
  session start [--label text] | list
  checkpoint [--session id] [--level L0..L3] [--summary text]
  context --manifest id [--spec path] [--adr path]
  prepare --manifest id --adapter specKit|bmad
  execute --context id [--execute]       Dry request by default
  verify --manifest id                   Build + functional + visual checks
  repair --manifest id [--execute] [--spec path] [--adr path]
  review create --manifest id --verification id
  review approve|reject|request-changes --review id --reviewer name [--notes text] [--findings file]
  review reject|request-changes --review id --reviewer ai:<model> --reviewer-kind model --model-evidence file [--model-session id]
  baseline create --review id | show [--baseline id]
  queue [--target id]                    Prototype versions in order; each target works on its 'current'
  --target id                            Selects the target for context/prepare/verify/repair/runner retry/
                                         delivery when a schemaVersion 2 project has several targets
  status                                Sessions, latest baseline, version queue, Spec Kit/BMad
All output is JSON: stdout carries the result; on failure the last stderr line is the JSON error
(earlier stderr lines are notices or diagnostics). Exit codes: 0 success, 1 error/failure, 2 NOT_RUN/NEEDS_REVIEW,
3 BLOCKED: context/prepare/execute/verify/repair target a version other than the
queue's current one; versions are accepted in checkpoint order (policy.sequentialVersions).
External commands are argv arrays, run without a shell. Nothing commits or pushes.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string', default: process.cwd() }, help: { type: 'boolean', short: 'h' }, personal: { type: 'boolean' }, 'skip-integrations': { type: 'boolean' }, once: { type: 'boolean' }, service: { type: 'boolean' }, env: { type: 'string', multiple: true }, port: { type: 'string' }, apply: { type: 'boolean' }, 'recover-unknown-start': { type: 'boolean' }, execute: { type: 'boolean' }, 'retry-review': { type: 'boolean' },
    ...Object.fromEntries(['repository', 'branch', 'path', 'start-sha', 'prototype-dir', 'source-dir', 'discovery-dir', 'label', 'session', 'level', 'summary', 'manifest', 'target', 'patch-file', 'output', 'spec', 'adr', 'adapter', 'context', 'verification', 'review', 'reviewer', 'notes', 'baseline', 'findings', 'reviewer-kind', 'model-evidence', 'model-session', 'delivery'].map(key => [key, { type: 'string' }]))
  } });
  const [command, action] = positionals;
  if (values.help || !command) { console.log(help); }
  else {
    const root = path.resolve(values.project);
    const requireOption = key => { if (!values[key]) throw new Error(`--${key} is required`); return values[key]; };
    const operation = async () => {
      if (command === 'init') return initProject(root, { prototypeDir: values['prototype-dir'], source: values.repository ? { kind: 'git', repository: values.repository, branch: requireOption('branch'), path: requireOption('path'), ...(values['start-sha'] ? { startSha: values['start-sha'] } : {}) } : undefined });
      if (command === 'install') return installSkill(root, { personal: values.personal, sourceDir: values['source-dir'], discoveryDir: values['discovery-dir'], integrations: values['skip-integrations'] ? false : undefined });
      // Proposal 0004: the dashboard spans projects; only snapshot/add/remove act on --project.
      if (command === 'dashboard') {
        const port = values.port ? Number(values.port) : 7420;
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be 1024-65535');
        const extraEnv = Object.fromEntries((values.env ?? []).map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error('--env takes KEY=VALUE'); return [pair.slice(0, at), pair.slice(at + 1)]; }));
        if (action === 'list') return { projects: await listProjects() };
        if (action === 'serve') return serveDashboard({ port, onListen: url => console.log(JSON.stringify({ event: 'listening', url })) });
        if (action === 'service') {
          const [, , operation] = positionals;
          if (operation === 'install') return installDashboardService({ port, extraEnv });
          if (operation === 'uninstall') return uninstallDashboardService();
          if (operation === 'status') return dashboardServiceStatus({ port });
          throw new Error('Use dashboard service install|uninstall|status');
        }
        if (action === 'snapshot') return dashboardSnapshot(root);
        if (action === 'add') return addProject(root, { name: values.label ?? null });
        if (action === 'remove') return removeProject(root);
        throw new Error('Use dashboard snapshot|add|remove|list|serve|service');
      }
      const config = await loadConfig(root);
      if (config.source && ['watch', 'checkpoint', 'session'].includes(command) && !(command === 'session' && action === 'list')) throw new Error('Git source configured: use source scan and runner start; local prototype edits are not application triggers');
      switch (command) {
        case 'source':
          if (action === 'scan') return scanSource(root, config);
          if (action === 'status') return sourceView(root, config);
          throw new Error('Use source scan|status');
        case 'doctor': return doctor(root, config);
        case 'runner':
          if (action === 'status') return runnerStatus(root, config);
          if (action === 'retry') return retryRunner(root, config, { target: values.target ?? null, recoverUnknownStart: values['recover-unknown-start'] === true });
          if (action === 'supersede') return supersedeRunner(root, config, { target: values.target ?? null });
          if (action === 'configure') return configureRunner(root, config);
          if (action === 'gc') return collectRunnerWorktrees(root, config, { apply: values.apply });
          if (action === 'start') {
            const controller = new AbortController();
            const stop = () => controller.abort();
            process.once('SIGINT', stop); process.once('SIGTERM', stop);
            try { return await startRunner(root, config, { once: values.once, service: values.service === true, signal: controller.signal, onEvent: event => console.log(JSON.stringify(event)) }); }
            finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
          }
          if (action === 'service') {
            const [, , operation] = positionals;
            const extraEnv = Object.fromEntries((values.env ?? []).map(pair => { const at = pair.indexOf('='); if (at < 1) throw new Error('--env takes KEY=VALUE'); return [pair.slice(0, at), pair.slice(at + 1)]; }));
            if (operation === 'install') {
              const installed = await installService(root, config, { extraEnv });
              // A resident runner appears on the dashboard without a separate step.
              if (installed.status === 'PASS') installed.dashboard = (await addProject(root)).project;
              return installed;
            }
            if (operation === 'uninstall') return uninstallService(root);
            if (operation === 'status') return serviceStatus(root);
            throw new Error('Use runner service install|uninstall|status');
          }
          throw new Error('Use runner start|status|retry|supersede|configure|gc|service');
        case 'delivery':
          if (action === 'sync') {
            if (!values['retry-review']) {
              if (values.delivery) throw new Error('--delivery is only used with --retry-review');
              return syncDeliveries(root, config, { target: values.target ?? null });
            }
            return syncDeliveries(root, config, { target: values.target ?? null, retryIndependentReview: { deliveryId: requireOption('delivery'), reviewId: requireOption('review') } });
          }
          if (action === 'status') return deliveryStatus(root, config, values.target ?? null);
          throw new Error('Use delivery sync|status');
        case 'issues':
          if (action === 'sync') return syncIssues(root, config);
          if (action === 'status') return issuesStatus(root);
          throw new Error('Use issues sync|status');
        case 'session':
          if (action === 'start') return startSession(root, config, { label: values.label });
          if (action === 'list') return listSessions(root);
          throw new Error('Use session start|list');
        case 'checkpoint': return checkpoint(root, config, { sessionId: values.session, level: values.level, summary: values.summary });
        case 'watch': {
          const controller = new AbortController();
          const stop = () => controller.abort();
          process.once('SIGINT', stop); process.once('SIGTERM', stop);
          try { return await watch(root, config, { once: values.once, signal: controller.signal, onReady: state => console.log(JSON.stringify({ event: 'ready', ...state })), onCheckpoint: manifest => console.log(JSON.stringify({ event: 'checkpoint', manifest })) }); }
          finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
        }
        case 'context': return createContext(root, config, requireOption('manifest'), { spec: values.spec, adr: values.adr, target: values.target });
        case 'prepare': return prepareIntegration(root, config, requireOption('manifest'), requireOption('adapter'), { target: values.target });
        case 'execute': return executeContext(root, config, requireOption('context'), { execute: values.execute });
        case 'verify': return verify(root, config, requireOption('manifest'), { target: values.target });
        case 'repair': return repair(root, config, requireOption('manifest'), { execute: values.execute, spec: values.spec, adr: values.adr, target: values.target });
        case 'review': {
          if (action === 'create') return createReview(root, config, requireOption('manifest'), requireOption('verification'));
          const status = { approve: 'approved', reject: 'rejected', 'request-changes': 'changes_requested' }[action];
          if (!status) throw new Error('Use review create|approve|reject|request-changes');
          const findings = values.findings ? await readJson(await projectPath(root, values.findings)) : [];
          const model = values['model-evidence'] ? { evidence: values['model-evidence'], session: values['model-session'] } : null;
          return decideReview(root, config, requireOption('review'), { status, reviewer: requireOption('reviewer'), reviewerKind: values['reviewer-kind'] ?? 'human', notes: values.notes, findings, model });
        }
        case 'baseline':
          if (action === 'create') return createBaseline(root, config, requireOption('review'));
          if (action === 'show') {
            const latest = await readJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: null });
            return values.baseline || latest.id ? loadArtifact(root, 'baselines', values.baseline ?? latest.id) : latest;
          }
          throw new Error('Use baseline create|show');
        case 'mappings':
          if (action === 'suggest') return suggestMappings(root, config);
          throw new Error('Use mappings suggest');
        case 'anchors':
          if (action === 'lint') return lintAnchors(root, config, { manifest: values.manifest });
          if (action === 'suggest') return suggestAnchorsCommand(root, config, { manifest: values.manifest, patchFile: values['patch-file'] });
          throw new Error('Use anchors lint|suggest');
        case 'contract':
          if (action === 'show') return showContract(root, config, requireOption('manifest'));
          throw new Error('Use contract show --manifest id');
        case 'migrate':
          if (action === 'anchors') return migrateCommand(root, config, { manifest: values.manifest, output: values.output });
          throw new Error('Use migrate anchors');
        case 'queue': return versionQueue(root, config, { target: values.target });
        case 'status': {
          const integrations = await detectIntegrations(root);
          return { sessions: await listSessions(root), baseline: await readJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: null }), queue: await versionQueue(root, config), integrations, notices: integrationNotices(integrations) };
        }
        default: throw new Error(`Unknown command: ${command}`);
      }
    };
    if (['init', 'install'].includes(command)) await mkdir(root, { recursive: true });
    // Design commands use their own lock so prototype versions can queue while the application pipeline runs.
    const readOnly = ['queue', 'status', 'doctor', 'contract'].includes(command) || ['source', 'runner', 'delivery', 'issues'].includes(command) && action === 'status' || command === 'anchors' && action === 'lint' || command === 'runner' && action === 'gc' && !values.apply || command === 'runner' && action === 'service' || command === 'dashboard';
    const result = readOnly || command === 'runner' && action === 'start' ? await operation() : await withLock(root, operation, ['session', 'checkpoint', 'watch'].includes(command) ? 'design' : 'active');
    flushDiagnostics();
    console.log(JSON.stringify(result, null, 2));
    // Integration reminders are for the developer at the terminal; stdout stays machine-readable JSON.
    for (const notice of result?.notices ?? []) console.error(`ProtoFlow: ${notice}`);
    if (['FAIL', 'SCAN_FAILED'].includes(result?.status)) process.exitCode = 1;
    else if (result?.status === 'BLOCKED') process.exitCode = 3;
    else if (['NOT_RUN', 'NEEDS_REVIEW'].includes(result?.status)) process.exitCode = 2;
  }
} catch (error) {
  flushDiagnostics();
  if (error.code === 'VERSION_ORDER') {
    console.error(JSON.stringify({ status: 'BLOCKED', error: error.message, queue: error.queue }));
    process.exitCode = 3;
  } else if (error.code === 'ANCHOR_LINT') {
    console.error(JSON.stringify({ status: 'ERROR', error: 'Prototype anchors are invalid', errors: error.errors }));
    process.exitCode = 1;
  } else {
    console.error(JSON.stringify({ status: 'ERROR', error: error.message }));
    process.exitCode = 1;
  }
}
