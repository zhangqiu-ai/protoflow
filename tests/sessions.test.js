import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { snapshot, startSession, checkpoint, classifyChanges, watch, getSession, getManifest, listSessions } from '../src/sessions.js';
import { loadConfig } from '../src/config.js';

const exec = promisify(execFile);
const config = {
  prototypeDir: 'prototype',
  mappings: [{ id: 'button', prototypeFiles: ['prototype/**/*.html', 'prototype/*.css'], prototype: '#button', application: '[data-ui=button]', component: 'src/button.js' }],
  policy: { requireHumanReview: true },
  watch: { pollMs: 20, idleMs: 80 },
};
const markup = color => `<style>button { color: ${color}; }</style>\n<button id="button">Save</button>\n`;

async function fixture(t, { git = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-sessions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'prototype/index.html'), markup('red'));
  await fs.writeFile(path.join(root, 'src/button.js'), 'export const label = "Save";\n');
  if (git) {
    await exec('git', ['init', '-q'], { cwd: root });
    await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
    await exec('git', ['config', 'user.name', 'ProtoFlow fixture'], { cwd: root });
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['commit', '-qm', 'fixture'], { cwd: root });
  }
  return root;
}

test('session captures pre-edit source and checkpoint records exact hashes/diff without staging', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'src/button.js'), 'export const label = "Publish";\n');
  await exec('git', ['add', 'src/button.js'], { cwd: root });
  const indexBefore = (await exec('git', ['ls-files', '--stage'], { cwd: root })).stdout;
  const session = await startSession(root, config, { label: 'Button color' });
  await fs.writeFile(path.join(root, 'prototype/index.html'), markup('blue'));
  const manifest = await checkpoint(root, config, { sessionId: session.id });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.level, 'L0');
  assert.equal(manifest.beforeHash, session.before.hash);
  assert.equal(manifest.afterHash, (await snapshot(root, config)).hash);
  assert.notEqual(manifest.beforeHash, manifest.afterHash);
  assert.deepEqual(manifest.mappings, ['button']);
  assert.match(manifest.changes[0].diff, /-<style>button \{ color: red;/);
  assert.match(manifest.changes[0].diff, /\+<style>button \{ color: blue;/);
  assert.match(manifest.git.status, /prototype\/index.html/);
  assert.match(manifest.git.diff, /blue/);
  assert.doesNotMatch(manifest.git.diff, /Publish/);
  assert.doesNotMatch(manifest.git.status, /src\/button.js/);
  assert.equal(manifest.review.status, 'pending');
  assert.deepEqual(await getManifest(root, manifest.id), manifest);
  const closed = await getSession(root, session.id);
  assert.equal(closed.status, 'checkpointed');
  assert.equal(closed.before.files['prototype/index.html'].content, markup('red'));
  assert.equal(closed.after.files['prototype/index.html'].content, markup('blue'));
  assert.equal((await exec('git', ['ls-files', '--stage'], { cwd: root })).stdout, indexBefore);
  await assert.rejects(checkpoint(root, config, { sessionId: session.id }), /already checkpointed/);
});

test('checkpoint without a session includes initial untracked files and then diffs previous checkpoint', async t => {
  const root = await fixture(t, { git: false });
  await exec('git', ['init', '-q'], { cwd: root });
  const initial = await checkpoint(root, config);
  assert.equal(initial.changes.length, 1);
  assert.equal(initial.changes[0].type, 'added');
  assert.equal(initial.changes[0].beforeHash, null);
  assert.match(initial.changes[0].diff, /--- \/dev\/null/);
  assert.match(initial.git.status, /\?\? prototype\/index.html/);
  assert.equal(initial.git.head, null);
  await fs.writeFile(path.join(root, 'prototype/index.html'), markup('green'));
  const next = await checkpoint(root, config);
  assert.equal(next.beforeHash, initial.afterHash);
  assert.equal(next.changes[0].type, 'modified');
  assert.equal(next.level, 'L0');
});

test('deletions retain original content and map to application components', async t => {
  const root = await fixture(t);
  const session = await startSession(root, config);
  await fs.unlink(path.join(root, 'prototype/index.html'));
  const manifest = await checkpoint(root, config);
  assert.equal(manifest.sessionId, session.id);
  assert.equal(manifest.changes[0].type, 'deleted');
  assert.equal(manifest.changes[0].afterHash, null);
  assert.match(manifest.changes[0].diff, /\+\+\+ \/dev\/null/);
  assert.match(manifest.changes[0].diff, /-<button id="button">Save<\/button>/);
  assert.deepEqual(manifest.changes[0].mappings, ['button']);
});

