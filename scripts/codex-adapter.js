#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { executorPrompt, assertContextPackage } from '../src/executor-prompt.js';
import { contextSizes } from '../src/context-budget.js';

// Protocol bridge: structured engine context -> noninteractive Codex stdin.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8 * 1024 * 1024) throw new Error('Context exceeds 8 MiB');
}
const context = JSON.parse(input);
assertContextPackage(context);
// `executor` carries engine options for this bridge (adapters.codex.ignoreUserConfig), not Context Package data.
const { executor = {}, ...contextPackage } = context;
const prompt = executorPrompt(context, contextPackage);
// Codex rejects prompts above 1,048,576 characters; name the largest Context Package fields instead of failing remotely.
const CODEX_INPUT_LIMIT = 1048576;
if (prompt.length > CODEX_INPUT_LIMIT) {
  throw new Error(`Context Package is ${prompt.length} characters, above the Codex input limit of ${CODEX_INPUT_LIMIT}; largest fields: ${contextSizes(contextPackage).map(([key, size]) => `${key} (${size})`).join(', ')}`);
}
const { values } = parseArgs({ options: { model: { type: 'string' }, ephemeral: { type: 'boolean' }, 'ignore-user-config': { type: 'boolean' }, 'add-dir': { type: 'string', multiple: true }, network: { type: 'boolean' } } });
// Toolchains that write outside the project (Flutter's SDK cache and ~/.dart-tool) need explicit extra writable roots;
// `flutter test` also binds 127.0.0.1, which the workspace-write sandbox only allows together with network access.
const extraDirs = values['add-dir'] ?? [];
if (extraDirs.some(dir => !path.isAbsolute(dir))) throw new Error('--add-dir requires absolute directories');
const sandbox = [...extraDirs.flatMap(dir => ['--add-dir', dir]), ...(values.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : [])];
// Isolation keeps $CODEX_HOME/config.toml (memories, model, provider, MCP, profiles) out of the run and its JSONL trace,
// which the independent reviewer later reads. Login still comes from CODEX_HOME. Memories are disabled explicitly as well.
const isolated = values['ignore-user-config'] === true || executor.ignoreUserConfig === true;
const isolation = isolated ? ['--ignore-user-config', '-c', 'features.memories=false', '-c', 'approval_policy="never"'] : [];
const argv = ['exec', '--json', '--sandbox', 'workspace-write', ...sandbox, ...isolation, ...(values.model ? ['--model', values.model] : []), ...(values.ephemeral ? ['--ephemeral'] : []), '-'];
const child = spawn('codex', argv, { stdio: ['pipe', 'inherit', 'inherit'], shell: false });
child.stdin.on('error', () => {});
child.stdin.end(prompt);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
