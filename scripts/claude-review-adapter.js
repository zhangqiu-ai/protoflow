#!/usr/bin/env node
/*
 * ProtoFlow Claude acceptor for the independent review gate (proposal 0003): the same bound request and run protocol as
 * scripts/codex-review-adapter.js, answered by one fresh, read-only, schema-bound `claude -p` session.
 *
 *   argv: node scripts/claude-review-adapter.js [--model ID] [--max-budget-usd N]
 *
 * Tests replace only the claude executable (PROTOFLOW_CLAUDE or PATH) and identify themselves as fixtures.
 */
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { hash } from '../src/util.js';
import { reviewPrompt } from '../src/review-prompt.js';
import { reviewVerdictSchema, assertStructuredVerdict } from '../src/delivery-review.js';
import { resolveClaudeExecutable, readClaudeTrace, claudeArgv } from '../src/claude.js';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) { input += chunk; if (input.length > 4 * 1024 * 1024) throw new Error('Independent review request exceeds 4 MiB'); }
const request = JSON.parse(input);
if (request.protocol !== 'protoflow.independent-review-request/1' || !/^AIR-[A-Za-z0-9-]+$/.test(request.id ?? '') || hash(request.binding) !== request.bindingHash) throw new Error('Expected an exact bound independent review request');
const { values } = parseArgs({ options: { model: { type: 'string' }, 'max-budget-usd': { type: 'string' } } });
let providerTrace = '', providerExitCode = null, providerExecutable = null;
try {
  providerExecutable = await resolveClaudeExecutable();
  if (hash(providerExecutable) !== hash(request.binding.providerExecutable)) throw new Error('Resolved Claude executable differs from the bound path/file SHA256');
  const schema = structuredClone(reviewVerdictSchema);
  schema.properties.requestId.const = request.id; schema.properties.bindingHash.const = request.bindingHash;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(providerExecutable.path, claudeArgv({ schema, model: values.model, maxBudgetUsd: values['max-budget-usd'] }), { cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let trace = '', stderr = '', overflow = false;
    const guard = () => { if (trace.length + stderr.length > 3 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } };
    child.stdout.setEncoding('utf8').on('data', chunk => { trace += chunk; guard(); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; guard(); });
    child.stdin.on('error', () => {}); child.stdin.end(reviewPrompt(request));
    child.once('error', reject); child.once('close', code => resolve({ code, trace, stderr, overflow }));
  });
  providerTrace = result.trace; providerExitCode = result.code;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.overflow) throw new Error('Claude independent review output exceeded the bridge limit');
  const parsed = readClaudeTrace(result.trace);
  if (result.code !== 0) throw new Error(`Claude independent review exited ${result.code} after its result`);
  assertStructuredVerdict(parsed.output, request);
  if (hash(await resolveClaudeExecutable()) !== hash(providerExecutable)) throw new Error('Claude executable changed during independent review');
  console.log(JSON.stringify({ protocol: 'protoflow.independent-review-run/1', requestId: request.id, bindingHash: request.bindingHash, provider: 'claude', providerExecutable, sandbox: 'read-only', freshSession: true, sessionId: parsed.sessionId, trace: result.trace, traceHash: parsed.traceHash, verdict: parsed.output }));
} catch (error) {
  console.log(JSON.stringify({ protocol: 'protoflow.independent-review-error/1', requestId: request.id, bindingHash: request.bindingHash, providerExecutable, trace: providerTrace, traceHash: hash(providerTrace), providerExitCode, error: error.message }));
  process.exitCode = 1;
}
