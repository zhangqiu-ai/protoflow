import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, projectPath, readJson, writeJson, runCommand } from './util.js';
import { HEARTBEAT } from './runner.js';

/**
 * The runner as a resident macOS service (launchd LaunchAgent): it starts at login, restarts when it dies, and runs
 * `runner start --service`, which keeps polling instead of exiting on blocks. Tools are resolved to absolute paths at
 * install time and checked first, so the service never depends on the PATH of whichever shell happened to start it.
 */
const CLI = fileURLToPath(new URL('../bin/protoflow.js', import.meta.url));
const COMMON_BINS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
// Toolchain locations and the network proxy: without the proxy a service could not reach GitHub where the shell could.
const PROXY_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy'];
const PASSED_ENV = ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'CLAUDE_CODE_OAUTH_TOKEN_FILE', 'LANG', ...PROXY_ENV];
/** Consecutive passes without the source or GitHub before status reports DEGRADED. */
export const DEGRADED_AFTER = 3;

export async function serviceLabel(root) { return `dev.protoflow.runner.${hash(await fs.realpath(root)).slice(0, 12)}`; }

/** Executables the configured flow runs: git always; gh for delivery and issues; claude and codex as adapters use them. */
export function requiredTools(config) {
  const argv = Object.values(config.adapters ?? {}).flatMap(adapter => adapter?.command?.argv ?? []).join(' ');
  const executor = config.policy?.executor ?? {};
  const providers = new Set([executor.primary ?? 'codex', executor.fallback, ...Object.values(executor.routes ?? {})].filter(Boolean));
  return [
    'git',
    ...(config.runner?.delivery || config.issues?.enabled ? ['gh'] : []),
    ...(/claude-(?:exec-|review-)?adapter\.js/.test(argv) || config.adapters?.independentReview?.provider === 'claude' || providers.has('claude') ? ['claude'] : []),
    ...(/codex-(?:review-)?adapter\.js/.test(argv) || providers.has('codex') ? ['codex'] : [])
  ];
}

async function resolveTool(name, dirs) {
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try { await fs.access(candidate, constants.X_OK); if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** LaunchAgent: run at load, restart whenever it exits (throttled), logs in the project's private runner directory. */
export function launchAgentPlist({ label, programArguments, workingDirectory, environment, stdout, stderr, throttleSeconds = 60 }) {
  const strings = items => items.map(item => `    <string>${xml(item)}</string>`).join('\n');
  const env = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(programArguments)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttleSeconds}</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderr)}</string>