test('classification separates CSS, DOM, data, security and unknown changes; rules only raise', async t => {
  const root = await fixture(t, { git: false });
  const cases = [
    ['style.css', 'button { color: blue }', 'L0'],
    ['new.html', '<button aria-expanded="true">Open</button>', 'L1'],
    ['interaction.js', 'document.querySelector("button").focus()', 'L1'],
    ['data.js', 'fetch("/api/profile")', 'L2'],
    ['security.js', 'checkPermission(user)', 'L3'],
    ['auth.js', 'const password = input.value', 'L3'],
    ['unknown.txt', 'a completely unfamiliar design decision', 'L2'],
  ];
  for (const [file, content, level] of cases) {
    const before = await snapshot(root, config);
    await fs.writeFile(path.join(root, 'prototype', file), content);
    const after = await snapshot(root, config);
    assert.equal(classifyChanges(before, after, config).level, level, file);
  }
  const before = await snapshot(root, config);
  await fs.writeFile(path.join(root, 'prototype/auth.js'), 'const password = "new value"');
  const after = await snapshot(root, config);
  assert.equal(classifyChanges(before, after, { ...config, classification: { rules: [{ pattern: '**/*.js', level: 'L0' }] } }, { level: 'L1' }).level, 'L3');
  await fs.writeFile(path.join(root, 'prototype/style.css'), 'button { color: pink }');
  assert.equal(classifyChanges(after, await snapshot(root, config), { ...config, classification: { rules: [{ pattern: 'prototype/*.css', level: 'L2' }] } }).level, 'L2');
  assert.throws(() => classifyChanges(before, after, config, { level: 'L4' }), /Invalid change level/);
});

test('snapshot excludes build dependencies and hashes binary assets', async t => {
  const root = await fixture(t, { git: false });
  await fs.mkdir(path.join(root, 'prototype/node_modules'));
  await fs.writeFile(path.join(root, 'prototype/node_modules/ignore.js'), 'ignored');
  await fs.writeFile(path.join(root, 'prototype/asset.bin'), Buffer.from([255, 254, 253]));
  const captured = await snapshot(root, config);
  assert.deepEqual(Object.keys(captured.files), ['prototype/asset.bin', 'prototype/index.html']);
  assert.equal(captured.files['prototype/asset.bin'].binary, true);
  assert.equal(captured.files['prototype/asset.bin'].content, undefined);
  assert.equal((await snapshot(root, config)).hash, captured.hash);
  await fs.writeFile(path.join(root, 'prototype/asset.bin'), Buffer.from([255, 254, 252]));
  const classification = classifyChanges(captured, await snapshot(root, config), config);
  assert.equal(classification.level, 'L2');
  assert.equal(classification.changes[0].diff, 'Binary asset changed');
});

test('snapshot bounds files, total size, and count and rejects escape/cycle symlinks', async t => {
  const root = await fixture(t, { git: false });
  await assert.rejects(snapshot(root, { ...config, snapshot: { maxFileBytes: 10 } }), /maxFileBytes/);
  await assert.rejects(snapshot(root, { ...config, snapshot: { maxTotalBytes: 10 } }), /maxTotalBytes/);
  await fs.writeFile(path.join(root, 'prototype/a.css'), 'a{}');
  await assert.rejects(snapshot(root, { ...config, snapshot: { maxFiles: 1 } }), /maxFiles/);
  await fs.symlink(os.tmpdir(), path.join(root, 'prototype/escape'));
  await assert.rejects(snapshot(root, config), /symlink escapes project/);
  await fs.unlink(path.join(root, 'prototype/escape'));
  await fs.symlink(path.join(root, 'prototype'), path.join(root, 'prototype/cycle'));
  await assert.rejects(snapshot(root, config), /symlink cycle/);
});

test('missing prototypes have deterministic empty snapshot and state identifiers are safe', async t => {
  const root = await fixture(t, { git: false });
  const empty = await snapshot(root, { ...config, prototypeDir: 'not-created' });
  assert.deepEqual(empty.files, {});
  assert.equal(empty.hash, (await snapshot(root, { ...config, prototypeDir: 'not-created' })).hash);
  await assert.rejects(getSession(root, '../../outside'), /Invalid/);
  await assert.rejects(getManifest(root, '../outside'), /Invalid/);
  const active = await startSession(root, config);
  await assert.rejects(startSession(root, config), /already exists/);
  assert.deepEqual((await listSessions(root)).map(item => item.id), [active.id]);
});

