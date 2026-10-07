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
