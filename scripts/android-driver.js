#!/usr/bin/env node
/*
 * ProtoFlow Android reference driver for the external driver protocol (schemas/driver-request.schema.json → stdout
 * schemas/driver-response.schema.json). Drives any Android app on an emulator by package name through a UiAutomator
 * instrumentation runner (drivers/android), so it serves Compose, View, React Native and Flutter targets alike.
 *
 *   argv: node scripts/android-driver.js --package ID --avd NAME [--apk PATH.apk] [--activity CLASS]
 *         [--launch-url TEMPLATE] [--frame safe-area|device] [--timeout-ms N] [--launch-timeout-ms N] [--cache DIR]
 *
 * Launch convention: the app receives PROTOFLOW_SCREEN, PROTOFLOW_STATE and PROTOFLOW_FIXTURE (JSON) as string intent
 * extras and must open that screen directly; with --launch-url the extras ride on an ACTION_VIEW intent for that deep
 * link (src/drivers/launch-url.js), e.g. Expo Router. Environment problems (no SDK/JDK, missing AVD, boot/install timeout,
 * runner build failure, lost adb) are NOT_RUN; an app that cannot reach the state is FAIL.
 */
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm, stat, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidResponse } from '../src/drivers/android-tree.js';
import { launchUrl, launchUrlTemplateError } from '../src/drivers/launch-url.js';

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerSource = path.join(engine, 'drivers/android');
const RUNNER_PACKAGE = 'dev.protoflow.driver';
const { values } = parseArgs({
  options: {
    package: { type: 'string' }, avd: { type: 'string' }, apk: { type: 'string' }, activity: { type: 'string' }, 'launch-url': { type: 'string' },
    frame: { type: 'string', default: 'safe-area' }, 'timeout-ms': { type: 'string' }, 'launch-timeout-ms': { type: 'string' }, cache: { type: 'string' }
  }
});

const respond = response => process.stdout.write(`${JSON.stringify(response)}\n`);
const notRun = reason => respond({ schemaVersion: 1, status: 'NOT_RUN', reason });
const fail = reason => respond({ schemaVersion: 1, status: 'FAIL', reason });
const tail = text => String(text ?? '').trim().split('\n').slice(-12).join('\n');

const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(homedir(), 'Library/Android/sdk');
const javaHome = process.env.JAVA_HOME ?? ['/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@17'].find(existsSync);
const toolEnv = { ANDROID_HOME: androidHome, ...(javaHome && { JAVA_HOME: javaHome }) };
const adbPath = path.join(androidHome, 'platform-tools/adb');
const emulatorPath = path.join(androidHome, 'emulator/emulator');

/** Run a child in this process group (the engine supervises the group) and collect its output. */
function run(argv, { env, timeoutMs = 600000, binary = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...toolEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const done = (code, error) => { clearTimeout(timer); const buffer = Buffer.concat(chunks); resolve({ code, stdout: binary ? buffer : buffer.toString('utf8'), stderr: error ?? stderr, timedOut }); };
    child.once('error', error => done(null, error.message));
    child.once('close', code => done(code));
  });
}
const adb = (serial, args, options) => run([adbPath, ...(serial ? ['-s', serial] : []), ...args], options);
async function exists(file) { try { await stat(file); return true; } catch { return false; } }

/** The running emulator serial for an AVD name, or null. */
async function serialFor(avd) {
  const devices = await adb(null, ['devices'], { timeoutMs: 60000 });
  if (devices.code !== 0) return { error: `adb is not responding: ${tail(devices.stderr)}` };
  for (const serial of devices.stdout.split('\n').slice(1).map(line => line.split('\t')).filter(([id, state]) => id?.startsWith('emulator-') && state === 'device').map(([id]) => id)) {
    const name = await adb(serial, ['emu', 'avd', 'name'], { timeoutMs: 30000 });
    if (name.stdout.split('\n')[0].trim() === avd) return { serial };
  }
  return { serial: null };
}

