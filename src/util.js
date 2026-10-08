import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, stat, realpath, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const id = prefix => `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, file);
}
export async function projectPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Expected a project-relative path');
  root = await realpath(root);
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`Path escapes project: ${relative}`);
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    let entry;
    try { entry = await lstat(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
    if (entry.isSymbolicLink()) {
      let resolved;
      try { resolved = await realpath(cursor); } catch { throw new Error(`Unresolved symlink in project path: ${relative}`); }
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Symlink escapes project: ${relative}`);
    }
  }
  return target;
}
const exec = promisify(execFile);
export async function gitInfo(root, paths = []) {
  const scoped = typeof paths === 'string' ? [paths] : paths;
  const result = { head: null, status: '', diff: '', available: false };
  try {
    result.status = (await exec('git', ['status', '--porcelain=v1', '-uall', '--', ...scoped], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout;
    result.available = true;
    result.diff = (await exec('git', ['diff', '--no-ext-diff', 'HEAD', '--', ...scoped], { cwd: root, maxBuffer: 8 * 1024 * 1024 })).stdout;
    result.head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  } catch { /* Non-Git or unborn repositories retain truthful null HEAD. */ }
  return result;
}
/** `active` serializes application-side work; `design` serializes prototype sessions so both sides can run concurrently. */
export async function withLock(root, action, name = 'active') {
  if (!['active', 'design', 'runner'].includes(name)) throw new Error(`Unknown lock: ${name}`);
  const directory = await projectPath(root, `.protoflow/${name}.lock`);
  await mkdir(path.dirname(directory), { recursive: true });
  try { await mkdir(directory); } catch (error) {
    if (error.code === 'EEXIST') {
      const owner = await readJson(path.join(directory, 'owner.json'), {});
      let alive = true;
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
      }
      if (!alive) {
        // Recovery has its own exclusive guard. Re-read under that guard so a
        // competing stale observer can never move/delete a replacement owner.
        const recovery = `${directory}.recovery`;
        try { await mkdir(recovery); } catch (failure) {
          if (failure.code === 'EEXIST') throw new Error(`Another ProtoFlow lock recovery holds .protoflow/${name}.lock.recovery; inspect its owner before manual recovery`);
          throw failure;
        }
        let recovered = false;
        try {
          await writeJson(path.join(recovery, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() });
          const current = await readJson(path.join(directory, 'owner.json'), {});
          let dead = false;
          if (Number.isSafeInteger(current.pid) && current.pid > 0) {
            try { process.kill(current.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') dead = true; }
          }
          if (dead) {
            const stale = `${directory}.stale-${randomUUID()}`;
            await rename(directory, stale);
            await rm(stale, { recursive: true });
            recovered = true;
          }
        } finally {
          // Recovery guards are never automatically reclaimed; an interrupted
          // guard requires inspection rather than risking another recovery race.
          await rm(recovery, { recursive: true });
        }
        if (recovered) return withLock(root, action, name);
      }
    }
    if (error.code === 'EEXIST') throw new Error(`Another ProtoFlow operation holds .protoflow/${name}.lock; inspect its owner before manual recovery`);
    throw error;
  }
  const token = randomUUID();
  try {
    await writeJson(path.join(directory, 'owner.json'), { token, pid: process.pid, startedAt: new Date().toISOString() });
    return await action();
  } finally {
    if ((await readJson(path.join(directory, 'owner.json'), {})).token === token) await rm(directory, { recursive: true });
  }
}
/** Project content hash; `exclude` lists project-relative directories (e.g. the prototype) owned by another version stream. */
export async function fingerprint(root, { exclude = [] } = {}) {
  root = await realpath(root);
  const files = {};
  const ignored = new Set(['.git', '.protoflow', 'node_modules', 'test-results', 'playwright-report']);
  const excluded = exclude.map(entry => entry.split(path.sep).join('/').replace(/^\.\/|\/+$/g, ''));
  const visiting = new Set();
  async function walk(relative = '') {
    const directory = relative ? await projectPath(root, relative) : root;
    const canonical = await realpath(directory);
    if (visiting.has(canonical)) throw new Error(`Project symlink cycle: ${relative}`);
    visiting.add(canonical);
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(item.name)) continue;
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (excluded.includes(name)) continue;
      const location = await projectPath(root, name);
      let entry = item;
      if (item.isSymbolicLink()) {
        const destination = await realpath(location);
        if (path.relative(root, destination).split(path.sep).some(segment => ignored.has(segment))) throw new Error(`Tracked symlink points into ignored state: ${name}`);
        files[`${name}:target`] = path.relative(root, destination);
        entry = await stat(location);
      }
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files[name] = hash(await readFile(location));
    }
    visiting.delete(canonical);
  }
  await walk();
  return { hash: hash(files), files };
}
/** A detached POSIX command owns a process group whose ID is its leader PID. */
/** Wait up to `graceMs` for a process group to finish exiting; true once it is gone. */
export async function awaitGroupExit(pid, graceMs) {
  const deadline = Date.now() + graceMs;
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}
export function processGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Unknown process-group identity; inspect before recovery');
  if (process.platform === 'win32') return true; // Cannot prove an orphaned process tree has ended.
  for (const target of [pid, -pid]) {
    try { process.kill(target, 0); return true; }
    catch (error) { if (error.code !== 'ESRCH') return true; }
  }
  return false;
}
export async function runCommand(root, command, input = null, { signal, onBeforeSpawn, onStart } = {}) {
  if (signal?.aborted) return { status: 'FAIL', aborted: true, spawned: false, exitCode: null, stdout: '', stderr: 'Stopped', processGroupActive: false };
  if (!command) return { status: 'NOT_RUN', spawned: false, exitCode: null, stdout: '', stderr: '' };
  if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some(x => typeof x !== 'string')) throw new Error('Command must contain a non-empty argv array');
  // PID persistence happens after spawn. A durable STARTING intent must exist
  // first so a crash in that unavoidable window cannot be silently retried.
  if (process.platform === 'win32') return { status: 'FAIL', spawned: false, exitCode: null, stdout: '', stderr: '', error: 'POSIX process-group supervision is required for command execution', processGroupActive: false };
  try { await onBeforeSpawn?.(); }
  catch (error) { return { status: 'FAIL', spawned: false, exitCode: null, stdout: '', stderr: '', error: error.message, processGroupActive: false }; }
  if (signal?.aborted) return { status: 'FAIL', aborted: true, spawned: false, exitCode: null, stdout: '', stderr: 'Stopped', processGroupActive: false };

  return new Promise(resolve => {
    const child = spawn(command.argv[0], command.argv.slice(1), { cwd: root, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', settled = false, timedOut = false, overflow = false;
    const stop = () => {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
    };
    const abort = () => stop();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, command.timeoutMs ?? 120000);
    const capture = key => chunk => {
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) { overflow = true; stop(); }
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', error => finish(null, error.message));
    child.once('close', code => finish(code));
    async function finish(exitCode, error = null) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await startup;
      error ??= startupError;
      let processGroupActive = Number.isSafeInteger(child.pid) && processGroupAlive(child.pid);
      if (processGroupActive) {
        error ??= 'Command exited with a surviving subprocess group; terminated the group and blocked advancement';
        stop();
        const deadline = Date.now() + 2000;
        while (processGroupAlive(child.pid) && Date.now() < deadline) await delay(10);
        processGroupActive = processGroupAlive(child.pid);
      }

      resolve({ status: exitCode === 0 && !signal?.aborted && !timedOut && !overflow && !error ? 'PASS' : 'FAIL', exitCode, aborted: signal?.aborted ?? false, stdout: stdout.slice(0, 4 * 1024 * 1024), stderr, timedOut, overflow, error, spawned: Number.isSafeInteger(child.pid), processGroupActive });
    }
    let startupError = null;
    const startup = (async () => {
      try {
        // Persist the child's identity before delivering an execution request.
        if (onStart && Number.isSafeInteger(child.pid)) await onStart(child.pid);
        if (signal?.aborted) stop();
        else child.stdin.end(input === null ? undefined : typeof input === 'string' ? input : JSON.stringify(input));
      } catch (error) {
        startupError = error.message; stop(); child.stdin.destroy();
      }
    })();
  });
}
