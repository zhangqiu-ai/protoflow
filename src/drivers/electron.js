import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright';
import { projectPath, awaitGroupExit, processGroupAlive } from '../util.js';
import { captureOnPage } from './web.js';

/*
 * Electron driver: every capture launches a real Electron process through Playwright's _electron, replays the state
 * with the same anchor logic as the web driver and reads facts and pixels from the Electron renderer. No HTML copy,
 * iframe or plain Chromium stands in for the application.
 *
 * The frozen prototype is rendered in the same Electron build (an engine-provided viewer window), so native controls
 * and text rasterization are compared like for like; plain Chromium may be a different Chromium version.
 */

const VIEWER = fileURLToPath(new URL('./electron-viewer.cjs', import.meta.url));
const BOOTSTRAP = fileURLToPath(new URL('./electron-bootstrap.cjs', import.meta.url));

/** The Electron executable: an explicit project path, else the `electron` dependency of the target or project. */
export async function resolveElectron(root, target) {
  if (target.driver.executablePath) {
    const file = await projectPath(root, target.driver.executablePath);
    await access(file);
    return file;
  }
  const projectRoot = await realpath(root);
  const bases = [target.root && target.root !== '.' ? await projectPath(root, target.root) : projectRoot, projectRoot];
  for (const base of bases) {
    // Electron's loader can download a missing binary and print to stdout. Resolution must stay read-only.
    try {
      const directory = path.dirname(createRequire(path.join(base, 'package.json')).resolve('electron'));
      const binary = (await readFile(path.join(directory, 'path.txt'), 'utf8')).trim();
      const executable = path.resolve(directory, 'dist', binary);
      if (!binary || !executable.startsWith(path.join(directory, 'dist') + path.sep)) continue;
      await access(executable);
      return executable;
    } catch { /* try the next base */ }
  }
  return null;
}

export function electronRoute(route, request) {
  const page = path.posix.basename(request.page).replace(/\.html?$/i, '');
  return route.replaceAll('{screen}', request.screen).replaceAll('{page}', page).replaceAll('{state}', request.state);
}

/**
 * Launch one supervised Electron process, let `navigate(page)` bring its first window to the screen, then capture.
 * Returns { status, reason?, capture?, runtime }. The process group must be gone before this returns.
 */
