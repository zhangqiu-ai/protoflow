import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { loadConfig, configSchemaV2 } from '../src/config.js';
import { captureExternal } from '../src/drivers/external.js';
import { scenesFor, targetSettings } from '../src/targets.js';
import { staticContract } from '../src/anchors.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/protoflow.js', import.meta.url));
const exampleConfig = JSON.parse(await fs.readFile(new URL('../examples/anchors/protoflow.config.json', import.meta.url), 'utf8'));

async function project(t, config = exampleConfig) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-targets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(fileURLToPath(new URL('../examples/anchors/', import.meta.url)), root, { recursive: true });
  await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
  return root;
}
const run = async (root, args) => {
  try { return { code: 0, json: JSON.parse((await exec(process.execPath, [cli, ...args, '--project', root])).stdout) }; }
  catch (error) { return { code: error.code, json: JSON.parse(error.stdout || error.stderr) }; }
};

test('v2 configs validate targets and drivers; v1 configs keep their own schema', async t => {
  const root = await project(t);
  assert.equal((await loadConfig(root)).schemaVersion, 2);
  const invalid = async (change, pattern) => {
    const config = structuredClone(exampleConfig); change(config);
    await fs.writeFile(path.join(root, 'protoflow.config.json'), JSON.stringify(config));
    await assert.rejects(loadConfig(root), pattern);
  };
  await invalid(config => { delete config.targets[0].driver.urlTemplate; }, /playwright-web requires driver\.urlTemplate/);
  await invalid(config => { config.targets[0].driver = { kind: 'external' }; }, /external driver requires driver\.command/);
  // Several targets need distinct, non-nested roots and known release targets.
  await invalid(config => { config.targets.push({ ...config.targets[0], id: 'second' }); }, /Target roots must be distinct/);
  await invalid(config => { config.targets[0].root = '.'; config.targets.push({ ...config.targets[0], id: 'second', root: 'app' }); }, /needs its own root directory/);
  await invalid(config => { config.targets.push({ ...config.targets[0], id: 'second', root: 'app/desktop' }); }, /not nested/);
  await invalid(config => { config.targets.push({ ...config.targets[0], id: 'second', root: 'prototype' }); config.release = { requireTargets: ['web', 'ios'] }; }, /unknown target: ios/);
  await invalid(config => { config.targets.push({ ...config.targets[0] }); }, /Duplicate target id/);
  await invalid(config => { config.targets[0].platform = 'symbian'; }, /allowed values/);
  await invalid(config => { config.targets[0].root = '../outside'; }, /escapes project/);
  await invalid(config => { config.mappings = []; }, /must NOT have additional properties/);
  assert.deepEqual(configSchemaV2.properties.targets.items.properties.platform.enum, ['web', 'electron', 'ios', 'android', 'flutter', 'react-native']);
});

test('platform defaults: same-technology targets are strict, native targets relative and perceptual', () => {
  assert.deepEqual(targetSettings({ platform: 'web' }).tiers, { structure: 'required', tokens: 'required', layout: 'required', visual: 'required' });
  assert.equal(targetSettings({ platform: 'web' }).regression, 'all');
  assert.equal(targetSettings({ platform: 'ios' }).tiers.visual, 'advisory');
  assert.equal(targetSettings({ platform: 'ios' }).visual.mode, 'perceptual');
  assert.equal(targetSettings({ platform: 'android' }).regression, 'affected+smoke');
  assert.equal(targetSettings({ platform: 'android', regression: 'all', visual: { mode: 'pixel' } }).visual.mode, 'pixel');
});

test('scenes follow the regression policy', () => {
  const page = (screen, extra = '') => `<html><body data-pf="${screen}" data-pf-role="screen">${extra}</body></html>`;
  const contract = staticContract({ files: {
    'p/a.html': { content: page('a') }, 'p/a.pf.json': { content: JSON.stringify({ schemaVersion: 1, screen: 'a', states: { open: { steps: [] } } }) },
    'p/b.html': { content: page('b') }, 'p/b.pf.json': { content: JSON.stringify({ schemaVersion: 1, screen: 'b', states: { busy: { steps: [] } } }) }
  } }, { prototypeDir: 'p' });
  const ids = regression => scenesFor(contract, { affected: ['a'] }, regression).map(scene => `${scene.screen}.${scene.state}`);
  assert.deepEqual(ids('affected'), ['a.initial', 'a.open']);
  assert.deepEqual(ids('affected+smoke'), ['a.initial', 'a.open', 'b.initial']);
  assert.deepEqual(ids('all'), ['a.initial', 'a.open', 'b.initial', 'b.busy']);
});

