import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/install.js';
import { loadConfig } from '../src/config.js';
import { checkpoint } from '../src/sessions.js';
import { createContext, executeContext } from '../src/workflow.js';
import { hash } from '../src/util.js';
import { executorPrompt } from '../src/executor-prompt.js';
import { briefManifest, diffExcerpts, fitContext, CONTEXT_BUDGET, DIFF_INLINE_LIMIT } from '../src/context-budget.js';

// A generated page with its whole body on one line, like qiuge's screens: one attribute change rewrites the line.
const page = (state, size) => `<!doctype html>\n<html><body><main id="card" data-state="${state}">${'<div class="row">FAKE FIXTURE row</div>'.repeat(Math.ceil(size / 40))}</main></body></html>\n`;

async function target(t, pages) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-context-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  for (const [name, content] of Object.entries(pages)) await writeFile(path.join(root, 'prototype', name), content);
  await writeFile(path.join(root, 'app.html'), '<main id="card">Hello</main>');
  const config = await loadConfig(root);
  config.mappings = [{ id: 'card', prototypeFiles: Object.keys(pages).map(name => `prototype/${name}`), prototype: '#card', application: '#card', component: 'app.html' }];
  config.policy = { ...config.policy, sequentialVersions: false };
  await writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  return { root, config, first: await checkpoint(root, config) };
}

test('excerpts show where a one-line page changed, with a little context, not the whole line', () => {
  const before = `<main data-state="old">${'x'.repeat(100000)}</main>`, after = `<main data-state="new">${'x'.repeat(100000)}</main>`;
  const [excerpt] = diffExcerpts(`--- a\n+++ b\n@@ -1 +1 @@\n-${before}\n+${after}\n`);
  assert.equal(excerpt.offset, before.indexOf('old'));
  assert.ok(excerpt.before.includes('data-state="old"') && excerpt.after.includes('data-state="new"'));
  assert.ok(excerpt.before.length < 400 && excerpt.after.length < 400);
  // The executor is told what an omitted diff means and where the content is.
  const prompt = context => executorPrompt({ instructions: 'FAKE' }, context);
  assert.match(prompt({ manifest: { changes: [{ path: 'a.html', diffOmitted: true }] } }), /`diffOmitted: true`[\s\S]*`frozenAfter` is this version, `frozenBefore` the previous one/);
  assert.doesNotMatch(prompt({ manifest: { changes: [{ path: 'a.html', diff: 'x' }] } }), /diffOmitted/);
});

test('FAKE executor only: a one-line generated page reaches the executor by its frozen files, and the record keeps the whole manifest', async t => {
  // Seven 200 KB one-line pages: their diffs alone are about 2.8 million characters, twice over with the git diff.
  const names = Array.from({ length: 7 }, (_, i) => `screen-${i}.html`);
  const { root, config } = await target(t, { ...Object.fromEntries(names.map(name => [name, page('old', 200000)])), 'small.html': '<p>FAKE FIXTURE small page</p>\n' });
  for (const name of names) await writeFile(path.join(root, 'prototype', name), page('new', 200000));
  await writeFile(path.join(root, 'prototype', 'small.html'), '<p>FAKE FIXTURE small page, changed</p>\n');
  const manifest = await checkpoint(root, config);
  assert.ok(JSON.stringify(manifest.changes).length > 2 * 1024 * 1024, 'the frozen manifest itself is unchanged');
  const context = await createContext(root, config, manifest.id);
  const dry = await executeContext(root, config, context.id);
  assert.equal(dry.status, 'NOT_RUN');
  const size = JSON.stringify(dry.request).length;
  assert.ok(size < CONTEXT_BUDGET, `request is ${size} characters`);
  const big = dry.request.manifest.changes.find(change => change.path === 'prototype/screen-0.html');
  assert.equal(big.diffOmitted, true); assert.equal(big.diff, undefined); assert.ok(big.diffSize > DIFF_INLINE_LIMIT);
  // Both frozen copies exist where the executor runs, and hold the before and after content.
  assert.match(big.frozenAfter, new RegExp(`^\\.protoflow/versions/${manifest.id}/files/prototype/screen-0\\.html$`));
  assert.match(await readFile(path.join(root, big.frozenAfter), 'utf8'), /data-state="new"/);
  assert.match(await readFile(path.join(root, big.frozenBefore), 'utf8'), /data-state="old"/);
  assert.ok(big.excerpts[0].after.includes('data-state="new"'));
  // A small change keeps its diff inline; the version's git diff is not sent a second time.
  const small = dry.request.manifest.changes.find(change => change.path === 'prototype/small.html');
  assert.equal(typeof small.diff, 'string'); assert.equal(small.diffOmitted, undefined);
  if (manifest.git?.diff !== undefined) { assert.equal(dry.request.manifest.git.diff, undefined); assert.equal(dry.request.manifest.git.diffOmitted, true); }
  // Executed: the executor receives the brief request; the record keeps the whole one, so delivery provenance still matches.
  const received = path.join(root, 'received.json');
  config.adapters.codex.command = { argv: [process.execPath, '-e', `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>require('fs').writeFileSync(${JSON.stringify(received)},s))`] };
  const executed = await executeContext(root, config, context.id, { execute: true });
  assert.equal(executed.status, 'PASS');
  const sent = await readFile(received, 'utf8');
  assert.ok(sent.length < CONTEXT_BUDGET);
  assert.equal(executed.request.manifestHash, hash(executed.request.manifest)); assert.deepEqual(executed.request.manifest, manifest);
  assert.equal(executed.sent.hash, hash(JSON.parse(sent))); assert.deepEqual(executed.sent.omittedDiffs, names.map(name => `prototype/${name}`));
});

test('a frozen manifest from an older engine fits too: references first, every diff if needed, else an error naming the parts', async t => {
  const { root, first } = await target(t, { 'index.html': page('old', 1000) });
  await access(path.join(root, `.protoflow/versions/${first.id}/files/prototype/index.html`));
  const diff = `--- a\n+++ b\n@@ -1 +1 @@\n-${'a'.repeat(30000)}\n+${'b'.repeat(30000)}\n`;
  const manifest = { id: first.id, changes: Array.from({ length: 20 }, (_, i) => ({ path: `prototype/p${i}.html`, type: 'modified', diff })), git: { available: true, head: 'abc', diff: diff.repeat(20) } };
  // Each diff is under the inline limit, but twenty of them with the git copy exceed a small budget: all go by reference.
  const fitted = await fitContext(root, { kind: 'implement', manifest }, { budget: 200000 });
  assert.ok(fitted.manifest.changes.every(change => change.diffOmitted)); assert.equal(fitted.manifest.git.diffOmitted, true);
  assert.ok(JSON.stringify(fitted).length < 200000);
  assert.deepEqual(await briefManifest(root, { id: 'x', changes: [{ path: 'a', diff: 'small' }] }), { id: 'x', changes: [{ path: 'a', diff: 'small' }] });
  await assert.rejects(fitContext(root, { kind: 'implement', manifest, anchors: { screens: 'y'.repeat(300000) } }, { budget: 200000 }), error => error.reasonCode === 'context-too-large' && /above the executor budget of 200000[\s\S]*largest parts: anchors\.screens \(300002\)/.test(error.message));
});
