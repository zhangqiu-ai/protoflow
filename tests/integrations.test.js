import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initProject, installSkill } from '../src/install.js';
import { detectIntegrations } from '../src/integrations.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/protoflow.js', import.meta.url));

/** Local stand-ins for the real installers: they write the same markers without network access. */
async function fakeInstallers(t, { specKit = 'install', bmad = 'install' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'protoflow-installers-'));
  const script = path.join(directory, 'installer.js');
  await writeFile(script, `
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
const [kind, mode] = process.argv.slice(2);
await appendFile('${path.join(directory, 'calls.log').replaceAll('\\', '\\\\')}', kind + '\\n');
if (mode === 'exit') { console.error('installer broke'); process.exit(3); }
if (mode === 'noop') process.exit(0);
if (kind === 'specKit') {
  await mkdir('.specify/memory', { recursive: true });
  await writeFile('.specify/memory/constitution.md', '# Constitution\\n');
  await mkdir('.agents/skills/speckit-specify', { recursive: true });
  await writeFile('.agents/skills/speckit-specify/SKILL.md', 'name: speckit-specify\\n');
} else {
  await mkdir('.agents/skills/bmad-help', { recursive: true });
  await writeFile('.agents/skills/bmad-help/SKILL.md', 'name: bmad-help\\n');
}
`);
  const command = (kind, mode) => mode === null ? null : { argv: [process.execPath, script, kind, mode], timeoutMs: 10000 };
  const calls = async () => (await readFile(path.join(directory, 'calls.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { specKit: command('specKit', specKit), bmad: command('bmad', bmad), calls };
}

async function configuredProject(installers) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-integrations-'));
  await initProject(root);
  const configFile = path.join(root, 'protoflow.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.adapters.specKit.install = installers.specKit;
  config.adapters.bmad.install = installers.bmad;
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return root;
}

async function run(args) {
  try { return { code: 0, ...(await exec(process.execPath, [cli, ...args])) }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

test('install runs configured Spec Kit and BMad installers once, reports changes and notices', async t => {
  const installers = await fakeInstallers(t);
  const root = await configuredProject(installers);
  const first = await installSkill(root);
  assert.equal(first.status, 'PASS');
  assert.deepEqual(first.integrations.map(item => [item.id, item.status]), [['specKit', 'installed'], ['bmad', 'installed']]);
  assert.ok(first.integrations[0].changed.includes('.specify/memory/constitution.md'));
  assert.ok(first.integrations[1].evidence.includes('.agents/skills/bmad-help'));
  assert.match(first.notices[0], /已安裝 Spec Kit/);
  assert.match(first.notices[1], /bmad setup/);
  // ProtoFlow's own skill is installed alongside, not replaced by the frameworks.
  assert.ok((await readFile(path.join(root, '.agents/skills/protoflow/SKILL.md'), 'utf8')).includes('name: protoflow'));

  const second = await installSkill(root);
  assert.deepEqual(second.integrations.map(item => item.status), ['present', 'present']);
  assert.match(second.notices[0], /已偵測到 Spec Kit/);
  assert.deepEqual(await installers.calls(), ['specKit', 'bmad']);
});

test('null installer is NOT_RUN with a manual-install reminder; skip flag only detects', async t => {
  const installers = await fakeInstallers(t, { specKit: null });
  const root = await configuredProject(installers);
  const skipped = await installSkill(root, { integrations: false });
  assert.equal(skipped.integrations.specKit.installed, false);
  assert.match(skipped.notices[0], /尚未安裝 Spec Kit/);
  assert.deepEqual(await installers.calls(), []);

  const result = await installSkill(root);
  assert.equal(result.status, 'PASS');
  assert.equal(result.integrations[0].status, 'NOT_RUN');
  assert.match(result.notices[0], /install 為 null.*specify init/);
  assert.equal(result.integrations[1].status, 'installed');
  assert.deepEqual(await installers.calls(), ['bmad']);
});

test('installer failures and installers that leave no markers are FAIL', async t => {
  const installers = await fakeInstallers(t, { specKit: 'exit', bmad: 'noop' });
  const root = await configuredProject(installers);
  const result = await installSkill(root);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.integrations[0].status, 'FAIL');
  assert.equal(result.integrations[0].exitCode, 3);
  assert.match(result.integrations[0].stderr, /installer broke/);
  assert.match(result.notices[0], /Spec Kit 安裝失敗（exit 3）/);
  assert.equal(result.integrations[1].status, 'FAIL');
  assert.match(result.notices[1], /未找到 _bmad 或 \.agents\/skills\/bmad\* 或 \.agents\/skills\/bmod\*/);
});

test('missing installer executable fails without throwing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-integrations-'));
  const result = await installSkill(root, { integrations: { specKit: { argv: ['protoflow-missing-installer-binary'] }, bmad: null } });
  assert.equal(result.integrations[0].status, 'FAIL');
  assert.match(result.integrations[0].error, /ENOENT/);
});

test('CLI install prints integration notices on stderr and keeps stdout JSON; status reports detection', async t => {
  const installers = await fakeInstallers(t);
  const root = await configuredProject(installers);
  const install = await run(['install', '--project', root]);
  assert.equal(install.code, 0, install.stderr);
  assert.equal(JSON.parse(install.stdout).status, 'PASS');
  assert.match(install.stderr, /ProtoFlow: 已安裝 Spec Kit/);
  assert.match(install.stderr, /ProtoFlow: 已安裝 BMad Method/);

  const status = JSON.parse((await run(['status', '--project', root])).stdout);
  assert.equal(status.integrations.specKit.installed, true);
  assert.equal(status.integrations.bmad.installed, true);

  const failing = await configuredProject(await fakeInstallers(t, { specKit: 'exit', bmad: null }));
  const failed = await run(['install', '--project', failing]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Spec Kit 安裝失敗/);
  const skipped = await run(['install', '--skip-integrations', '--project', failing]);
  assert.equal(skipped.code, 0);
  assert.match(skipped.stderr, /尚未安裝 Spec Kit/);
});

test('detection accepts existing installs from framework markers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'protoflow-detect-'));
  await mkdir(path.join(root, '_bmad'));
  const detected = await detectIntegrations(root);
  assert.deepEqual(detected.bmad, { name: 'BMad Method', installed: true, evidence: ['_bmad'] });
  assert.equal(detected.specKit.installed, false);
  await mkdir(path.join(root, '.agents/skills/bmod-method'), { recursive: true });
  assert.deepEqual((await detectIntegrations(root)).bmad.evidence, ['_bmad', '.agents/skills/bmod-method']);
});
