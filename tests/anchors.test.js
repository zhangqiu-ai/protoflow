import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseAnchors, staticContract, contractScope, scopeLevel, suggestAnchors, lineDiff, normalizeText } from '../src/anchors.js';
import { checkpoint, classifyChanges } from '../src/sessions.js';
import { scanSource, sourceStatus } from '../src/source.js';

const exec = promisify(execFile);
const config = { schemaVersion: 2, prototypeDir: 'prototype', targets: [{ id: 'web', platform: 'web', driver: { kind: 'playwright-web', urlTemplate: 'app/{page}.html' } }] };
const page = (body, screen = 'home') => `<!doctype html><html><body><main data-pf="${screen}" data-pf-role="screen">${body}</main></body></html>\n`;
const snapshot = files => ({ files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, { hash: String(content.length) + content, content }])) });

test('parser follows nesting, roles, repeats, entities and skips script/style text', () => {
  const { anchors, errors } = parseAnchors(page(`
    <section data-pf="home.list" data-pf-role="region"><h2 data-pf="home.list.title">Tom &amp; Jerry&#33;</h2>
      <ul><li data-pf="home.item" data-pf-repeat>One<li data-pf="home.item" data-pf-repeat>Two</ul></section>
    <p data-pf="home.clock" data-pf-text="dynamic">12:00</p>
    <svg data-pf="home.chart" data-pf-visual-only><path d="M0 0"/></svg>
    <style>.x::after{content:"<b>"}</style><script>if (a < b) document.write("<p data-pf='fake'>")</script>
    <input data-pf="home.email" data-pf-role="input" type="email">`));
  assert.deepEqual(errors, []);
  assert.deepEqual(anchors.map(anchor => [anchor.id, anchor.role, anchor.parent, anchor.order]), [
    ['home', 'screen', null, 0], ['home.list', 'region', 'home', 0], ['home.list.title', 'element', 'home.list', 0],
    ['home.item', 'element', 'home.list', 1], ['home.item', 'element', 'home.list', 2],
    ['home.clock', 'element', 'home', 1], ['home.chart', 'element', 'home', 2], ['home.email', 'input', 'home', 3]
  ]);
  const byId = Object.fromEntries(anchors.map(anchor => [anchor.id, anchor]));
  assert.equal(byId['home.list.title'].text, 'Tom & Jerry!');
  assert.equal(byId['home.item'].repeat, true);
  assert.equal(byId['home.clock'].text, null);
  assert.equal(byId['home.chart'].visualOnly, true);
  assert.equal(byId['home.email'].inputType, 'email');
  assert.equal(normalizeText(' a​ \n b '), 'a b');
});

test('static contract lints screens, ids, duplicates and sidecars', () => {
  const contract = staticContract(snapshot({
    'prototype/a.html': page('<h1 data-pf="a.title">A</h1><b data-pf="a.title">again</b><i data-pf="Bad_Id">x</i>', 'a'),
    'prototype/b.html': '<html><body><h1>No screen</h1></body></html>',
    'prototype/c.html': page('<button data-pf="c.go" data-pf-role="action">Go</button>', 'a'),
    'prototype/d.html': page('<p data-pf="other.thing">x</p>', 'd'),
    'prototype/d.pf.json': JSON.stringify({ schemaVersion: 1, screen: 'd', states: { loop: { from: 'again' }, again: { from: 'loop' }, missing: { fixture: 'nope' } } }),
    'prototype/e.html': page('', 'e'),
    'prototype/e.pf.json': JSON.stringify({ schemaVersion: 1, screen: 'wrong' }),
    'prototype/f.html': page('', 'f'),
    'prototype/f.pf.json': '{not json'
  }), config);
  const errors = contract.errors.join('\n');
  assert.match(errors, /a\.html: anchor "a\.title" appears 2 times/);
  assert.match(errors, /a\.html: Invalid anchor id "Bad_Id"/);
  assert.match(errors, /b\.html: expected exactly one data-pf-role="screen" anchor, found 0/);
  assert.match(errors, /c\.html: screen "a" is already defined by prototype\/a\.html/);
  assert.match(errors, /d\.pf\.json: State cycle/);
  assert.match(errors, /d\.pf\.json: State "missing" uses undefined fixture "nope"/);
  assert.match(errors, /e\.pf\.json: screen "wrong" does not match page screen "e"/);
  assert.match(errors, /f\.pf\.json: invalid JSON/);
  assert.match(contract.warnings.join('\n'), /d\.html: anchor "other\.thing" is not namespaced under screen "d"/);
});