test('watch records the snapshot before a burst of changes and checkpoints only after idle', async t => {
  const root = await fixture(t);
  let ready;
  const initialReady = new Promise(resolve => { ready = resolve; });
  const observations = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const running = watch(root, config, { once: true, signal: controller.signal, onReady: ready, onCheckpoint: manifest => observations.push(manifest) });
  await initialReady;
  await fs.writeFile(path.join(root, 'prototype/index.html'), markup('blue'));
  await delay(45);
  await fs.writeFile(path.join(root, 'prototype/index.html'), markup('green'));
  assert.equal(observations.length, 0);
  const result = await running;
  assert.equal(result.checkpoints.length, 1);
  assert.equal(result.stopped, false);
  assert.equal(observations.length, 1);
  const saved = await getSession(root, result.checkpoints[0].sessionId);
  assert.equal(saved.before.files['prototype/index.html'].content, markup('red'));
  assert.equal(saved.after.files['prototype/index.html'].content, markup('green'));
  assert.equal(result.checkpoints[0].level, 'L0');
});

test('aborted watch leaves a recoverable pre-change session, and resumed watch checkpoints it', async t => {
  const root = await fixture(t);
  const controller = new AbortController();
  let ready;
  const initialReady = new Promise(resolve => { ready = resolve; });
  const running = watch(root, { ...config, watch: { pollMs: 20, idleMs: 1000 } }, { signal: controller.signal, onReady: ready });
  await initialReady;
  await fs.writeFile(path.join(root, 'prototype/index.html'), markup('blue'));
  let sessions = [];
  for (let attempt = 0; attempt < 100 && !sessions.length; attempt++) {
    await delay(10);
    sessions = await listSessions(root);
  }
  assert.equal(sessions.length, 1);
  controller.abort();
  const aborted = await running;
  assert.equal(aborted.activeSessionId, sessions[0].id);
  assert.equal(aborted.checkpoints.length, 0);
  const resumed = await watch(root, config, { once: true });
  assert.equal(resumed.checkpoints[0].sessionId, sessions[0].id);
  assert.equal(resumed.checkpoints[0].beforeHash, sessions[0].before.hash);
});

test('CLI watch emits readiness and persists one debounced checkpoint without holding its lock afterward', { timeout: 10000 }, async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify({ schemaVersion: 1, ...config }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/protoflow.js', import.meta.url)), 'watch', '--once', '--project', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  const events = [];
  let ready;
  let readyError;
  const readiness = new Promise((resolve, reject) => { ready = resolve; readyError = reject; });
  child.once('error', readyError);
  child.once('close', code => { if (!events.some(item => item.event === 'ready')) readyError(new Error(`Watcher exited ${code}: ${stderr}`)); });
  lines.on('line', line => {
    try {
      const item = JSON.parse(line);
      if (item.event) { events.push(item); if (item.event === 'ready') ready(item); }
    } catch { /* The final return value is pretty-printed JSON, not an event line. */ }
  });
  const state = await readiness;
  assert.equal(state.activeSessionId, null);
  await fs.writeFile(path.join(root, 'prototype/index.html'), markup('purple'));
  assert.equal(await exit, 0, stderr);
  assert.deepEqual(events.map(item => item.event), ['ready', 'checkpoint']);
  const saved = await getSession(root, events[1].manifest.sessionId);
  assert.equal(saved.before.files['prototype/index.html'].content, markup('red'));
  assert.equal(saved.after.files['prototype/index.html'].content, markup('purple'));
  await assert.rejects(fs.stat(path.join(root, '.protoflow/active.lock')), { code: 'ENOENT' });
});

const singlePageMappings = [
  { id: 'navigation', prototypeFiles: ['prototype/index.html'], prototype: '#navigation', application: '[data-ui=navigation]', component: 'src/Navigation.tsx' },
  { id: 'chat', prototypeFiles: ['prototype/index.html'], prototype: '#chat', application: '[data-ui=chat]', component: 'src/Chat.tsx' },
];
const pageContent = label => `<nav id="navigation">Home</nav>\n<main id="chat">${label}</main>\n`;

test('one prototype HTML supports multiple mappings with distinct application component files', async t => {
  const root = await fixture(t, { git: false });
  await fs.writeFile(path.join(root, 'prototype/index.html'), pageContent('Messages'));
  await fs.writeFile(path.join(root, 'src/Navigation.tsx'), 'export default function Navigation() { return "Home"; }');
  await fs.writeFile(path.join(root, 'src/Chat.tsx'), 'export default function Chat() { return "Messages"; }');
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify({ schemaVersion: 1, ...config, mappings: singlePageMappings }));
  const loaded = await loadConfig(root);
  const manifest = await checkpoint(root, loaded);
  assert.deepEqual(loaded.mappings.map(mapping => mapping.component), ['src/Navigation.tsx', 'src/Chat.tsx']);
  assert.deepEqual(manifest.mappings, ['navigation', 'chat']);
  assert.deepEqual(manifest.changes.map(change => change.path), ['prototype/index.html']);
  assert.deepEqual((await getManifest(root, manifest.id)).changes[0].mappings, ['navigation', 'chat']);
});

