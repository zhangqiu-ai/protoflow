import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rename, stat, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startProbeBridge } from '../src/drivers/uikit-probe-bridge.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const session = { nonce: '11111111-1111-4111-8111-111111111111', contextId: 'CTX-bridge-proof', sceneId: 'test.screen.modal', screenAnchor: 'test.screen' };
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
async function waitFor(read, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const value = await read(); if (value) return value; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pause(10);
  }
  throw new Error('synthetic bridge test timed out');
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'protoflow-probe-bridge-')));
  const device = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bundleId = 'dev.siyue.capture';
  const containers = path.join(root, 'CoreSimulator/Devices', device, 'data/Containers');
  const app = path.join(containers, 'Bundle/Application', randomUUID(), 'Siyue.app');
  const data = path.join(containers, 'Data/Application', randomUUID());
  const channel = path.join(data, 'Library/Caches/SiyueCaptureProbe');
  const outputDir = path.join(root, 'output');
  await Promise.all([mkdir(app, { recursive: true }), mkdir(channel, { recursive: true, mode: 0o700 }), mkdir(outputDir)]);
  await chmod(channel, 0o700);
  const executable = Buffer.from('synthetic installed executable bytes');
  const javascript = Buffer.from('synthetic installed main bundle bytes');
  await Promise.all([writeFile(path.join(app, 'Siyue'), executable), writeFile(path.join(app, 'main.jsbundle'), javascript), writeFile(path.join(app, 'Info.plist'), 'synthetic plist fixture')]);
  const info = { CFBundleIdentifier: bundleId, CFBundleShortVersionString: '0.0.1', CFBundleVersion: '7', CFBundleExecutable: 'Siyue' };
  const calls = [], cleanups = [];
  const run = async argv => {
    calls.push([...argv]);
    if (argv[0] === 'xcrun' && argv[1] === 'simctl' && argv[2] === 'get_app_container') {
      assert.deepEqual(argv.slice(3, 5), [device, bundleId]);
      return { code: 0, stdout: `${argv[5] === 'app' ? app : data}\n` };
    }
    assert.equal(argv[0], '/usr/bin/plutil');
    assert.equal(argv.at(-1), path.join(app, 'Info.plist'));
    assert.ok(Object.hasOwn(info, argv[2]));
    return { code: 0, stdout: `${info[argv[2]]}\n` };
  };
  const marker = async (phase, sampleId = randomUUID()) => {
    const file = path.join(outputDir, '.marker-pending');
    await writeFile(file, JSON.stringify({ nonce: session.nonce, sampleId, phase }), { mode: 0o600 });
    await rename(file, path.join(outputDir, 'probe-request.json'));
    return sampleId;
  };
  const start = () => {
    const bridge = startProbeBridge({ device, bundleId, outputDir, session, run });
    cleanups.push(() => bridge.stop());
    return bridge;
  };
  const collector = (mode = 0o600, nativeError = null) => {
    let stopped = false, failure;
    const sent = [], ids = new Set();
    const work = (async () => {
      while (!stopped) {
        try {
          const request = await readJSON(path.join(channel, 'request.json'));
          if (!ids.has(request.sampleId)) {
            ids.add(request.sampleId);
            const sample = { schemaVersion: 1, status: nativeError ? 'ERROR' : 'OK', nonce: request.nonce, sampleId: request.sampleId,
              ...(nativeError ? { reason: nativeError } : { actualBuild: request.expectedBuild }), syntheticObservation: 'same raw bytes must be retained' };
            const bytes = Buffer.from(`${JSON.stringify(sample, null, 2)}\n`);
            const pending = path.join(channel, '.synthetic-response');
            await writeFile(pending, bytes, { mode });
            await rename(pending, path.join(channel, 'response.json'));
            sent.push({ request, bytes });
          }
        } catch (error) { if (error.code !== 'ENOENT') { failure = error; break; } }
        await pause(10);
      }
    })();
    cleanups.push(async () => { stopped = true; await work; });
    return { sent, get error() { return failure; } };
  };
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  return { root, app, data, channel, outputDir, executable, javascript, calls, start, collector, marker };
}

