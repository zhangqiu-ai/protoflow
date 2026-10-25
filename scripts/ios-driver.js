#!/usr/bin/env node
/*
 * ProtoFlow iOS reference driver for the external driver protocol (schemas/driver-request.schema.json → stdout
 * schemas/driver-response.schema.json). Drives any iOS app on a Simulator by bundle identifier through XCUITest, so it
 * serves SwiftUI, UIKit and React Native targets alike.
 *
 *   argv: node scripts/ios-driver.js --bundle-id ID --device NAME|UDID [--app PATH.app] [--frame safe-area|device]
 *         [--launch-url TEMPLATE] [--timeout-ms N] [--launch-timeout-ms N] [--cache DIR]
 *
 * Launch convention: the app receives `-PROTOFLOW_SCREEN <screen> -PROTOFLOW_STATE <state> -PROTOFLOW_FIXTURE <json>`
 * as launch arguments (readable through UserDefaults / NSArgumentDomain) and must open that screen directly. With
 * --launch-url the app is instead cold-started by opening that deep link (src/drivers/launch-url.js), e.g. Expo Router.
 * A missing simulator, Xcode or runner build is NOT_RUN; an app that cannot reach the state is FAIL.
 */
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iosResponse } from '../src/drivers/ios-tree.js';
import { launchUrl, launchUrlTemplateError } from '../src/drivers/launch-url.js';

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerSource = path.join(engine, 'drivers/ios');
const { values } = parseArgs({
  options: {
    'bundle-id': { type: 'string' }, app: { type: 'string' }, device: { type: 'string' },
    frame: { type: 'string', default: 'safe-area' }, 'launch-url': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'launch-timeout-ms': { type: 'string' }, cache: { type: 'string' }
  }
});

const respond = response => process.stdout.write(`${JSON.stringify(response)}\n`);
const notRun = reason => respond({ schemaVersion: 1, status: 'NOT_RUN', reason });
const fail = reason => respond({ schemaVersion: 1, status: 'FAIL', reason });
const tail = text => String(text ?? '').trim().split('\n').slice(-12).join('\n');

/** Run a child in this process group (the engine supervises the group) and collect its output. */
function run(argv, { env, timeoutMs = 600000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: error.message, timedOut }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

async function exists(file) { try { await stat(file); return true; } catch { return false; } }

async function hashTree(directory, hash = createHash('sha256')) {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.') || item.name === 'xcuserdata') continue;
    const file = path.join(directory, item.name);
    hash.update(path.relative(runnerSource, file));
    if (item.isDirectory()) await hashTree(file, hash); else hash.update(await readFile(file));
  }
  return hash;
}

async function findDevice(wanted) {
  const listing = await run(['xcrun', 'simctl', 'list', 'devices', '--json'], { timeoutMs: 300000 });
  if (listing.timedOut) return { error: 'the simulator service did not answer `simctl list` within 300 s' };
  if (listing.code !== 0) return { error: `Xcode simulator tools are not available: ${tail(listing.stderr)}` };
  const devices = Object.entries(JSON.parse(listing.stdout).devices).flatMap(([runtime, items]) => items.map(item => ({ ...item, runtime })));
  const device = devices.find(item => item.udid === wanted) ?? devices.find(item => item.name === wanted && item.isAvailable);
  if (!device) return { error: `simulator "${wanted}" was not found; create it, e.g. xcrun simctl create "${wanted}" com.apple.CoreSimulator.SimDeviceType.iPhone-17 <runtime>` };
  return { device };
}

async function prepareDevice(device) {
  if (device.state !== 'Booted') {
    const boot = await run(['xcrun', 'simctl', 'boot', device.udid], { timeoutMs: 180000 });
    if (boot.code !== 0 && !/current state: Booted/.test(boot.stderr)) return `simulator ${device.name} did not boot: ${tail(boot.stderr)}`;
  }
  const ready = await run(['xcrun', 'simctl', 'bootstatus', device.udid, '-b'], { timeoutMs: 300000 });
  if (ready.code !== 0) return `simulator ${device.name} did not finish booting: ${tail(ready.stderr)}`;
  await run(['xcrun', 'simctl', 'ui', device.udid, 'appearance', 'light'], { timeoutMs: 300000 });
  return null;
}

