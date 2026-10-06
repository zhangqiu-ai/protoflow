import { appendFile, cp, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPath as safeProjectPath, readJson } from './util.js';
import { INTEGRATIONS, configuredInstallers, detectIntegrations, installIntegrations, integrationNotices } from './integrations.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const skillSource = path.join(packageRoot, 'skills/protoflow');
const agentsBegin = '<!-- protoflow:begin -->';
const agentsEnd = '<!-- protoflow:end -->';

export function defaultConfig(prototypeDir = 'prototype') {
  return {
    schemaVersion: 1,
    prototypeDir,
    mappings: [],
    classification: { rules: [] },
    policy: { maxRepairAttempts: 3, requireHumanReview: true, sequentialVersions: true },
    watch: { pollMs: 200, idleMs: 1000 },
    verification: { build: null, functional: null },
    visual: { scenes: [], maxDiffRatio: 0.01, geometryTolerance: 1, pixelThreshold: 0.1 },
    adapters: {
      codex: { command: null },
      specKit: { command: null, install: INTEGRATIONS.specKit.install },
      bmad: { command: null, install: INTEGRATIONS.bmad.install },
    },
  };
}

async function exists(destination) {
  try { await lstat(destination); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function projectPath(root, relative) {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) {
    throw new Error('prototypeDir must be a nonempty relative project path');
  }
  const resolved = path.resolve(root, relative);
  const difference = path.relative(root, resolved);
  if (!difference || difference === '..' || difference.startsWith(`..${path.sep}`)) {
    throw new Error('prototypeDir must be inside the project');
  }
  return resolved;
}

/** Initialize configuration and append the managed contract without replacing user files. */
export async function initProject(root, { prototypeDir = 'prototype' } = {}) {
  const project = path.resolve(root);
  projectPath(project, prototypeDir);
  await mkdir(project, { recursive: true });
  const configPath = await safeProjectPath(project, 'protoflow.config.json');
  const agentsPath = await safeProjectPath(project, 'AGENTS.md');
  await safeProjectPath(project, prototypeDir);
  const created = [];
  const skipped = [];
  let effectivePrototypeDir = prototypeDir;
  try {
    await writeFile(configPath, `${JSON.stringify(defaultConfig(prototypeDir), null, 2)}\n`, { flag: 'wx' });
    created.push(configPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = JSON.parse(await readFile(configPath, 'utf8'));
    effectivePrototypeDir = current.prototypeDir ?? prototypeDir;
    skipped.push(configPath);
  }
  projectPath(project, effectivePrototypeDir);
  const prototypePath = await safeProjectPath(project, effectivePrototypeDir);
  if (!await exists(prototypePath)) { await mkdir(prototypePath, { recursive: true }); created.push(prototypePath); }
  else skipped.push(prototypePath);

  let agents = '';
  try { agents = await readFile(agentsPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (agents.includes(agentsBegin)) {
    if (!agents.includes(agentsEnd)) throw new Error('AGENTS.md has an incomplete ProtoFlow managed block; preserve and repair it manually');
    skipped.push(agentsPath);
  } else {
    const contract = await readFile(path.join(packageRoot, 'templates/AGENTS.block.md'), 'utf8');
    const separator = agents.length ? (agents.endsWith('\n') ? '\n' : '\n\n') : '';
    await appendFile(agentsPath, `${separator}${contract.trimEnd()}\n`);
    created.push(agentsPath);
  }
  return { project, configPath, agentsPath, created, skipped };
}

/**
 * Install the ProtoFlow instructions (the engine stays shared), then Spec Kit and BMad into the project.
 * `integrations`: undefined uses protoflow.config.json installers or engine defaults; false only detects.
 */
export async function installSkill(root, {
  personal = false,
  sourceDir = '/Users/feature/GitHub/skills',
  discoveryDir = '/Users/feature/.codex/skills',
  integrations,
} = {}) {
  const project = path.resolve(root);
  if (!personal) await mkdir(project, { recursive: true });
  const skillDir = personal ? path.resolve(sourceDir, 'protoflow') : await safeProjectPath(project, '.agents/skills/protoflow');
  const installed = [];
  const skipped = [];
  if (await exists(skillDir)) skipped.push(skillDir);
  else {
    await mkdir(path.dirname(skillDir), { recursive: true });
    await cp(skillSource, skillDir, { recursive: true, force: false, errorOnExist: true, dereference: false });
    installed.push(skillDir);
  }
  if (personal) {
    const link = path.resolve(discoveryDir, 'protoflow');
    if (link === skillDir || await exists(link)) skipped.push(link);
    else {
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(skillDir, link, 'dir');
      installed.push(link);
    }
  }
  if (personal || integrations === false) {
    const detected = await detectIntegrations(project).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
    return { project, personal, skillDir, installed, skipped, integrations: detected, notices: integrationNotices(detected) };
  }
  const config = await readJson(await safeProjectPath(project, 'protoflow.config.json'), null);
  const results = await installIntegrations(project, integrations ?? configuredInstallers(config));
  return {
    status: results.some(result => result.status === 'FAIL') ? 'FAIL' : 'PASS',
    project, personal, skillDir, installed, skipped,
    integrations: results, notices: results.map(result => result.notice),
  };
}