async function launchAndCapture({ executablePath, args, cwd, env, viewport, attribute, request, timeout, stepTimeout, phase, navigate, hooks }) {
  const { signal, onBeforeSpawn, onStart, onFinish } = hooks;
  let app = null, pid = null, exit = null, exited = null, outcome, failure = null, launchAttempted = false, profileDir = null, runtime = { executablePath, args };
  let forcedTermination = false, resolveAbort;
  const interrupted = new Promise(resolve => { resolveAbort = resolve; });
  const terminate = () => {
    if (!pid || !processGroupAlive(pid)) return;
    forcedTermination = true;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the bounded group check below decides */ }
  };
  const abort = () => { terminate(); resolveAbort(); };
  await onBeforeSpawn?.(phase);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    profileDir = await realpath(await mkdtemp(path.join(tmpdir(), 'protoflow-electron-profile-')));
    // The switch covers native startup; the preloaded bootstrap sets Electron's app paths before target code runs.
    args = [`--user-data-dir=${profileDir}`, '-r', BOOTSTRAP, ...args];
    runtime = { executablePath, args, profileDir };
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    launchAttempted = true;
    app = await _electron.launch({ executablePath, args, cwd, env: { ...env, PROTOFLOW_ELECTRON_USER_DATA: profileDir }, timeout });
    const child = app.process();
    const identity = child.pid;
    if (!Number.isSafeInteger(identity) || identity <= 0) throw new Error('Electron process identity is unavailable');
    pid = identity;
    exited = new Promise(resolve => {
      const observed = (code, signalName) => { exit = { code, signal: signalName }; resolve(exit); };
      if (child.exitCode !== null || child.signalCode !== null) observed(child.exitCode, child.signalCode);
      else child.once('exit', observed);
    });
    runtime.pid = pid;
    await onStart?.(phase, pid);
    if (signal?.aborted) { abort(); throw new Error('STOPPED: visual verification was interrupted'); }
    runtime = { ...runtime, pid, ...(await app.evaluate(({ app: electronApp }) => ({
      electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
      platform: process.platform, arch: process.arch, appName: electronApp.getName(),
      userData: electronApp.getPath('userData'), sessionData: electronApp.getPath('sessionData')
    }))) };
    if (runtime.userData !== profileDir || runtime.sessionData !== profileDir) throw new Error('Electron storage isolation was overridden; userData and sessionData must use the private capture profile');
    await app.context().addInitScript(data => {
      window.__PROTOFLOW_FIXTURE__ = data;
      for (const [key, value] of Object.entries(data?.localStorage ?? {})) localStorage.setItem(key, String(value));
    }, request.fixture.data ?? {});
    try {
      const page = await app.firstWindow({ timeout });
      page.setDefaultTimeout(timeout);
      await app.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height); }, { width: viewport.width, height: viewport.height });
      runtime.url = await navigate(page);
      await page.locator(`[${attribute}="${request.screen}"]`).first().waitFor({ state: 'attached', timeout });
      // Measure, never assume: the window manager may clamp the requested content size (for example to the screen).
      const expected = { width: viewport.width, height: viewport.height, scale: viewport.scale ?? 1 };
      runtime.requestedViewport = expected;
      runtime.viewport = await measureViewport(page, expected, Math.min(timeout, 5000));
      if (!sameViewport(runtime.viewport, expected)) {
        outcome = { status: 'FAIL', reason: `${phase === 'visual-electron' ? 'Electron application' : 'Prototype in Electron'} window is ${describe(runtime.viewport)}, expected ${describe(expected)}; the window was resized or clamped (create its BrowserWindow with enableLargerThanScreen: true on macOS when the viewport exceeds the screen)`, runtime };
        return outcome;
      }
      const { elements, screenshot } = await captureOnPage(page, { attribute, anchors: request.anchors, steps: request.steps, timeoutMs: stepTimeout });
      const image = PNG.sync.read(screenshot);
      runtime.screenshot = { width: image.width, height: image.height };
      const pixels = { width: Math.round(expected.width * expected.scale), height: Math.round(expected.height * expected.scale) };
      if (image.width !== pixels.width || image.height !== pixels.height) {
        outcome = { status: 'FAIL', reason: `Screenshot is ${image.width}×${image.height} px, expected ${pixels.width}×${pixels.height} px for ${describe(expected)}`, runtime };
        return outcome;
      }
      // The capture reports the measured viewport (equal to the requested one here), not the configuration.
      outcome = { status: 'PASS', capture: { viewport: { ...runtime.viewport }, screenshot, elements }, runtime };
    } catch (error) {
      outcome = { status: 'FAIL', reason: `${phase === 'visual-electron' ? 'Electron application' : 'Prototype in Electron'} could not reach ${request.screen}.${request.state}: ${error.message.split('\n')[0]}`, runtime };
    }
    return outcome;
  } catch (error) { failure = error; throw error; }
  finally {
    const unknown = launchAttempted && (!Number.isSafeInteger(pid) || pid <= 0);
    let processGroupActive = unknown;
    if (app) {
      const closeStarted = Date.now();
      const shutdown = { timeoutMs: timeout, timedOut: false, forcedTermination };
      let closeTimer;
      try {
        // app.close() waits for native process exit and can remain pending when the app prevents quit. The deadline
        // must cover that await itself; a group check after an unbounded close cannot supervise a stuck application.
        await Promise.race([
          app.close().catch(() => { /* the group and observed exit checks below decide */ }),
          interrupted,
          new Promise(resolve => {
            closeTimer = setTimeout(() => {
              shutdown.timedOut = true;
              failure ??= new Error(`Electron close timed out after ${timeout} ms; terminated the process group and blocked advancement`);
              terminate(); resolve();
            }, timeout);
          })
        ]);
      } finally { clearTimeout(closeTimer); }
      if (pid && !(await awaitGroupExit(pid, 5000))) {
        terminate();
        processGroupActive = !(await awaitGroupExit(pid, 2000));
        failure ??= new Error('Electron closed with a surviving process group; terminated the group and blocked advancement');
      }
      // A capture only counts when the process ended normally: observed exit, code 0, no signal.
      if (!processGroupActive && exited) {
        let exitTimer;
        try { await Promise.race([exited, new Promise(resolve => { exitTimer = setTimeout(resolve, 5000); })]); }
        finally { clearTimeout(exitTimer); }
      }
      if (!failure && (!exit || exit.code !== 0 || exit.signal)) {
        const detail = exit ? `code ${exit.code}, signal ${exit.signal}` : 'no exit status observed';
        failure = new Error(`Electron exited abnormally (${detail})`);
      }
      runtime.shutdown = { ...shutdown, elapsedMs: Date.now() - closeStarted, forcedTermination };
    }
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) failure = new Error('STOPPED: visual verification was interrupted');
    if (failure && outcome && outcome.status !== 'NOT_RUN') { outcome.status = 'FAIL'; outcome.reason = `${failure.message}${outcome.reason ? `; ${outcome.reason}` : ''}`; }
    if (outcome?.runtime) outcome.runtime.exit = exit;
    // A rejected launch can have created subprocesses without returning their identity. Keep both STARTING and
    // its profile durable until manual recovery can establish that all possible processes have stopped.
    const processResult = { status: failure || outcome?.status !== 'PASS' ? 'FAIL' : 'PASS', spawned: launchAttempted ? unknown ? null : true : false, processGroupActive, aborted: signal?.aborted ?? false, exit, error: failure?.message ?? null };
    if (profileDir && !processGroupActive) await rm(profileDir, { recursive: true, force: true });
    if (!unknown) await onFinish?.(phase, pid, processResult);
    if (processGroupActive) {
      const error = new Error(unknown ? `Electron launch has unknown PID; inspect possible subprocesses before manual recovery (private profile preserved at ${profileDir})` : 'Electron process group remains active; stop it before further verification or repair');
      error.code = unknown ? 'PROCESS_START_UNKNOWN' : 'PROCESS_GROUP_ACTIVE'; error.phase = phase; error.result = { ...processResult, runtime };
      throw error;
    }
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
  }
}