/** Build the XCUITest runner once per runner source and Xcode version; returns the .xctestrun path. */
async function runner(cache) {
  const xcode = await run(['xcodebuild', '-version'], { timeoutMs: 60000 });
  if (xcode.code !== 0) return { error: `xcodebuild is not available: ${tail(xcode.stderr)}` };
  const key = (await hashTree(runnerSource)).update(xcode.stdout).digest('hex').slice(0, 16);
  const derived = path.join(cache, `runner-${key}`);
  const products = path.join(derived, 'Build/Products');
  const find = async () => (await exists(products)) ? (await readdir(products)).find(name => name.endsWith('.xctestrun')) : null;
  let xctestrun = await find();
  if (!xctestrun) {
    const build = await run(['xcodebuild', 'build-for-testing', '-project', path.join(runnerSource, 'ProtoFlowDriver.xcodeproj'), '-scheme', 'ProtoFlowDriver',
      '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, '-quiet'], { timeoutMs: 900000 });
    xctestrun = await find();
    if (build.code !== 0 || !xctestrun) return { error: `the XCUITest driver runner could not be built: ${tail(build.stderr || build.stdout)}` };
  }
  return { xctestrun: path.join(products, xctestrun), directory: derived };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (process.platform !== 'darwin') return notRun('the iOS driver needs macOS with Xcode');
  if (!values['bundle-id'] || !values.device) return notRun('the iOS driver needs --bundle-id and --device');
  if (!['safe-area', 'device'].includes(values.frame)) return notRun(`unknown --frame ${values.frame}`);
  const urlError = values['launch-url'] !== undefined && launchUrlTemplateError(values['launch-url']);
  if (urlError) return notRun(urlError);
  const timeoutMs = Number(values['timeout-ms'] ?? 10000);
  const launchTimeoutMs = Number(values['launch-timeout-ms'] ?? 60000);
  const cache = path.resolve(values.cache ?? '.protoflow/cache/ios-driver');
  await mkdir(cache, { recursive: true });

  const { device, error } = await findDevice(values.device);
  if (error) return notRun(error);
  const bootError = await prepareDevice(device);
  if (bootError) return notRun(bootError);
  if (values.app) {
    const app = path.resolve(values.app);
    if (!await exists(app)) return fail(`app bundle ${values.app} does not exist; the target's build must produce it`);
    const install = await run(['xcrun', 'simctl', 'install', device.udid, app], { timeoutMs: 300000 });
    // A hung simulator service is the environment, not the app: only a reported install error is FAIL.
    if (install.timedOut || install.code === null) return notRun(`simulator ${device.name} did not finish installing ${values.app} within 300 s`);
    if (install.code !== 0) return fail(`app ${values.app} could not be installed: ${tail(install.stderr)}`);
  }
  const built = await runner(cache);
  if (built.error) return notRun(built.error);

  const outputDir = path.resolve(request.outputDir);
  await mkdir(outputDir, { recursive: true });
  await rm(path.join(outputDir, 'raw.json'), { force: true });
  // Measured by this runner build: a changed probe invalidates the cached safe area with the runner.
  const safeAreaFile = path.join(built.directory, `safe-area-${device.udid}.json`);
  const safeArea = JSON.parse(await readFile(safeAreaFile, 'utf8').catch(() => 'null'));
  const job = {
    bundleId: values['bundle-id'], screen: request.screen, steps: request.steps, outputDir, timeoutMs, launchTimeoutMs,
    probeSafeArea: values.frame === 'safe-area' && !safeArea,
    launchArguments: ['-PROTOFLOW_SCREEN', request.screen, '-PROTOFLOW_STATE', request.state, '-PROTOFLOW_FIXTURE', JSON.stringify(request.fixture?.data ?? {}),
      '-AppleLanguages', '(en)', '-AppleLocale', 'en_US'],
    ...(values['launch-url'] && { launchUrl: launchUrl(values['launch-url'], request) })
  };
  const jobFile = path.join(outputDir, 'job.json');
  await writeFile(jobFile, `${JSON.stringify(job, null, 2)}\n`);
  const results = await mkdtemp(path.join(tmpdir(), 'protoflow-ios-'));
  let test;
  try {
    test = await run(['xcodebuild', 'test-without-building', '-xctestrun', built.xctestrun, '-destination', `id=${device.udid}`,
      '-only-testing:ProtoFlowDriverUITests/CaptureTests/testCapture', '-resultBundlePath', path.join(results, 'capture.xcresult')],
    { env: { TEST_RUNNER_PROTOFLOW_DRIVER_JOB: jobFile }, timeoutMs: 600000 });
  } finally { await rm(results, { recursive: true, force: true }); }
  const raw = JSON.parse(await readFile(path.join(outputDir, 'raw.json'), 'utf8').catch(() => 'null'));
  if (!raw) return notRun(`the XCUITest capture produced no result (xcodebuild exit ${test.code}): ${tail(test.stdout + test.stderr)}`);
  if (raw.safeArea) await writeFile(safeAreaFile, `${JSON.stringify(raw.safeArea)}\n`);
  const screenshot = raw.status === 'PASS' ? await readFile(path.join(outputDir, raw.screenshot)) : null;
  const { response, png } = iosResponse(raw, screenshot, { anchors: request.anchors, screen: request.screen, frame: values.frame, safeArea, steps: request.steps });
  if (png) await writeFile(path.join(outputDir, 'screen.png'), png);
  respond({ ...response, log: `device ${device.name} (${device.udid}), runtime ${device.runtime.split('.').pop()}` });
}

main().catch(error => notRun(`ios driver error: ${error.message}`));