test('sidecar states resolve through from-chains with fixtures and expectations', () => {
  const contract = staticContract(snapshot({
    'prototype/login.html': page('<input data-pf="login.email" data-pf-role="input"><button data-pf="login.go" data-pf-role="action">Go</button>', 'login'),
    'prototype/login.pf.json': JSON.stringify({ schemaVersion: 1, screen: 'login', fixtures: { member: { localStorage: { user: 'x' } } }, states: {
      filled: { fixture: 'member', steps: [{ action: 'fill', anchor: 'login.email', value: 'a@b.c' }] },
      submitted: { from: 'filled', steps: [{ action: 'tap', anchor: 'login.go' }], expect: { visible: ['login.welcome'] } }
    } })
  }), config);
  assert.deepEqual(contract.errors, []);
  const states = contract.screens.login.states;
  assert.deepEqual(Object.keys(states), ['initial', 'filled', 'submitted']);
  assert.equal(states.submitted.fixture, 'member');
  assert.deepEqual(states.submitted.steps.map(step => step.action), ['fill', 'tap']);
  assert.deepEqual(states.submitted.expect.visible, ['login.welcome']);
  // Script-created anchors are allowed but flagged.
  assert.match(contract.warnings.join(), /references "login\.welcome", which is not in the static HTML/);
});

test('scope reports added/removed screens, anchor changes, resource-only changes and level', () => {
  const before = staticContract(snapshot({
    'prototype/a.html': page('<link rel="stylesheet" href="shared.css"><h1 data-pf="a.title">Old</h1>', 'a'),
    'prototype/b.html': page('<p data-pf="b.text">B</p>', 'b'),
    'prototype/gone.html': page('', 'gone'),
    'prototype/shared.css': 'h1{color:red}'
  }), config);
  const after = staticContract(snapshot({
    'prototype/a.html': page('<link rel="stylesheet" href="shared.css"><h1 data-pf="a.title">New</h1><button data-pf="a.go" data-pf-role="action">Go</button>', 'a'),
    'prototype/b.html': page('<link rel="stylesheet" href="shared.css"><p data-pf="b.text">B</p>', 'b'),
    'prototype/new.html': page('', 'new'),
    'prototype/shared.css': 'h1{color:blue}',
    'prototype/unused.png': 'x'
  }), config);
  const scope = contractScope(before, after, ['prototype/a.html', 'prototype/b.html', 'prototype/gone.html', 'prototype/new.html', 'prototype/shared.css', 'prototype/unused.png']);
  assert.deepEqual(scope.affected, ['a', 'b', 'new']);
  assert.deepEqual(scope.removed, ['gone']);
  assert.deepEqual(scope.screens.a.anchors.added, ['a.go']);
  assert.deepEqual(scope.screens.a.anchors.changed, [{ id: 'a.title', fields: ['text'] }]);
  assert.equal(scope.screens.b.lowPrecision, true);
  assert.ok(scope.screens.b.reasons.includes('resource changed: prototype/shared.css'));
  assert.equal(scope.screens.new.status, 'added');
  assert.deepEqual(scope.unscreened, ['prototype/unused.png']);
  assert.equal(scopeLevel(scope, after), 'L1');
  // Own text: the screen's text excludes its children's, so only the changed anchor is reported.
  assert.ok(!scope.screens.a.anchors.changed.some(change => change.id === 'a'));
});

test('style-only change stays L0 and v2 checkpoints carry scope instead of mappings', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-anchor-cp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.writeFile(path.join(root, 'prototype/a.html'), page('<link rel="stylesheet" href="a.css"><h1 data-pf="a.title">A</h1>', 'a'));
  await fs.writeFile(path.join(root, 'prototype/a.css'), 'h1{color:red}');
  const first = await checkpoint(root, config);
  assert.deepEqual(first.mappings, []);
  assert.deepEqual(first.scope.affected, ['a']);
  await fs.writeFile(path.join(root, 'prototype/a.css'), 'h1{color:blue}');
  const second = await checkpoint(root, config);
  assert.equal(second.level, 'L0');
  assert.deepEqual(second.scope.affected, ['a']);
  assert.equal(second.scope.screens.a.lowPrecision, true);
  await fs.writeFile(path.join(root, 'prototype/b.html'), '<html><body>no anchors</body></html>');
  await assert.rejects(checkpoint(root, config), error => error.code === 'ANCHOR_LINT' && /b\.html/.test(error.errors.join()));
  // v1 configs are untouched by anchors.
  const v1 = classifyChanges({ files: {} }, snapshot({ 'prototype/x.html': '<p>x</p>' }), { prototypeDir: 'prototype', mappings: [] });
  assert.equal(v1.scope, undefined);
});

