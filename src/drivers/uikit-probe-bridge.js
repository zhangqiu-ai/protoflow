import { constants } from 'node:fs';
import { readFile, writeFile, open, rename, lstat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const requireValue = (condition, reason) => { if (!condition) throw new Error(`UIKit bridge: ${reason}`); };
async function privateRead(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    requireValue(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && !(info.mode & 0o077) && info.size <= limit, 'unowned or oversized channel file');
    const data = await handle.readFile();
    requireValue(data.length <= limit && data.length === info.size, 'channel file changed or exceeded size limit');
    return data;
  } finally { await handle.close(); }
}

/** Fixed owned-cache bridge. Resolves only the selected simulator/bundle's current app container per sample. */
export function startProbeBridge({ device, bundleId, outputDir, session, run }) {
  let stopped = false, failure = null, expectedBuild = null;
  const seen = new Set(), receipts = [];
  const checkedRun = async argv => {
    const result = await run(argv, { timeoutMs: 10000 });
    requireValue(result.code === 0 && !result.timedOut, `${argv[0]} failed resolving current capture app`);
    return result.stdout.trim();
  };
  const container = async kind => {
    const value = await checkedRun(['xcrun', 'simctl', 'get_app_container', device, bundleId, kind]);
    const canonical = await realpath(value);
    requireValue(canonical === value && canonical.includes(`/CoreSimulator/Devices/${device}/data/Containers/`) && (kind !== 'app' || canonical.endsWith('.app')), 'unexpected app container path');
    return canonical;
  };
  const identity = async () => {
    const app = await container('app');
    const plist = async key => checkedRun(['/usr/bin/plutil', '-extract', key, 'raw', '-o', '-', path.join(app, 'Info.plist')]);
    const [identifier, shortVersion, buildVersion, executable] = await Promise.all(['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion', 'CFBundleExecutable'].map(plist));
    requireValue(identifier === bundleId && /^[A-Za-z0-9._-]+$/.test(executable) && !['.', '..'].includes(executable), 'installed app identity mismatch');
    const result = { bundleIdentifier: identifier, shortVersion, buildVersion, reactNativeVersion: '0.86.3',
      executableSha256: digest(await readFile(path.join(app, executable))), javascriptSha256: digest(await readFile(path.join(app, 'main.jsbundle'))) };
    if (expectedBuild) requireValue(JSON.stringify(result) === JSON.stringify(expectedBuild), 'installed build changed between samples');
    expectedBuild = result;
    return result;
  };
  const serve = async marker => {
    requireValue(marker.nonce === session.nonce && UUID.test(marker.sampleId) && ['before', 'after'].includes(marker.phase), 'unexpected request marker');
    requireValue(!seen.has(marker.sampleId) && seen.size < 2, 'sample replay or session limit');
    seen.add(marker.sampleId);
    const expected = await identity();
    const current = await container('data');
    const channel = path.join(current, 'Library/Caches/SiyueCaptureProbe');
    const info = await lstat(channel);
    requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077) && await realpath(channel) === channel, 'capture channel is not owned/private');
    const issuedAt = Date.now() / 1000;
    const request = { schemaVersion: 1, ...session, sampleId: marker.sampleId, issuedAt, expiresAt: issuedAt + 10, expectedBuild: expected };
    const pending = path.join(channel, `.request-${marker.sampleId}`);
    await writeFile(pending, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    await rename(pending, path.join(channel, 'request.json'));
    const deadline = Date.now() + 8000;
    let bytes, sample;
    while (!stopped && Date.now() < deadline) {
      try {
        const candidate = await privateRead(path.join(channel, 'response.json'), 2 * 1024 * 1024);
        const parsed = JSON.parse(candidate);
        if (parsed.nonce === session.nonce && parsed.sampleId === marker.sampleId) { bytes = candidate; sample = parsed; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(50);
    }
    requireValue(sample, 'native response timeout');
    const file = `probe-${marker.phase}.json`;
    await writeFile(path.join(outputDir, file), bytes, { mode: 0o600, flag: 'wx' });
    const receipt = { phase: marker.phase, sampleId: marker.sampleId, nonce: session.nonce, copiedAt: Date.now() / 1000,
      sha256: digest(bytes), appDataContainer: current, actualInstalledBuild: expected };
    receipts.push(receipt);
    await writeFile(path.join(outputDir, 'probe-bridge.json'), JSON.stringify({ session, receipts }, null, 2), { mode: 0o600 });
    requireValue(sample.status === 'OK', sample.reason ?? 'native collector failed');
    return { status: 'OK', nonce: session.nonce, sampleId: marker.sampleId, file };
  };
  const work = (async () => {
    while (!stopped) {
      let marker;
      try { marker = JSON.parse(await readFile(path.join(outputDir, 'probe-request.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') { failure = error; break; } }
      if (marker && !seen.has(marker.sampleId)) {
        let result;
        try { result = await serve(marker); }
        catch (error) { failure = error; result = { status: 'ERROR', nonce: session.nonce, sampleId: marker.sampleId, reason: error.message }; }
        if (!['before', 'after'].includes(marker.phase)) { failure ??= new Error('UIKit bridge: invalid marker phase'); break; }
        const pending = path.join(outputDir, `.probe-ack-${randomUUID()}`);
        await writeFile(pending, JSON.stringify(result), { mode: 0o600 });
        await rename(pending, path.join(outputDir, `probe-ack-${marker.phase}.json`));
        if (failure) break;
      }
      await delay(50);
    }
  })().catch(error => { failure = error; });
  return { stop: async () => { stopped = true; await work; }, get error() { return failure; }, get expectedBuild() { return expectedBuild; } };
}
