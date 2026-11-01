import { constants } from 'node:fs';
import { readFile, writeFile, open, rename, lstat, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalProbeValue, hashProbeCapture, validateProbeCapture } from './uikit-probe.js';

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
export function startProbeBridge({ device, bundleId, outputDir, session, run, settleBeforeCapture = false }) {
  let stopped = false, failure = null, expectedBuild = null;
  requireValue(typeof settleBeforeCapture === 'boolean', 'invalid settling opt-in');
  const seen = new Set(), receipts = [];
  const settlingSamples = new Set(), settlingMarkers = new Set(), settlingReceipts = [];
  let settlingDeadline = null, settlingComplete = false;
  const remaining = () => {
    requireValue(!stopped && settlingDeadline !== null, 'settling stopped');
    const value = settlingDeadline - performance.now();
    requireValue(value > 0, 'settling deadline exceeded');
    return value;
  };
  // Bound every preflight IO by the same monotonic deadline. Late read results cannot continue the protocol.
  const budget = async operation => {
    if (settlingDeadline === null) return operation();
    const milliseconds = remaining();
    let timer;
    try {
      const value = await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('UIKit bridge: settling deadline exceeded')), milliseconds);
      })]);
      remaining();
      return value;
    } finally { clearTimeout(timer); }
  };
  const checkedRun = async argv => {
    const result = await budget(() => run(argv, { timeoutMs: settlingDeadline === null ? 10000 : Math.max(1, Math.floor(remaining())) }));
    requireValue(result.code === 0 && !result.timedOut, `${argv[0]} failed resolving current capture app`);
    return result.stdout.trim();
  };
  const container = async kind => {
    const value = await checkedRun(['xcrun', 'simctl', 'get_app_container', device, bundleId, kind]);
    const canonical = await budget(() => realpath(value));
    requireValue(canonical === value && canonical.includes(`/CoreSimulator/Devices/${device}/data/Containers/`) && (kind !== 'app' || canonical.endsWith('.app')), 'unexpected app container path');
    return canonical;
  };
  const identity = async () => {
    const app = await container('app');
    const plist = async key => checkedRun(['/usr/bin/plutil', '-extract', key, 'raw', '-o', '-', path.join(app, 'Info.plist')]);
    const [identifier, shortVersion, buildVersion, executable] = await Promise.all(['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion', 'CFBundleExecutable'].map(plist));
    requireValue(identifier === bundleId && /^[A-Za-z0-9._-]+$/.test(executable) && !['.', '..'].includes(executable), 'installed app identity mismatch');
    const result = { bundleIdentifier: identifier, shortVersion, buildVersion, reactNativeVersion: '0.86.3',
      executableSha256: digest(await budget(() => readFile(path.join(app, executable)))), javascriptSha256: digest(await budget(() => readFile(path.join(app, 'main.jsbundle')))) };
    if (expectedBuild) requireValue(JSON.stringify(result) === JSON.stringify(expectedBuild), 'installed build changed between samples');
    expectedBuild = result;
    return result;
  };
  const serve = async (marker, settlingIndex = null) => {
    const settling = settlingIndex !== null;
    requireValue(marker.nonce === session.nonce && UUID.test(marker.sampleId) && (settling ? marker.phase === 'settling' : ['before', 'after'].includes(marker.phase)), 'unexpected request marker');
    requireValue(!seen.has(marker.sampleId) && !settlingSamples.has(marker.sampleId) && !settlingMarkers.has(marker.sampleId), 'sample replay or session limit');
    requireValue(settling ? settlingSamples.size < 8 : seen.size < 2, 'sample replay or session limit');
    requireValue(settling || !settleBeforeCapture || settlingComplete, 'settling must complete before the measured pair');
    (settling ? settlingSamples : seen).add(marker.sampleId);
    const expected = await identity();
    const current = await container('data');
    const channel = path.join(current, 'Library/Caches/SiyueCaptureProbe');
    const info = await budget(() => lstat(channel));
    requireValue(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077) && await budget(() => realpath(channel)) === channel, 'capture channel is not owned/private');
    const issuedAt = Date.now() / 1000;
    const request = { schemaVersion: 1, ...session, sampleId: marker.sampleId, issuedAt, expiresAt: issuedAt + (settling ? Math.min(10, remaining() / 1000) : 10), expectedBuild: expected };
    const pending = path.join(channel, `.request-${marker.sampleId}`);
    await budget(() => writeFile(pending, JSON.stringify(request), { mode: 0o600, flag: 'wx' }));
    await budget(() => rename(pending, path.join(channel, 'request.json')));
    const deadline = Date.now() + (settling ? Math.min(8000, remaining()) : 8000);
    let bytes, sample;
    while (!stopped && Date.now() < deadline) {
      try {
        const candidate = await budget(() => privateRead(path.join(channel, 'response.json'), 2 * 1024 * 1024));
        const parsed = JSON.parse(candidate);
        if (parsed.nonce === session.nonce && parsed.sampleId === marker.sampleId) { bytes = candidate; sample = parsed; break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await budget(() => delay(settling ? Math.min(50, remaining()) : 50));
    }
    requireValue(sample, 'native response timeout');
    const file = settling ? `probe-settling-${settlingIndex}-${marker.sampleId}.json` : `probe-${marker.phase}.json`;
    await budget(() => writeFile(path.join(outputDir, file), bytes, { mode: 0o600, flag: 'wx' }));
    const receipt = { phase: marker.phase, sampleId: marker.sampleId, nonce: session.nonce, copiedAt: Date.now() / 1000,
      sha256: digest(bytes), appDataContainer: current, actualInstalledBuild: expected };
    if (settling) {
      settlingReceipts.push({ ...receipt, file });
      await budget(() => writeFile(path.join(outputDir, 'probe-settling.json'), JSON.stringify({ session, status: 'RUNNING', settlingReceipts }, null, 2), { mode: 0o600 }));
    } else {
      receipts.push(receipt);
      await writeFile(path.join(outputDir, 'probe-bridge.json'), JSON.stringify({ session, receipts }, null, 2), { mode: 0o600 });
    }
    requireValue(sample.status === 'OK', sample.reason ?? 'native collector failed');
    if (settling) {
      remaining();
      requireValue(sample.schemaVersion === 1 && sample.mainThread === true, 'invalid settling sample');
      requireValue(canonicalProbeValue(sample.correlation) === canonicalProbeValue(session) && canonicalProbeValue(sample.actualBuild) === canonicalProbeValue(expected), 'settling sample provenance mismatch');
      requireValue([sample.startedAt, sample.finishedAt].every(value => typeof value === 'number' && Number.isFinite(value)) && sample.startedAt <= sample.finishedAt && sample.startedAt >= issuedAt - 1 && sample.finishedAt <= Date.now() / 1000 + 1, 'invalid settling sample time');
      validateProbeCapture(sample.capture, session.screenAnchor);
      return sample;
    }
    return { status: 'OK', nonce: session.nonce, sampleId: marker.sampleId, file };
  };
  const settle = async marker => {
    requireValue(settleBeforeCapture && marker.nonce === session.nonce && UUID.test(marker.sampleId) && marker.phase === 'settle', 'unexpected settling marker');
    requireValue(!settlingMarkers.size && !seen.size && !settlingSamples.has(marker.sampleId), 'settling phase replay or order');
    settlingMarkers.add(marker.sampleId);
    settlingDeadline = performance.now() + 6000;
    const startedAt = Date.now() / 1000;
    let previousHash = null, firstFinishedAt = 0, firstObservedAt = 0, lastFinishedAt = 0, consecutive = 0, quietSpanMs = 0, observedQuietSpanMs = 0;
    try {
      for (let index = 0; index < 8; index++) {
        remaining();
        const sample = await serve({ nonce: session.nonce, sampleId: randomUUID(), phase: 'settling' }, index);
        requireValue(sample.startedAt >= lastFinishedAt, 'overlapping settling samples');
        const captureHash = hashProbeCapture(sample.capture);
        settlingReceipts.at(-1).captureHash = captureHash;
        if (captureHash === previousHash) consecutive++;
        else { previousHash = captureHash; consecutive = 1; firstFinishedAt = sample.finishedAt; firstObservedAt = performance.now(); }
        lastFinishedAt = sample.finishedAt;
        quietSpanMs = (sample.startedAt - firstFinishedAt) * 1000;
        observedQuietSpanMs = performance.now() - firstObservedAt;
        if (consecutive >= 3 && quietSpanMs >= 1500 && observedQuietSpanMs >= 1500) {
          await budget(() => writeFile(path.join(outputDir, 'probe-settling.json'), JSON.stringify({ session, status: 'READY', startedAt,
            finishedAt: Date.now() / 1000, maxSamples: 8, budgetMs: 6000, minimumQuietSpanMs: 1500,
            consecutive, quietSpanMs, observedQuietSpanMs, settlingReceipts }, null, 2), { mode: 0o600 }));
          remaining();
          settlingComplete = true;
          return { status: 'OK', nonce: session.nonce, sampleId: marker.sampleId, file: 'probe-settling.json' };
        }
        if (index < 7) await budget(() => delay(Math.min(250, remaining())));
      }
      throw new Error('UIKit bridge: settling sample limit exceeded without a quiet tree');
    } catch (error) {
      await writeFile(path.join(outputDir, 'probe-settling.json'), JSON.stringify({ session, status: 'NOT_RUN', startedAt,
        finishedAt: Date.now() / 1000, reason: error.message, maxSamples: 8, budgetMs: 6000, minimumQuietSpanMs: 1500,
        consecutive, quietSpanMs, observedQuietSpanMs, settlingReceipts }, null, 2), { mode: 0o600 });
      throw error;
    } finally { settlingDeadline = null; }
  };
  const work = (async () => {
    while (!stopped) {
      let marker;
      try { marker = JSON.parse(await readFile(path.join(outputDir, 'probe-request.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') { failure = error; break; } }
      if (marker && !seen.has(marker.sampleId) && !settlingMarkers.has(marker.sampleId)) {
        let result;
        try { result = marker.phase === 'settle' ? await settle(marker) : await serve(marker); }
        catch (error) { failure = error; result = { status: 'ERROR', nonce: session.nonce, sampleId: marker.sampleId, reason: error.message }; }
        if (!['before', 'after', ...(settleBeforeCapture ? ['settle'] : [])].includes(marker.phase)) { failure ??= new Error('UIKit bridge: invalid marker phase'); break; }
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
