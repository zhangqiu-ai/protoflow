import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchAgentPlist, requiredTools, installService, uninstallService, serviceStatus, serviceLabel } from '../src/runner-service.js';

async function fixture(t, { tools = ['git', 'gh', 'claude', 'codex'], print = null } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'protoflow-service-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), home = path.join(base, 'home'), bin = path.join(base, 'bin'), calls = path.join(base, 'launchctl-calls.jsonl');
  for (const dir of [root, home, bin]) await fs.mkdir(dir, { recursive: true });
  for (const tool of tools) await fs.writeFile(path.join(bin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // FAKE launchctl: records its argv; `print` answers with the given text or fails like an unknown service.
  await fs.writeFile(path.join(bin, 'launchctl'), `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'print') { const text = process.env.FAKE_LAUNCHCTL_PRINT; if (!text) { console.error('Could not find service'); process.exit(113); } console.log(text); }
`, { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, JAVA_HOME: '/fake/jdk', ...(print && { FAKE_LAUNCHCTL_PRINT: print }) };
  const options = { home, env, launchctl: path.join(bin, 'launchctl'), platform: 'darwin', uid: 501 };
  const config = { schemaVersion: 2, runner: { delivery: { branch: 'protoflow/delivery', baseBranch: 'main' } }, issues: { enabled: true }, policy: { executor: { primary: 'claude', fallback: 'codex' } }, adapters: { planner: { command: { argv: ['node', '/x/scripts/claude-adapter.js'] } } } };
  const launchctlCalls = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, home, bin, env, options, config, launchctlCalls };
}

test('the LaunchAgent starts at login, restarts on exit, escapes its values and logs in the project', () => {
  const plist = launchAgentPlist({ label: 'dev.protoflow.runner.abc', programArguments: ['/n/node', '/e/cli.js', 'runner', 'start', '--service', '--project', '/p/a&b'], workingDirectory: '/p/a&b', environment: { PATH: '/x', HOME: '/h' }, stdout: '/p/o.log', stderr: '/p/e.log' });
  for (const fragment of ['<key>RunAtLoad</key>\n  <true/>', '<key>KeepAlive</key>\n  <true/>', '<key>ThrottleInterval</key>\n  <integer>60</integer>', '<string>--service</string>', '<string>/p/a&amp;b</string>', '<key>HOME</key>\n    <string>/h</string>', '<key>StandardErrorPath</key>\n  <string>/p/e.log</string>']) assert.ok(plist.includes(fragment), fragment);
  assert.ok(!plist.includes('/p/a&b'));
});

test('required tools follow the configured flow', () => {
  assert.deepEqual(requiredTools({}), ['git', 'codex']);
  assert.deepEqual(requiredTools({ runner: { delivery: {} }, adapters: { independentReview: { provider: 'claude', command: { argv: ['node', 'claude-review-adapter.js'] } }, codex: { command: { argv: ['node', 'codex-adapter.js'] } } } }), ['git', 'gh', 'claude', 'codex']);
  assert.deepEqual(requiredTools({ issues: { enabled: true }, policy: { executor: { primary: 'claude' } } }), ['git', 'gh', 'claude']);
});

test('FAKE launchctl only: install resolves every tool to an absolute path, writes the agent and bootstraps it', async t => {
  const { root, home, bin, options, config, launchctlCalls } = await fixture(t);
  const result = await installService(root, config, { ...options, extraEnv: { FLUTTER_ROOT: '/fake/flutter' } });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const label = await serviceLabel(root);
  assert.equal(result.label, label); assert.match(label, /^dev\.protoflow\.runner\.[0-9a-f]{12}$/);
  assert.equal(result.plist, path.join(home, 'Library/LaunchAgents', `${label}.plist`));
  assert.deepEqual(result.tools, Object.fromEntries(['git', 'gh', 'claude', 'codex'].map(tool => [tool, path.join(bin, tool)])));
  const plist = await fs.readFile(result.plist, 'utf8');
  assert.ok(plist.includes(`<string>${await fs.realpath(process.execPath)}</string>`)); assert.ok(plist.includes('<string>--service</string>'));
  for (const key of ['JAVA_HOME', 'FLUTTER_ROOT', 'HOME', 'PATH']) assert.ok(plist.includes(`<key>${key}</key>`), key);
  assert.deepEqual(await launchctlCalls(), [['bootout', `gui/501/${label}`], ['bootstrap', 'gui/501', result.plist]]);
  const record = JSON.parse(await fs.readFile(path.join(root, '.protoflow/runner/service.json'), 'utf8'));
  assert.equal(record.label, label); assert.equal(record.tools.claude, path.join(bin, 'claude'));
  const removed = await uninstallService(root, options);
  assert.equal(removed.status, 'PASS'); await assert.rejects(fs.access(result.plist), { code: 'ENOENT' });
});

test('FAKE launchctl only: install refuses missing tools, a running foreground runner and other systems', async t => {
  const missing = await fixture(t, { tools: ['git', 'gh'] });
  const result = await installService(missing.root, missing.config, { ...missing.options, env: { PATH: missing.bin }, commonBins: [] });
  assert.equal(result.status, 'BLOCKED'); assert.match(result.reason, /^Not found on PATH or : claude, codex;/);
  assert.deepEqual(await missing.launchctlCalls(), [], 'nothing is loaded when a tool is missing');
  const { root, options, config } = await fixture(t);
  await fs.mkdir(path.join(root, '.protoflow/runner.lock'), { recursive: true });
  await fs.writeFile(path.join(root, '.protoflow/runner.lock/owner.json'), JSON.stringify({ pid: process.ppid }));
  assert.match((await installService(root, config, options)).reason, /already running for this project; stop it/);
  assert.equal((await installService(root, config, { ...options, platform: 'linux' })).status, 'NOT_RUN');
});

test('FAKE launchctl only: status is healthy only when launchd runs the pid that heartbeats in service mode', async t => {
  const running = 'gui/501/dev.protoflow.runner.x = {\n\tstate = running\n\truns = 3\n\tpid = 4242\n\tlast exit code = 0\n}';
  const { root, options } = await fixture(t, { print: running });
  await fs.mkdir(path.join(root, '.protoflow/runner'), { recursive: true });
  const beat = extra => fs.writeFile(path.join(root, '.protoflow/runner/heartbeat.json'), JSON.stringify({ pid: 4242, service: true, at: new Date().toISOString(), ...extra }));
  await beat();
  let status = await serviceStatus(root, options);
  assert.equal(status.status, 'HEALTHY'); assert.equal(status.pid, 4242); assert.equal(status.runs, 3); assert.ok(status.beatAgeSeconds <= 1);
  await beat({ pid: 1 });
  assert.equal((await serviceStatus(root, options)).status, 'STARTING');
  const down = await fixture(t, { print: 'gui/501/x = {\n\tstate = not running\n\tlast exit code = 1\n}' });
  status = await serviceStatus(down.root, down.options);
  assert.equal(status.status, 'DOWN'); assert.equal(status.lastExitCode, '1');
  const absent = await fixture(t);
  assert.equal((await serviceStatus(absent.root, absent.options)).status, 'NOT_INSTALLED');
});
