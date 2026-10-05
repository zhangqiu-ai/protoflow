import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, stat, realpath, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

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
export async function withLock(root, action) {
  const directory = await projectPath(root, '.protoflow/active.lock');
  await mkdir(path.dirname(directory), { recursive: true });
  try { await mkdir(directory); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another ProtoFlow operation holds .protoflow/active.lock; inspect its owner before manual recovery');
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
export async function fingerprint(root) {
  root = await realpath(root);
  const files = {};
  const ignored = new Set(['.git', '.protoflow', 'node_modules', 'test-results', 'playwright-report']);
  const visiting = new Set();
  async function walk(relative = '') {
    const directory = relative ? await projectPath(root, relative) : root;
    const canonical = await realpath(directory);
    if (visiting.has(canonical)) throw new Error(`Project symlink cycle: ${relative}`);
    visiting.add(canonical);
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(item.name)) continue;
      const name = relative ? `${relative}/${item.name}` : item.name;
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
export async function runCommand(root, command, input = null) {
  if (!command) return { status: 'NOT_RUN', exitCode: null, stdout: '', stderr: '' };
  if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some(x => typeof x !== 'string')) throw new Error('Command must contain a non-empty argv array');
  return new Promise(resolve => {
    const child = spawn(command.argv[0], command.argv.slice(1), { cwd: root, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', settled = false, timedOut = false, overflow = false;
    const stop = () => {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
    };
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
    function finish(exitCode, error = null) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ status: exitCode === 0 && !timedOut && !overflow && !error ? 'PASS' : 'FAIL', exitCode, stdout: stdout.slice(0, 4 * 1024 * 1024), stderr, timedOut, overflow, error });
    }
    child.stdin.end(input === null ? undefined : typeof input === 'string' ? input : JSON.stringify(input));
  });
}
