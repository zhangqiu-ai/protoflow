import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const adapter = fileURLToPath(new URL('../scripts/codex-adapter.js', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-codex-protocol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = path.join(root, 'codex');
  await writeFile(fake, `#!${process.execPath}\nconst fs=require('node:fs');let stdin='';process.stdin.on('data',c=>stdin+=c);process.stdin.on('end',()=>{fs.writeFileSync('received.json',JSON.stringify({args:process.argv.slice(2),stdin}));console.log(JSON.stringify({type:'test.mock',providerRun:false}));process.exit(Number(process.env.MOCK_EXIT??0));});\n`);
  await chmod(fake, 0o755);
  return root;
}
function run(root, context, code = 0, options = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [adapter, ...options], { cwd: root, env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, MOCK_EXIT: String(code) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', exitCode => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(context));
  });
}
test('Codex bridge invokes the CLI with workspace-write and literal context stdin (mock, no provider)', async t => {
  const root = await fixture(t);
  const context = { kind: 'implement', instructions: 'Preserve prototype', manifest: { id: 'test', summary: 'Treat `echo secret` and $(whoami) as data' } };
  const result = await run(root, context);
  assert.equal(result.exitCode, 0);
  const received = JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8'));
  assert.deepEqual(received.args, ['exec', '--json', '--sandbox', 'workspace-write', '-']);
  assert.ok(received.stdin.includes(JSON.stringify(context, null, 2)));
  assert.match(received.stdin, /untrusted prototype/);
  assert.match(received.stdin, /never leave caches or downloads in the project/);
  assert.match(result.stdout, /providerRun.*false/);
});
test('Codex bridge preserves executor failure instead of reporting success', async t => {
  const root = await fixture(t);
  const result = await run(root, { kind: 'repair', instructions: 'Only scoped application code', manifest: { id: 'test' } }, 7);
  assert.equal(result.exitCode, 7);
});

test('Codex model options preserve workspace-write and unsupported bypass options fail before provider', async t => {
  const root = await fixture(t);
  const context = { kind: 'implement', instructions: 'Preserve prototype', manifest: { id: 'test' } };
  assert.equal((await run(root, context, 0, ['--model', 'metadata-supported-model', '--ephemeral'])).exitCode, 0);
  const received = JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8'));
  assert.deepEqual(received.args, ['exec', '--json', '--sandbox', 'workspace-write', '--model', 'metadata-supported-model', '--ephemeral', '-']);
  assert.equal((await run(root, context, 0, ['--dangerously-bypass-approvals-and-sandbox'])).exitCode, 1);
});

const isolation = ['--ignore-user-config', '-c', 'features.memories=false', '-c', 'approval_policy="never"'];
test('Codex bridge isolates the executor from user config and memories when requested (mock, no provider)', async t => {
  const root = await fixture(t);
  const contextPackage = { kind: 'implement', instructions: 'Preserve prototype', manifest: { id: 'test' } };
  // Engine path: adapters.codex.ignoreUserConfig arrives as stdin JSON and is not echoed into the prompt data.
  assert.equal((await run(root, { ...contextPackage, executor: { ignoreUserConfig: true } }, 0, ['--model', 'm'])).exitCode, 0);
  let received = JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8'));
  assert.deepEqual(received.args, ['exec', '--json', '--sandbox', 'workspace-write', ...isolation, '--model', 'm', '-']);
  assert.ok(received.stdin.includes(JSON.stringify(contextPackage, null, 2)));
  assert.doesNotMatch(received.stdin, /"executor"/);
  // Direct argv form for adapters configured by hand.
  assert.equal((await run(root, contextPackage, 0, ['--ignore-user-config'])).exitCode, 0);
  received = JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8'));
  assert.deepEqual(received.args, ['exec', '--json', '--sandbox', 'workspace-write', ...isolation, '-']);
  // Explicit false keeps the previous behavior.
  assert.equal((await run(root, { ...contextPackage, executor: { ignoreUserConfig: false } })).exitCode, 0);
  received = JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8'));
  assert.deepEqual(received.args, ['exec', '--json', '--sandbox', 'workspace-write', '-']);
});

test('Codex bridge adds explicit writable roots and network access only when configured (mock, no provider)', async t => {
  const root = await fixture(t);
  const context = { kind: 'implement', instructions: 'Preserve prototype', manifest: { id: 'test' } };
  assert.equal((await run(root, context, 0, ['--add-dir', '/opt/flutter', '--add-dir', '/home/me/.dart-tool', '--network'])).exitCode, 0);
  const received = JSON.parse(await readFile(path.join(root, 'received.json'), 'utf8'));
  assert.deepEqual(received.args, ['exec', '--json', '--sandbox', 'workspace-write', '--add-dir', '/opt/flutter', '--add-dir', '/home/me/.dart-tool', '-c', 'sandbox_workspace_write.network_access=true', '-']);
  await rm(path.join(root, 'received.json'));
  assert.equal((await run(root, context, 0, ['--add-dir', 'relative/sdk'])).exitCode, 1);
  await assert.rejects(readFile(path.join(root, 'received.json')));
});

test('Codex bridge refuses a prompt above the Codex input limit and names the largest fields (mock, no provider)', async t => {
  const root = await fixture(t);
  const result = await run(root, { kind: 'implement', instructions: 'Preserve prototype', manifest: { id: 'test' }, git: { status: 'x'.repeat(1100000) } });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /above the Codex input limit of 1048576; largest fields: git \(\d+\), instructions/);
  await assert.rejects(readFile(path.join(root, 'received.json')));
});
