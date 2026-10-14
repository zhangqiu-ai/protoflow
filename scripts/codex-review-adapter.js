#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { hash } from '../src/util.js';
import { reviewPrompt } from '../src/review-prompt.js';
import { reviewVerdictSchema, readCodexTrace, assertStructuredVerdict, resolveCodexExecutable } from '../src/delivery-review.js';

// Real provider bridge. Tests replace only the codex executable and identify themselves as fixtures.
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) { input += chunk; if (input.length > 4 * 1024 * 1024) throw new Error('Independent review request exceeds 4 MiB'); }
const request = JSON.parse(input);
if (request.protocol !== 'protoflow.independent-review-request/1' || !/^AIR-[A-Za-z0-9-]+$/.test(request.id ?? '') || hash(request.binding) !== request.bindingHash) throw new Error('Expected an exact bound independent review request');
// What the bound evidence hashes cover, so a reviewer that recomputes them compares the same bytes the engine hashed.
const { values } = parseArgs({ options: { model: { type: 'string' } } });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-codex-review-'));
let providerTrace = '', providerExitCode = null, providerExecutable = null;
try {
  providerExecutable = await resolveCodexExecutable();
  if (hash(providerExecutable) !== hash(request.binding.providerExecutable)) throw new Error('Resolved Codex executable differs from the bound path/file SHA256');
  const schemaFile = path.join(temporary, 'verdict.schema.json');
  const schema = structuredClone(reviewVerdictSchema);
  schema.properties.requestId.const = request.id; schema.properties.bindingHash.const = request.bindingHash;
  await fs.writeFile(schemaFile, JSON.stringify(schema));
  const argv = ['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '-c', 'approval_policy="never"', '--output-schema', schemaFile, ...(values.model ? ['--model', values.model] : []), '-'];
  const prompt = reviewPrompt(request);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(providerExecutable.path, argv, { cwd: process.cwd(), shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let trace = '', stderr = '', overflow = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { trace += chunk; if (trace.length + stderr.length > 3 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; if (trace.length + stderr.length > 3 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } });
    child.stdin.on('error', () => {}); child.stdin.end(prompt);
    child.once('error', reject); child.once('close', code => resolve({ code, trace, stderr, overflow }));
  });
  providerTrace = result.trace; providerExitCode = result.code;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0 || result.overflow) throw new Error(`Codex independent review did not complete (${result.code ?? 'unknown exit'})`);
  const parsed = readCodexTrace(result.trace, { finalVerdict: true });
  assertStructuredVerdict(parsed.verdict, request);
  if (hash(await resolveCodexExecutable()) !== hash(providerExecutable)) throw new Error('Codex executable changed during independent review');
  console.log(JSON.stringify({ protocol: 'protoflow.independent-review-run/1', requestId: request.id, bindingHash: request.bindingHash, provider: 'codex', providerExecutable, sandbox: 'read-only', freshSession: true, sessionId: parsed.sessionId, trace: result.trace, traceHash: parsed.traceHash, verdict: parsed.verdict }));
} catch (error) {
  console.log(JSON.stringify({ protocol: 'protoflow.independent-review-error/1', requestId: request.id, bindingHash: request.bindingHash, providerExecutable, trace: providerTrace, traceHash: hash(providerTrace), providerExitCode, error: error.message }));
  process.exitCode = 1;
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
