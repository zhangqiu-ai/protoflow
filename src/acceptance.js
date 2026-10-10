import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, processGroupAlive, projectPath } from './util.js';

const exec = promisify(execFile);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const statuses = new Set(['PASS', 'FAIL', 'NOT_RUN']);
const outputLimit = 4 * 1024 * 1024;

async function processInfo(pid) {
  const { stdout } = await exec('ps', ['-o', 'ppid=,pgid=,lstart=', '-p', String(pid)], { maxBuffer: 4096, timeout: 2000 });
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout);
  if (!match) throw new Error(`Process ${pid} identity is unavailable`);
  return { parent: Number(match[1]), group: Number(match[2]), birth: match[3] };
}
async function ownedProcess(pid, parent) {
  const info = await processInfo(pid);
  if (info.group !== pid) throw new Error('Acceptance child must own its POSIX process group');
  let ancestor = info.parent;
  for (let count = 0; count < 64 && ancestor > 1; count++) {
    if (ancestor === parent) return info;
    ancestor = (await processInfo(ancestor)).parent;
  }
  throw new Error(`Acceptance child ${pid} is not owned by adapter ${parent}`);
}

/** Bidirectional transport is local to this protocol; ordinary argv commands still use util.runCommand. */
async function runProtocol(root, command, request, { signal, onBeforeSpawn, onStart, onMessage }) {
  const unspawned = error => ({ status: 'FAIL', spawned: false, exitCode: null, stdout: '', stderr: '', error, processGroupActive: false });
  if (signal?.aborted) return { ...unspawned('Stopped'), aborted: true };
  if (process.platform === 'win32') return unspawned('POSIX process-group supervision is required for acceptance');
  if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some(value => typeof value !== 'string' || !value)) throw new Error('Command must contain a non-empty argv array');
  try { await onBeforeSpawn?.(); } catch (error) { return unspawned(error.message); }
  if (signal?.aborted) return { ...unspawned('Stopped'), aborted: true };
  return new Promise(resolve => {
    const child = spawn(command.argv[0], command.argv.slice(1), { cwd: root, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', buffer = '', messages = Promise.resolve(), settled = false;
    let timedOut = false, overflow = false, failure = null, exitTimer;
    const stop = () => { if (Number.isSafeInteger(child.pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Independently checked at completion. */ } } };
    const abort = () => stop();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, command.timeoutMs ?? 120000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk; buffer += chunk;
      if (stdout.length + stderr.length > outputLimit) { overflow = true; stop(); }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        messages = messages.then(async () => {
          await startup;
          if (failure) return;
          try {
            const response = await onMessage(JSON.parse(line));
            if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(response)}\n`);
          } catch (error) { failure = error.message; stop(); }
        });
      }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; if (stdout.length + stderr.length > outputLimit) { overflow = true; stop(); } });
    child.stdin.on('error', () => {});
    child.once('error', error => finish(null, error.message));
    child.once('close', (code, exitSignal) => finish(code, null, exitSignal));
    child.once('exit', (code, exitSignal) => {
      // A detached application may inherit these pipes. Do not wait forever for its EOF before cleaning it.
      if (!settled) exitTimer = setTimeout(() => finish(code, 'Adapter exited before its output streams closed', exitSignal), 1000);
    });
    async function finish(exitCode, error = null, exitSignal = null) {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(exitTimer); signal?.removeEventListener('abort', abort);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      await startup; await messages;
      error ??= failure;
      if (buffer.trim()) error ??= 'Acceptance adapter ended with an incomplete JSONL message';
      let processGroupActive = Number.isSafeInteger(child.pid) && processGroupAlive(child.pid);
      if (processGroupActive) {
        error ??= 'Adapter exited with a surviving subprocess group'; stop();
        const deadline = Date.now() + 2000;
        while (processGroupAlive(child.pid) && Date.now() < deadline) await delay(10);
        processGroupActive = processGroupAlive(child.pid);
      }
      resolve({ status: exitCode === 0 && !exitSignal && !signal?.aborted && !timedOut && !overflow && !error ? 'PASS' : 'FAIL', exitCode, signal: exitSignal, aborted: signal?.aborted ?? false, stdout: stdout.slice(0, outputLimit), stderr: stderr.slice(0, outputLimit), timedOut, overflow, error, spawned: Number.isSafeInteger(child.pid), processGroupActive });
    }
    const startup = (async () => {
      try {
        if (Number.isSafeInteger(child.pid)) await onStart?.(child.pid);
        if (signal?.aborted) stop(); else child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) { failure = error.message; stop(); child.stdin.destroy(); }
    })();
  });
}

/** Generic project adapter with durable acknowledgements and independently verified owned process groups. */
export async function runAcceptanceAdapter(root, config, phase, payload, { signal, onBeforeSpawn, onStart, onFinish } = {}) {
  const command = config.adapters?.acceptance?.command;
  if (!command) return { status: 'NOT_RUN', reason: 'No project acceptance adapter configured', artifacts: [], stdout: '', stderr: '' };
  if (!['functional', 'visual'].includes(phase)) throw new Error('Unsupported acceptance phase');
  const request = { ...payload, schemaVersion: 1, protocol: 'protoflow.acceptance/1', requestId: randomUUID(), phase, projectRoot: root, options: config.adapters.acceptance.options ?? {} };
  const children = new Map(); let adapterPid = null, report = null, lastSequence = 0, protocolFailure = null, outerStarted = false;
  const childPhase = id => `${phase}-adapter-${id}`;
  const childResult = (child, status, error = null) => ({ status, spawned: child.pid !== null, processGroupActive: child.pid === null || processGroupAlive(child.pid), error });
  const operation = await runProtocol(root, command, request, {
    signal,
    onBeforeSpawn: async () => { outerStarted = true; await onBeforeSpawn?.(`${phase}-adapter`); },
    onStart: async pid => { adapterPid = pid; await onStart?.(`${phase}-adapter`, pid); },
    onMessage: async message => {
      try {
        if (!Number.isSafeInteger(message.seq) || message.seq !== lastSequence + 1 || report) throw new Error('Invalid acceptance message order');
        lastSequence = message.seq;
        if (message.type === 'process-starting') {
          if (!validId(message.id) || children.has(message.id) || children.size >= 100) throw new Error('Invalid or duplicate acceptance child id');
          children.set(message.id, { id: message.id, pid: null, status: 'STARTING', completed: false });
          await onBeforeSpawn?.(childPhase(message.id));
        } else if (message.type === 'process-started') {
          const child = children.get(message.id);
          if (!child || child.status !== 'STARTING' || !Number.isSafeInteger(message.pid) || message.pid <= 0 || message.pgid !== message.pid || message.pid === adapterPid) throw new Error('Invalid acceptance process identity');
          const info = await ownedProcess(message.pid, adapterPid);
          child.pid = message.pid; child.birth = info.birth; child.status = 'RUNNING';
          await onStart?.(childPhase(message.id), message.pid);
        } else if (message.type === 'process-not-started') {
          const child = children.get(message.id);
          if (!child || child.status !== 'STARTING' || child.pid !== null) throw new Error('Invalid unspawned acceptance process');
          await onFinish?.(childPhase(message.id), null, { status: 'FAIL', spawned: false, processGroupActive: false, error: message.error ?? 'OS rejected process spawn' });
          child.completed = true; child.status = 'FAIL';
        } else if (message.type === 'process-finished') {
          const child = children.get(message.id);
          if (!child || child.status !== 'RUNNING' || !statuses.has(message.status)) throw new Error('Invalid acceptance process completion');
          const result = childResult(child, message.status);
          await onFinish?.(childPhase(message.id), child.pid, result);
          if (result.processGroupActive) throw new Error('Acceptance child reports completion with an active process group');
          child.completed = true; child.status = message.status;
        } else if (message.type === 'result') {
          if (message.schemaVersion !== 1 || message.requestId !== request.requestId || message.phase !== phase || !statuses.has(message.status)) throw new Error('Acceptance result does not match its request');
          if ([...children.values()].some(child => !child.completed)) throw new Error('Acceptance result contains unfinished child processes');
          if (message.status === 'PASS') {
            if ([...children.values()].some(child => child.status !== 'PASS')) throw new Error('PASS requires successful child lifecycles');
            const surface = message.applicationSurface;
            if (!surface || !validId(surface.kind) || ![...children.values()].some(child => child.pid === surface.processId && child.completed)) throw new Error('PASS requires a real supervised application surface');
            if (phase === 'functional' && (!message.functional || message.functional.exitCode !== 0 || message.functional.status !== 'PASS')) throw new Error('Functional PASS requires successful project test evidence');
          }
          report = message;
        } else throw new Error('Unsupported acceptance message type');
        return { ack: message.seq, ok: true };
      } catch (error) { protocolFailure = error; throw error; }
    }
  });
  let persistenceFailure;
  try { if (outerStarted) await onFinish?.(`${phase}-adapter`, adapterPid, operation); } catch (error) { persistenceFailure = error; }
  for (const child of children.values()) {
    if (child.completed || child.pid === null) continue;
    if (processGroupAlive(child.pid)) {
      let identityChanged = false;
      try { identityChanged = (await processInfo(child.pid)).birth !== child.birth; } catch { /* Leader may have exited while its group survives. */ }
      if (!identityChanged) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Independently checked below. */ } }
      const deadline = Date.now() + 2000;
      while (processGroupAlive(child.pid) && Date.now() < deadline) await delay(10);
    }
    const result = childResult(child, 'FAIL', protocolFailure?.message ?? operation.error ?? 'Acceptance adapter stopped before child completion');
    try { await onFinish?.(childPhase(child.id), child.pid, result); } catch (error) { persistenceFailure ??= error; }
    if (!result.processGroupActive) { child.completed = true; child.status = 'FAIL'; }
  }
  const unknown = [...children.values()].some(child => child.pid === null && !child.completed);
  const active = operation.processGroupActive || [...children.values()].some(child => child.pid !== null && !child.completed && processGroupAlive(child.pid));
  if (unknown || active) {
    const error = new Error(unknown ? 'Acceptance child launch has unknown PID; inspect possible subprocesses before recovery' : 'Acceptance process group remains active; stop it before verification or repair');
    error.code = unknown ? 'PROCESS_START_UNKNOWN' : 'PROCESS_GROUP_ACTIVE'; error.phase = `${phase}-adapter`; error.result = operation; throw error;
  }
  if (signal?.aborted) throw new Error('STOPPED: acceptance adapter was interrupted');
  if (persistenceFailure) throw persistenceFailure;
  const status = operation.status === 'PASS' && !protocolFailure && report ? report.status : 'FAIL';
  return { ...report, status, stdout: report?.functional?.stdout ?? '', stderr: report?.functional?.stderr ?? operation.stderr, exitCode: report?.functional?.exitCode ?? operation.exitCode, error: protocolFailure?.message ?? operation.error ?? (!report ? 'Acceptance adapter returned no result' : null), adapter: { exitCode: operation.exitCode, signal: operation.signal, status: operation.status, processes: [...children.values()].map(({ birth, ...child }) => child) } };
}

export const sceneEvidenceHash = scene => hash(scene);

/** Resolve file targets before rejecting live/frozen prototype sources, including relative URLs and symlinks. */
export async function acceptanceApplicationUrl(root, config, value) {
  if (typeof value !== 'string' || !value) throw new Error('Scene requires applicationUrl');
  root = await realpath(root);
  const url = new URL(value, pathToFileURL(`${root}${path.sep}`));
  if (url.protocol !== 'file:') return value;
  const canonical = await realpath(fileURLToPath(url));
  await projectPath(root, path.relative(root, canonical));
  const prototype = await realpath(await projectPath(root, config.prototypeDir));
  const relative = path.relative(root, canonical).split(path.sep).join('/');
  if (canonical === prototype || canonical.startsWith(`${prototype}${path.sep}`) || relative === '.protoflow/versions' || relative.startsWith('.protoflow/versions/')) throw new Error('Project application capture cannot load prototype HTML');
  const resolved = pathToFileURL(canonical); resolved.search = url.search; resolved.hash = url.hash;
  return resolved.href;
}
