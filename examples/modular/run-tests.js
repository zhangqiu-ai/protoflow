import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Resolve the runner through Node so npm hoisting and production installs work.
const require = createRequire(import.meta.url);
const runner = require.resolve('@playwright/test/cli');
const child = spawn(process.execPath, [runner, 'test', '-c', fileURLToPath(new URL('playwright.config.js', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
