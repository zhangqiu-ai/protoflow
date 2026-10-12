import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseCliOutput } from './helpers/cli-json.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/protoflow.js', import.meta.url));
// FORCE_COLOR and NO_COLOR together make Node print a runtime warning while built-in modules load.
const noisy = { ...process.env, FORCE_COLOR: '1', NO_COLOR: '1' };
const run = async (args, env = noisy) => {
  try { return { code: 0, ...(await exec(process.execPath, [cli, ...args], { env })) }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
};

test('with Node runtime warnings, a failure still ends stderr with its JSON error and stdout stays empty', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-cli-json-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.writeFile(path.join(root, 'prototype/broken.html'), '<!doctype html><html><body><main><h1 data-pf="Bad Id">x</h1></main></body></html>\n');
  await fs.copyFile(fileURLToPath(new URL('../examples/anchors/protoflow.config.json', import.meta.url)), path.join(root, 'protoflow.config.json'));

  const failed = await run(['checkpoint', '--project', root]);
  assert.equal(failed.code, 1);
  assert.equal(failed.stdout, '');
  const lines = failed.stderr.trim().split('\n');
  assert.match(lines[0], /^ProtoFlow diagnostic: Warning: The 'NO_COLOR' env is ignored/);
  const error = JSON.parse(lines.at(-1));
  assert.equal(error.error, 'Prototype anchors are invalid');
  assert.match(error.errors.join('\n'), /broken\.html: Invalid anchor id "Bad Id"/);
  assert.deepEqual(parseCliOutput(failed.stdout, failed.stderr), error);
  // The invalid prototype never became a version.
  const queue = await run(['queue', '--project', root]);
  assert.equal(queue.code, 0);
  assert.deepEqual(JSON.parse(queue.stdout).versions, []);
});

test('with Node runtime warnings, a successful command keeps stdout pure JSON', async () => {
  const example = fileURLToPath(new URL('../examples/anchors/', import.meta.url));
  const lint = await run(['anchors', 'lint', '--project', example]);
  assert.equal(lint.code, 0);
  assert.equal(JSON.parse(lint.stdout).status, 'PASS');
  assert.match(lint.stderr, /ProtoFlow diagnostic: Warning/);
});

test('multi-target source status and runner status show per-target progress and exit 0', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-cli-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = id => ({ id, platform: 'web', root: id, driver: { kind: 'playwright-web', urlTemplate: `${id}/{page}.html` } });
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify({ schemaVersion: 2, prototypeDir: 'prototype', targets: [target('web'), target('desktop')] }));
  const sha = 'a'.repeat(40);
  await fs.mkdir(path.join(root, '.protoflow/source'), { recursive: true });
  await fs.writeFile(path.join(root, '.protoflow/source/state.json'), JSON.stringify({ schemaVersion: 1, status: 'READY', scannedSha: sha, completedSha: null, entries: [{ sha, manifestId: 'git-a', prototypeHash: 'h', ordinal: 1, status: 'PENDING', attempts: [] }] }));
  for (const id of ['web', 'desktop']) {
    await fs.mkdir(path.join(root, `.protoflow/targets/${id}`), { recursive: true });
    await fs.writeFile(path.join(root, `.protoflow/targets/${id}/progress.json`), JSON.stringify({ schemaVersion: 1, target: id, entries: [{ sha, manifestId: 'git-a', prototypeHash: 'h', ordinal: 1, status: 'PASS', attempts: [] }], completedSha: sha }));
  }
  const source = await run(['source', 'status', '--project', root]);
  assert.equal(source.code, 0);
  assert.deepEqual(JSON.parse(source.stdout).entries.map(entry => [entry.status, entry.targets]), [['PASS', { web: 'PASS', desktop: 'PASS' }]]);
  const runner = await run(['runner', 'status', '--project', root]);
  assert.equal(runner.code, 0);
  const status = JSON.parse(runner.stdout);
  assert.equal(status.source.statusBasis, 'targets');
  assert.equal(status.source.completedSha, sha);
  assert.deepEqual(Object.fromEntries(Object.entries(status.targets).map(([id, item]) => [id, item.summary.status])), { web: 'IDLE', desktop: 'IDLE' });
});