const describe = viewport => `${viewport.width}×${viewport.height}@${viewport.scale}`;
const sameViewport = (actual, expected) => actual.width === expected.width && actual.height === expected.height && actual.scale === expected.scale;
/** Wait briefly for a resize to settle, then return the renderer's actual innerWidth/innerHeight/devicePixelRatio. */
async function measureViewport(page, expected, timeout) {
  const read = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
  const deadline = Date.now() + timeout;
  let actual = await read();
  while (!sameViewport(actual, expected) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    actual = await read();
  }
  return actual;
}

async function electronContext(root, target, settings) {
  if (process.platform === 'win32') return { reason: 'Electron capture requires POSIX process-group supervision' };
  let executablePath;
  try { executablePath = await resolveElectron(root, target); }
  catch (error) { return { reason: `Electron executable not found: ${error.message}` }; }
  if (!executablePath) return { reason: `Electron is not installed for target ${target.id}; add the electron dependency or driver.executablePath` };
  const env = { ...process.env, ...target.driver.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return { executablePath, env, scaleArg: `--force-device-scale-factor=${settings.viewport.scale ?? 1}`, timeout: target.timeoutMs ?? 30000 };
}

/** Capture the target's real Electron application (phase 'visual-electron'). */
export async function captureElectron(root, target, settings, request, hooks = {}) {
  const context = await electronContext(root, target, settings);
  if (!context.executablePath) return { status: 'NOT_RUN', reason: context.reason };
  const targetRoot = target.root && target.root !== '.' ? await projectPath(root, target.root) : await realpath(root);
  const main = await projectPath(root, path.posix.join(target.root ?? '.', target.driver.main));
  return launchAndCapture({
    executablePath: context.executablePath, args: [context.scaleArg, main, ...(target.driver.args ?? [])], cwd: targetRoot,
    env: { ...context.env, PROTOFLOW_SCREEN: request.screen, PROTOFLOW_STATE: request.state, PROTOFLOW_FIXTURE: JSON.stringify(request.fixture.data ?? {}) },
    viewport: settings.viewport, attribute: settings.locator.attribute, request, timeout: context.timeout, stepTimeout: target.timeoutMs ?? 10000,
    phase: 'visual-electron', hooks,
    navigate: async page => {
      const route = electronRoute(target.driver.route, request);
      const url = route.startsWith('#') ? `${page.url().split('#')[0]}${route}` : pathToFileURL(await projectPath(root, path.posix.join(target.root ?? '.', route))).href;
      await page.goto(url);
      // Reload so the fixture init script also runs for this screen's document.
      await page.reload({ waitUntil: 'load' });
      return url;
    }
  });
}

/** Capture the frozen prototype page in the same Electron build (phase 'visual-electron-prototype'). */
export async function captureElectronPrototype(root, target, settings, request, { url, attribute }, hooks = {}) {
  const context = await electronContext(root, target, settings);
  if (!context.executablePath) return { status: 'NOT_RUN', reason: context.reason };
  return launchAndCapture({
    executablePath: context.executablePath, args: [context.scaleArg, VIEWER], cwd: await realpath(root),
    env: { ...context.env, PROTOFLOW_VIEWER_URL: url, PROTOFLOW_VIEWER_WIDTH: String(settings.viewport.width), PROTOFLOW_VIEWER_HEIGHT: String(settings.viewport.height) },
    viewport: settings.viewport, attribute, request, timeout: context.timeout, stepTimeout: target.timeoutMs ?? 10000,
    phase: 'visual-electron-prototype', hooks,
    navigate: async page => { await page.reload({ waitUntil: 'load' }); return url; }
  });
}
