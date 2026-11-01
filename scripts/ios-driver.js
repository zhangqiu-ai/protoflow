#!/usr/bin/env node
/*
 * ProtoFlow iOS reference driver for the external driver protocol (schemas/driver-request.schema.json → stdout
 * schemas/driver-response.schema.json). Drives any iOS app on a Simulator by bundle identifier through XCUITest, so it
 * serves SwiftUI, UIKit and React Native targets alike.
 *
 *   argv: node scripts/ios-driver.js --bundle-id ID --device NAME|UDID [--app PATH.app] [--frame safe-area|device]
 *         [--launch-url TEMPLATE] [--timeout-ms N] [--launch-timeout-ms N] [--cache DIR]
 *         Optional responsive capture flags: see docs/ios-responsive-capture.md (default behavior is unchanged).
 *
 * Launch convention: the app receives `-PROTOFLOW_SCREEN <screen> -PROTOFLOW_STATE <state> -PROTOFLOW_FIXTURE <json>`
 * as launch arguments (readable through UserDefaults / NSArgumentDomain) and must open that screen directly. With
 * --launch-url the app is instead cold-started by opening that deep link (src/drivers/launch-url.js), e.g. Expo Router.
 * A missing simulator, Xcode or runner build is NOT_RUN; an app that cannot reach the state is FAIL.
 */
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm, stat, mkdtemp, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScrollSteps, nativeScrollEnds } from '../src/drivers/scroll-alignment.js';
import { iosResponse } from '../src/drivers/ios-tree.js';
import { launchUrl, launchUrlTemplateError } from '../src/drivers/launch-url.js';
import { startProbeBridge } from '../src/drivers/uikit-probe-bridge.js';
import { validateProbePair, supplementUIKitFacts } from '../src/drivers/uikit-probe.js';

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runnerSource = path.join(engine, 'drivers/ios');
export const driverOptions = args => parseArgs({
  args,
  options: {
    'bundle-id': { type: 'string' }, app: { type: 'string' }, device: { type: 'string' },
    'uikit-probe-context': { type: 'string' }, 'uikit-settling-budget-ms': { type: 'string' },
    'launch-preparation-dir': { type: 'string' }, 'launch-preparation-token': { type: 'string' },
    frame: { type: 'string', default: 'safe-area' }, 'launch-url': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'launch-timeout-ms': { type: 'string' }, cache: { type: 'string' },
    orientation: { type: 'string' }, 'rotate-after-steps': { type: 'string' },
    'preserve-known-synthetic-inputs': { type: 'string' }, 'hittable-anchors': { type: 'string' }, appearance: { type: 'string' }
  }
}).values;

