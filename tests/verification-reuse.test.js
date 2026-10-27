import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, cp, symlink, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { checkpoint } from '../src/sessions.js';
import { verify } from '../src/workflow.js';
import { TEST_ONLY_FILES } from '../src/environment.js';

const engine = fileURLToPath(new URL('..', import.meta.url));

/** The anchors example with build and functional replaced by scripts that count their runs outside the project. */
async function project(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-reuse-'));
  const counters = await mkdtemp(path.join(os.tmpdir(), 'protoflow-reuse-counters-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(counters, { recursive: true, force: true })]));
  await cp(path.join(engine, 'examples/anchors'), root, { recursive: true, filter: source => !/(\.protoflow|test-results|node_modules)/.test(source) });
  await symlink(path.join(engine, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}\n');
  const configFile = path.join(root, 'protoflow.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const counter = name => ({ argv: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(path.join(counters, name))}, 'x')`] });
  config.targets[0].build = counter('build');
  config.targets[0].functional = counter('functional');
  await writeFile(configFile, JSON.stringify(config, null, 2));
  const count = async name => (await readFile(path.join(counters, name), 'utf8').catch(() => '')).length;
  return { root, config: await loadConfig(root), count };
}
const edit = async (root, file, from, to) => {
  const target = path.join(root, file);
  const content = await readFile(target, 'utf8');
  if (!content.includes(from)) throw new Error(`${file} lacks ${from}`);
  await writeFile(target, content.replace(from, to));
};
const byId = report => Object.fromEntries(report.visual.scenes.map(scene => [scene.id, scene]));
const exists = file => access(file).then(() => true, () => false);

test('TEST_ONLY_FILES names files that cannot change the build or the screens', () => {
  for (const file of ['tests/foo.test.ts', 'e2e/x.spec.ts', 'README.md', 'src/__tests__/a.js', 'a/b/spec/c.js', 'jest.config.cjs', 'playwright.config.js', 'src/a.test.mts', 'docs/x.txt', '__mocks__/fs.js', 'test/fixtures/a.json']) assert.ok(TEST_ONLY_FILES.test(file), file);
  for (const file of ['src/app.tsx', 'package.json', 'ios/Podfile', 'testsuite/a.js', 'spectacle/a.js', 'app/tasks.html', 'build.js']) assert.ok(!TEST_ONLY_FILES.test(file), file);
});

test('a verification reuses the build and the scenes a previous one proved, captures failing scenes first and stops after them', async t => {
  const { root, config, count } = await project(t);
  const manifest = await checkpoint(root, config, { summary: 'v1' });
  const run = options => verify(root, config, manifest.id, { target: 'web', reverify: true, ...options });

  // Round 0: everything runs. The tasks page lacks its settings link, so its three scenes fail.
  await edit(root, 'app/tasks.html', '<a data-testid="tasks.settings" href="settings.html">Settings</a>', '');
  const failed = await run();
  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.build.status, 'PASS');
  assert.equal(await count('build'), 1);
  assert.equal(await count('functional'), 1);
  const failing = failed.visual.scenes.filter(scene => scene.status !== 'PASS').map(scene => ({ id: scene.id, variant: scene.variant ?? null }));
  assert.deepEqual(failing.map(scene => scene.id).sort(), ['tasks.added', 'tasks.empty-error', 'tasks.initial']);
  assert.equal(failed.reused, undefined);
  assert.equal(failed.partial, undefined);

  // Round 1: a repair that touched the application without fixing it. Nothing is reused; the failing scenes are
  // captured first, still fail, and the settings scenes are not captured at all.
  await edit(root, 'app/settings.js', 'document.getElementById', '/* repair attempt */ document.getElementById');
  const partial = await run({ reuse: { report: failed }, priority: { scenes: failing, failFast: true } });
  assert.equal(partial.status, 'FAIL');
  assert.equal(await count('build'), 2);
  assert.equal(await count('functional'), 2);
  assert.match(partial.reuseSkipped, /application changed outside test files: app\/settings\.js/);
  assert.equal(partial.reused, undefined);
  assert.deepEqual(partial.partial, { skipped: 2, reason: 'a scene that failed before still fails; the other scenes were not captured' });
  assert.equal(partial.visual.skipped, 2);
  const partialScenes = byId(partial);
  for (const id of ['settings.initial', 'settings.saved']) {
    assert.equal(partialScenes[id].status, 'NOT_RUN');
    assert.equal(partialScenes[id].skipped, true);
    assert.deepEqual(partialScenes[id].artifacts, []);
  }
  for (const id of ['tasks.initial', 'tasks.empty-error', 'tasks.added']) assert.equal(partialScenes[id].status, 'FAIL');
  assert.ok(!partial.visual.reason.includes('settings.'), partial.visual.reason);
  assert.equal(partial.visual.scenes.length, 5);
  assert.ok(await exists(partial.visual.artifacts.at(-1)), 'report.html of the partial verification');

  // Round 2: the fix lands. The failing scenes pass first, then the rest are captured; nothing is skipped.
  await edit(root, 'app/tasks.html', '<h1 data-testid="tasks.title">Today</h1>\n', '<h1 data-testid="tasks.title">Today</h1>\n    <a data-testid="tasks.settings" href="settings.html">Settings</a>\n');
  const fixed = await run({ reuse: { report: partial }, priority: { scenes: failing, failFast: true } });
  assert.equal(fixed.status, 'PASS', fixed.visual.reason);
  assert.equal(await count('build'), 3);
  assert.match(fixed.reuseSkipped, /app\/tasks\.html/);
  assert.equal(fixed.partial, undefined);
  assert.equal(fixed.visual.skipped, undefined);
  assert.ok(fixed.visual.scenes.every(scene => scene.status === 'PASS' && !scene.skipped && !scene.reusedFrom));

  // Round 3: nothing changed. The build and every scene come from the previous verification; functional runs again.
  const same = await run({ reuse: { report: fixed } });
  assert.equal(same.status, 'PASS', same.visual.reason);
  assert.equal(await count('build'), 3);
  assert.equal(await count('functional'), 4);
  assert.deepEqual(same.reused, { from: fixed.id, build: true, scenes: 5 });
  assert.equal(same.build.reusedFrom, fixed.id);
  assert.equal(same.build.status, 'PASS');
  assert.equal(same.visual.reused, 5);
  assert.ok(same.visual.scenes.every(scene => scene.reusedFrom === fixed.id && scene.status === 'PASS'));
  assert.deepEqual(same.visual.scenes.map(scene => scene.id), fixed.visual.scenes.map(scene => scene.id));
  // Reused evidence keeps its files, so the record's hashes and later reviews still point at real screenshots.
  assert.deepEqual(byId(same)['tasks.initial'].artifacts, byId(fixed)['tasks.initial'].artifacts);
  assert.ok(Object.keys(same.artifactHashes).some(file => file.includes(fixed.id)));
  assert.ok(Object.keys(same.artifactHashes).some(file => file.includes(same.id) && file.endsWith('report.html')));
  assert.equal(same.changedDuringVerification, false);
  assert.equal(same.project.hash, fixed.project.hash);

  // Round 4: only test files and docs changed. The build and the scenes still hold; the changed files are recorded.
  await writeFile(path.join(root, 'tests/extra.spec.js'), 'export const extra = true;\n');
  await writeFile(path.join(root, 'README.md'), '# changed\n');
  const testsOnly = await run({ reuse: { report: same } });
  assert.equal(testsOnly.status, 'PASS', testsOnly.visual.reason);
  assert.equal(await count('build'), 3);
  assert.equal(await count('functional'), 5);
  assert.deepEqual(testsOnly.reused, { from: same.id, build: true, scenes: 5, changedFiles: ['README.md', 'tests/extra.spec.js'] });
  // A scene reused twice still names the verification that captured it.
  assert.ok(testsOnly.visual.scenes.every(scene => scene.reusedFrom === fixed.id));
  assert.notEqual(testsOnly.project.hash, same.project.hash);

  // A scene that passed through a maintainer waiver is captured again, so the new record carries the waiver it needs.
  const waived = { ...testsOnly, visual: { ...testsOnly.visual, scenes: testsOnly.visual.scenes.map(scene => scene.id === 'settings.initial' ? { ...scene, waived: [{ tier: 'layout', waiverId: 'WVR-fixture' }] } : scene) } };
  const rewaived = await run({ reuse: { report: waived } });
  assert.equal(rewaived.status, 'PASS', rewaived.visual.reason);
  assert.equal(await count('build'), 3);
  assert.deepEqual([rewaived.reused.scenes, rewaived.visual.reused], [4, 4]);
  assert.equal(byId(rewaived)['settings.initial'].reusedFrom, undefined);
  assert.equal(byId(rewaived)['settings.saved'].reusedFrom, fixed.id);

  // A report of another manifest, or one whose build did not pass, proves nothing here.
  const other = await run({ reuse: { report: { ...testsOnly, manifestHash: 'other' } } });
  assert.equal(other.reuseSkipped, 'manifest differs');
  assert.equal(await count('build'), 4);
  const unbuilt = await run({ reuse: { report: { ...testsOnly, build: { ...testsOnly.build, status: 'FAIL' } } } });
  assert.equal(unbuilt.reuseSkipped, `build of ${testsOnly.id} was FAIL`);
  assert.equal(await count('build'), 5);
  assert.equal(unbuilt.status, 'PASS', unbuilt.visual.reason);
});
