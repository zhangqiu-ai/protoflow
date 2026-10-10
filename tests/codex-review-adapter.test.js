import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { hash } from '../src/util.js';

const adapter = fileURLToPath(new URL('../scripts/codex-review-adapter.js', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/protoflow-readonly-review-fake-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(fileURLToPath(new URL('./fixtures/fake-codex-review.cjs', import.meta.url)), path.join(root, 'codex')); await fs.chmod(path.join(root, 'codex'), 0o755);
  return root;
}
async function run(root, mode = 'pass', options = []) {
  const binding = { executors: [{ sessionId: 'executor-fixture-thread' }], ambientAuthorIds: ['author-fixture-thread'], providerExecutable: { path: await fs.realpath(path.join(root, 'codex')), hash: hash(await fs.readFile(path.join(root, 'codex'))) } };
  const request = { protocol: 'protoflow.independent-review-request/1', id: 'AIR-adapter-fixture', binding, bindingHash: hash(binding), diff: 'FAKE FIXTURE ONLY' };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [adapter, ...options], { cwd: root, env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, FAKE_REVIEW_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(request));
  });
}
test('FAKE CLI only: review bridge fixes fresh readonly ephemeral/schema arguments and preserves FAIL', async t => {
  const root = await fixture(t), result = await run(root, 'fail', ['--model', 'fixture-model']); assert.equal(result.code, 0, result.stderr);
  const received = JSON.parse(await fs.readFile(path.join(root, '.protoflow/fixture-review/received.json'))), envelope = JSON.parse(result.stdout);
  assert.equal(received.providerRun, false); assert.equal(received.args[received.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(received.args.includes('--ephemeral') && received.args.includes('--ignore-user-config') && received.args.includes('--output-schema'));
  assert.equal(envelope.verdict.status, 'FAIL'); assert.match(envelope.verdict.summary, /FAKE FIXTURE/); assert.equal(envelope.traceHash, hash(envelope.trace));
  assert.equal(envelope.providerExecutable.path, await fs.realpath(path.join(root, 'codex'))); assert.equal(envelope.providerExecutable.hash, hash(await fs.readFile(path.join(root, 'codex'))));
});
test('FAKE CLI only: malformed verdict/incomplete trace preserve raw failure evidence and never emit PASS', async t => {
  const root = await fixture(t);
  for (const mode of ['malformed', 'incomplete', 'wrong-binding', 'extra-verdict-key']) {
    const result = await run(root, mode); assert.equal(result.code, 1);
    const error = JSON.parse(result.stdout); assert.equal(error.protocol, 'protoflow.independent-review-error/1'); assert.equal(error.traceHash, hash(error.trace)); assert.match(error.trace, /test.fixture/);
  }
});
test('FAKE CLI only: unsupported resume/bypass arguments fail before spawning review provider', async t => {
  const root = await fixture(t);
  for (const option of ['--resume', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox']) assert.equal((await run(root, 'pass', [option])).code, 1);
  await assert.rejects(fs.access(path.join(root, '.protoflow/fixture-review/received.json')), { code: 'ENOENT' });
});

test('FAKE CLI only: provider output schema explicitly types every field, including const and enum constraints', async t => {
  const root = await fixture(t), result = await run(root); assert.equal(result.code, 0, result.stderr);
  const { schema } = JSON.parse(await fs.readFile(path.join(root, '.protoflow/fixture-review/received.json')));
  const inspect = (node, location) => {
    assert.ok(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(node.type), `${location}: provider requires an explicit type`);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      for (const [key, child] of Object.entries(node.properties)) inspect(child, `${location}.${key}`);
    }
    if (node.type === 'array') inspect(node.items, `${location}[]`);
    for (const value of [...(node.enum ?? []), ...(Object.hasOwn(node, 'const') ? [node.const] : [])]) {
      assert.equal(typeof value, node.type === 'integer' ? 'number' : node.type, `${location}: constrained values must match their declared type`);
    }
  };
  inspect(schema, 'verdict');
  assert.equal(schema.properties.requestId.const, 'AIR-adapter-fixture');
  assert.match(schema.properties.bindingHash.const, /^[a-f0-9]{64}$/);
});