/** A host may prepare a short-lived deep link at the native open boundary; no issuer credential enters this job. */
export async function launchPreparationOptions(values) {
  const directory = values['launch-preparation-dir'], token = values['launch-preparation-token'];
  if (directory === undefined && token === undefined) return null;
  if (directory === undefined || token === undefined || token.length !== 64 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('launch preparation needs a directory and a 64-character lowercase hexadecimal token');
  if (!values['launch-url']) throw new Error('launch preparation needs --launch-url');
  try {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new Error();
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid() ||
      (metadata.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) throw new Error();
  } catch { throw new Error('launch preparation needs an existing canonical owned mode-0700 directory without symlinks'); }
  return { directory, token, timeoutMs: 15000 };
}

const orientations = ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right'];
export function responsiveOptionsError(values, request) {
  if (values['uikit-settling-budget-ms'] !== undefined) {
    const budget = values['uikit-settling-budget-ms'];
    if (!values['uikit-probe-context']) return '--uikit-settling-budget-ms needs --uikit-probe-context';
    if (!/^[0-9]+$/.test(budget) || !Number.isSafeInteger(Number(budget)) || Number(budget) < 6000 || Number(budget) > 10000) return 'invalid --uikit-settling-budget-ms (integer 6000..10000 required)';
  }
  if (!['safe-area', 'device', 'app-window'].includes(values.frame)) return `unknown --frame ${values.frame}`;
  if (values.frame === 'app-window' && !values['uikit-probe-context']) return '--frame app-window needs --uikit-probe-context';
  if (values['rotate-after-steps'] && values.frame === 'safe-area') return '--rotate-after-steps needs --frame device or app-window';
  for (const key of ['orientation', 'rotate-after-steps']) {
    if (values[key] !== undefined && !orientations.includes(values[key])) return `invalid --${key}`;
  }
  if (values.appearance !== undefined && !['light', 'dark'].includes(values.appearance)) return 'invalid --appearance';
  if (values['hittable-anchors'] !== undefined) {
    const anchors = values['hittable-anchors'].split(',');
    if (anchors.length > 16 || new Set(anchors).size !== anchors.length || anchors.some(anchor => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(anchor))) return 'invalid --hittable-anchors';
  }
  if (values['preserve-known-synthetic-inputs'] !== undefined) {
    const anchors = values['preserve-known-synthetic-inputs'].split(',');
    if (!values['rotate-after-steps'] || request.fixture?.data?.session !== 'qa' || anchors.length > 8 ||
      new Set(anchors).size !== anchors.length || anchors.some(anchor => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(anchor) ||
        !request.steps?.some(step => step.action === 'fill' && step.anchor === anchor && typeof step.value === 'string' && step.value.length > 0 && step.value.length <= 4096))) {
      return '--preserve-known-synthetic-inputs needs qa fixture, rotation, and up to eight unique filled anchors';
    }
  }
  return null;
}

/** Only validated, unchanged probe samples may supply an app-window crop. No target viewport is involved. */
export function measuredAppContent(capture) {
  const reject = () => { throw new Error('UIKit probe: app-window crop has invalid or transformed measured geometry'); };
  const window = capture?.windows?.length === 1 ? capture.windows[0] : null;
  const rect = value => value && ['x', 'y', 'width', 'height'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) && value.width > 0 && value.height > 0;
  const { bounds, windowFrame: frame, screenBounds: screen, safeAreaInsets: insets, tree } = window ?? {};
  if (!rect(bounds) || !rect(frame) || !rect(screen) || !rect(tree?.frameInScreen) || tree.transformed !== false ||
    bounds.x !== 0 || bounds.y !== 0 || bounds.width !== frame.width || bounds.height !== frame.height ||
    ['x', 'y', 'width', 'height'].some(key => frame[key] !== tree.frameInScreen[key]) ||
    !insets || !['top', 'left', 'bottom', 'right'].every(key => typeof insets[key] === 'number' && Number.isFinite(insets[key]) && insets[key] >= 0) ||
    frame.x < screen.x || frame.y < screen.y || frame.x + frame.width > screen.x + screen.width || frame.y + frame.height > screen.y + screen.height) reject();
  const result = { x: frame.x + insets.left, y: frame.y + insets.top, width: bounds.width - insets.left - insets.right, height: bounds.height - insets.top - insets.bottom };
  if (!rect(result)) reject();
  return result;
}

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

async function prepareDevice(device, appearance) {
  if (device.state !== 'Booted') {
    const boot = await run(['xcrun', 'simctl', 'boot', device.udid], { timeoutMs: 180000 });
    if (boot.code !== 0 && !/current state: Booted/.test(boot.stderr)) return `simulator ${device.name} did not boot: ${tail(boot.stderr)}`;
  }
  const ready = await run(['xcrun', 'simctl', 'bootstatus', device.udid, '-b'], { timeoutMs: 300000 });
  if (ready.code !== 0) return `simulator ${device.name} did not finish booting: ${tail(ready.stderr)}`;
  const appearanceResult = await run(['xcrun', 'simctl', 'ui', device.udid, 'appearance', appearance ?? 'light'], { timeoutMs: 300000 });
  if (appearance !== undefined && appearanceResult.code !== 0) return `simulator ${device.name} did not set its appearance: ${tail(appearanceResult.stderr)}`;
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
  const values = driverOptions(process.argv.slice(2));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  try { validateScrollSteps(request.steps, { requireUIKit: true, hasUIKit: Boolean(values['uikit-probe-context']) }); }
  catch (error) { return notRun(error.message); }
  if (process.platform !== 'darwin') return notRun('the iOS driver needs macOS with Xcode');
  if (!values['bundle-id'] || !values.device) return notRun('the iOS driver needs --bundle-id and --device');
  const optionError = responsiveOptionsError(values, request);
  if (optionError) return notRun(optionError);
  const urlError = values['launch-url'] !== undefined && launchUrlTemplateError(values['launch-url']);
  if (urlError) return notRun(urlError);
  let launchPreparation;
  try { launchPreparation = await launchPreparationOptions(values); }
  catch (error) { return notRun(error.message); }
  const probeContext = values['uikit-probe-context'];
  if (probeContext !== undefined && !/^CTX-[A-Za-z0-9_-]{1,124}$/.test(probeContext)) return notRun('invalid --uikit-probe-context');
  const timeoutMs = Number(values['timeout-ms'] ?? 10000);
  const launchTimeoutMs = Number(values['launch-timeout-ms'] ?? 60000);
  const cache = path.resolve(values.cache ?? '.protoflow/cache/ios-driver');
  await mkdir(cache, { recursive: true });

  const { device, error } = await findDevice(values.device);
  if (error) return notRun(error);
  const bootError = await prepareDevice(device, values.appearance);
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
  const safeAreaFile = path.join(built.directory, `safe-area-${device.udid}${values.orientation ? `-${values.orientation}` : ''}.json`);
  const safeArea = JSON.parse(await readFile(safeAreaFile, 'utf8').catch(() => 'null'));
  const probeDir = probeContext ? await mkdtemp(path.join(outputDir, 'uikit-probe-')) : null;
  const probeSession = probeContext ? { nonce: randomUUID(), contextId: probeContext, sceneId: `${request.screen}.${request.state}`, screenAnchor: request.screen } : null;
  if (probeSession && (probeSession.sceneId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(probeSession.sceneId))) return notRun('invalid capture probe scene label');
  const job = {
    bundleId: values['bundle-id'], screen: request.screen, steps: request.steps, outputDir, timeoutMs, launchTimeoutMs,
    probeSafeArea: values.frame === 'safe-area' && !safeArea,
    launchArguments: ['-PROTOFLOW_SCREEN', request.screen, '-PROTOFLOW_STATE', request.state, '-PROTOFLOW_FIXTURE', JSON.stringify(request.fixture?.data ?? {}),
      '-AppleLanguages', '(en)', '-AppleLocale', 'en_US'],
    ...(probeSession && { captureProbe: { ...probeSession, outputDir: probeDir, settleBeforeCapture: true } }),
    ...(values.orientation && { orientation: values.orientation }),
    ...(values['rotate-after-steps'] && { rotateAfterSteps: values['rotate-after-steps'] }),
    ...(values['preserve-known-synthetic-inputs'] && { preserveSyntheticInputs: values['preserve-known-synthetic-inputs'].split(',') }),
    ...(values['hittable-anchors'] && { hittableAnchors: values['hittable-anchors'].split(',') }),
    ...(launchPreparation && { launchPreparation }),
    ...(values['launch-url'] && { launchUrl: launchUrl(values['launch-url'], request) })
  };
  const jobFile = path.join(outputDir, 'job.json');
  await writeFile(jobFile, `${JSON.stringify(job, null, 2)}\n`);
  const results = await mkdtemp(path.join(probeDir ?? tmpdir(), 'protoflow-ios-'));
  const bridge = probeSession ? startProbeBridge({ device: device.udid, bundleId: values['bundle-id'], outputDir: probeDir, session: probeSession, run, settleBeforeCapture: true, settlingBudgetMs: Number(values['uikit-settling-budget-ms'] ?? 6000) }) : null;
  let test;
  try {
    test = await run(['xcodebuild', 'test-without-building', '-xctestrun', built.xctestrun, '-destination', `id=${device.udid}`,
      '-only-testing:ProtoFlowDriverUITests/CaptureTests/testCapture', ...(probeSession ? ['-parallel-testing-enabled', 'NO', '-collect-test-diagnostics', 'never', '-maximum-concurrent-test-simulator-destinations', '1'] : []), '-resultBundlePath', path.join(results, 'capture.xcresult')],
    { env: { TEST_RUNNER_PROTOFLOW_DRIVER_JOB: jobFile }, timeoutMs: 600000 });
  } finally {
    await bridge?.stop();
    if (!probeDir) await rm(results, { recursive: true, force: true });
  }
  if (probeDir) await writeFile(path.join(probeDir, 'xcodebuild.log'), test.stdout + test.stderr);
  const raw = JSON.parse(await readFile(path.join(outputDir, 'raw.json'), 'utf8').catch(() => 'null'));
  if (!raw) return notRun(`the XCUITest capture produced no result (xcodebuild exit ${test.code}): ${tail(test.stdout + test.stderr)}`);
  if (raw.safeArea) await writeFile(safeAreaFile, `${JSON.stringify(raw.safeArea)}\n`);
  const screenshot = raw.status === 'PASS' ? await readFile(path.join(outputDir, raw.screenshot)) : null;
  let verifiedProbe;
  if (values.frame === 'app-window' && raw.status === 'PASS') {
    try {
      if (bridge.error) throw bridge.error;
      const before = JSON.parse(await readFile(path.join(probeDir, 'probe-before.json'), 'utf8'));
      const after = JSON.parse(await readFile(path.join(probeDir, 'probe-after.json'), 'utf8'));
      verifiedProbe = validateProbePair({ before, after, timing: raw.probeTiming, expectedBuild: bridge.expectedBuild, session: probeSession });
      raw.safeArea = measuredAppContent(verifiedProbe.capture);
      await writeFile(path.join(outputDir, 'app-window-frame.json'), JSON.stringify({ source: 'stableCurrentUIKitWindow',
        currentTreeSha256: verifiedProbe.hash, window: verifiedProbe.capture.windows[0].windowFrame,
        bounds: verifiedProbe.capture.windows[0].bounds, safeAreaInsets: verifiedProbe.capture.windows[0].safeAreaInsets, content: raw.safeArea }, null, 2));
    } catch (error) { return notRun(error.message); }
  }
  let { response, png } = iosResponse(raw, screenshot, { anchors: request.anchors, screen: request.screen, frame: values.frame === 'app-window' ? 'safe-area' : values.frame, safeArea, steps: request.steps });
  if (probeSession && response.status === 'PASS') {
    try {
      if (bridge.error) throw bridge.error;
      const before = JSON.parse(await readFile(path.join(probeDir, 'probe-before.json'), 'utf8'));
      const after = JSON.parse(await readFile(path.join(probeDir, 'probe-after.json'), 'utf8'));
      const verified = verifiedProbe ?? validateProbePair({ before, after, timing: raw.probeTiming, expectedBuild: bridge.expectedBuild, session: probeSession });
      const alignment = nativeScrollEnds(verified.capture, request.steps, raw.scrollEndObservations);
      if (alignment.length) await writeFile(path.join(probeDir, 'probe-scroll-alignment.json'), JSON.stringify({ status: 'PASS', currentTreeSha256: verified.hash, sampleIds: { before: before.sampleId, after: after.sampleId }, alignment }, null, 2));
      const area = values.frame === 'device' ? { x: 0, y: 0 } : raw.safeArea ?? safeArea;
      response = supplementUIKitFacts(response, raw.tree, verified.capture, { anchors: request.anchors, screen: request.screen,
        content: { x: area.x, y: area.y, width: response.viewport.width, height: response.viewport.height } });
      await writeFile(path.join(probeDir, 'probe-validation.json'), JSON.stringify({ status: 'PASS', currentTreeSha256: verified.hash,
        session: probeSession, actualInstalledBuild: bridge.expectedBuild, timing: raw.probeTiming }, null, 2));
    } catch (error) {
      await writeFile(path.join(probeDir, 'probe-validation-error.json'), JSON.stringify({ status: 'NOT_RUN', reason: error.message, session: probeSession }, null, 2));
      return notRun(error.message);
    }
  }
  if (png) await writeFile(path.join(outputDir, 'screen.png'), png);
  respond({ ...response, log: `device ${device.name} (${device.udid}), runtime ${device.runtime.split('.').pop()}` });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => notRun(`ios driver error: ${error.message}`));