test('local text edit within one HTML fans out to all file mappings despite distinct selectors', async t => {
  const root = await fixture(t, { git: false });
  const pageConfig = { ...config, mappings: singlePageMappings };
  await fs.writeFile(path.join(root, 'prototype/index.html'), pageContent('Messages'));
  const session = await startSession(root, pageConfig);
  await fs.writeFile(path.join(root, 'prototype/index.html'), pageContent('New messages'));
  const manifest = await checkpoint(root, pageConfig, { sessionId: session.id });
  assert.deepEqual(manifest.mappings, ['navigation', 'chat']);
  assert.deepEqual(manifest.changes[0].mappings, ['navigation', 'chat']);
  const saved = await getSession(root, session.id);
  assert.equal(saved.before.files['prototype/index.html'].content.split('\n')[0], saved.after.files['prototype/index.html'].content.split('\n')[0]);
  assert.match(manifest.changes[0].diff, /-<main id="chat">Messages<\/main>/);
  assert.match(manifest.changes[0].diff, /\+<main id="chat">New messages<\/main>/);
});

async function multipageFixture(t) {
  const root = await fixture(t, { git: false });
  await fs.mkdir(path.join(root, 'prototype/pages/chat'), { recursive: true });
  await fs.mkdir(path.join(root, 'prototype/shared'), { recursive: true });
  await fs.writeFile(path.join(root, 'prototype/pages/navigation.html'), '<link rel="stylesheet" href="../shared/tokens.css"><nav id="navigation">Home</nav>');
  await fs.writeFile(path.join(root, 'prototype/pages/chat/index.html'), '<link rel="stylesheet" href="../../shared/tokens.css"><main id="chat">Messages</main>');
  await fs.writeFile(path.join(root, 'prototype/shared/tokens.css'), ':root { --accent: blue; }');
  const pageConfig = { ...config, mappings: [
    { ...singlePageMappings[0], prototypeFiles: ['prototype/pages/navigation.html', 'prototype/shared/tokens.css'] },
    { ...singlePageMappings[1], prototypeFiles: ['prototype/pages/chat/**/*.html', 'prototype/shared/tokens.css'] },
  ] };
  return { root, pageConfig };
}

test('split prototype pages route a local change only to the affected page component', async t => {
  const { root, pageConfig } = await multipageFixture(t);
  const before = await snapshot(root, pageConfig);
  await fs.writeFile(path.join(root, 'prototype/pages/chat/index.html'), '<link rel="stylesheet" href="../../shared/tokens.css"><main id="chat">New messages</main>');
  const after = await snapshot(root, pageConfig);
  const change = classifyChanges(before, after, pageConfig);
  assert.deepEqual(change.mappings, ['chat']);
  assert.deepEqual(change.changes.map(item => item.path), ['prototype/pages/chat/index.html']);
  assert.deepEqual(change.changes[0].mappings, ['chat']);
  assert.equal(before.files['prototype/pages/navigation.html'].hash, after.files['prototype/pages/navigation.html'].hash);
});

test('shared token edits fan out to every explicitly configured consumer mapping', async t => {
  const { root, pageConfig } = await multipageFixture(t);
  const session = await startSession(root, pageConfig);
  await fs.writeFile(path.join(root, 'prototype/shared/tokens.css'), ':root { --accent: green; }');
  const manifest = await checkpoint(root, pageConfig, { sessionId: session.id });
  assert.equal(manifest.level, 'L0');
  assert.deepEqual(manifest.mappings, ['navigation', 'chat']);
  assert.deepEqual(manifest.changes.map(change => change.path), ['prototype/shared/tokens.css']);
  assert.deepEqual(manifest.changes[0].mappings, ['navigation', 'chat']);
  assert.equal(manifest.changes[0].type, 'modified');
});

test('deleting a shared token file retains original evidence and fans out to every consumer mapping', async t => {
  const { root, pageConfig } = await multipageFixture(t);
  const session = await startSession(root, pageConfig);
  await fs.unlink(path.join(root, 'prototype/shared/tokens.css'));
  const manifest = await checkpoint(root, pageConfig, { sessionId: session.id });
  assert.deepEqual(manifest.mappings, ['navigation', 'chat']);
  assert.deepEqual(manifest.changes.map(change => change.path), ['prototype/shared/tokens.css']);
  assert.deepEqual(manifest.changes[0].mappings, ['navigation', 'chat']);
  assert.equal(manifest.changes[0].type, 'deleted');
  assert.equal(manifest.changes[0].beforeHash, session.before.files['prototype/shared/tokens.css'].hash);
  assert.equal(manifest.changes[0].afterHash, null);
  assert.match(manifest.changes[0].diff, /-:root \{ --accent: blue; \}/);
});