test('suggested anchors produce a git-applicable patch and a valid contract', async t => {
  const original = '<!doctype html>\n<html><body>\n<header><h1>Inbox</h1><nav aria-label="Primary"><a href="#">Home</a></nav></header>\n<main>\n<form><input name="query" type="search"><button type="submit">Search</button></form>\n<p>Done</p>\n</main>\n</body></html>\n';
  const suggestion = suggestAnchors('prototype/inbox.html', original);
  assert.equal(suggestion.screen, 'inbox');
  assert.deepEqual(suggestion.suggestions.map(item => `${item.id}:${item.role}`), [
    'inbox:screen', 'inbox.header:region', 'inbox.inbox:element', 'inbox.primary:region', 'inbox.home:action', 'inbox.form:region', 'inbox.query:input', 'inbox.search:action'
  ]);
  assert.deepEqual(staticContract(snapshot({ 'prototype/inbox.html': suggestion.html }), config).errors, []);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-suggest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prototype'));
  await fs.writeFile(path.join(root, 'prototype/inbox.html'), original);
  await exec('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, 'anchors.patch'), lineDiff('prototype/inbox.html', original, suggestion.html));
  await exec('git', ['apply', 'anchors.patch'], { cwd: root });
  assert.equal(await fs.readFile(path.join(root, 'prototype/inbox.html'), 'utf8'), suggestion.html);
  // Files without a trailing newline are marked so git can apply them too.
  const unterminated = lineDiff('x.html', 'a\nb', 'a\nB');
  assert.match(unterminated, /\+B\n\\ No newline at end of file\n$/);
});

test('git source folds an invalid anchored commit into the next valid version', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-anchor-scan-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const design = path.join(base, 'design'), root = path.join(base, 'app');
  await fs.mkdir(path.join(design, 'prototype'), { recursive: true });
  await fs.mkdir(root);
  const git = (...args) => exec('git', args, { cwd: design }).then(result => result.stdout.trim());
  await git('init', '-q', '-b', 'prototypes');
  await git('config', 'user.email', 'fixture@protoflow.test'); await git('config', 'user.name', 'Fixture');
  const commit = async (file, content, message) => { await fs.writeFile(path.join(design, file), content); await git('add', '.'); await git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  const start = await commit('README.md', 'design\n', 'start');
  const valid = await commit('prototype/a.html', page('<h1 data-pf="a.title">One</h1>', 'a'), 'valid');
  const invalid = await commit('prototype/b.html', '<html><body><p>forgot anchors</p></body></html>', 'invalid');
  const fixed = await commit('prototype/b.html', page('<p data-pf="b.text">Fixed</p>', 'b'), 'fixed');
  const sourceConfig = { ...config, source: { kind: 'git', repository: design, branch: 'prototypes', path: 'prototype', startSha: start } };
  const result = await scanSource(root, sourceConfig);
  assert.deepEqual(result.added, [`git-${valid}`, `git-${fixed}`]);
  const state = await sourceStatus(root);
  assert.equal(state.rejected.length, 1);
  assert.equal(state.rejected[0].sha, invalid);
  assert.equal(state.rejected[0].foldedInto, fixed);
  assert.match(state.rejected[0].errors.join(), /b\.html: expected exactly one data-pf-role="screen"/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, `.protoflow/manifests/git-${fixed}.json`), 'utf8'));
  // The fixed version's diff starts from the last valid version, so the invalid commit's change is not lost.
  assert.equal(manifest.beforeHash, JSON.parse(await fs.readFile(path.join(root, `.protoflow/manifests/git-${valid}.json`), 'utf8')).afterHash);
  assert.deepEqual(manifest.scope.affected, ['b']);
});
