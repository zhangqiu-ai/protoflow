#!/usr/bin/env node
/*
 * ProtoFlow Claude executor bridge: Context Package on stdin → one headless `claude -p` session that may edit files and
 * run sandboxed commands inside the current worktree → the raw stream-json trace on stdout (execution evidence).
 *
 *   argv: node scripts/claude-exec-adapter.js [--model ID] [--subagent-model ID] [--max-budget-usd N] [--claude PATH] [--add-dir DIR ...]
 *
 * --subagent-model lets the session delegate independent subtasks to parallel worker subagents on that model; they keep
 * the same tools (without Agent), --restricted confinement, Bash sandbox and budget. Without it nothing changes.
 *
 * Exit 0 only when the trace is one session limited to the executor tools that completed successfully; the engine
 * still verifies the trace and every result independently. Credentials come from the inherited environment.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { executorPrompt, assertContextPackage } from '../src/executor-prompt.js';
import { resolveClaudeExecutable, claudeExecutorArgv, readClaudeTrace } from '../src/claude.js';

let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 8 * 1024 * 1024) throw new Error('Context exceeds 8 MiB'); }
const context = JSON.parse(input);
assertContextPackage(context);
const { executor = {}, ...contextPackage } = context;
const { values } = parseArgs({ options: { model: { type: 'string' }, 'subagent-model': { type: 'string' }, 'max-budget-usd': { type: 'string' }, claude: { type: 'string' }, 'add-dir': { type: 'string', multiple: true } } });
const addDirs = values['add-dir'] ?? [];
if (addDirs.some(dir => !path.isAbsolute(dir))) throw new Error('--add-dir requires absolute directories');
const claude = await resolveClaudeExecutable(values.claude ?? process.env.PROTOFLOW_CLAUDE);
const child = spawn(claude.path, claudeExecutorArgv({ model: values.model, maxBudgetUsd: values['max-budget-usd'], addDirs, subagentModel: values['subagent-model'] }), { cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'inherit'] });
let trace = '';
child.stdout.setEncoding('utf8').on('data', chunk => { trace += chunk; process.stdout.write(chunk); });
child.stdin.on('error', () => {});
child.stdin.end(executorPrompt(context, contextPackage, { subagents: Boolean(values['subagent-model']) }));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => {
  try { readClaudeTrace(trace, { executor: true }); process.exitCode = code ?? 1; }
  catch (error) { console.error(`Claude executor session rejected: ${error.message}`); process.exitCode = code || 1; }
});
