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
import { acquireDevices } from '../src/devices.js';

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
  const { stat, ...git } = dry.request.git;
  assert.deepEqual(git, context.git); assert.ok(Array.isArray(stat));
  assert.equal(dry.request.handoff, `.protoflow/handoff/${context.id}.json`);
  const status = ' D cache/entry.bin\n'.repeat(10000);
  const repairing = await executeContext(root, unordered, context.id, { repair: { attempt: 1, verification: { id: 'VER-x', status: 'FAIL', project: context.project, git: { head: 'abc', status, diff: '', available: true } } } });
  const { git: repaired, ...rest } = repairing.request.repair.verification;
  assert.deepEqual(rest, { id: 'VER-x', status: 'FAIL', project: dry.request.project });
  assert.equal(repaired.head, 'abc'); assert.equal(repaired.diff, '');
  assert.deepEqual(repaired.stat, [], 'deleted files show in the diff, not as untracked');
  assert.equal(repaired.status, `${status.slice(0, 64 * 1024)}\n[truncated: ${status.length} characters, 10001 lines]`);
  // The stat counts lines per file from the whole diff (a removed line starting with "--" included) and lists untracked files.
  const diff = 'diff --git a/a.sql b/a.sql\nindex 1..2 100644\n--- a/a.sql\n+++ b/a.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new comment\n+select 1;\n context\ndiff --git a/b.js b/b.js\ndeleted file mode 100644\n--- a/b.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n';
  const stated = await executeContext(root, unordered, context.id, { repair: { attempt: 1, verification: { id: 'VER-z', status: 'FAIL', project: context.project, git: { head: 'abc', status: ' M a.sql\n D b.js\n?? new file.txt\n', diff, available: true } } } });
  assert.deepEqual(stated.request.repair.verification.git.stat, [{ path: 'a.sql', added: 2, removed: 1 }, { path: 'b.js', added: 0, removed: 1 }, { path: 'new file.txt', untracked: true }]);
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
test('protoflow repair gives each attempt the files the previous one changed and its handoff note', async t => {
  const { root, config, manifest } = await target(t);
  const received = path.join(root, '..', 'second-attempt.json');
  const note = JSON.stringify({ changed: ['app.html'], tried: 'first fix', remaining: 'functional still fails' });
  config.adapters.codex.command = { argv: [process.execPath, '-e', `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const r=JSON.parse(s);const fs=require('node:fs');if(r.repair.attempt===2){fs.writeFileSync(process.argv[2],s);fs.writeFileSync('fixed.txt','yes');return}fs.writeFileSync('app.html','<main>first fix</main>');fs.mkdirSync('.protoflow/handoff',{recursive:true});fs.writeFileSync(r.handoff,process.argv[1])})`, note, received] };
  const repairing = { ...config, policy: { ...config.policy, maxRepairAttempts: 2 }, verification: { build: { argv: [process.execPath, '-e', 'process.exit(0)'] }, functional: { argv: [process.execPath, '-e', `process.exit(require('node:fs').existsSync('fixed.txt')?0:1)`] } } };
  const result = await repair(root, repairing, manifest.id, { execute: true });
  assert.equal(result.executions.length, 2);
  const input = JSON.parse(await readFile(received, 'utf8'));
  assert.deepEqual(input.repair.previousAttempt.handoff, { changed: ['app.html'], tried: 'first fix', remaining: 'functional still fails' });
  assert.equal(input.repair.previousAttempt.attempt, 1);
  assert.deepEqual(input.repair.previousAttempt.changes.files.find(file => file.path === 'app.html'), { path: 'app.html', change: 'modified' });
});
test('a build that exits 0 still fails without its outputs or with a swallowed pod install failure, and is not retried', async t => {
  const { root, config, manifest } = await target(t);
  const node = script => [process.execPath, '-e', script];
  const policy = { ...config.policy, transientRetryDelayMs: 0 };
  const missing = await verify(root, { ...config, policy, verification: { build: { argv: node('console.log("built")'), outputs: ['ios/App.xcworkspace'] } } }, manifest.id);
  assert.equal(missing.build.status, 'FAIL'); assert.match(missing.build.error, /exited 0 but did not produce: ios\/App\.xcworkspace/);
  assert.match(missing.build.stderr, /built/, 'the end of the build output comes with the reason');
  assert.equal(missing.build.environmentRetry, undefined); assert.equal(missing.status, 'FAIL'); assert.equal(missing.reasonCode, undefined);
  const produced = await verify(root, { ...config, policy, verification: { build: { argv: node('require("fs").mkdirSync("ios/App.xcworkspace", { recursive: true })'), outputs: ['ios/App.xcworkspace'] } } }, manifest.id);
  assert.equal(produced.build.status, 'PASS');
  // Expo prebuild exits 0 when pod install fails; a native dependency the version added is the version's failure.
  const pod = 'console.log("✔ Finished prebuild\\n⚠️  Something went wrong running `pod install` in the `ios` directory.\\nCommand `pod install` failed.\\n└─ Cause: Unable to find a specification for `RNFoo` depended upon by `RNBar`")';
  const swallowed = await verify(root, { ...config, policy, verification: { build: { argv: node(pod) } } }, manifest.id);
  assert.equal(swallowed.build.status, 'FAIL'); assert.match(swallowed.build.error, /reports a failure: ⚠️ +Something went wrong running `pod install`[\s\S]*RNFoo/);
  assert.equal(swallowed.build.environmentRetry, undefined, 'a failure that does not name the machine is not retried');
  assert.equal(swallowed.status, 'FAIL'); assert.equal(swallowed.reasonCode, undefined);
});
test('a verification waits for a simulator another project holds, runs its checks after, and records the wait', async t => {
  const { root, config, manifest } = await target(t);
  const locks = await mkdtemp(path.join(os.tmpdir(), 'protoflow-device-locks-'));
  const previous = process.env.PROTOFLOW_DEVICE_LOCKS;
  process.env.PROTOFLOW_DEVICE_LOCKS = locks;
  t.after(async () => { if (previous === undefined) delete process.env.PROTOFLOW_DEVICE_LOCKS; else process.env.PROTOFLOW_DEVICE_LOCKS = previous; await rm(locks, { recursive: true, force: true }); });
  const marker = path.join(locks, 'functional-ran');
  const functional = { argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, '--', '-destination', 'platform=iOS Simulator,name=ProtoFlow iPhone 17'] };
  const release = await acquireDevices(['ProtoFlow iPhone 17'], { project: 'siyue', target: 'ios', manifestId: 'git-siyue', phase: 'visual' }, { dir: locks });
  const waits = [];
  const running = verify(root, { ...config, verification: { functional } }, manifest.id, { onDeviceWait: wait => waits.push(wait) });
  const deadline = Date.now() + 10000;
  while (!waits.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([waits[0].device, waits[0].phase, waits[0].holder.project, waits[0].holder.target, waits[0].holder.manifestId], ['ProtoFlow iPhone 17', 'functional', 'siyue', 'ios', 'git-siyue']);
  await assert.rejects(readFile(marker), /ENOENT/, 'the tests do not start while another project drives the simulator');
  await release();
  const report = await running;
  assert.equal(report.functional.status, 'PASS'); assert.equal(await readFile(marker, 'utf8'), 'ran');
  assert.deepEqual(report.devices.names, ['ProtoFlow iPhone 17']); assert.equal(report.devices.waits[0].holder.project, 'siyue'); assert.ok(report.devices.waitedMs >= 0);
  assert.deepEqual([waits.at(-1).acquired, waits.at(-1).devices], [true, ['ProtoFlow iPhone 17']]);
  // The verification let go of the simulator: the next one takes it at once.
  await (await acquireDevices(['ProtoFlow iPhone 17'], { project: 'siyue' }, { dir: locks, onWait: () => assert.fail('still held') }))();
});
test('tests a busy simulator did not serve run once more and then are NOT_RUN environment; a failed test is the version\'s', async t => {
  const { root, config, manifest } = await target(t);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'protoflow-functional-runs-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runs = path.join(scratch, 'runs');
  const policy = { ...config.policy, transientRetryDelayMs: 0 };
  const xcodebuild = lines => ({ argv: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(runs)}, 'x'); console.error(${JSON.stringify(lines)}); process.exit(65)`] });
  const bootstrap = 'Testing failed:\n\tProtoFlowTasksUITests-Runner (96777) encountered an error (Early unexpected exit, operation never finished bootstrapping - no restart will be attempted. (Underlying Error: Test crashed with signal kill while preparing to run tests.))\n\n** TEST FAILED **';
  const blocked = await verify(root, { ...config, policy, verification: { functional: xcodebuild(bootstrap) } }, manifest.id);
  assert.equal(await readFile(runs, 'utf8'), 'xx', 'the tests ran once more');
  assert.deepEqual([blocked.status, blocked.reasonCode, blocked.functional.status, blocked.environment.phase, blocked.environment.retry.status], ['NOT_RUN', 'environment', 'NOT_RUN', 'functional', 'FAIL']);
  assert.match(blocked.environment.line, /operation never finished bootstrapping/);
  assert.equal(blocked.visual.status, 'NOT_RUN'); assert.match(blocked.visual.reason, /Functional tests could not run in this environment/);
  await rm(runs);
  const failed = await verify(root, { ...config, policy, verification: { functional: xcodebuild(`/app/UITests.swift:88: error: -[ProtoFlowTasksUITests testDraft] : XCTAssertEqual failed: ("W") is not equal to ("WX")\n${bootstrap}`) } }, manifest.id);
  assert.equal(await readFile(runs, 'utf8'), 'x', 'a test that failed is not retried');
  assert.deepEqual([failed.status, failed.reasonCode, failed.functional.status, failed.functional.environmentRetry], ['FAIL', undefined, 'FAIL', undefined]);
});
test('a build that fails for the machine runs once more: failing again it is NOT_RUN environment and nothing else runs', async t => {
  const { root, config, manifest } = await target(t);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'protoflow-build-runs-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const runs = path.join(scratch, 'runs'), marker = path.join(scratch, 'functional');
  const count = `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(runs)}, 'x'); const run = fs.readFileSync(${JSON.stringify(runs)}, 'utf8').length;`;
  const functional = { argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] };
  const policy = { ...config.policy, transientRetryDelayMs: 0 };
  // hermes-engine falls back to a source build that needs cmake when its Maven check fails; Expo swallows it.
  const hermes = `${count} console.log("⚠️  Something went wrong running \`pod install\` in the \`ios\` directory.\\n[!] Invalid \`hermes-engine.podspec\` file: [!] Unable to locate the executable \`cmake\`.")`;
  const blocked = await verify(root, { ...config, policy, verification: { build: { argv: [process.execPath, '-e', hermes] }, functional } }, manifest.id);
  assert.equal((await readFile(runs, 'utf8')).length, 2, 'the build ran once more');
  assert.equal(blocked.status, 'NOT_RUN'); assert.equal(blocked.reasonCode, 'environment'); assert.equal(blocked.build.status, 'NOT_RUN');
  assert.match(blocked.environment.line, /Unable to locate the executable `cmake`/); assert.match(blocked.environment.hint, /HERMES_ENGINE_TARBALL_PATH/);
  assert.deepEqual([blocked.environment.phase, blocked.environment.retry.status], ['build', 'FAIL']); assert.match(blocked.environment.retry.firstLine, /cmake/);
  assert.equal(blocked.functional.status, 'NOT_RUN'); assert.equal(blocked.visual.status, 'NOT_RUN');
  await assert.rejects(readFile(marker), /ENOENT/, 'functional checks did not run against a build that never happened');
  // A dropped connection on the first run and a clean second run: the build passes and the checks go on.
  await rm(runs);
  const flaky = `${count} if (run === 1) { console.error("fatal: unable to access 'https://repo1.maven.org/': LibreSSL SSL_connect: SSL_ERROR_SYSCALL"); process.exit(1); }`;
  const recovered = await verify(root, { ...config, policy, verification: { build: { argv: [process.execPath, '-e', flaky] }, functional } }, manifest.id);
  assert.equal(recovered.build.status, 'PASS'); assert.equal(recovered.functional.status, 'PASS'); assert.equal(recovered.reasonCode, undefined);
  assert.match(recovered.build.environmentRetry.firstLine, /SSL_connect/); assert.equal(recovered.build.environmentRetry.status, 'PASS');
});
