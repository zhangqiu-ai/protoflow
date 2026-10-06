import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(root, '../../bin/protoflow.js');
const exec = promisify(execFile);
const env = { ...process.env, PROTOFLOW_MODULAR_PORT: '4319', PROTOFLOW_MODULAR_URL: 'http://127.0.0.1:4319' };
// Conflicting color environment variables can add Node warnings ahead of JSON errors.
delete env.NO_COLOR;
delete env.FORCE_COLOR;
const server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverErrors = '';
server.stderr.on('data', (chunk) => { serverErrors += chunk; });
const stop = () => { if (server.exitCode === null && !server.killed) server.kill('SIGTERM'); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
async function command(args) {
  const result = await exec(process.execPath, [cli, ...args, '--project', root], { cwd: root, env, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Modular preview did not start within 10 seconds')), 10000);
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Modular preview exited ${code}: ${serverErrors}`)); });
    server.stdout.on('data', (chunk) => { if (String(chunk).includes('http://127.0.0.1:4319')) { clearTimeout(timer); resolve(); } });
  });
  const checkpoint = await command(['checkpoint', '--summary', 'Modular example verification']);
  const context = await command(['context', '--manifest', checkpoint.id, '--spec', 'specs/modular.md']);
  const verification = await command(['verify', '--manifest', checkpoint.id]);
  console.log(JSON.stringify({ checkpointId: checkpoint.id, contextId: context.id, verification }, null, 2));
} catch (error) {
  if (error.stdout?.trim()) process.stderr.write(error.stdout);
  if (error.stderr?.trim()) process.stderr.write(error.stderr);
  if (!error.stdout && !error.stderr) console.error(error.message);
  process.exitCode = typeof error.code === 'number' ? error.code : 1;
} finally {
  stop();
}
