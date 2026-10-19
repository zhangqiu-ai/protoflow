import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { initProject } from '../src/install.js';
import { loadConfig } from '../src/config.js';
import { checkpoint, startSession } from '../src/sessions.js';
import { createContext, executeContext, prepareIntegration, verify, createReview, decideReview, createBaseline, repair } from '../src/workflow.js';
import { hash } from '../src/util.js';

async function target(t, content = '<main id="card">Hello</main>') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await writeFile(path.join(root, 'prototype/index.html'), content);
  await writeFile(path.join(root, 'app.html'), content);
  const config = await loadConfig(root);
  config.mappings = [{ id: 'card', prototypeFiles: ['prototype/index.html'], prototype: '#card', application: '#card', component: 'app.html' }];
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  const manifest = await checkpoint(root, config);
  return { root, config, manifest };
}
test('context requires mapped changes and remains dry without explicit execution', async t => {
  const { root, config, manifest } = await target(t);
  // Planning gates for later versions are exercised directly; version ordering is tested in queue.test.js.
  const unordered = { ...config, policy: { ...config.policy, sequentialVersions: false } };
  const context = await createContext(root, unordered, manifest.id);
  assert.equal(context.mappings[0].component, 'app.html');
  const dry = await executeContext(root, unordered, context.id);
  assert.equal(dry.status, 'NOT_RUN');
  // The executor request carries the application hash and size, never one hash per file.
  assert.deepEqual(dry.request.project, { hash: context.project.hash, fileCount: Object.keys(context.project.files).length });
  assert.deepEqual(dry.request.git, context.git);
  const status = ' D cache/entry.bin\n'.repeat(10000);
  const repairing = await executeContext(root, unordered, context.id, { repair: { attempt: 1, verification: { id: 'VER-x', status: 'FAIL', project: context.project, git: { head: 'abc', status, diff: '', available: true } } } });
  const { git, ...rest } = repairing.request.repair.verification;
  assert.deepEqual(rest, { id: 'VER-x', status: 'FAIL', project: dry.request.project });
  assert.equal(git.head, 'abc'); assert.equal(git.diff, '');
  assert.equal(git.status, `${status.slice(0, 64 * 1024)}\n[truncated: ${status.length} characters, 10001 lines]`);
  // Native build logs run to megabytes: the repair request keeps each stream's tail, where the failure is reported.
  const log = `${'compiling module\n'.repeat(200000)}error: Cannot find module 'expo-notifications'\n`;
  const failed = await executeContext(root, unordered, context.id, { repair: { attempt: 1, verification: { id: 'VER-y', status: 'FAIL', project: context.project, build: { status: 'FAIL', exitCode: 1, stdout: log, stderr: 'short', variants: { iphone: { status: 'FAIL', stdout: log }, android: { status: 'PASS', stdout: 'ok' } } }, functional: { status: 'NOT_RUN' }, artifactHashes: { a: 'x', b: 'y' } } } });
  const { build, functional, artifactCount } = failed.request.repair.verification;
  assert.equal(build.status, 'FAIL'); assert.equal(build.exitCode, 1); assert.equal(build.stderr, 'short');
  assert.ok(build.stdout.length < 17 * 1024); assert.match(build.stdout, /^\[truncated: first \d+ of \d+ characters omitted\]\n/);
  assert.ok(build.stdout.endsWith("error: Cannot find module 'expo-notifications'\n"));
  assert.ok(build.variants.iphone.stdout.length < 17 * 1024); assert.equal(build.variants.android.stdout, 'ok');
  assert.deepEqual(functional, { status: 'NOT_RUN' }); assert.equal(artifactCount, 2);
  assert.ok(!('artifactHashes' in failed.request.repair.verification));
  await writeFile(path.join(root, 'app.html'), 'User edited');
  await assert.rejects(executeContext(root, unordered, context.id, { execute: true }), /stale/);
  const next = await startSession(root, unordered);
  await writeFile(path.join(root, 'prototype/new.html'), '<aside>Unknown</aside>');
  const unmapped = await checkpoint(root, unordered, { sessionId: next.id });
  await assert.rejects(createContext(root, unordered, unmapped.id), /Map changed/);
});
test('L2 specification and L3 human architecture decisions are separate mandatory gates', async t => {
  const { root, config } = await target(t);
  // Planning gates for later versions are exercised directly; version ordering is tested in queue.test.js.
  const unordered = { ...config, policy: { ...config.policy, sequentialVersions: false } };
  const session = await startSession(root, unordered);
  await writeFile(path.join(root, 'prototype/index.html'), '<main id="card"><script>fetch("/api")</script></main>');
  const l2 = await checkpoint(root, unordered, { sessionId: session.id });
  assert.equal(l2.level, 'L2');
  await assert.rejects(createContext(root, unordered, l2.id), /requires --spec/);
  await writeFile(path.join(root, 'spec.md'), '# Feature\nAcceptance: loads data and shows failures.');
  assert.equal((await createContext(root, unordered, l2.id, { spec: 'spec.md' })).spec.path, 'spec.md');
  const next = await startSession(root, unordered);
  await writeFile(path.join(root, 'prototype/index.html'), '<main id="card">Replace authentication permission system</main>');
  const l3 = await checkpoint(root, unordered, { sessionId: next.id });
  assert.equal(l3.level, 'L3');
  await assert.rejects(createContext(root, unordered, l3.id, { spec: 'spec.md' }), /requires --adr/);
  await writeFile(path.join(root, 'adr.json'), JSON.stringify({ status: 'approved', reviewer: 'Test human fixture', manifestHash: 'wrong', decision: 'Preserve current auth' }));
  await assert.rejects(createContext(root, unordered, l3.id, { spec: 'spec.md', adr: 'adr.json' }), /human approval/);
  await writeFile(path.join(root, 'adr.json'), JSON.stringify({ status: 'approved', reviewer: 'Test human fixture', manifestHash: hash(l3), decision: 'Preserve current auth' }));
  const context = await createContext(root, unordered, l3.id, { spec: 'spec.md', adr: 'adr.json' });
  assert.equal(context.adr.path, 'adr.json');
});
test('missing checks stay NOT_RUN and can never approve or create baseline', async t => {
  const { root, config, manifest } = await target(t);
  const report = await verify(root, config, manifest.id);
  assert.equal(report.status, 'NOT_RUN');
  assert.equal(report.build.status, 'NOT_RUN');
  const review = await createReview(root, config, manifest.id, report.id);
  await assert.rejects(decideReview(root, config, review.id, { status: 'approved', reviewer: 'Test human fixture' }), /PASS/);
  await assert.rejects(createBaseline(root, config, review.id), /approved/);
  const rejected = await decideReview(root, config, review.id, { status: 'changes_requested', reviewer: 'Test human fixture', findings: [{ component: 'card', severity: 'high', description: 'Configure verification' }] });
  assert.equal(rejected.status, 'changes_requested');
});
test('verification regenerating Git-ignored codegen is not a change during verification; committable output is', async t => {
  const { root, config, manifest } = await target(t);
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@protoflow.test'], ['config', 'user.name', 'Fixture']]) execFileSync('git', args, { cwd: root });
  await writeFile(path.join(root, '.gitignore'), '.protoflow/\nbuild/\n');
  const regenerate = file => ({ argv: [process.execPath, '-e', `const fs = require('fs'); fs.mkdirSync(require('path').dirname(${JSON.stringify(file)}), { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, String(Math.random()))`] });
  const ignored = await verify(root, { ...config, verification: { build: regenerate('build/generated/Codegen.h'), functional: regenerate('build/generated/Codegen.h') } }, manifest.id);
  assert.equal(ignored.build.status, 'PASS'); assert.equal(ignored.functional.status, 'PASS');
  assert.equal(ignored.changedDuringVerification, false);
  assert.ok(!Object.keys(ignored.project.files).some(file => file.startsWith('build/')));
  const committable = await verify(root, { ...config, verification: { functional: regenerate('generated/Codegen.h') } }, manifest.id);
  assert.equal(committable.changedDuringVerification, true);
  assert.equal(committable.status, 'FAIL');
});
test('planning adapter validates actual produced artifact paths, not just exit zero', async t => {
  const { root, config, manifest } = await target(t);
  assert.equal((await prepareIntegration(root, config, manifest.id, 'specKit')).status, 'NOT_RUN');
  config.adapters.specKit.command = { argv: [process.execPath, '-e', 'process.stdin.resume(); console.log(JSON.stringify({status:"ready",artifacts:["missing.md"]}))'] };
  assert.equal((await prepareIntegration(root, config, manifest.id, 'specKit')).status, 'FAIL');
  await writeFile(path.join(root, 'spec.md'), 'Acceptance criteria and tests');
  config.adapters.specKit.command.argv[2] = 'process.stdin.resume(); console.log(JSON.stringify({status:"ready",artifacts:["spec.md"]}))';
  const result = await prepareIntegration(root, config, manifest.id, 'specKit');
  assert.equal(result.status, 'PASS');
  assert.equal(result.response.evidence[0].hash, hash('Acceptance criteria and tests'));
});
test('executor fails if it alters the frozen version; live prototype edits are recorded, not attributed', async t => {
  const { root, config, manifest } = await target(t);
  const frozen = `.protoflow/versions/${manifest.id}/files/prototype/index.html`;
  config.adapters.codex.command = { argv: [process.execPath, '-e', `process.stdin.resume(); require("fs").writeFileSync(${JSON.stringify(frozen)}, "Agent changed design")`] };
  const context = await createContext(root, config, manifest.id);
  const result = await executeContext(root, config, context.id, { execute: true });
  assert.equal(result.status, 'FAIL');
  assert.match(result.result.error, /Executor changed the frozen prototype version/);
  await assert.rejects(verify(root, config, manifest.id), /version store changed/);

  const second = await target(t);
  second.config.adapters.codex.command = { argv: [process.execPath, '-e', 'process.stdin.resume(); require("fs").writeFileSync("prototype/index.html", "Designer kept working")'] };
  const concurrent = await executeContext(second.root, second.config, (await createContext(second.root, second.config, second.manifest.id)).id, { execute: true });
  assert.equal(concurrent.status, 'PASS');
  assert.equal(concurrent.livePrototypeChanged, true);
  assert.equal((await verify(second.root, second.config, second.manifest.id)).prototypeVersion.manifestId, second.manifest.id);
});
test('adapters.codex.ignoreUserConfig reaches the executor as stdin JSON; existing configs send no executor options', async t => {
  const { root, config, manifest } = await target(t);
  config.adapters.codex.command = { argv: [process.execPath, '-e', 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify(JSON.parse(s).executor ?? null)))'] };
  const unordered = { ...config, policy: { ...config.policy, sequentialVersions: false } };
  const plain = await executeContext(root, unordered, (await createContext(root, unordered, manifest.id)).id, { execute: true });
  assert.equal(plain.status, 'PASS');
  assert.equal(plain.request.executor, undefined);
  assert.equal(plain.result.stdout.trim(), 'null');
  const isolated = { ...unordered, adapters: { ...unordered.adapters, codex: { ...unordered.adapters.codex, ignoreUserConfig: true } } };
  const result = await executeContext(root, isolated, (await createContext(root, isolated, manifest.id)).id, { execute: true });
  assert.deepEqual(result.request.executor, { ignoreUserConfig: true });
  assert.deepEqual(JSON.parse(result.result.stdout), { ignoreUserConfig: true });
});
test('repair does not retry NOT_RUN checks and escalates to pending human review', async t => {
  const { root, config, manifest } = await target(t);
  const result = await repair(root, config, manifest.id, { execute: true });
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.executions.length, 0);
  const review = JSON.parse(await readFile(path.join(root, '.protoflow/reviews', `${result.reviewId}.json`)));
  assert.equal(review.status, 'pending');
});
