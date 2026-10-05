import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, writeJson, projectPath, hash, id, gitInfo } from './util.js';

const LEVELS = ['L0', 'L1', 'L2', 'L3'];
const EXCLUDED = new Set(['node_modules', '.git', '.protoflow']);
const DEFAULT_LIMITS = { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxFiles: 1000 };

function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid session or manifest identifier');
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Capture immutable prototype text; no writes, staging, or Git operations. */
export async function snapshot(root, config) {
  const realRoot = await fs.realpath(root);
  root = realRoot;
  const directory = await projectPath(root, config.prototypeDir);
  const limits = { ...DEFAULT_LIMITS, ...config.snapshot };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid snapshot limit: ${name}`);
  }
  const files = {};
  let totalBytes = 0;
  const visiting = new Set();

  async function visit(location) {
    const canonical = await fs.realpath(location);
    if (!inside(realRoot, canonical)) throw new Error(`Prototype symlink escapes project: ${path.relative(root, location)}`);
    if (path.relative(realRoot, canonical).split(path.sep).some(part => EXCLUDED.has(part))) return;
    const stat = await fs.stat(location);
    if (stat.isDirectory()) {
      if (visiting.has(canonical)) throw new Error(`Prototype symlink cycle: ${path.relative(root, location)}`);
      visiting.add(canonical);
      for (const name of (await fs.readdir(location)).sort()) {
        if (!EXCLUDED.has(name)) await visit(path.join(location, name));
      }
      visiting.delete(canonical);
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported prototype entry: ${path.relative(root, location)}`);
    if (stat.size > limits.maxFileBytes) throw new Error(`Prototype file exceeds maxFileBytes: ${path.relative(root, location)}`);
    // Read with a fixed upper bound even if a concurrently edited file grows.
    const handle = await fs.open(location, 'r');
    let bytes;
    try {
      const buffer = Buffer.alloc(limits.maxFileBytes + 1);
      const result = await handle.read(buffer, 0, buffer.length, 0);
      if (result.bytesRead > limits.maxFileBytes) throw new Error(`Prototype file exceeds maxFileBytes: ${path.relative(root, location)}`);
      bytes = buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
    totalBytes += bytes.length;
    if (totalBytes > limits.maxTotalBytes) throw new Error('Prototype snapshot exceeds maxTotalBytes');
    if (Object.keys(files).length >= limits.maxFiles) throw new Error('Prototype snapshot exceeds maxFiles');
    const relative = path.relative(root, location).split(path.sep).join('/');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary asset: hashed, not interpreted as code. */ }
    files[relative] = { hash: hash(bytes), size: bytes.length, ...(content === undefined ? { binary: true } : { content }) };
  }

  try { await visit(directory); } catch (error) {
    // Missing prototype directories are legitimate before the first design edit.
    if (error.code !== 'ENOENT' || await fs.lstat(directory).then(() => true, () => false)) throw error;
  }
  return { files, hash: hash(JSON.stringify(Object.entries(files).map(([name, file]) => [name, file.hash]))) };
}

function patternMatches(pattern, file) {
  if (typeof pattern !== 'string') return false;
  // Portable glob subset: * does not cross '/', ** does; no arbitrary regex evaluation.
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') { expression += '(?:.*/)?'; i += 2; }
      else { expression += '.*'; i++; }
    } else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(file);
}

function changedLines(before, after) {
  const left = before === undefined || before === '' ? [] : before.split('\n');
  const right = after === undefined || after === '' ? [] : after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix && left.at(-1 - suffix) === right.at(-1 - suffix)) suffix++;
  return { left, right, prefix, suffix, removed: left.slice(prefix, left.length - suffix), added: right.slice(prefix, right.length - suffix) };
}

