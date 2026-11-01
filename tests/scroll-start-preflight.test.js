import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
for (const [value, reason] of [['start', /scroll-to start needs current UIKit probe/]]) {
 test(`iOS rejects ${value} before touching Simulator tools`, { skip: process.platform !== 'darwin' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scroll-preflight-'));
  try {
   await writeFile(path.join(dir, 'xcrun'), `#!/bin/sh\nprintf '%s\\n' '{"devices":{}}'\n`);
   await chmod(path.join(dir, 'xcrun'), 0o755);
   const child = spawn(process.execPath, [path.join(root, 'scripts/ios-driver.js'), '--bundle-id', 'dev.synthetic', '--device', 'Fake', '--cache', path.join(dir, 'cache')], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: ['pipe', 'pipe', 'pipe'] });
   let stdout = ''; child.stdout.setEncoding('utf8').on('data', s => stdout += s); let stderr = ''; child.stderr.setEncoding('utf8').on('data', s => stderr += s);
   child.stdin.end(JSON.stringify({ schemaVersion: 1, kind: 'capture', screen: 'demo', state: 'initial', anchors: ['demo'], steps: [{ action: 'scroll-to', anchor: 'demo.export', value }], outputDir: path.join(dir, 'out') }));
   await new Promise(resolve => child.once('close', resolve));
   const response = JSON.parse(stdout); assert.equal(response.status, 'NOT_RUN'); assert.match(response.reason, reason, stderr);
  } finally { await rm(dir, { recursive: true, force: true }); }
 });
}
