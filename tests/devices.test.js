import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { acquireDevices, commandDevices, describeHolder } from '../src/devices.js';
import { hash } from '../src/util.js';

async function lockDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'protoflow-devices-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const until = async (check, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('commands name their devices through the drivers, xcodebuild destinations, adb serials and an explicit list', () => {
  assert.deepEqual(commandDevices({ argv: ['node', '../../scripts/ios-driver.js', '--bundle-id', 'dev.x', '--device', 'ProtoFlow iPhone 17', '--app', 'X.app'] }), ['ProtoFlow iPhone 17']);
  assert.deepEqual(commandDevices({ argv: ['node', 'scripts/android-driver.js', '--package', 'dev.x', '--avd=ProtoFlow_Pixel'] }), ['ProtoFlow_Pixel']);
  assert.deepEqual(commandDevices({ argv: ['xcodebuild', 'test', '-destination', 'platform=iOS Simulator,name=ProtoFlow iPhone 17'] }), ['ProtoFlow iPhone 17']);
  assert.deepEqual(commandDevices({ argv: ['xcodebuild', 'test-without-building', '-destination', 'id=29E6F823-0000-4000-8000-000000000000'] }), ['29E6F823-0000-4000-8000-000000000000']);
  assert.deepEqual(commandDevices({ argv: ['xcodebuild', 'build', '-destination', 'generic/platform=iOS Simulator'] }), [], 'a generic destination drives no device');
  assert.deepEqual(commandDevices({ argv: ['/sdk/platform-tools/adb', '-s', 'emulator-5554', 'shell', 'true'] }), ['emulator-5554']);
  assert.deepEqual(commandDevices({ argv: ['sort', '-s', 'file'] }), [], '-s names a serial only for adb');
  assert.deepEqual(commandDevices({ argv: ['npm', 'run', 'test:ios'], devices: ['ProtoFlow iPhone 17'] }), ['ProtoFlow iPhone 17']);
  assert.deepEqual(commandDevices({ argv: ['xcodebuild', '-destination', 'name=B', '--device', 'A'], devices: ['B'] }), ['A', 'B']);
  assert.deepEqual([commandDevices(null), commandDevices({ adapter: 'acceptance' })], [[], []]);
  assert.equal(describeHolder({ project: 'siyue', target: 'ios', manifestId: 'git-1', phase: 'visual' }), 'siyue/ios (git-1, visual)');
});

test('a device is held by one verification at a time, the next in line gets it, and an aborted wait leaves the queue', async t => {
  const dir = await lockDir(t);
  const releaseA = await acquireDevices(['ProtoFlow iPhone 17'], { project: 'siyue', target: 'ios', phase: 'visual' }, { dir, pollMs: 10 });
  const waits = [], order = [];
  const b = acquireDevices(['ProtoFlow iPhone 17'], { project: 'mobile', target: 'ios' }, { dir, pollMs: 10, onWait: wait => waits.push(wait) }).then(release => { order.push('mobile'); return release; });
  await until(() => waits.length === 1);
  assert.equal(waits[0].device, 'ProtoFlow iPhone 17');
  assert.deepEqual([waits[0].holder.project, waits[0].holder.target, waits[0].holder.phase, waits[0].holder.pid], ['siyue', 'ios', 'visual', process.pid]);
  // The holder releases and asks again at once: the waiter that came first is served first.
  await releaseA();
  const again = acquireDevices(['ProtoFlow iPhone 17'], { project: 'siyue', target: 'ios' }, { dir, pollMs: 10 }).then(release => { order.push('siyue'); return release; });
  const releaseB = await b;
  assert.deepEqual(order, ['mobile']);
  await releaseB();
  await (await again)();
  assert.deepEqual(order, ['mobile', 'siyue']);
  // A waiter whose run is stopped throws and takes its ticket out of the queue.
  const hold = await acquireDevices(['ProtoFlow iPhone 17'], { project: 'siyue' }, { dir, pollMs: 10 });
  const controller = new AbortController();
  const stopped = acquireDevices(['ProtoFlow iPhone 17'], { project: 'mobile' }, { dir, pollMs: 10, signal: controller.signal, onWait: () => controller.abort() });
  await assert.rejects(stopped, error => error.code === 'RUNNER_STOPPED');
  const folder = path.join(dir, hash('ProtoFlow iPhone 17').slice(0, 24));
  assert.deepEqual(await readdir(path.join(folder, 'queue')), []);
  await hold();
  assert.deepEqual((await readdir(folder)).filter(name => name !== 'queue'), [], 'the lock is gone after release');
});

test('several devices are taken in one order, so two verifications that need both never wait on each other', async t => {
  const dir = await lockDir(t);
  const first = await acquireDevices(['B', 'A'], { project: 'one' }, { dir, pollMs: 10 });
  let second = null;
  const pending = acquireDevices(['A', 'B'], { project: 'two' }, { dir, pollMs: 10 }).then(release => { second = release; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(second, null);
  await first(); await pending;
  await second();
});

test('a lock or ticket left by a process that is gone does not block; a holder in another process does', async t => {
  const dir = await lockDir(t);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  const folder = path.join(dir, hash('Pixel').slice(0, 24));
  await mkdir(path.join(folder, 'queue'), { recursive: true });
  await writeFile(path.join(folder, 'lock'), JSON.stringify({ project: 'crashed', pid: deadPid, host: os.hostname(), token: 'old' }));
  await writeFile(path.join(folder, 'queue', '000000000000001-1-dead.json'), JSON.stringify({ project: 'crashed', pid: deadPid, host: os.hostname(), token: '000000000000001-1-dead' }));
  const waits = [];
  await (await acquireDevices(['Pixel'], { project: 'mobile' }, { dir, pollMs: 10, onWait: wait => waits.push(wait) }))();
  assert.deepEqual(waits, []);
  // Another project's runner, in its own process, holds the simulator until it is told to let go.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const { acquireDevices } = await import(${JSON.stringify(new URL('../src/devices.js', import.meta.url).href)});
    const release = await acquireDevices(['ProtoFlow iPhone 17'], { project: 'siyue', target: 'ios', manifestId: 'git-abc', phase: 'visual' }, { dir: ${JSON.stringify(dir)}, pollMs: 10 });
    process.stdout.write('held\\n');
    process.stdin.once('data', async () => { await release(); process.exit(0); });
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise(resolve => holder.stdout.once('data', resolve));
  const seen = [];
  const mine = acquireDevices(['ProtoFlow iPhone 17'], { project: 'mobile', target: 'ios' }, { dir, pollMs: 10, onWait: wait => seen.push(wait) });
  await until(() => seen.length === 1);
  assert.deepEqual([seen[0].holder.project, seen[0].holder.manifestId, seen[0].holder.pid], ['siyue', 'git-abc', holder.pid]);
  holder.stdin.write('go\n');
  await (await mine)();
});
