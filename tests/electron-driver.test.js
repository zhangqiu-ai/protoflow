import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { _electron } from 'playwright';
import { captureElectron, captureElectronPrototype, resolveElectron } from '../src/drivers/electron.js';
import { awaitGroupExit, processGroupAlive } from '../src/util.js';

const settings = { viewport: { width: 800, height: 600, scale: 1 }, locator: { attribute: 'data-testid' } };
const request = { screen: 'tasks', state: 'initial', page: 'prototype/tasks.html', fixture: { data: {} }, anchors: ['tasks'], steps: [] };

async function captureFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-electron-launch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.cjs'), '// main fixture\n');
  await fs.writeFile(path.join(root, 'electron'), 'fixture binary; launch is mocked\n');
  return { root, target: { id: 'desktop', root: '.', driver: { executablePath: 'electron', main: 'main.cjs', route: '#/{screen}' } } };
}

test('Electron resolution reads the installed binary without evaluating its download-on-require loader', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-electron-resolution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'node_modules/electron');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'electron', main: 'index.js' }));
  await fs.writeFile(path.join(directory, 'index.js'), 'throw new Error("The automatic downloader must not execute");');
  await fs.writeFile(path.join(directory, 'path.txt'), 'electron');
  const target = { id: 'desktop', root: '.', driver: {} };
  assert.equal(await resolveElectron(root, target), null);
  await fs.mkdir(path.join(directory, 'dist'));
  const executable = path.join(directory, 'dist/electron');
  await fs.writeFile(executable, 'fixture binary path; not executable');
  assert.equal(await resolveElectron(root, target), await fs.realpath(executable));
});

for (const kind of ['application', 'prototype']) {
  test(`an attempted Electron ${kind} launch without a PID retains spawn intent and its private profile`, async t => {
    const { root, target } = await captureFixture(t);
    const events = [];
    let options, failure;
    t.mock.method(_electron, 'launch', async value => { options = value; throw new Error('launch handshake timed out'); });
    const hooks = { onBeforeSpawn: phase => events.push(`starting:${phase}`), onFinish: phase => events.push(`finished:${phase}`) };
    const capture = kind === 'application'
      ? captureElectron(root, target, settings, request, hooks)
      : captureElectronPrototype(root, target, settings, request, { url: 'file:///prototype/tasks.html', attribute: 'data-testid' }, hooks);
    try { await capture; } catch (error) { failure = error; }
    const profileDir = options?.env.PROTOFLOW_ELECTRON_USER_DATA;
    if (profileDir) t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
    assert.equal(failure?.code, 'PROCESS_START_UNKNOWN');
    assert.equal(failure.phase, kind === 'application' ? 'visual-electron' : 'visual-electron-prototype');
    assert.match(failure.message, /unknown PID/);
    assert.match(failure.result.error, /launch handshake timed out/);
    assert.deepEqual(events, [`starting:${failure.phase}`]);
    assert.equal(failure.result.spawned, null);
    assert.equal(failure.result.processGroupActive, true);
    assert.ok(profileDir);
    assert.equal(failure.result.runtime.profileDir, profileDir);
    assert.ok((await fs.stat(profileDir)).isDirectory());
    assert.ok(options.args.includes(`--user-data-dir=${profileDir}`));
  });
}

test('a missing Electron executable remains NOT_RUN without spawn intent', async t => {
  const { root, target } = await captureFixture(t);
  target.driver.executablePath = 'missing-electron';
  const events = [];
  t.mock.method(_electron, 'launch', () => { throw new Error('must not attempt launch'); });
  const result = await captureElectron(root, target, settings, request, { onBeforeSpawn: phase => events.push(phase), onFinish: phase => events.push(phase) });
  assert.equal(result.status, 'NOT_RUN');
  assert.deepEqual(events, []);
});

test('an Electron application object without a valid process identity cannot finish or remove its profile', async t => {
  const { root, target } = await captureFixture(t);
  const events = [];
  let profileDir;
  t.mock.method(_electron, 'launch', async options => {
    profileDir = options.env.PROTOFLOW_ELECTRON_USER_DATA;
    return { process: () => ({ pid: undefined }), close: async () => events.push('closed') };
  });
  t.after(() => profileDir && fs.rm(profileDir, { recursive: true, force: true }));
  await assert.rejects(captureElectron(root, target, settings, request, {
    onBeforeSpawn: () => events.push('starting'), onStart: () => events.push('started'), onFinish: () => events.push('finished')
  }), error => error.code === 'PROCESS_START_UNKNOWN' && error.result.spawned === null && error.result.processGroupActive);
  assert.deepEqual(events, ['starting', 'closed']);
  assert.ok((await fs.stat(profileDir)).isDirectory());
});

test('invalid Electron process identities are never probed or signalled as process groups', async t => {
  const { root, target } = await captureFixture(t);
  const signals = [], profiles = [];
  let identity;
  t.mock.method(process, 'kill', (...args) => { signals.push(args); throw Object.assign(new Error('fixture does not signal any process'), { code: 'ESRCH' }); });
  t.mock.method(_electron, 'launch', async options => {
    profiles.push(options.env.PROTOFLOW_ELECTRON_USER_DATA);
    return { process: () => ({ pid: identity }), close: async () => {} };
  });
  t.after(() => Promise.all(profiles.map(directory => fs.rm(directory, { recursive: true, force: true }))));
  for (identity of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(captureElectron(root, target, settings, request), { code: 'PROCESS_START_UNKNOWN' });
  }
  assert.deepEqual(signals, []);
});

for (const exitCode of [0, 17]) {
  test(`an acknowledged Electron group with exit ${exitCode} keeps its profile until all processes have gone`, async t => {
    const { root, target } = await captureFixture(t);
    const child = spawn(process.execPath, ['-e', `process.on('message', () => process.exit(${exitCode})); process.send('ready');`], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(async () => {
      if (processGroupAlive(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* only this fixture's group */ } }
      assert.equal(await awaitGroupExit(child.pid, 2000), true);
    });
    await once(child, 'message');
    let profileDir, finished;
    t.mock.method(_electron, 'launch', async options => {
      profileDir = options.env.PROTOFLOW_ELECTRON_USER_DATA;
      return {
        process: () => child,
        evaluate: async () => ({ userData: profileDir, sessionData: profileDir }),
        context: () => ({ addInitScript: async () => {} }),
        firstWindow: async () => { throw new Error('fixture has no renderer window'); },
        close: async () => {
          assert.equal(processGroupAlive(child.pid), true);
          assert.ok((await fs.stat(profileDir)).isDirectory());
          const exited = once(child, 'exit'); child.send('close'); await exited;
        }
      };
    });
    const result = await captureElectron(root, target, settings, request, { onFinish: async (_phase, pid, outcome) => {
      assert.equal(pid, child.pid);
      assert.equal(processGroupAlive(pid), false);
      await assert.rejects(fs.stat(profileDir), { code: 'ENOENT' });
      finished = outcome;
    } });
    assert.equal(result.status, 'FAIL');
    assert.match(result.reason, exitCode === 0 ? /fixture has no renderer window/ : /Electron exited abnormally \(code 17, signal null\)/);
    assert.deepEqual(result.runtime.exit, { code: exitCode, signal: null });
    assert.deepEqual(finished.exit, result.runtime.exit);
    assert.equal(finished.spawned, true);
    assert.equal(finished.processGroupActive, false);
  });
}