test('bridge uses the private fixed channel and actual installed file bytes for two fresh samples', async t => {
  const f = await fixture(t), collector = f.collector(), bridge = f.start();
  const ids = [];
  for (const phase of ['before', 'after']) {
    const sampleId = await f.marker(phase);
    ids.push(sampleId);
    const ack = await waitFor(() => readJSON(path.join(f.outputDir, `probe-ack-${phase}.json`)));
    assert.deepEqual(ack, { status: 'OK', nonce: session.nonce, sampleId, file: `probe-${phase}.json` });
    const sent = collector.sent.find(item => item.request.sampleId === sampleId);
    assert.ok(sent);
    assert.deepEqual(await readFile(path.join(f.outputDir, ack.file)), sent.bytes, 'raw native bytes are copied without rewriting');
    assert.equal((await stat(path.join(f.outputDir, ack.file))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(f.channel, 'request.json'))).mode & 0o777, 0o600);
    assert.equal(sent.request.expiresAt - sent.request.issuedAt, 10);
    assert.equal(sent.request.schemaVersion, 1);
    for (const [key, value] of Object.entries(session)) assert.equal(sent.request[key], value);
    assert.equal(sent.request.expectedBuild.executableSha256, digest(f.executable));
    assert.equal(sent.request.expectedBuild.javascriptSha256, digest(f.javascript));
  }
  const ledger = await readJSON(path.join(f.outputDir, 'probe-bridge.json'));
  assert.deepEqual(ledger.session, session);
  assert.equal(ledger.receipts.length, 2);
  for (const receipt of ledger.receipts) {
    const sent = collector.sent.find(item => item.request.sampleId === receipt.sampleId);
    assert.ok(ids.includes(receipt.sampleId));
    assert.equal(receipt.sha256, digest(sent.bytes));
    assert.equal(receipt.appDataContainer, f.data);
    assert.equal(receipt.actualInstalledBuild.executableSha256, digest(f.executable));
  }
  assert.equal(bridge.expectedBuild.javascriptSha256, digest(f.javascript));
  assert.equal(bridge.error, null);
  assert.equal(collector.error, undefined);
  assert.equal(f.calls.filter(argv => argv[0] === 'xcrun' && argv.at(-1) === 'app').length, 2, 'resolve current installed App for every sample');
  assert.equal(f.calls.filter(argv => argv[0] === 'xcrun' && argv.at(-1) === 'data').length, 2, 'resolve current data container for every sample');
});

test('a public cache channel is rejected before any request is written', async t => {
  const f = await fixture(t);
  await chmod(f.channel, 0o755);
  const bridge = f.start();
  await f.marker('before');
  const ack = await waitFor(() => readJSON(path.join(f.outputDir, 'probe-ack-before.json')));
  assert.equal(ack.status, 'ERROR');
  assert.ok(bridge.error);
  await assert.rejects(stat(path.join(f.channel, 'request.json')), { code: 'ENOENT' });
});

test('a public native response fails closed rather than becoming a successful observation', async t => {
  const f = await fixture(t);
  f.collector(0o644);
  const bridge = f.start();
  await f.marker('before');
  const ack = await waitFor(() => readJSON(path.join(f.outputDir, 'probe-ack-before.json')));
  assert.equal(ack.status, 'ERROR');
  assert.ok(bridge.error);
  await assert.rejects(stat(path.join(f.outputDir, 'probe-before.json')), { code: 'ENOENT' });
});

test('invalid marker phases cannot choose paths outside the fixed mailbox artifacts', async t => {
  const f = await fixture(t), bridge = f.start();
  await f.marker('../outside');
  await waitFor(() => bridge.error);
  assert.match(bridge.error.message, /marker|phase/);
  await assert.rejects(stat(path.join(f.root, 'outside')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.channel, 'request.json')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 0, 'invalid markers do not resolve or read an App container');
});

test('changing installed bundle bytes between samples prevents a second successful capture', async t => {
  const f = await fixture(t);
  f.collector();
  const bridge = f.start();
  await f.marker('before');
  assert.equal((await waitFor(() => readJSON(path.join(f.outputDir, 'probe-ack-before.json')))).status, 'OK');
  await writeFile(path.join(f.app, 'main.jsbundle'), 'different installed JavaScript bytes');
  await f.marker('after');
  const after = await waitFor(() => readJSON(path.join(f.outputDir, 'probe-ack-after.json')));
  assert.equal(after.status, 'ERROR');
  assert.match(bridge.error.message, /installed build changed/);
  await assert.rejects(stat(path.join(f.outputDir, 'probe-after.json')), { code: 'ENOENT' });
});


test('a matching native ERROR preserves its raw evidence and receipt while acknowledgement fails closed', async t => {
  const f = await fixture(t), collector = f.collector(0o600, 'TREE_LIMIT'), bridge = f.start();
  const sampleId = await f.marker('before');
  const ack = await waitFor(() => readJSON(path.join(f.outputDir, 'probe-ack-before.json')));
  assert.equal(ack.status, 'ERROR');
  assert.equal(ack.nonce, session.nonce);
  assert.equal(ack.sampleId, sampleId);
  assert.match(ack.reason, /TREE_LIMIT/);
  assert.match(bridge.error.message, /TREE_LIMIT/);
  const sent = collector.sent.find(item => item.request.sampleId === sampleId);
  assert.ok(sent);
  const preserved = await readFile(path.join(f.outputDir, 'probe-before.json'));
  assert.deepEqual(preserved, sent.bytes, 'retain the native failure bytes without rewriting them into a success');
  assert.equal(JSON.parse(preserved).status, 'ERROR');
  assert.equal(JSON.parse(preserved).reason, 'TREE_LIMIT');
  assert.equal((await stat(path.join(f.outputDir, 'probe-before.json'))).mode & 0o777, 0o600);
  const ledger = await readJSON(path.join(f.outputDir, 'probe-bridge.json'));
  assert.deepEqual(ledger.session, session);
  assert.equal(ledger.receipts.length, 1);
  assert.equal(ledger.receipts[0].sampleId, sampleId);
  assert.equal(ledger.receipts[0].nonce, session.nonce);
  assert.equal(ledger.receipts[0].phase, 'before');
  assert.equal(ledger.receipts[0].sha256, digest(sent.bytes));
});
