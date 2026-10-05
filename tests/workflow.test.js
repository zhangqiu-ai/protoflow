import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
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
  const context = await createContext(root, config, manifest.id);
  assert.equal(context.mappings[0].component, 'app.html');
  const dry = await executeContext(root, config, context.id);
  assert.equal(dry.status, 'NOT_RUN');
  await writeFile(path.join(root, 'app.html'), 'User edited');
  await assert.rejects(executeContext(root, config, context.id, { execute: true }), /stale/);
  const next = await startSession(root, config);
  await writeFile(path.join(root, 'prototype/new.html'), '<aside>Unknown</aside>');
  const unmapped = await checkpoint(root, config, { sessionId: next.id });
  await assert.rejects(createContext(root, config, unmapped.id), /Map changed/);
});
test('L2 specification and L3 human architecture decisions are separate mandatory gates', async t => {
  const { root, config } = await target(t);
  const session = await startSession(root, config);
  await writeFile(path.join(root, 'prototype/index.html'), '<main id="card"><script>fetch("/api")</script></main>');
  const l2 = await checkpoint(root, config, { sessionId: session.id });
  assert.equal(l2.level, 'L2');
  await assert.rejects(createContext(root, config, l2.id), /requires --spec/);
  await writeFile(path.join(root, 'spec.md'), '# Feature\nAcceptance: loads data and shows failures.');
  assert.equal((await createContext(root, config, l2.id, { spec: 'spec.md' })).spec.path, 'spec.md');
  const next = await startSession(root, config);
  await writeFile(path.join(root, 'prototype/index.html'), '<main id="card">Replace authentication permission system</main>');
  const l3 = await checkpoint(root, config, { sessionId: next.id });
  assert.equal(l3.level, 'L3');
  await assert.rejects(createContext(root, config, l3.id, { spec: 'spec.md' }), /requires --adr/);
  await writeFile(path.join(root, 'adr.json'), JSON.stringify({ status: 'approved', reviewer: 'Test human fixture', manifestHash: 'wrong', decision: 'Preserve current auth' }));
  await assert.rejects(createContext(root, config, l3.id, { spec: 'spec.md', adr: 'adr.json' }), /human approval/);
  await writeFile(path.join(root, 'adr.json'), JSON.stringify({ status: 'approved', reviewer: 'Test human fixture', manifestHash: hash(l3), decision: 'Preserve current auth' }));
  const context = await createContext(root, config, l3.id, { spec: 'spec.md', adr: 'adr.json' });
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
test('executor records process results and rejects prototype modification', async t => {
  const { root, config, manifest } = await target(t);
  config.adapters.codex.command = { argv: [process.execPath, '-e', 'process.stdin.resume(); require("fs").writeFileSync("prototype/index.html", "Agent changed design")'] };
  const context = await createContext(root, config, manifest.id);
  const result = await executeContext(root, config, context.id, { execute: true });
  assert.equal(result.status, 'FAIL');
  assert.match(result.result.error, /changed prototype/);
  await assert.rejects(verify(root, config, manifest.id), /checkpoint/);
});
test('repair does not retry NOT_RUN checks and escalates to pending human review', async t => {
  const { root, config, manifest } = await target(t);
  const result = await repair(root, config, manifest.id, { execute: true });
  assert.equal(result.status, 'NEEDS_REVIEW');
  assert.equal(result.executions.length, 0);
  const review = JSON.parse(await readFile(path.join(root, '.protoflow/reviews', `${result.reviewId}.json`)));
  assert.equal(review.status, 'pending');
});
