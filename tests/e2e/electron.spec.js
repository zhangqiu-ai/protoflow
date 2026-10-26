import { test, expect } from '@playwright/test';
import { mkdtemp, cp, readFile, writeFile, rm, symlink, mkdir, chmod, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseCliOutput } from '../helpers/cli-json.js';
import { processGroupAlive, awaitGroupExit } from '../../src/util.js';
import { captureElectron, captureElectronPrototype, resolveElectron } from '../../src/drivers/electron.js';

const exec = promisify(execFile);
const engine = path.resolve('.');
const cli = path.join(engine, 'bin/protoflow.js');
const playwrightCli = path.join(engine, 'node_modules/@playwright/test/cli.js');

// The native CI project runs on macOS; an unavailable runtime must fail rather than skip acceptance.

async function command(root, args, expectedCode = 0) {
  let result;
  try { result = { code: 0, ...(await exec(process.execPath, [cli, ...args, '--project', root], { cwd: root, maxBuffer: 64 * 1024 * 1024 })) }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  const json = parseCliOutput(result.stdout, result.stderr);
  await test.info().attach(`protoflow ${args.join(' ')}`, {
    body: JSON.stringify(json, null, 2), contentType: 'application/json'
  });
  const scenes = json.visual?.scenes?.map(scene => `${scene.id}:${scene.status} ${scene.reason ?? ''} ${JSON.stringify(Object.fromEntries(Object.entries(scene.tiers).map(([tier, value]) => [tier, value.reasons?.slice(0, 2)])))}`);
  expect(result.code, `${args.join(' ')}\n${json.error ?? json.visual?.reason ?? ''}\n${scenes?.join('\n') ?? ''}`).toBe(expectedCode);
  return json;
}

/** The anchors example with two targets: the web app (Playwright) and the desktop app (real Electron). */
async function project({ electron = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'protoflow-electron-e2e-'));
  await cp(path.join(engine, 'examples/anchors'), root, { recursive: true, filter: source => !/(\.protoflow|test-results|node_modules)/.test(source) });
  if (electron) await symlink(path.join(engine, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}\n');
  await writeFile(path.join(root, 'spec.md'), '# Reviewed specification\nTasks and settings behave as in the prototype.\n');
  const configFile = path.join(root, 'protoflow.config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const web = { ...config.targets[0], functional: { argv: [process.execPath, playwrightCli, 'test', '-c', 'playwright.config.js'] } };
  const desktop = {
    id: 'desktop', platform: 'electron', root: 'desktop',
    driver: { kind: 'playwright-electron', main: 'main.cjs', route: '#/{screen}' },
    build: { argv: [process.execPath, '-e', '0'] }, functional: { argv: [process.execPath, '-e', '0'] },
    viewport: { width: 800, height: 600, scale: 1 }
  };
  config.targets = electron ? [web, desktop] : [desktop];
  config.release = electron ? { requireTargets: ['web', 'desktop'] } : undefined;
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return root;
}

// Electron helpers can retain inherited output pipes after the leader exits. Observe exit and the whole group
// separately; normal shutdown still requires code 0, no signal, and no surviving processes within the deadline.
async function earlyQuit(binary, wrapper, root) {
  const env = { ...process.env, PROTOFLOW_VIEWER_URL: 'data:text/html,<h1>Early quit fixture</h1>', PROTOFLOW_VIEWER_WIDTH: '800', PROTOFLOW_VIEWER_HEIGHT: '600' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [wrapper], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exit = null, error = null;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', failure => { error = failure.message; });
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  // Match the native driver's default launch/close budget. Electron 44's bare early-quit control can take
  // about 16 seconds for its helpers to exit naturally on macOS, even after the leader exits with code 0.
  const deadline = Date.now() + 30000;
  while ((!exit || processGroupAlive(child.pid)) && !error && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  const timedOut = !exit || processGroupAlive(child.pid);
  if (timedOut) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    await awaitGroupExit(child.pid, 2000);
  }
  child.stdout.destroy(); child.stderr.destroy();
  return { exit, error, timedOut, processGroupActive: processGroupAlive(child.pid), stdout, stderr };
}

test('viewer and desktop quit safely before Electron is ready', async () => {
  test.setTimeout(105000);
  const root = await project();
  try {
    const binary = await resolveElectron(root, { root: 'desktop', driver: {} });
    expect(binary).toBeTruthy();
    for (const [name, main] of [['control', null], ['viewer', path.join(engine, 'src/drivers/electron-viewer.cjs')], ['desktop', path.join(root, 'desktop/main.cjs')]]) {
      const wrapper = path.join(root, `${name}-early-quit.cjs`);
      await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(root, `userdata-${name}`))}); let windows = 0; app.on('browser-window-created', () => windows++); ${main ? `require(${JSON.stringify(main)});` : ''} app.on('before-quit', () => console.log('before-quit-ready=' + app.isReady())); app.on('will-quit', () => console.log('windows=' + windows)); app.quit();\n`);
      const result = await earlyQuit(binary, wrapper, root);
      expect(result.error, JSON.stringify(result)).toBeNull();
      expect(result.timedOut, JSON.stringify(result)).toBe(false);
      expect(result.exit).toEqual({ code: 0, signal: null });
      expect(result.processGroupActive).toBe(false);
      expect(result.stdout).toContain('before-quit-ready=false');
      expect(result.stdout).toContain('windows=0');
      expect(result.stderr).not.toMatch(/Cannot read properties|defaultSession|UnhandledPromiseRejection/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a real Electron target is verified on four required tiers against the same prototype as the web target', async () => {
  test.setTimeout(300000);
  const root = await project();
  try {
    // Fixture text outside any anchor (an unread count) differs between the prototype and the application. Without
    // anchors.dynamicText on both Electron captures it fails every tasks scene; transparent, it leaves pixels alone.
    const badge = 'position:absolute;right:0;top:0;color:transparent';
    const configFile = path.join(root, 'protoflow.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    await writeFile(configFile, JSON.stringify({ ...config, anchors: { ...config.anchors, dynamicText: ['.badge'] } }, null, 2));
    const prototypeFile = path.join(root, 'prototype/tasks.html');
    await writeFile(prototypeFile, (await readFile(prototypeFile, 'utf8')).replace('</h1>', `</h1><span class="badge" style="${badge}">3 new</span>`));
    const rendererFile = path.join(root, 'desktop/renderer/app.js');
    await writeFile(rendererFile, (await readFile(rendererFile, 'utf8')).replace("text: 'Today' }),", `text: 'Today' }), element('span', { class: 'badge', style: '${badge}', text: '12 new' }),`));
    const manifest = await command(root, ['checkpoint']);
    expect(manifest.scope.affected).toEqual(['settings', 'tasks']);

    // Drift in the Electron renderer is caught before anything is accepted.
    const appFile = path.join(root, 'desktop/renderer/app.js');
    const original = await readFile(appFile, 'utf8');
    await writeFile(appFile, original.replace("text: 'Today'", "text: 'Tomorrow'"));
    const drifted = await command(root, ['verify', '--manifest', manifest.id, '--target', 'desktop'], 1);
    expect(drifted.visual.scenes.find(scene => scene.id === 'tasks.initial').tiers.structure.reasons).toContain('tasks.title: text "Today" vs "Tomorrow"');
    await writeFile(appFile, original);

    const desktop = await command(root, ['verify', '--manifest', manifest.id, '--target', 'desktop']);
    expect(desktop.status).toBe('PASS');
    expect(desktop.target).toBe('desktop');
    expect(desktop.visual.platform).toBe('electron');
    expect(Object.values(desktop.visual.tiers).map(tier => `${tier.policy}:${tier.status}`)).toEqual(['required:PASS', 'required:PASS', 'required:PASS', 'required:PASS']);
    expect(desktop.visual.scenes.map(scene => scene.id)).toEqual(['settings.initial', 'settings.saved', 'tasks.initial', 'tasks.empty-error', 'tasks.added']);
    for (const scene of desktop.visual.scenes) {
      // Runtime evidence: a real Electron process for the app and for the prototype reference, same build, exited cleanly.
      expect(scene.runtime.electron).toMatch(/^\d+\.\d+\.\d+$/);
      expect(scene.prototypeRuntime.electron).toBe(scene.runtime.electron);
      expect(scene.prototypeRuntime.chrome).toBe(scene.runtime.chrome);
      expect(scene.runtime.args.at(-1).endsWith(path.join('desktop', 'main.cjs'))).toBe(true);
      expect(scene.runtime.url).toMatch(new RegExp(`#/${scene.screen}$`));
      expect(scene.runtime.viewport).toEqual({ width: 800, height: 600, scale: 1 });
      for (const runtime of [scene.runtime, scene.prototypeRuntime]) {
        expect(runtime.exit).toEqual({ code: 0, signal: null });
        expect(processGroupAlive(runtime.pid)).toBe(false);
      }
    }
    // Runtime evidence is hash-bound like screenshots.
    expect(Object.keys(desktop.artifactHashes).filter(file => file.endsWith('runtime.json')).length).toBe(10);

    const web = await command(root, ['verify', '--manifest', manifest.id, '--target', 'web']);
    expect(web.status).toBe('PASS');
    const queue = await command(root, ['queue']);
    expect(queue.versions[0].acceptance).toBe('accepted');
    expect(queue.versions[0].targets).toEqual({ web: web.id, desktop: desktop.id });
    expect(queue.release.version).toBe(manifest.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an Electron application that cannot reach a state fails, and missing Electron is NOT_RUN', async () => {
  test.setTimeout(180000);
  const broken = await project();
  let pid;
  try {
    // Remove the settings screen from the Electron renderer: its route falls back to tasks.
    const appFile = path.join(broken, 'desktop/renderer/app.js');
    await writeFile(appFile, (await readFile(appFile, 'utf8')).replace('(screens[name] ?? screens.tasks)()', "(name === 'settings' ? screens.tasks : screens[name] ?? screens.tasks)()"));
    const { targets } = JSON.parse(await readFile(path.join(broken, 'protoflow.config.json'), 'utf8'));
    const target = { ...targets[1], timeoutMs: 30000 };
    const request = { screen: 'settings', state: 'initial', page: 'prototype/settings.html', fixture: { data: {} }, anchors: ['settings'], steps: [] };
    // One failed screen reaches the full driver deadline; repeating every scene adds no failure coverage.
    const scene = await boundedCapture(captureElectron(broken, target, { viewport: target.viewport, locator: { attribute: 'data-testid' } }, request, {
      onStart: (phase, current) => { expect(phase).toBe('visual-electron'); pid = current; }
    }), () => pid, 60000);
    expect(scene.status).toBe('FAIL');
    expect(scene.reason).toMatch(/Electron application could not reach settings\.initial/);
    expect(scene.runtime.pid).toBe(pid);
    expect(scene.runtime.exit).toEqual({ code: 0, signal: null });
    expect(processGroupAlive(scene.runtime.pid)).toBe(false);
  } finally { await cleanCapture(broken, pid); }

  const missing = await project({ electron: false });
  try {
    const manifest = await command(missing, ['checkpoint']);
    const result = await command(missing, ['verify', '--manifest', manifest.id], 2);
    expect(result.status).toBe('NOT_RUN');
    expect(result.visual.scenes[0].reason).toMatch(/Electron is not installed for target desktop/);
    expect((await command(missing, ['queue'])).versions[0].targets.desktop).toBe(null);
  } finally { await rm(missing, { recursive: true, force: true }); }
});

