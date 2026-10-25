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
  const env = { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, JAVA_HOME: '/fake/jdk', HTTPS_PROXY: 'http://127.0.0.1:9', no_proxy: 'localhost', ...(print && { FAKE_LAUNCHCTL_PRINT: print }) };
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
  // The proxy travels with the service, so it reaches GitHub exactly as the installing shell did.
  for (const key of ['JAVA_HOME', 'FLUTTER_ROOT', 'HOME', 'PATH', 'HTTPS_PROXY', 'no_proxy']) assert.ok(plist.includes(`<key>${key}</key>`), key);
  assert.deepEqual(await launchctlCalls(), [['bootout', `gui/501/${label}`], ['bootstrap', 'gui/501', result.plist]]);
  const record = JSON.parse(await fs.readFile(path.join(root, '.protoflow/runner/service.json'), 'utf8'));
  assert.equal(record.label, label); assert.equal(record.tools.claude, path.join(bin, 'claude'));
  const removed = await uninstallService(root, options);
  assert.equal(removed.status, 'PASS'); await assert.rejects(fs.access(result.plist), { code: 'ENOENT' });
});

test('FAKE launchctl only: uninstall returns once the service process has exited, so a command right after finds its locks free', async t => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });
  const done = new Promise(resolve => child.on('exit', resolve));
  t.after(() => child.kill());
  const { root, options } = await fixture(t, { print: `state = running\n\tpid = ${child.pid}\n\truns = 1` });
  const started = Date.now();
  const removed = await uninstallService(root, options);
  assert.deepEqual([removed.status, removed.pid, removed.exited], ['PASS', child.pid, true], JSON.stringify(removed));
  assert.ok(Date.now() - started >= 1000, 'uninstall waited for the process');
  await done;
  const stuck = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => stuck.kill());
  const again = await fixture(t, { print: `state = running\n\tpid = ${stuck.pid}` });
  const late = await uninstallService(again.root, { ...again.options, exitTimeoutMs: 300 });
  assert.deepEqual([late.status, late.exited], ['PASS', false]); assert.match(late.warning, /still exiting/);
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
  await beat({ failingPasses: 2, lastFailure: { error: 'Get "https://api.github.com/...": EOF' } });
  assert.equal((await serviceStatus(root, options)).status, 'HEALTHY', 'two failed passes are still transient');
  await beat({ failingPasses: 3, lastFailure: { error: 'Get "https://api.github.com/...": EOF' } });
  status = await serviceStatus(root, options);
  assert.equal(status.status, 'DEGRADED'); assert.match(status.reason, /^3 consecutive passes failed: Get .*EOF$/);
  // A runner that beats every minute but has been silent for over 5 minutes stopped responding.
  const old = new Date(Date.now() - 6 * 60000).toISOString();
  await beat({ at: old, beatIntervalMs: 60000, lastEvent: { event: 'execute' } });
  status = await serviceStatus(root, options);
  assert.equal(status.status, 'STALLED'); assert.match(status.reason, /^No heartbeat for 3\d\d s; last event execute$/);
  await beat({ at: new Date(Date.now() - 4 * 60000).toISOString(), beatIntervalMs: 60000 });
  assert.equal((await serviceStatus(root, options)).status, 'HEALTHY', 'a beat within 5 minutes is healthy');
  // Runners from before the per-minute heartbeat only beat between passes and are not judged stale.
  await beat({ at: old });
  assert.equal((await serviceStatus(root, options)).status, 'HEALTHY');
  await beat({ pid: 1 });
  assert.equal((await serviceStatus(root, options)).status, 'STARTING');
  const down = await fixture(t, { print: 'gui/501/x = {\n\tstate = not running\n\tlast exit code = 1\n}' });
  status = await serviceStatus(down.root, down.options);
  assert.equal(status.status, 'DOWN'); assert.equal(status.lastExitCode, '1');
  const absent = await fixture(t);
  assert.equal((await serviceStatus(absent.root, absent.options)).status, 'NOT_INSTALLED');
});

test('FAKE launchctl only: the dashboard service runs `dashboard serve` at login and is healthy only when the page answers', async t => {
  const { installDashboardService, uninstallDashboardService, dashboardServiceStatus, DASHBOARD_LABEL } = await import('../src/runner-service.js');
  const running = 'gui/501/dev.protoflow.dashboard = {\n\tstate = running\n\tpid = 5151\n\truns = 1\n}';
  const { home, bin, options, launchctlCalls } = await fixture(t, { print: running });
  const result = await installDashboardService({ ...options, port: 7499 });
  assert.equal(result.status, 'PASS', JSON.stringify(result)); assert.equal(result.url, 'http://127.0.0.1:7499/');
  assert.equal(result.plist, path.join(home, 'Library/LaunchAgents', `${DASHBOARD_LABEL}.plist`));
  const plist = await fs.readFile(result.plist, 'utf8');
  for (const fragment of ['<string>dashboard</string>', '<string>serve</string>', '<string>--service</string>', '<string>--port</string>', '<string>7499</string>', '<key>HTTPS_PROXY</key>', `<string>${path.join(home, '.protoflow', 'dashboard.out.log')}</string>`]) assert.ok(plist.includes(fragment), fragment);
  assert.deepEqual(result.tools, { git: path.join(bin, 'git'), gh: path.join(bin, 'gh') });
  assert.deepEqual((await launchctlCalls()).at(-1), ['bootstrap', 'gui/501', result.plist]);
  assert.equal((await dashboardServiceStatus({ ...options, port: 7499, fetchImpl: async () => ({ ok: true }) })).status, 'HEALTHY');
  assert.equal((await dashboardServiceStatus({ ...options, port: 7499, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).status, 'STARTING');
  assert.equal((await uninstallDashboardService(options)).status, 'PASS');
  await assert.rejects(fs.access(result.plist), { code: 'ENOENT' });
  assert.equal((await installDashboardService({ ...options, platform: 'linux' })).status, 'NOT_RUN');
});