function textDiff(file, before, after) {
  const lines = changedLines(before, after);
  const start = Math.max(0, lines.prefix - 3);
  const endLeft = Math.min(lines.left.length, lines.left.length - lines.suffix + 3);
  const endRight = Math.min(lines.right.length, lines.right.length - lines.suffix + 3);
  return [
    `--- ${before === undefined ? '/dev/null' : `a/${file}`}`,
    `+++ ${after === undefined ? '/dev/null' : `b/${file}`}`,
    `@@ -${endLeft === 0 ? 0 : start + 1},${endLeft - start} +${endRight === 0 ? 0 : start + 1},${endRight - start} @@`,
    ...lines.left.slice(start, lines.prefix).map(line => ` ${line}`),
    ...lines.removed.map(line => `-${line}`),
    ...lines.added.map(line => `+${line}`),
    ...lines.left.slice(lines.left.length - lines.suffix, endLeft).map(line => ` ${line}`),
  ].join('\n');
}

function stripStyles(text) {
  return text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
}

function inferredLevel(file, before, after) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.css') return 'L0';
  if (before !== undefined && after !== undefined && /\.(?:html?|vue|svelte)$/.test(file) && stripStyles(before) === stripStyles(after)) return 'L0';
  const { added, removed } = changedLines(before, after);
  const delta = [...removed, ...added].join('\n').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  if (/\b(auth(?:entication|orization)?|oauth|permission|rbac|password|secret|jwt|csrf|encryption|security|architecture|migration|middleware)\b/i.test(delta)) return 'L3';
  if (/\b(fetch|api|graphql|database|schema|endpoint|websocket|axios|storage|persist|indexedDB|localStorage|data-model|server|sql)\b|https?:\/\//i.test(delta)) return 'L2';
  if (/\.(?:html?|vue|svelte)$/.test(file) && !/<script\b/i.test(delta)) return 'L1';
  if (/\b(add Event Listener|on Click|onclick|on Change|onchange|query Selector|class List|toggle|focus|aria expanded|aria selected)\b/i.test(delta)) return 'L1';
  return 'L2';
}

/** Classification is conservative: explicit rules/overrides may only raise risk. */
export function classifyChanges(before, after, config, { level } = {}) {
  if (level !== undefined && !LEVELS.includes(level)) throw new Error(`Invalid change level: ${level}`);
  const changes = [];
  for (const file of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const previous = before.files[file];
    const current = after.files[file];
    if (previous?.hash === current?.hash) continue;
    const type = !previous ? 'added' : !current ? 'deleted' : 'modified';
    let risk = inferredLevel(file, previous?.content, current?.content);
    if (previous?.binary || current?.binary) risk = 'L2';
    for (const rule of config.classification?.rules ?? []) {
      if (!LEVELS.includes(rule.level)) throw new Error(`Invalid classification rule level: ${rule.level}`);
      if (patternMatches(rule.pattern, file) && LEVELS.indexOf(rule.level) > LEVELS.indexOf(risk)) risk = rule.level;
    }
    if (level && LEVELS.indexOf(level) > LEVELS.indexOf(risk)) risk = level;
    const mappings = (config.mappings ?? []).filter(mapping => (mapping.prototypeFiles ?? []).some(pattern => patternMatches(pattern, file))).map(mapping => mapping.id);
    changes.push({ path: file, type, beforeHash: previous?.hash ?? null, afterHash: current?.hash ?? null, level: risk, mappings,
      diff: previous?.binary || current?.binary ? 'Binary asset changed' : textDiff(file, previous?.content, current?.content) });
  }
  return { level: changes.reduce((result, change) => LEVELS.indexOf(change.level) > LEVELS.indexOf(result) ? change.level : result, 'L0'),
    changes, mappings: [...new Set(changes.flatMap(change => change.mappings))] };
}

async function statePath(root, kind, identifier) {
  return projectPath(root, `.protoflow/${kind}/${safeId(identifier)}.json`);
}

export async function listSessions(root) {
  const directory = await projectPath(root, '.protoflow/sessions');
  let names;
  try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const sessions = await Promise.all(names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).map(name => readJson(path.join(directory, name))));
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSession(root, identifier) {
  const result = await readJson(await statePath(root, 'sessions', identifier), null);
  if (!result) throw new Error(`Session not found: ${identifier}`);
  return result;
}

