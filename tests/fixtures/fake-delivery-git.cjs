#!/usr/bin/env node
// Test transport only: no production path recognizes these fixture variables.
const fs = require('node:fs');
const { spawnSync, execFileSync } = require('node:child_process');
const fixture = JSON.parse(fs.readFileSync(process.env.FAKE_DELIVERY_GIT, 'utf8'));
const args = process.argv.slice(2);
const calls = fs.existsSync(fixture.log) ? JSON.parse(fs.readFileSync(fixture.log, 'utf8')) : [];
calls.push({ args: [...args], gitEnvironment: Object.keys(process.env).filter(key => key.startsWith('GIT_')) });
fs.writeFileSync(fixture.log, JSON.stringify(calls));
let command = 0;
while (args[command] === '-c' || args[command] === '--no-replace-objects') command += args[command] === '-c' ? 2 : 1;
if (['ls-remote', 'fetch', 'push'].includes(args[command])) {
  let position = command + 1;
  while (args[position]?.startsWith('-')) position++;
  let destination = args[position];
  if (!destination.startsWith('/') && !destination.includes(':')) {
    destination = execFileSync(fixture.realGit, ['remote', 'get-url', ...(args[command] === 'push' ? ['--push'] : []), destination], { encoding: 'utf8' }).trim();
  }
  if (fixture.urls[destination]) args[position] = fixture.urls[destination];
  else if (!destination.startsWith('/')) { console.error('Unmapped fixture transport: ' + destination); process.exit(2); }
}
const result = spawnSync(fixture.realGit, args, { stdio: 'inherit', env: process.env });
if (result.error) { console.error(result.error.message); process.exit(2); }
process.exit(result.status ?? 2);