test('external driver responses are validated; failures are NOT_RUN unless the driver reports FAIL', async t => {
  const root = await project(t);
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.writeFile(path.join(root, 'out/shot.png'), png);
  const driver = async (script, extra = {}) => {
    await fs.writeFile(path.join(root, 'driver.mjs'), script);
    return captureExternal(root, { id: 'ios', driver: { command: { argv: [process.execPath, 'driver.mjs'] } } }, { schemaVersion: 1, outputDir: 'out', viewport: { width: 2, height: 2, scale: 1 }, ...extra });
  };
  const respond = response => `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(response))}));`;
  const ok = await driver(respond({ schemaVersion: 1, status: 'PASS', screenshot: 'shot.png', elements: [{ anchor: 'a', visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 }, text: 'A' }], missing: ['b'] }));
  assert.equal(ok.status, 'PASS');
  assert.deepEqual(ok.capture.elements, { a: { visible: true, bounds: { x: 0, y: 0, width: 1, height: 1 }, text: 'A', count: 1 }, b: { count: 0, visible: false } });
  assert.deepEqual(ok.capture.screenshot, png);
  assert.deepEqual(await driver(respond({ schemaVersion: 1, status: 'FAIL', reason: 'app crashed on launch' })), { status: 'FAIL', reason: 'app crashed on launch' });
  assert.match((await driver('console.log("not json")')).reason, /invalid response/);
  assert.match((await driver(respond({ schemaVersion: 2, status: 'PASS' }))).reason, /schemaVersion 1/);
  assert.match((await driver('process.exit(4)')).reason, /driver ios failed \(exit 4\)/);
  assert.match((await driver(respond({ schemaVersion: 1, status: 'PASS', screenshot: '../../etc/passwd' }))).reason, /escapes its output directory/);
  assert.equal((await captureExternal(root, { id: 'x', driver: {} }, { outputDir: 'out' })).status, 'NOT_RUN');
});

test('CLI anchors suggest writes a draft patch; contract show and doctor read v2 projects', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'prototype/help.html'), '<!doctype html>\n<html><body>\n<h1>Help</h1>\n<button type="button">Contact</button>\n</body></html>\n');
  const lint = await run(root, ['anchors', 'lint']);
  assert.equal(lint.code, 1);
  const suggest = await run(root, ['anchors', 'suggest', '--patch-file', '.protoflow/anchors.patch']);
  assert.equal(suggest.json.status, 'DRAFT');
  assert.deepEqual(suggest.json.pages.map(page => page.page), ['prototype/help.html']);
  assert.equal(suggest.json.pages[0].sidecar, 'prototype/help.pf.json');
  await exec('git', ['apply', '.protoflow/anchors.patch'], { cwd: root });
  assert.equal((await run(root, ['anchors', 'lint'])).json.status, 'PASS');
  const checkpoint = await run(root, ['checkpoint']);
  assert.deepEqual(checkpoint.json.scope.affected, ['help', 'settings', 'tasks']);
  const contract = await run(root, ['contract', 'show', '--manifest', checkpoint.json.id]);
  assert.deepEqual(Object.keys(contract.json.contract.screens), ['help', 'settings', 'tasks']);
  const doctor = await run(root, ['doctor']);
  assert.match(doctor.json.checks.find(check => check.name === 'anchors').detail, /3 screen\(s\)/);
  assert.match(doctor.json.checks.find(check => check.name === 'verification').detail, /target web \(web, playwright-web\)/);
});

test('static contracts and driver requests conform to the published schemas', async () => {
  const { default: Ajv } = await import('ajv');
  const { staticContractSchema, driverRequestSchema } = await import('../src/protocol-schemas.js');
  const { snapshot } = await import('../src/sessions.js');
  const { driverRequest } = await import('../src/targets.js');
  const root = fileURLToPath(new URL('../examples/anchors/', import.meta.url));
  const contract = staticContract(await snapshot(root, exampleConfig), exampleConfig);
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.equal(ajv.validate(staticContractSchema, contract), true, JSON.stringify(ajv.errors));
  const target = { id: 'ios', platform: 'ios', driver: { kind: 'external', command: { argv: ['x'] } } };
  const screen = contract.screens.tasks;
  const request = driverRequest(target, targetSettings(target), { screen: 'tasks', state: 'added' }, screen, screen.states.added, '.protoflow/out');
  assert.equal(ajv.validate(driverRequestSchema, request), true, JSON.stringify(ajv.errors));
  assert.deepEqual(request.steps.map(step => step.action), ['fill', 'tap']);
  assert.ok(request.anchors.includes('tasks.error'));
});

test('runner configure keeps target identity fixed for anchored streams', async t => {
  const { configureRunner } = await import('../src/runner.js');
  const { writeJson } = await import('../src/util.js');
  const root = await project(t);
  const worktree = path.join(root, '.protoflow/runner/worktree');
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(worktree, 'protoflow.config.json'), JSON.stringify(exampleConfig));
  await writeJson(path.join(root, '.protoflow/runner/state.json'), { schemaVersion: 1, worktree, status: 'IDLE', configHash: 'old' });
  const retargeted = structuredClone(exampleConfig); retargeted.targets[0].id = 'mobile';
  await assert.rejects(configureRunner(root, retargeted), /Cannot change source\/prototypeDir\/targets/);
  const tuned = structuredClone(exampleConfig); tuned.targets[0].tiers = { visual: 'advisory' };
  assert.equal((await configureRunner(root, tuned)).status, 'PASS');
});