export async function getManifest(root, identifier) {
  const result = await readJson(await statePath(root, 'manifests', identifier), null);
  if (!result) throw new Error(`Manifest not found: ${identifier}`);
  return result;
}

export async function startSession(root, config, { label, before } = {}) {
  const active = (await listSessions(root)).find(session => session.status === 'active');
  if (active) throw new Error(`An active design session already exists: ${active.id}`);
  const session = { schemaVersion: 1, version: 1, id: id('session'), label: label ?? 'Design session', status: 'active', createdAt: new Date().toISOString(),
    before: before ?? await snapshot(root, config) };
  await writeJson(await statePath(root, 'sessions', session.id), session);
  return session;
}

export async function checkpoint(root, config, { sessionId, level, summary } = {}) {
  const sessions = await listSessions(root);
  let session = sessionId ? await getSession(root, sessionId) : sessions.find(item => item.status === 'active');
  if (!session) {
    const previous = sessions.find(item => item.status === 'checkpointed' && item.after);
    session = await startSession(root, config, { label: summary ?? 'Prototype checkpoint', before: previous?.after ?? { files: {}, hash: hash(JSON.stringify([])) } });
  }
  if (session.status !== 'active') throw new Error(`Session is already ${session.status}: ${session.id}`);
  const after = await snapshot(root, config);
  const classification = classifyChanges(session.before, after, config, { level });
  const requireHumanReview = config.policy?.requireHumanReview ?? true;
  const required = requireHumanReview === true || (Array.isArray(requireHumanReview) && requireHumanReview.includes(classification.level));
  const manifest = { schemaVersion: 1, version: 1, id: id('manifest'), sessionId: session.id, createdAt: new Date().toISOString(),
    summary: summary ?? session.label, beforeHash: session.before.hash, afterHash: after.hash, ...classification,
    requires: { spec: ['L2', 'L3'].includes(classification.level), architecture: classification.level === 'L3', humanReview: required },
    git: await gitInfo(root, config.prototypeDir), review: { required, status: required ? 'pending' : 'not_required' } };
  await writeJson(await statePath(root, 'manifests', manifest.id), manifest);
  await writeJson(await statePath(root, 'sessions', session.id), { ...session, status: 'checkpointed', completedAt: manifest.createdAt,
    after, manifestId: manifest.id });
  return manifest;
}

/** Polling watches recursive directories portably; the pre-change snapshot stays fixed until idle. */
export async function watch(root, config, { once = false, onCheckpoint, onReady, signal } = {}) {
  const pollMs = config.watch?.pollMs ?? config.watch?.pollIntervalMs ?? 200;
  const idleMs = config.watch?.idleMs ?? config.watch?.debounceMs ?? 1000;
  if (!Number.isFinite(pollMs) || pollMs < 10 || !Number.isFinite(idleMs) || idleMs < 0) throw new Error('Invalid watch timing');
  let previous = await snapshot(root, config);
  let session = (await listSessions(root)).find(item => item.status === 'active');
  let changedAt = session && session.before.hash !== previous.hash ? Date.now() : null;
  const checkpoints = [];
  if (onReady) await onReady({ hash: previous.hash, activeSessionId: session?.id ?? null });
  while (!signal?.aborted) {
    try { await delay(pollMs, undefined, { signal }); } catch (error) { if (error.name === 'AbortError') break; throw error; }
    if (signal?.aborted) break;
    const current = await snapshot(root, config);
    if (current.hash !== previous.hash) {
      if (!session) session = await startSession(root, config, { label: 'Watched prototype changes', before: previous });
      changedAt = Date.now();
      previous = current;
    }
    if (session && changedAt !== null && Date.now() - changedAt >= idleMs) {
      const manifest = await checkpoint(root, config, { sessionId: session.id });
      checkpoints.push(manifest);
      session = undefined;
      changedAt = null;
      // Take checkpointed state directly: edits during callback become the next session.
      previous = (await getSession(root, manifest.sessionId)).after;
      if (onCheckpoint) await onCheckpoint(manifest);
      if (once) return { checkpoints, stopped: false };
    }
  }
  return { checkpoints, stopped: true, activeSessionId: session?.id ?? null };
}