</dict>
</plist>
`;
}

function context(root, { home = os.homedir(), env = process.env, launchctl = 'launchctl', platform = process.platform, uid = process.getuid?.(), commonBins = COMMON_BINS } = {}) {
  return { root, home, env, launchctl, platform, uid, commonBins, domain: `gui/${uid}` };
}
const launch = (ctx, args) => runCommand(ctx.root, { argv: [ctx.launchctl, ...args], timeoutMs: 30000 }, null, { env: ctx.env });

/**
 * Write and (re)load one LaunchAgent that runs this engine's CLI with `args`: the tools it needs are resolved to absolute
 * paths first (BLOCKED when one is missing), and the agent gets the install-time node, PATH, toolchain and proxy variables.
 */
async function loadAgent(ctx, { label, toolNames, args, workingDirectory, logs, logName, extraEnv = {} }) {
  const searchPath = [...new Set([...(ctx.env.PATH ?? '').split(path.delimiter), ...ctx.commonBins])].filter(dir => path.isAbsolute(dir));
  const tools = {}, missing = [];
  for (const name of toolNames) { const found = await resolveTool(name, searchPath); if (found) tools[name] = found; else missing.push(name); }
  if (missing.length) return { status: 'BLOCKED', reason: `Not found on PATH or ${ctx.commonBins.join(', ')}: ${missing.join(', ')}; install them or start the install from a shell that has them` };
  const node = await fs.realpath(process.execPath);
  // The service PATH: the resolved tools first, then the installing shell's PATH (toolchains such as Flutter).
  const servicePath = [...new Set([path.dirname(node), ...Object.values(tools).map(tool => path.dirname(tool)), ...searchPath])].join(path.delimiter);
  const environment = { PATH: servicePath, HOME: ctx.home, ...Object.fromEntries(PASSED_ENV.filter(key => ctx.env[key]).map(key => [key, ctx.env[key]])), ...extraEnv };
  await fs.mkdir(logs, { recursive: true });
  const plist = path.join(ctx.home, 'Library/LaunchAgents', `${label}.plist`);
  const content = launchAgentPlist({ label, programArguments: [node, CLI, ...args], workingDirectory, environment, stdout: path.join(logs, `${logName}.out.log`), stderr: path.join(logs, `${logName}.err.log`) });
  await fs.mkdir(path.dirname(plist), { recursive: true });
  await fs.writeFile(plist, content);
  await launch(ctx, ['bootout', `${ctx.domain}/${label}`]);
  const loaded = await launch(ctx, ['bootstrap', ctx.domain, plist]);
  if (loaded.status !== 'PASS') return { status: 'FAIL', label, plist, reason: `launchctl bootstrap failed: ${(loaded.stderr || loaded.error || '').trim()}` };
  return { status: 'PASS', label, plist, tools, environment, node };
}

/** launchd's state, pid, runs and last exit code for one agent; null when it is not loaded. */
async function agentState(ctx, label) {
  const printed = await launch(ctx, ['print', `${ctx.domain}/${label}`]);
  if (printed.status !== 'PASS') return null;
  const field = name => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(printed.stdout)?.[1]?.trim() ?? null;
  return { state: field('state'), pid: Number(field('pid')) || null, runs: Number(field('runs')) || null, lastExitCode: field('last exit code') };
}

export async function installService(root, config, options = {}) {
  const ctx = context(root, options);
  if (ctx.platform !== 'darwin') return { status: 'NOT_RUN', reason: 'runner service supports macOS launchd only; on other systems run `protoflow runner start --service` under the system supervisor' };
  const label = await serviceLabel(root), realRoot = await fs.realpath(root);
  // A foreground runner holds the runner lock; the service would only fail on it and restart forever.
  const owner = await readJson(await projectPath(root, '.protoflow/runner.lock/owner.json'), null);
  if (owner?.pid && owner.pid !== process.pid) {
    let alive = true; try { process.kill(owner.pid, 0); } catch { alive = false; }
    if (alive) return { status: 'BLOCKED', reason: `A runner (pid ${owner.pid}) is already running for this project; stop it, then install the service` };
  }
  const logs = path.join(realRoot, '.protoflow/runner');
  const agent = await loadAgent(ctx, { label, toolNames: requiredTools(config), args: ['runner', 'start', '--service', '--project', realRoot], workingDirectory: realRoot, logs, logName: 'service', extraEnv: options.extraEnv });
  if (agent.status !== 'PASS') return agent;
  const { plist, tools, environment, node } = agent, servicePath = environment.PATH;
  const record = { schemaVersion: 1, label, plist, installedAt: new Date().toISOString(), node, cli: CLI, tools, environment: { ...environment, PATH: servicePath } };
  await writeJson(await projectPath(root, '.protoflow/runner/service.json'), record);
  return { status: 'PASS', label, plist, tools, logs: { stdout: path.join(logs, 'service.out.log'), stderr: path.join(logs, 'service.err.log') }, next: 'runner service status' };
}

export async function uninstallService(root, options = {}) {
  const ctx = context(root, options);
  if (ctx.platform !== 'darwin') return { status: 'NOT_RUN', reason: 'runner service supports macOS launchd only' };
  const label = await serviceLabel(root), plist = path.join(ctx.home, 'Library/LaunchAgents', `${label}.plist`);
  const result = await launch(ctx, ['bootout', `${ctx.domain}/${label}`]);
  await fs.rm(plist, { force: true });
  await fs.rm(await projectPath(root, '.protoflow/runner/service.json'), { force: true });
  return { status: 'PASS', label, stopped: result.status === 'PASS' };
}

/** launchd's view of the job plus the runner's own heartbeat: healthy means running and heartbeating as that pid. */
export async function serviceStatus(root, options = {}) {
  const ctx = context(root, options);
  if (ctx.platform !== 'darwin') return { status: 'NOT_RUN', reason: 'runner service supports macOS launchd only' };
  const label = await serviceLabel(root);
  const printed = await launch(ctx, ['print', `${ctx.domain}/${label}`]);
  const heartbeat = await readJson(await projectPath(root, HEARTBEAT), null);
  const beatAgeSeconds = heartbeat?.at ? Math.round((Date.now() - Date.parse(heartbeat.at)) / 1000) : null;
  if (printed.status !== 'PASS') return { status: 'NOT_INSTALLED', label, heartbeat, beatAgeSeconds };
  const field = name => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(printed.stdout)?.[1]?.trim() ?? null;
  const state = field('state'), pid = Number(field('pid')) || null, runs = Number(field('runs')) || null, lastExit = field('last exit code');
  const running = state === 'running' && pid !== null;
  const alive = running && heartbeat?.pid === pid && heartbeat.service === true;
  // A live runner that cannot read its source or reach GitHub does no work: that is not healthy.
  const degraded = alive && (heartbeat.failingPasses ?? 0) >= DEGRADED_AFTER;
  return { status: degraded ? 'DEGRADED' : alive ? 'HEALTHY' : running ? 'STARTING' : 'DOWN', label, state, pid, runs, lastExitCode: lastExit, heartbeat, beatAgeSeconds, ...(degraded && { reason: `${heartbeat.failingPasses} consecutive passes failed: ${heartbeat.lastFailure?.error ?? 'unknown error'}` }) };
}

/** Proposal 0004: the dashboard as a LaunchAgent (one per machine), serving every registered project. */
export const DASHBOARD_LABEL = 'dev.protoflow.dashboard';
export async function installDashboardService({ port = 7420, ...options } = {}) {
  const ctx = context(process.cwd(), options);
  if (ctx.platform !== 'darwin') return { status: 'NOT_RUN', reason: 'dashboard service supports macOS launchd only; run `protoflow dashboard serve` under the system supervisor' };
  const logs = path.join(ctx.home, '.protoflow');
  // gh and git: approvals from the dashboard merge PRs and edit issue labels as the person.
  const agent = await loadAgent(ctx, { label: DASHBOARD_LABEL, toolNames: ['git', 'gh'], args: ['dashboard', 'serve', '--port', String(port)], workingDirectory: logs, logs, logName: 'dashboard', extraEnv: options.extraEnv });
  if (agent.status !== 'PASS') return agent;
  return { status: 'PASS', label: DASHBOARD_LABEL, plist: agent.plist, url: `http://127.0.0.1:${port}/`, tools: agent.tools, logs: { stdout: path.join(logs, 'dashboard.out.log'), stderr: path.join(logs, 'dashboard.err.log') } };
}
export async function uninstallDashboardService(options = {}) {
  const ctx = context(process.cwd(), options);
  if (ctx.platform !== 'darwin') return { status: 'NOT_RUN', reason: 'dashboard service supports macOS launchd only' };
  const result = await launch(ctx, ['bootout', `${ctx.domain}/${DASHBOARD_LABEL}`]);
  await fs.rm(path.join(ctx.home, 'Library/LaunchAgents', `${DASHBOARD_LABEL}.plist`), { force: true });
  return { status: 'PASS', label: DASHBOARD_LABEL, stopped: result.status === 'PASS' };
}
export async function dashboardServiceStatus({ port = 7420, fetchImpl = globalThis.fetch, ...options } = {}) {
  const ctx = context(process.cwd(), options);
  if (ctx.platform !== 'darwin') return { status: 'NOT_RUN', reason: 'dashboard service supports macOS launchd only' };
  const state = await agentState(ctx, DASHBOARD_LABEL);
  if (!state) return { status: 'NOT_INSTALLED', label: DASHBOARD_LABEL };
  let responding = false;
  try { responding = (await fetchImpl(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* not answering */ }
  const running = state.state === 'running' && state.pid !== null;
  return { status: running && responding ? 'HEALTHY' : running ? 'STARTING' : 'DOWN', label: DASHBOARD_LABEL, url: `http://127.0.0.1:${port}/`, ...state, responding };
}