test('an Electron application that exits abnormally after a successful capture fails and does not count', async () => {
  test.setTimeout(180000);
  const root = await project();
  try {
    const manifest = await command(root, ['checkpoint']);
    // The renderer is correct; only the main process misbehaves on quit (PF-ELECTRON-EXIT-17).
    const mainFile = path.join(root, 'desktop/main.cjs');
    await writeFile(mainFile, `${await readFile(mainFile, 'utf8')}app.on('before-quit', () => app.exit(17));\n`);
    const result = await command(root, ['verify', '--manifest', manifest.id, '--target', 'desktop'], 1);
    expect(result.status).toBe('FAIL');
    for (const scene of result.visual.scenes) {
      expect(scene.status).toBe('FAIL');
      expect(scene.reason).toMatch(/Electron exited abnormally \(code 17, signal null\)/);
      expect(scene.runtime.exit).toEqual({ code: 17, signal: null });
      expect(processGroupAlive(scene.runtime.pid)).toBe(false);
      // The prototype reference ran in the engine's viewer and exited normally.
      expect(scene.prototypeRuntime.exit).toEqual({ code: 0, signal: null });
    }
    expect((await command(root, ['queue'])).versions[0].targets.desktop).toBe(null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an Electron window clamped by the screen fails with its measured size instead of passing', async () => {
  test.setTimeout(180000);
  const root = await project();
  try {
    // Taller than any screen work area: without enableLargerThanScreen macOS clamps the window.
    const configFile = path.join(root, 'protoflow.config.json');
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    config.targets[1].viewport = { width: 1440, height: 3000, scale: 1 };
    await writeFile(configFile, JSON.stringify(config, null, 2));
    const mainFile = path.join(root, 'desktop/main.cjs');
    await writeFile(mainFile, (await readFile(mainFile, 'utf8')).replace('enableLargerThanScreen: true, ', ''));
    const manifest = await command(root, ['checkpoint']);
    const result = await command(root, ['verify', '--manifest', manifest.id, '--target', 'desktop'], 1);
    for (const scene of result.visual.scenes) {
      expect(scene.status).toBe('FAIL');
      expect(scene.reason).toMatch(/Electron application window is 1440×\d+@1, expected 1440×3000@1/);
      // The measured size is recorded as evidence, never replaced by the configured one.
      expect(scene.runtime.viewport.height).toBeLessThan(3000);
      expect(scene.runtime.requestedViewport).toEqual({ width: 1440, height: 3000, scale: 1 });
      // The engine's prototype viewer is allowed to be larger than the screen and reaches the requested size.
      expect(scene.prototypeRuntime.viewport).toEqual({ width: 1440, height: 3000, scale: 1 });
    }
    expect((await command(root, ['queue'])).versions[0].targets.desktop).toBe(null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The watchdog is independent of the driver: the pre-fix stuck close must fail this test without leaking its own app.
async function boundedCapture(capture, getPid, watchdogMs = 15000) {
  let watchdog;
  try {
    return await Promise.race([capture, new Promise((_, reject) => {
      watchdog = setTimeout(() => {
        const pid = getPid();
        if (pid && processGroupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* only this test's group */ } }
        reject(new Error('Electron lifecycle regression watchdog expired'));
      }, watchdogMs);
    })]);
  } finally { clearTimeout(watchdog); }
}

test('abort during async Electron onFinish throws a STOPPED error after a normal exit', async () => {
  test.setTimeout(55000);
  const root = await project();
  const controller = new AbortController();
  let pid, finished;
  try {
    const { targets } = JSON.parse(await readFile(path.join(root, 'protoflow.config.json'), 'utf8'));
    const target = { ...targets[1], timeoutMs: 30000 };
    await expect(boundedCapture(captureElectron(root, target, { viewport: target.viewport, locator: { attribute: 'data-testid' } }, initialTasks, {
      signal: controller.signal,
      onStart: (phase, value) => { expect(phase).toBe('visual-electron'); pid = value; },
      onFinish: async (phase, value, outcome) => {
        expect(value).toBe(pid); finished = outcome;
        // This timing used to reach the final abort check with failure === null and therefore throw null.
        expect(outcome).toMatchObject({ status: 'PASS', aborted: false, exit: { code: 0, signal: null }, processGroupActive: false });
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
      }
    }), () => pid, 45000)).rejects.toThrow('STOPPED: visual verification was interrupted');
    expect(finished.status).toBe('PASS');
    expect(processGroupAlive(pid)).toBe(false);
  } finally { await cleanCapture(root, pid); }
});

async function cleanCapture(root, pid) {
  if (pid && processGroupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* only this test's group */ } }
  if (pid) expect(await awaitGroupExit(pid, 3000)).toBe(true);
  await rm(root, { recursive: true, force: true });
}

const initialTasks = { screen: 'tasks', state: 'initial', page: 'prototype/tasks.html', fixture: { data: {} }, anchors: ['tasks'], steps: [] };

test('an Electron launch that exits before the Chromium handshake retains STARTING and its private profile', async () => {
  const root = await project();
  let failure, observedPid;
  try {
    const { targets } = JSON.parse(await readFile(path.join(root, 'protoflow.config.json'), 'utf8'));
    const marker = path.join(root, 'attempted.pid');
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const main = path.join(root, 'quitting-inspector.cjs');
    // Reach the real Node inspector first, then exit without ever exposing a Chromium inspector. Playwright 1.63
    // leaves waitForLine promises unhandled if a process exits before even the Node inspector starts listening.
    await writeFile(main, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => process.exit(0), 2000);\n`);
    const executable = path.join(root, 'quitting-electron');
    await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} --inspect=0 ${quote(main)}\n`);
    await chmod(executable, 0o700);
    const target = { ...targets[1], timeoutMs: 5000, driver: { ...targets[1].driver, executablePath: 'quitting-electron' } };
    const events = [];
    try {
      await captureElectron(root, target, { viewport: target.viewport, locator: { attribute: 'data-testid' } }, initialTasks, {
        onBeforeSpawn: phase => events.push(`starting:${phase}`),
        onStart: () => events.push('started'), onFinish: () => events.push('finished')
      });
    } catch (error) { failure = error; }
    expect(failure?.code).toBe('PROCESS_START_UNKNOWN');
    expect(failure.phase).toBe('visual-electron');
    expect(failure.result).toMatchObject({ status: 'FAIL', spawned: null, processGroupActive: true });
    expect(events).toEqual(['starting:visual-electron']);
    expect((await stat(failure.result.runtime.profileDir)).isDirectory()).toBe(true);
  } finally {
    // Independent fixture evidence proves this single exec'd Node child is gone before removing the retained profile.
    try { observedPid = Number((await readFile(path.join(root, 'attempted.pid'), 'utf8')).trim()); } catch { /* launch may not have reached the shell */ }
    if (Number.isSafeInteger(observedPid) && observedPid > 0) {
      if (processGroupAlive(observedPid)) { try { process.kill(-observedPid, 'SIGKILL'); } catch { /* only this fixture's group */ } }
      expect(await awaitGroupExit(observedPid, 3000)).toBe(true);
      if (failure?.result?.runtime?.profileDir) await rm(failure.result.runtime.profileDir, { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('each real Electron application and prototype capture isolates app files and Chromium storage from existing profiles', async () => {
  test.setTimeout(180000);
  const root = await project();
  const pids = [];
  try {
    const { targets } = JSON.parse(await readFile(path.join(root, 'protoflow.config.json'), 'utf8'));
    const binary = await resolveElectron(root, targets[1]);
    expect(binary).toBeTruthy();
    // Redirect the test's default profile to a seeded directory before the engine's preloaded bootstrap runs.
    // A regression therefore writes only to this test fixture, never the user's actual Electron profile.
    const existing = path.join(root, 'existing-user-profile');
    await mkdir(existing);
    await writeFile(path.join(existing, 'keep.json'), '{"personalSetting":"preserve"}\n');
    const probe = path.join(root, 'profile-probe.json');
    const guard = path.join(root, 'existing-profile.cjs');
    await writeFile(guard, `const { app } = require('electron'); const fs = require('node:fs'); const path = require('node:path'); app.setPath('userData', ${JSON.stringify(existing)}); app.setPath('sessionData', ${JSON.stringify(existing)}); app.once('ready', () => { const facts = { userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }; fs.writeFileSync(path.join(facts.userData, 'capture.marker'), 'private capture'); fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(facts)); });\n`);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const wrapper = path.join(root, 'isolated-electron');
    await writeFile(wrapper, `#!/bin/sh\nexec ${quote(binary)} --user-data-dir=${quote(existing)} -r ${quote(guard)} "$@"\n`);
    await chmod(wrapper, 0o700);
    const target = { ...targets[1], driver: { ...targets[1].driver, executablePath: 'isolated-electron' } };
    const settings = { viewport: target.viewport, locator: { attribute: 'data-testid' } };
    const appFile = path.join(root, 'desktop/renderer/app.js');
    await writeFile(appFile, (await readFile(appFile, 'utf8')).replace("text: 'Today'", "text: localStorage.getItem('protoflow-profile-test') ?? 'absent'"));
    const prototypeFile = path.join(root, 'prototype/tasks.html');
    await writeFile(prototypeFile, `${await readFile(prototypeFile, 'utf8')}<script>document.querySelector('[data-pf="tasks.title"]').textContent = localStorage.getItem('protoflow-profile-test') ?? 'absent';</script>\n`);
    const profiles = new Set();
    for (const kind of ['application', 'prototype']) {
      for (const value of ['scene-one', null]) {
        let pid;
        const scene = { ...initialTasks, anchors: ['tasks.title'], fixture: { data: value ? { localStorage: { 'protoflow-profile-test': value } } : {} } };
        const hooks = { onStart: (_phase, current) => { pid = current; pids.push(current); } };
        const pending = kind === 'application'
          ? captureElectron(root, target, settings, scene, hooks)
          : captureElectronPrototype(root, target, settings, scene, { url: pathToFileURL(prototypeFile).href, attribute: 'data-pf' }, hooks);
        const result = await boundedCapture(pending, () => pid, 45000);
        expect(result.status, result.reason).toBe('PASS');
        expect(result.capture.elements['tasks.title'].text).toBe(value ?? 'absent');
        const measured = JSON.parse(await readFile(probe, 'utf8'));
        expect(measured).toEqual({ userData: result.runtime.profileDir, sessionData: result.runtime.profileDir });
        expect(result.runtime.userData).toBe(measured.userData);
        expect(result.runtime.sessionData).toBe(measured.sessionData);
        expect(result.runtime.profileDir).not.toBe(existing);
        expect(profiles.has(result.runtime.profileDir)).toBe(false);
        profiles.add(result.runtime.profileDir);
        expect(result.runtime.exit).toEqual({ code: 0, signal: null });
        expect(processGroupAlive(pid)).toBe(false);
        await expect(stat(result.runtime.profileDir)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(existing, { recursive: true })).toEqual(['keep.json']);
        expect(await readFile(path.join(existing, 'keep.json'), 'utf8')).toBe('{"personalSetting":"preserve"}\n');
      }
    }
    expect(profiles.size).toBe(4);
  } finally {
    for (const pid of pids) {
      if (processGroupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* only this test's group */ } }
      expect(await awaitGroupExit(pid, 3000)).toBe(true);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('an Electron app that prevents quit reaches a bounded FAIL and leaves no process group', async () => {
  test.setTimeout(25000);
  const root = await project();
  let pid, finished;
  try {
    const mainFile = path.join(root, 'desktop/main.cjs');
    await writeFile(mainFile, `${await readFile(mainFile, 'utf8')}app.on('before-quit', event => event.preventDefault());\n`);
    const { targets } = JSON.parse(await readFile(path.join(root, 'protoflow.config.json'), 'utf8'));
    const target = { ...targets[1], timeoutMs: 5000 };
    const result = await boundedCapture(captureElectron(root, target, { viewport: target.viewport, locator: { attribute: 'data-testid' } }, initialTasks, {
      onStart: (phase, value) => { expect(phase).toBe('visual-electron'); pid = value; },
      onFinish: (phase, value, outcome) => { expect(value).toBe(pid); finished = outcome; }
    }), () => pid);
    expect(result.status).toBe('FAIL');
    expect(result.reason).toMatch(/Electron close timed out/);
    expect(result.runtime.shutdown).toMatchObject({ timeoutMs: 5000, timedOut: true, forcedTermination: true });
    expect(result.runtime.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(finished).toMatchObject({ status: 'FAIL', spawned: true, aborted: false, processGroupActive: false });
    expect(processGroupAlive(pid)).toBe(false);
  } finally { await cleanCapture(root, pid); }
});

for (const abortAt of ['start', 'close']) {
test(`abort during real Electron ${abortAt} stops capture and waits for its process group`, async () => {
  test.setTimeout(25000);
  const root = await project();
  const controller = new AbortController();
  let pid, finished, abortTimer;
  try {
    const closing = path.join(root, 'desktop', 'closing.marker');
    if (abortAt === 'close') {
      const mainFile = path.join(root, 'desktop/main.cjs');
      await writeFile(mainFile, `${await readFile(mainFile, 'utf8')}app.on('before-quit', event => { event.preventDefault(); require('node:fs').writeFileSync(path.join(__dirname, 'closing.marker'), 'quit requested'); });\n`);
    }
    const { targets } = JSON.parse(await readFile(path.join(root, 'protoflow.config.json'), 'utf8'));
    const target = { ...targets[1], timeoutMs: 20000 };
    await expect(boundedCapture(captureElectron(root, target, { viewport: target.viewport, locator: { attribute: 'data-testid' } }, initialTasks, {
      signal: controller.signal,
      onStart: (phase, value) => {
        expect(phase).toBe('visual-electron'); pid = value;
        if (abortAt === 'start') controller.abort();
        else abortTimer = setInterval(() => { readFile(closing).then(() => { clearInterval(abortTimer); controller.abort(); }).catch(() => {}); }, 25);
      },
      onFinish: (phase, value, outcome) => { expect(value).toBe(pid); finished = outcome; }
    }), () => pid)).rejects.toThrow('STOPPED: visual verification was interrupted');
    expect(finished).toMatchObject({ status: 'FAIL', spawned: true, aborted: true, processGroupActive: false });
    expect(finished.exit).toEqual({ code: null, signal: 'SIGKILL' });
    expect(processGroupAlive(pid)).toBe(false);
  } finally { clearInterval(abortTimer); await cleanCapture(root, pid); }
});
}
