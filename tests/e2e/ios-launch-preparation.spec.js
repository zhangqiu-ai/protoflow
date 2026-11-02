import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile), token = 'a'.repeat(64), bundleId = 'dev.protoflow.synthetic';
let root, binary;
test.skip(process.platform !== 'darwin', 'Foundation channel runtime needs the macOS Swift toolchain; no Simulator is used');

test.beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'protoflow-launch-channel-e2e-')));
  await chmod(root, 0o700);
  const source = await readFile(new URL('../../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
  const helper = source.split('// BEGIN HOST LAUNCH PREPARATION:')[1].split('\n').slice(1).join('\n').split('// END HOST LAUNCH PREPARATION')[0];
  // Execute the actual Foundation-only helper, not a JavaScript reimplementation of its protocol.
  const main = `\nlet args = CommandLine.arguments\nlet channel = NativeLaunchPreparation(directory: args[1], token: args[2], timeoutMs: 15000)\nfor _ in 0..<Int(args[4])! {\n let result = preparedLaunchURL(channel, original: URL(string: args[3])!, bundleId: "${bundleId}")\n let safe: [String: Any] = ["url": result.url?.absoluteString as Any? ?? NSNull(), "reason": result.reason as Any? ?? NSNull(), "observation": result.observation]\n print(String(data: try JSONSerialization.data(withJSONObject: safe, options: [.sortedKeys]), encoding: .utf8)!)\n fflush(stdout)\n}\n`;
  const file = path.join(root, 'main.swift'); binary = path.join(root, 'channel');
  await writeFile(file, 'import Foundation\nimport Darwin\nimport CoreFoundation\n' + helper + main);
  const result = await exec('xcrun', ['--sdk', 'macosx', 'swiftc', file, '-o', binary], { timeout: 60000 });
  await writeFile(path.join(root, 'compile.log'), result.stdout + result.stderr);
});
test.afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function channel() {
  const directory = await mkdtemp(path.join(root, 'private-')); await chmod(directory, 0o700); return directory;
}
async function start(directory, count = 1) {
  const child = spawn(binary, [directory, token, 'example://screen?fixture=base', String(count)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', ended = false;
  child.stdout.setEncoding('utf8').on('data', value => stdout += value);
  child.stderr.setEncoding('utf8').on('data', value => stderr += value);
  const result = new Promise(resolve => child.once('close', code => { ended = true; resolve({ code, stderr, rows: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  return { child, result, ended: () => ended, close: async () => { clearTimeout(timer); if (!ended) child.kill('SIGTERM'); await result; } };
}
async function request(directory, previous) {
  let value;
  await expect.poll(async () => {
    try { value = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8')); }
    catch { return false; }
    return value.requestId !== previous;
  }, { intervals: [10, 25, 50], timeout: 5000 }).toBe(true);
  expect(value).toMatchObject({ schemaVersion: 1, token, bundleId });
  expect(value.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  return value;
}
async function respond(directory, request, overrides = {}) {
  const temporary = path.join(directory, 'response-new.json');
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, token, requestId: request.requestId, status: 'ready', launchUrl: 'example://screen?fixture=fresh', ...overrides }), { mode: 0o600 });
  await rename(temporary, path.join(directory, 'response.json'));
}
function safeObservation(row) {
  expect(row.observation.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(row.observation)).not.toContain(token);
  expect(JSON.stringify(row.observation)).not.toMatch(/example:|launchUrl|fixture=/);
}

test('the actual Swift channel waits for the host and accepts only the fresh URL with safe observations', async () => {
  const directory = await channel(), running = await start(directory);
  try {
    const message = await request(directory); expect(running.ended()).toBe(false);
    const publishedAt = Date.now() / 1000; await respond(directory, message);
    const result = await running.result; expect(result.code).toBe(0); expect(result.rows).toHaveLength(1);
    const row = result.rows[0]; expect(row.url).toBe('example://screen?fixture=fresh'); expect(row.reason).toBeNull();
    expect(row.observation.requestedAt).toBeLessThanOrEqual(publishedAt);
    expect(row.observation.responseAcceptedAt).toBeGreaterThanOrEqual(publishedAt); safeObservation(row);
  } finally { await running.close(); }
});

test('stale tokens and request IDs do not authorize the current open', async () => {
  const directory = await channel(), running = await start(directory);
  try {
    const message = await request(directory);
    await respond(directory, message, { token: 'b'.repeat(64), launchUrl: 'example://screen?fixture=wrong-token' });
    await new Promise(resolve => setTimeout(resolve, 100)); expect(running.ended()).toBe(false);
    await respond(directory, message, { requestId: '00000000-0000-4000-8000-000000000000', launchUrl: 'example://screen?fixture=old-open' });
    await new Promise(resolve => setTimeout(resolve, 100)); expect(running.ended()).toBe(false);
    await respond(directory, message); const result = await running.result;
    expect(result.rows[0].url).toBe('example://screen?fixture=fresh'); safeObservation(result.rows[0]);
  } finally { await running.close(); }
});

test('a repeated cold open produces a new request ID and cannot reuse the previous response', async () => {
  const directory = await channel(), running = await start(directory, 2);
  try {
    const first = await request(directory); await respond(directory, first);
    const second = await request(directory, first.requestId); expect(second.requestId).not.toBe(first.requestId);
    expect(running.ended()).toBe(false); await respond(directory, second, { launchUrl: 'example://screen?fixture=second' });
    const result = await running.result; expect(result.rows.map(row => row.url)).toEqual(['example://screen?fixture=fresh', 'example://screen?fixture=second']);
    expect(new Set(result.rows.map(row => row.observation.requestId)).size).toBe(2);
  } finally { await running.close(); }
});

test('host errors, boolean schema and changed origin fail closed without disclosing host details', async () => {
  const cases = [
    [{ status: 'error', reason: 'untrusted-private-detail' }, 'launch_preparation_failed'],
    [{ schemaVersion: true }, 'launch_preparation_invalid_response'],
    ...['other://screen', 'example://other', 'example://screen:80', 'example://user:password@screen'].map(launchUrl => [{ launchUrl }, 'launch_preparation_invalid_url']),
  ];
  for (const [overrides, reason] of cases) {
    const directory = await channel(), running = await start(directory);
    try {
      await respond(directory, await request(directory), overrides);
      const result = await running.result; expect(result.rows[0]).toMatchObject({ url: null, reason });
      expect(JSON.stringify(result.rows[0])).not.toContain('untrusted-private-detail'); safeObservation(result.rows[0]);
    } finally { await running.close(); }
  }
});

test('the Swift side rechecks private directory and response file permissions, symlinks and size', async () => {
  const publicDirectory = await channel(); await chmod(publicDirectory, 0o755);
  let running = await start(publicDirectory);
  try { expect((await running.result).rows[0]).toMatchObject({ url: null, reason: 'launch_preparation_io_failed' }); }
  finally { await running.close(); }
  for (const kind of ['symlink', 'public', 'large']) {
    const directory = await channel(); running = await start(directory);
    try {
      const message = await request(directory), response = path.join(directory, 'response.json');
      if (kind === 'symlink') {
        const target = path.join(root, 'unrelated-' + message.requestId); await writeFile(target, '{}', { mode: 0o600 }); await symlink(target, response);
      } else if (kind === 'public') { await writeFile(response, '{}', { mode: 0o644 }); }
      else { await writeFile(response, 'x'.repeat(65537), { mode: 0o600 }); }
      expect((await running.result).rows[0]).toMatchObject({ url: null, reason: 'launch_preparation_io_failed' });
    } finally { await running.close(); }
  }
});

test('an absent host response times out without returning the original URL', async () => {
  const directory = await channel(), running = await start(directory), started = performance.now();
  try {
    await request(directory); const result = await running.result;
    expect(result.rows[0]).toMatchObject({ url: null, reason: 'launch_preparation_timed_out' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(14000); safeObservation(result.rows[0]);
  } finally { await running.close(); }
});

test('the UIKit call resolves after warm launch and returns before open on preparation failure', async () => {
  const source = await readFile(new URL('../../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
  const launch = source.slice(source.indexOf('if let launchUrl = job.launchUrl {'), source.indexOf('guard app.wait(for:'));
  expect(launch.indexOf('if job.captureProbe != nil { app.launch() }')).toBeLessThan(launch.indexOf('preparedLaunchURL('));
  expect(launch.indexOf('preparedLaunchURL(')).toBeLessThan(launch.indexOf('app.open(urlToOpen)'));
  expect(launch).toMatch(/guard let preparedURL = prepared.url else \{[\s\S]*"status": "NOT_RUN"[\s\S]*return\s*\}/);
});


// Protocol scheduling only: execute the real capture fragment with Foundation shims.
// This does not exercise XCTest/UIKit or establish that a real application is stable.
test('probe accessibility preparation runs once before the unchanged measured bracket and stays outside raw capture', async ({}, testInfo) => {
  const source = await readFile(new URL('../../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
  const declaration = source.match(/        var accessibilityPreparation: \[String: Any\]\? = nil/);
  expect(declaration, 'the opt-in preparation must have separate optional metadata').not.toBeNull();
  const observation = source.match(/            if let accessibilityPreparation \{ result\["accessibilityPreparation"\] = accessibilityPreparation \}/);
  expect(observation, 'metadata must survive the existing raw result reset and early returns').not.toBeNull();
  const segment = source.slice(source.indexOf('        Thread.sleep(forTimeInterval: 0.3)'),
    source.indexOf('        // A state that ends while typing'));
  const file = path.join(root, 'preparation-order.swift'), binary = path.join(root, 'preparation-order');
  const shim = `import Foundation
var events: [String] = []
let mode = CommandLine.arguments[1]
struct Probe { let settleBeforeCapture: Bool? }
struct Job { let captureProbe: Probe?; let hittableAnchors: [String]? = nil }
struct Target { let exists = false; let isEnabled = false; let isHittable = false }
struct Keyboards { var firstMatch: Target { Target() } }
final class App {
 var calls = 0
 var keyboards: Keyboards { Keyboards() }
 func snapshot() throws -> Int {
  calls += 1; events.append("snapshot")
  if mode == "preparation-error" && calls == 1 { throw NSError(domain: "synthetic-preparation", code: 1) }
  return calls
 }
}
struct Shot { var pngRepresentation: Data { Data() } }
struct XCUIScreen { static var main: XCUIScreen { XCUIScreen() }; func screenshot() -> Shot { events.append("screenshot"); return Shot() } }
func element(_ app: App, _ anchor: String) -> Target { Target() }
func serialize(_ snapshot: Int) -> [String: Any] { ["snapshotOrdinal": snapshot, "label": "synthetic-measured-only"] }
func failure(_ app: App, _ output: URL, _ reason: String) -> [String: Any] { ["status": "NOT_RUN", "reason": reason] }
func requestProbe(_ probe: Probe, phase: String) -> String? { events.append(phase); return nil }
let app = App()
let output = URL(fileURLWithPath: CommandLine.arguments[2])
func capture() throws {
 let job = Job(captureProbe: mode == "default" ? nil : Probe(settleBeforeCapture: nil))
 var result: [String: Any] = [:]
 var responsive: [String: Any]? = nil
${declaration[0]}
 defer {
${observation[0]}
  try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: output.appendingPathComponent("raw.json"))
 }
${segment}
}
var thrown = false
 do { try capture() } catch { thrown = true }
print(String(data: try JSONSerialization.data(withJSONObject: ["events": events, "thrown": thrown], options: [.sortedKeys]), encoding: .utf8)!)
`;
  await writeFile(file, shim);
  await writeFile(testInfo.outputPath('actual-capture-fragment.swift'), shim);
  await testInfo.attach('actual-capture-fragment.swift', { body: shim, contentType: 'text/plain' });
  const compile = await exec('xcrun', ['--sdk', 'macosx', 'swiftc', file, '-o', binary], { timeout: 60000 });
  await writeFile(testInfo.outputPath('foundation-compile.log'), compile.stdout + compile.stderr);
  await testInfo.attach('foundation-compile.log', { body: compile.stdout + compile.stderr, contentType: 'text/plain' });
  const observations = [];
  for (const mode of ['probe', 'default', 'preparation-error']) {
    const directory = await channel(), result = await exec(binary, [mode, directory]);
    const actual = JSON.parse(result.stdout), raw = JSON.parse(await readFile(path.join(directory, 'raw.json'), 'utf8'));
    observations.push({ mode, actual, raw });
    if (mode === 'preparation-error') {
      expect(actual.thrown).toBe(true);
      expect(actual.events).not.toContain('before'); expect(actual.events).not.toContain('after');
      expect(raw.probeTiming).toBeUndefined(); expect(raw.accessibilityPreparation).toBeUndefined();
      continue;
    }
    expect(actual.thrown).toBe(false);
    expect(actual.events).toEqual(mode === 'probe' ? ['snapshot', 'before', 'snapshot', 'screenshot', 'after'] : ['snapshot', 'screenshot']);
    expect(raw.tree.snapshotOrdinal).toBe(mode === 'probe' ? 2 : 1);
    if (mode === 'default') { expect(raw.accessibilityPreparation).toBeUndefined(); expect(raw.probeTiming).toBeUndefined(); continue; }
    expect(Object.keys(raw.accessibilityPreparation).sort()).toEqual(['count', 'finishedAt', 'method', 'startedAt']);
    expect(raw.accessibilityPreparation).toMatchObject({ method: 'XCUIApplication.snapshot', count: 1 });
    expect(raw.accessibilityPreparation.startedAt).toBeLessThanOrEqual(raw.accessibilityPreparation.finishedAt);
    expect(raw.accessibilityPreparation.finishedAt).toBeLessThanOrEqual(raw.probeTiming.axStartedAt);
    expect(raw.probeTiming.axStartedAt).toBeLessThanOrEqual(raw.probeTiming.axFinishedAt);
    expect(raw.probeTiming.axFinishedAt).toBeLessThanOrEqual(raw.probeTiming.screenshotStartedAt);
    expect(raw.probeTiming.screenshotStartedAt).toBeLessThanOrEqual(raw.probeTiming.screenshotFinishedAt);
  }
  await writeFile(testInfo.outputPath('protocol-observations.json'), JSON.stringify(observations, null, 2));
  await testInfo.attach('protocol-observations.json', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
});
