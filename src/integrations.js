import { lstat, readdir } from 'node:fs/promises';
import { fingerprint, projectPath, runCommand } from './util.js';

const installTimeoutMs = 600000;

/** Planning frameworks ProtoFlow installs into target projects; install argv is overridable per project. */
export const INTEGRATIONS = {
  specKit: {
    name: 'Spec Kit',
    source: 'https://github.com/github/spec-kit',
    install: { argv: ['uvx', '--from', 'specify-cli', 'specify', 'init', '--here', '--force', '--non-interactive', '--integration', 'codex', '--script', 'sh'], timeoutMs: installTimeoutMs },
    markers: ['.specify'],
    skillPrefixes: ['speckit'],
    usage: 'L2 變更先在 Codex 以 $speckit-specify／$speckit-plan 產生規格，再以 `protoflow context --spec <path>` 提供證據。',
  },
  bmad: {
    name: 'BMad Method',
    source: 'https://github.com/bmad-code-org/BMAD-METHOD',
    install: { argv: ['npx', '--yes', 'skills', 'add', 'bmad-code-org/BMAD-METHOD', '--skill', '*', '--agent', 'codex', '--yes'], timeoutMs: installTimeoutMs },
    markers: ['_bmad'],
    // BMad ships its module records as bmod-* alongside bmad-* skills.
    skillPrefixes: ['bmad', 'bmod'],
    usage: '在 Codex 請 `bmad` skill 執行 `bmad setup` 完成專案設定；L3 ADR 仍需真實人類批准並綁定 manifestHash。',
  },
};

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Report installed integrations from project markers and Codex skill directories; reads only. */
export async function detectIntegrations(root) {
  let skills = [];
  try { skills = await readdir(await projectPath(root, '.agents/skills')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = {};
  for (const [key, integration] of Object.entries(INTEGRATIONS)) {
    const found = [];
    for (const marker of integration.markers) if (await exists(await projectPath(root, marker))) found.push(marker);
    for (const name of skills.sort()) if (integration.skillPrefixes.some(prefix => name.startsWith(prefix))) found.push(`.agents/skills/${name}`);
    result[key] = { name: integration.name, installed: found.length > 0, evidence: found };
  }
  return result;
}

export function integrationNotices(detected) {
  return Object.entries(detected).map(([key, state]) => state.installed
    ? `已安裝 ${state.name}（${state.evidence.slice(0, 3).join('、')}${state.evidence.length > 3 ? ' 等' : ''}）。${INTEGRATIONS[key].usage}`
    : `尚未安裝 ${state.name}：執行 \`protoflow install --project <root>\` 安裝，或依 ${INTEGRATIONS[key].source} 手動安裝。`);
}

function changedFiles(before, after) {
  if (!before || !after) return null;
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(file => before.files[file] !== after.files[file]).sort();
}

async function safeFingerprint(root) {
  try { return await fingerprint(root); } catch { return null; }
}

/**
 * Run each configured installer only when the integration is absent.
 * `commands[key]` overrides the engine default; null skips that integration.
 */
export async function installIntegrations(root, commands = {}) {
  const results = [];
  for (const [key, integration] of Object.entries(INTEGRATIONS)) {
    const command = key in commands ? commands[key] : integration.install;
    const before = await detectIntegrations(root);
    if (before[key].installed) {
      results.push({ id: key, name: integration.name, status: 'present', evidence: before[key].evidence, notice: `已偵測到 ${integration.name}，略過安裝。${integration.usage}` });
      continue;
    }
    if (!command) {
      results.push({ id: key, name: integration.name, status: 'NOT_RUN', command: null, notice: `未安裝 ${integration.name}：配置的 install 為 null。可手動執行 \`${integration.install.argv.join(' ')}\`，或依 ${integration.source} 安裝。` });
      continue;
    }
    const start = await safeFingerprint(root);
    const run = await runCommand(root, command);
    const changed = changedFiles(start, await safeFingerprint(root));
    const after = (await detectIntegrations(root))[key];
    const record = { id: key, name: integration.name, command: command.argv, exitCode: run.exitCode, stdout: run.stdout.slice(-8000), stderr: run.stderr.slice(-8000), error: run.error ?? null, changed, evidence: after.evidence };
    if (run.status === 'PASS' && after.installed) {
      results.push({ ...record, status: 'installed', notice: `已安裝 ${integration.name}，請檢查新增檔案的 diff。${integration.usage}` });
    } else {
      const reason = run.status !== 'PASS' ? (run.error ?? (run.timedOut ? 'timeout' : `exit ${run.exitCode}`)) : `未找到 ${[...integration.markers, ...integration.skillPrefixes.map(prefix => `.agents/skills/${prefix}*`)].join(' 或 ')}`;
      results.push({ ...record, status: 'FAIL', notice: `${integration.name} 安裝失敗（${reason}）。手動執行 \`${command.argv.join(' ')}\` 後重新執行 protoflow install。` });
    }
  }
  return results;
}

/** Installer commands from project config; missing keys fall back to engine defaults. */
export function configuredInstallers(config) {
  const commands = {};
  for (const key of Object.keys(INTEGRATIONS)) {
    const adapter = config?.adapters?.[key];
    if (adapter && 'install' in adapter) commands[key] = adapter.install;
  }
  return commands;
}

