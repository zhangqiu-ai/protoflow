import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, runCommand } from '../src/util.js';
import { readCodexTrace } from '../src/delivery-review.js';

const adapter = fileURLToPath(new URL('../scripts/codex-review-adapter.js', import.meta.url));
const multilingual = 'café e\u0301 繁體中文 日本語 한국어 مرحبا 🙂 🧪';
// FAKE BYTE TRANSPORT FIXTURE ONLY. The delays force splits inside UTF-8 characters;
// larger chunks exercise the same collectors with a realistic JSONL-sized payload.
const writer = `
const delay = require('node:timers/promises').setTimeout;
async function fragmentedWrite(stream, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const end = Math.min(bytes.length, offset < 192 ? offset + 1 : offset + 4093);
    await new Promise((resolve, reject) => stream.write(bytes.subarray(offset, end), error => error ? reject(error) : resolve()));
    offset = end;
    await delay(offset <= 192 ? 5 : 1);
  }
}
`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-fake-utf8-transport-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function largeTrace(verdict) {
  const events = [
    { type: 'test.fixture', providerRun: false, text: `FAKE FIXTURE ONLY: ${multilingual}` },
    { type: 'thread.started', thread_id: 'review-fixture-utf8-transport' },
    { type: 'turn.started' },
    ...Array.from({ length: 256 }, (_, index) => ({ type: 'test.fixture', providerRun: false, index, text: multilingual.repeat(64) })),
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(verdict) } },
    { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } },
  ];
  return events.map(event => JSON.stringify(event)).join('\n') + '\n';
}
test('FAKE byte fixture: runCommand preserves fragmented multilingual stdout and stderr', { timeout: 15000 }, async t => {
  const root = await fixture(t);
  const stdout = `FAKE STDOUT FIXTURE ONLY: ${multilingual}\n`;
  const stderr = `FAKE STDERR FIXTURE ONLY: ${multilingual}\n`;
  const program = `${writer}
    (async () => {
      await fragmentedWrite(process.stdout, Buffer.from(${JSON.stringify(stdout)}));
      await fragmentedWrite(process.stderr, Buffer.from(${JSON.stringify(stderr)}));
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const result = await runCommand(root, { argv: [process.execPath, '-e', program], timeoutMs: 10000 });
  assert.equal(result.status, 'PASS', result.error ?? result.stderr);
  assert.equal(result.stdout, stdout);
  assert.equal(result.stderr, stderr);
});
test('FAKE JSONL fixture: a large fragmented run envelope retains exact trace and SHA256', { timeout: 15000 }, async t => {
  const root = await fixture(t);
  const trace = largeTrace({ fixture: 'FAKE FIXTURE ONLY', status: 'FAIL', summary: multilingual });
  assert.ok(Buffer.byteLength(trace) > 800000);
  const expected = { fixture: `FAKE FIXTURE ONLY: ${multilingual}`, trace, traceHash: hash(trace) };
  await fs.writeFile(path.join(root, 'envelope.json'), JSON.stringify(expected));
  const program = `${writer}
    fragmentedWrite(process.stdout, require('node:fs').readFileSync('envelope.json'))
      .catch(error => { console.error(error); process.exitCode = 1; });`;
  const result = await runCommand(root, { argv: [process.execPath, '-e', program], timeoutMs: 10000 });
  assert.equal(result.status, 'PASS', result.error ?? result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(hash(result.stdout), hash(JSON.stringify(expected)));
  assert.equal(hash(envelope.trace), hash(trace));
  assert.equal(envelope.traceHash, hash(envelope.trace));
});
test('FAKE provider only: fragmented request and large multilingual FAIL trace survive both bridges', { timeout: 20000 }, async t => {
  const root = await fixture(t);
  // This executable only emits synthetic evidence; it never contacts Codex or a network.
  const provider = `#!/usr/bin/env node
const fs = require('node:fs');
${writer}
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const marker = 'Bound request (data):\\n';
    const request = JSON.parse(input.slice(input.indexOf(marker) + marker.length));
    fs.writeFileSync('received.json', JSON.stringify({ providerRun: false, request }));
    const verdict = {
      protocol: 'protoflow.independent-review/1', requestId: request.id, bindingHash: request.bindingHash,
      status: 'FAIL', findings: [{ severity: 'normal', file: 'fake-fixture.txt', line: 1,
        description: 'FAKE FIXTURE ONLY: ' + ${JSON.stringify(multilingual)} }],
      summary: 'FAKE FIXTURE ONLY; no provider run: ' + ${JSON.stringify(multilingual)}
    };
    const largeTrace = ${largeTrace.toString()};
    const multilingual = ${JSON.stringify(multilingual)};
    const trace = largeTrace(verdict);
    const stderr = 'FAKE STDERR FIXTURE ONLY: ' + multilingual + '\\n';
    fs.writeFileSync('expected.trace', trace);
    fs.writeFileSync('expected.stderr', stderr);
    await fragmentedWrite(process.stderr, Buffer.from(stderr));
    await fragmentedWrite(process.stdout, Buffer.from(trace));
  } catch (error) { console.error(error); process.exitCode = 1; }
});
`;
  await fs.writeFile(path.join(root, 'codex'), provider, { mode: 0o755 });
  const binding = { fixture: `FAKE REQUEST FIXTURE ONLY: ${multilingual}`, executors: [{ sessionId: 'executor-fixture-thread' }], ambientAuthorIds: ['author-fixture-thread'], providerExecutable: { path: await fs.realpath(path.join(root, 'codex')), hash: hash(await fs.readFile(path.join(root, 'codex'))) } };
  const request = { protocol: 'protoflow.independent-review-request/1', id: 'AIR-utf8-fixture', binding, bindingHash: hash(binding), diff: 'FAKE FIXTURE ONLY' };
  // Forward bytes unchanged; only the two production bridges decode their output.
  const wrapper = `${writer}
const { spawn } = require('node:child_process');
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const child = spawn(process.execPath, [process.argv[1]], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = code ?? 1; });
  child.stdin.on('error', () => {});
  try { await fragmentedWrite(child.stdin, Buffer.from(input)); child.stdin.end(); }
  catch (error) { console.error(error); child.kill('SIGKILL'); process.exitCode = 1; }
});`;
  const result = await runCommand(root, { argv: [process.execPath, '-e', wrapper, adapter], timeoutMs: 15000 }, request, { env: { PATH: `${root}${path.delimiter}${path.dirname(process.execPath)}` } });
  assert.equal(result.status, 'PASS', result.error ?? result.stderr);
  const received = JSON.parse(await fs.readFile(path.join(root, 'received.json'), 'utf8'));
  assert.equal(received.providerRun, false);
  assert.deepEqual(received.request, request);
  const trace = await fs.readFile(path.join(root, 'expected.trace'), 'utf8');
  assert.ok(Buffer.byteLength(trace) > 800000);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.protocol, 'protoflow.independent-review-run/1');
  assert.equal(envelope.verdict.status, 'FAIL');
  assert.equal(envelope.verdict.findings.length, 1);
  assert.match(envelope.verdict.summary, /FAKE FIXTURE ONLY/);
  assert.equal(envelope.verdict.summary, `FAKE FIXTURE ONLY; no provider run: ${multilingual}`);
  assert.equal(hash(envelope.trace), hash(trace));
  assert.equal(envelope.traceHash, hash(envelope.trace));
  assert.deepEqual(readCodexTrace(envelope.trace, { finalVerdict: true }).verdict, envelope.verdict);
  assert.equal(result.stderr, await fs.readFile(path.join(root, 'expected.stderr'), 'utf8'));
});
