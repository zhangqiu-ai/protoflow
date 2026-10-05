#!/usr/bin/env node
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { initProject, installSkill } from '../src/install.js';
import { loadConfig } from '../src/config.js';
import { startSession, checkpoint, watch, listSessions } from '../src/sessions.js';
import { withLock, readJson, projectPath } from '../src/util.js';
import { createContext, prepareIntegration, executeContext, verify, createReview, decideReview, createBaseline, repair, loadArtifact } from '../src/workflow.js';

const help = `ProtoFlow 0.1 — shared prototype-driven engineering engine
Usage: protoflow <command> [action] --project <path> [options]
  init [--prototype-dir prototype]       Create project config + AGENTS convention
  install [--personal]                   Install instruction-only Codex Skill
  watch [--once]                         Debounced prototype checkpoints (Ctrl+C to stop)
  session start [--label text] | list
  checkpoint [--session id] [--level L0..L3] [--summary text]
  context --manifest id [--spec path] [--adr path]
  prepare --manifest id --adapter specKit|bmad
  execute --context id [--execute]       Dry request by default
  verify --manifest id                   Build + functional + visual checks
  repair --manifest id [--execute] [--spec path] [--adr path]
  review create --manifest id --verification id
  review approve|reject|request-changes --review id --reviewer name [--notes text]
  baseline create --review id | show [--baseline id]
  status                                List sessions + latest baseline
All output is JSON. Exit codes: 0 success, 1 error/failure, 2 NOT_RUN/NEEDS_REVIEW.
External commands are argv arrays, run without a shell. Nothing commits or pushes.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    project: { type: 'string', default: process.cwd() }, help: { type: 'boolean', short: 'h' }, personal: { type: 'boolean' }, once: { type: 'boolean' }, execute: { type: 'boolean' },
    ...Object.fromEntries(['prototype-dir', 'source-dir', 'discovery-dir', 'label', 'session', 'level', 'summary', 'manifest', 'spec', 'adr', 'adapter', 'context', 'verification', 'review', 'reviewer', 'notes', 'baseline', 'findings'].map(key => [key, { type: 'string' }]))
  } });
  const [command, action] = positionals;
  if (values.help || !command) { console.log(help); }
  else {
    const root = path.resolve(values.project);
    const requireOption = key => { if (!values[key]) throw new Error(`--${key} is required`); return values[key]; };
    const operation = async () => {
      if (command === 'init') return initProject(root, { prototypeDir: values['prototype-dir'] });
      if (command === 'install') return installSkill(root, { personal: values.personal, sourceDir: values['source-dir'], discoveryDir: values['discovery-dir'] });
      const config = await loadConfig(root);
      switch (command) {
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
        case 'context': return createContext(root, config, requireOption('manifest'), { spec: values.spec, adr: values.adr });
        case 'prepare': return prepareIntegration(root, config, requireOption('manifest'), requireOption('adapter'));
        case 'execute': return executeContext(root, config, requireOption('context'), { execute: values.execute });
        case 'verify': return verify(root, config, requireOption('manifest'));
        case 'repair': return repair(root, config, requireOption('manifest'), { execute: values.execute, spec: values.spec, adr: values.adr });
        case 'review': {
          if (action === 'create') return createReview(root, config, requireOption('manifest'), requireOption('verification'));
          const status = { approve: 'approved', reject: 'rejected', 'request-changes': 'changes_requested' }[action];
          if (!status) throw new Error('Use review create|approve|reject|request-changes');
          const findings = values.findings ? await readJson(await projectPath(root, values.findings)) : [];
          return decideReview(root, config, requireOption('review'), { status, reviewer: requireOption('reviewer'), notes: values.notes, findings });
        }
        case 'baseline':
          if (action === 'create') return createBaseline(root, config, requireOption('review'));
          if (action === 'show') {
            const latest = await readJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: null });
            return values.baseline || latest.id ? loadArtifact(root, 'baselines', values.baseline ?? latest.id) : latest;
          }
          throw new Error('Use baseline create|show');
        case 'status': return { sessions: await listSessions(root), baseline: await readJson(await projectPath(root, '.protoflow/baselines/latest.json'), { id: null }) };
        default: throw new Error(`Unknown command: ${command}`);
      }
    };
    if (['init', 'install'].includes(command)) await mkdir(root, { recursive: true });
    const result = await withLock(root, operation);
    console.log(JSON.stringify(result, null, 2));
    if (result?.status === 'FAIL') process.exitCode = 1;
    else if (['NOT_RUN', 'NEEDS_REVIEW'].includes(result?.status)) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'ERROR', error: error.message }));
  process.exitCode = 1;
}
