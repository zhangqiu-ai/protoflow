import { spawn } from 'node:child_process';

// This group leader receives argv only after the supervisor persists its PID.
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { argv } = JSON.parse(input);
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || !value)) throw new Error('Expected explicit command argv');
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', shell: false, detached: false });
  child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = Number.isInteger(code) ? code : 1; });
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