/** Find or boot the AVD. The emulator is a device service: it runs detached and outlives this capture. */
async function ensureDevice(avd) {
  let found = await serialFor(avd);
  if (found.error || found.serial) return found;
  const list = await run([emulatorPath, '-list-avds'], { timeoutMs: 60000 });
  if (!list.stdout.split('\n').map(line => line.trim()).includes(avd)) return { error: `AVD "${avd}" was not found; create it with avdmanager create avd -n "${avd}" -k <system image>` };
  // The emulator outlives this capture: start it from the home directory, never from a runner worktree, so cleanup of
  // processes left in a worktree cannot mistake the device for an executor leftover.
  const child = spawn(emulatorPath, ['-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save'], { cwd: homedir(), env: { ...process.env, ...toolEnv }, detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    found = await serialFor(avd);
    if (found.serial) {
      const booted = await adb(found.serial, ['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 30000 });
      if (booted.stdout.trim() === '1') return found;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return { error: `AVD "${avd}" did not finish booting within 300 s` };
}

/** Deterministic captures: no animations, and no soft keyboard while a hardware keyboard is configured. */
async function prepare(serial) {
  for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) await adb(serial, ['shell', 'settings', 'put', 'global', key, '0'], { timeoutMs: 30000 });
  await adb(serial, ['shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '0'], { timeoutMs: 30000 });
}

async function hashTree(directory, hash = createHash('sha256')) {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.') || ['build', 'local.properties'].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    hash.update(path.relative(runnerSource, file));
    if (item.isDirectory()) await hashTree(file, hash); else hash.update(await readFile(file));
  }
  return hash;
}

/** Build the runner APKs once per runner source and JDK, in a private copy (the engine may be read-only). */
async function runner(cache) {
  if (!javaHome) return { error: 'no JDK 17 found; set JAVA_HOME' };
  const java = await run([path.join(javaHome, 'bin/java'), '-version'], { timeoutMs: 60000 });
  if (java.code !== 0) return { error: `JDK at ${javaHome} is not usable: ${tail(java.stderr)}` };
  const key = (await hashTree(runnerSource)).update(java.stderr).digest('hex').slice(0, 16);
  const directory = path.join(cache, `runner-${key}`);
  const apks = { app: path.join(directory, 'driver/build/outputs/apk/debug/driver-debug.apk'), test: path.join(directory, 'driver/build/outputs/apk/androidTest/debug/driver-debug-androidTest.apk') };
  if (await exists(apks.app) && await exists(apks.test)) return { apks, directory };
  await rm(directory, { recursive: true, force: true });
  await cp(runnerSource, directory, { recursive: true, filter: source => !/[\\/](build|\.gradle)([\\/]|$)/.test(path.relative(runnerSource, source)) });
  await writeFile(path.join(directory, 'local.properties'), `sdk.dir=${androidHome}\n`);
  // `sh gradlew`: a packed engine may not keep the wrapper's executable bit.
  const build = await run(['sh', path.join(directory, 'gradlew'), '-p', directory, '--no-daemon', '-q', 'assembleDebug', 'assembleDebugAndroidTest'], { timeoutMs: 1800000 });
  if (build.code !== 0 || !await exists(apks.test)) return { error: `the UiAutomator driver runner could not be built: ${tail(build.stderr || build.stdout)}` };
  return { apks, directory };
}

const DEVICE_UNAVAILABLE = /Can't find service: package|cmd: Failure calling service package|device offline|device '[^']*' not found|no devices\/emulators found|Broken pipe \(32\)|Is the system running\?/i;
async function install(serial, apk, label, packageName = null) {
  let result = await adb(serial, ['install', '-r', '-g', apk], { timeoutMs: 300000 });
  let replaced = false;
  // The verified build is authoritative: a copy signed with another key (another checkout, an agent's own build) is replaced.
  if (packageName && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(result.stdout + result.stderr)) {
    await adb(serial, ['uninstall', packageName], { timeoutMs: 120000 });
    result = await adb(serial, ['install', '-r', '-g', apk], { timeoutMs: 300000 });
    replaced = true;
  }
  if (result.timedOut || result.code === null) return { notRun: `emulator did not finish installing ${label} within 300 s` };
  // The device, not the APK: its package manager is down (the emulator is restarting) or adb lost it.
  if (DEVICE_UNAVAILABLE.test(result.stdout + result.stderr)) return { notRun: `emulator could not install ${label}: ${tail(result.stdout + result.stderr)}` };
  if (result.code !== 0 || !/Success/.test(result.stdout)) return { fail: `${label} could not be installed: ${tail(result.stdout + result.stderr)}` };
  return { replaced };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (!values.package || !values.avd) return notRun('the Android driver needs --package and --avd');
  if (!['safe-area', 'device'].includes(values.frame)) return notRun(`unknown --frame ${values.frame}`);
  const urlError = values['launch-url'] !== undefined && launchUrlTemplateError(values['launch-url']);
  if (urlError) return notRun(urlError);
  if (!await exists(adbPath)) return notRun(`Android SDK platform-tools not found under ${androidHome}; set ANDROID_HOME`);
  if (!await exists(emulatorPath)) return notRun(`Android emulator not found under ${androidHome}`);
  const cache = path.resolve(values.cache ?? '.protoflow/cache/android-driver');
  await mkdir(cache, { recursive: true });

  const { serial, error } = await ensureDevice(values.avd);
  if (error) return notRun(error);
  await prepare(serial);
  let installed = {};
  if (values.apk) {
    const apk = path.resolve(values.apk);
    if (!await exists(apk)) return fail(`APK ${values.apk} does not exist; the target's build must produce it`);
    installed = await install(serial, apk, values.apk, values.package);
    if (installed.notRun) return notRun(installed.notRun);
    if (installed.fail) return fail(installed.fail);
  }
  const built = await runner(cache);
  if (built.error) return notRun(built.error);
  for (const [label, apk] of Object.entries(built.apks)) {
    const runnerInstall = await install(serial, apk, `driver ${label} APK`, label === 'app' ? RUNNER_PACKAGE : `${RUNNER_PACKAGE}.test`);
    if (runnerInstall.notRun || runnerInstall.fail) return notRun(runnerInstall.notRun ?? runnerInstall.fail);
  }

  const outputDir = path.resolve(request.outputDir);
  await mkdir(outputDir, { recursive: true });
  // Measured by this runner build: a changed probe invalidates the cached insets with the runner.
  const insetsFile = path.join(built.directory, `insets-${values.avd.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
  const insets = JSON.parse(await readFile(insetsFile, 'utf8').catch(() => 'null'));
  const job = {
    package: values.package, ...(values.activity && { activity: values.activity }),
    ...(values['launch-url'] && { launchUrl: launchUrl(values['launch-url'], request) }), screen: request.screen, steps: request.steps,
    timeoutMs: Number(values['timeout-ms'] ?? 10000), launchTimeoutMs: Number(values['launch-timeout-ms'] ?? 60000),
    probeInsets: values.frame === 'safe-area' && !insets,
    extras: { PROTOFLOW_SCREEN: request.screen, PROTOFLOW_STATE: request.state, PROTOFLOW_FIXTURE: JSON.stringify(request.fixture?.data ?? {}) }
  };
  await writeFile(path.join(outputDir, 'job.json'), `${JSON.stringify(job, null, 2)}\n`);
  const encoded = Buffer.from(JSON.stringify(job)).toString('base64');
  const instrument = await adb(serial, ['shell', 'am', 'instrument', '-w', '-e', 'job', encoded, '-e', 'class', `${RUNNER_PACKAGE}.CaptureTest`, `${RUNNER_PACKAGE}.test/androidx.test.runner.AndroidJUnitRunner`], { timeoutMs: 600000 });
  const pull = async (name, binary = false) => {
    const result = await adb(serial, ['exec-out', 'run-as', RUNNER_PACKAGE, 'cat', `files/out/${name}`], { timeoutMs: 120000, binary });
    return result.code === 0 && result.stdout.length ? result.stdout : null;
  };
  const rawText = await pull('raw.json');
  let raw = null;
  try { raw = rawText && JSON.parse(rawText); } catch { /* reported below */ }
  await writeFile(path.join(outputDir, 'raw.json'), rawText ?? '');
  if (!raw) return notRun(`the UiAutomator capture produced no result (instrument exit ${instrument.code}): ${tail(instrument.stdout + instrument.stderr)}`);
  if (raw.insets) await writeFile(insetsFile, `${JSON.stringify(raw.insets)}\n`);
  else if (insets) raw.insets = insets;
  const failurePng = raw.status === 'FAIL' ? await pull('failure.png', true) : null;
  if (failurePng) await writeFile(path.join(outputDir, 'failure.png'), failurePng);
  const screenshot = raw.status === 'PASS' ? await pull('device.png', true) : null;
  if (raw.status === 'PASS' && !screenshot) return notRun('the device screenshot could not be retrieved');
  if (screenshot) await writeFile(path.join(outputDir, 'device.png'), screenshot);
  const { response, png } = androidResponse(raw, screenshot, { anchors: request.anchors, screen: request.screen, frame: values.frame, steps: request.steps });
  if (png) await writeFile(path.join(outputDir, 'screen.png'), png);
  respond({ ...response, log: `avd ${values.avd} (${serial}), density ${raw.density ?? '?'}${installed.replaced ? `; replaced an installed ${values.package} signed with another key` : ''}` });
}

main().catch(error => notRun(`android driver error: ${error.message}`));
