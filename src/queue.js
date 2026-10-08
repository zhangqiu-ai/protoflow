import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, projectPath, hash } from './util.js';

async function records(root, kind) {
  const directory = await projectPath(root, `.protoflow/${kind}`);
  let names;
  try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(names.filter(name => /^[a-zA-Z0-9_.-]+\.json$/.test(name)).map(name => readJson(path.join(directory, name))));
}

const chronological = (a, b) => a.source?.identity && a.source.identity === b.source?.identity && a.source.ordinal && b.source.ordinal ? a.source.ordinal - b.source.ordinal : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * A prototype version is accepted once a PASS verification is bound to its exact manifest and prototype content.
 * With targets, only that target's verifications count; records made before targets existed belong to the first one.
 */
export function acceptedBy(manifest, verifications, target, defaultTarget = target) {
  return verifications.filter(item => item.manifestId === manifest.id && item.status === 'PASS' && item.manifestHash === hash(manifest) && item.prototypeHash === manifest.afterHash
    && (target === undefined || (item.target ?? defaultTarget) === target))
    .sort(chronological).at(-1) ?? null;
}

const stepsFor = (current, target) => {
  if (!current) return [];
  const flag = target ? ` --target ${target}` : '';
  return [`protoflow context --manifest ${current.id}${flag}`, 'protoflow execute --context <CONTEXT_ID> --execute', `protoflow verify --manifest ${current.id}${flag}`, `protoflow repair --manifest ${current.id}${flag} --execute`];
};
function cursor(versions, accepted) {
  const index = versions.findIndex(version => !accepted(version));
  return {
    current: index === -1 ? null : versions[index],
    waiting: index === -1 ? [] : versions.slice(index + 1).map(version => version.id),
    lastAccepted: [...versions].reverse().find(version => accepted(version)) ?? null
  };
}

/**
 * Prototype versions queue up freely; the application advances through them in checkpoint order.
 * `current` is the oldest version without accepted application verification. With several targets each target has
 * its own cursor (`targets`); the top level follows `target` when given, otherwise the first version not yet accepted
 * by every target. `release` reports the newest version every required target has accepted.
 */
export async function versionQueue(root, config, { target } = {}) {
  const manifests = (await records(root, 'manifests')).sort(chronological);
  const verifications = await records(root, 'verifications');
  const sequential = config.policy?.sequentialVersions !== false;
  const ids = config.schemaVersion === 2 ? config.targets.map(item => item.id) : [];
  if (target && !ids.includes(target)) throw new Error(`Unknown target: ${target}`);
  const selected = target ?? (ids.length === 1 ? ids[0] : null);
  const versions = manifests.map(manifest => {
    const byTarget = Object.fromEntries(ids.map(id => [id, acceptedBy(manifest, verifications, id, ids[0])?.id ?? null]));
    const count = Object.values(byTarget).filter(Boolean).length;
    const acceptedById = ids.length ? (selected ? byTarget[selected] : count === ids.length ? 'all' : null) : acceptedBy(manifest, verifications)?.id ?? null;
    return {
      id: manifest.id, createdAt: manifest.createdAt, summary: manifest.summary, level: manifest.level, source: manifest.source ?? null, mappings: manifest.mappings,
      acceptedBy: acceptedById,
      ...(ids.length && { targets: byTarget, acceptance: count === ids.length ? 'accepted' : count ? 'partial' : 'pending' })
    };
  });
  const top = cursor(versions, version => version.acceptedBy);
  const result = { status: top.current ? 'PENDING' : 'IDLE', sequential, ...(selected && ids.length > 1 && { target: selected }), ...top, versions, nextSteps: stepsFor(top.current, ids.length > 1 ? selected ?? '<id>' : null) };
  if (ids.length > 1) {
    result.targets = Object.fromEntries(ids.map(id => { const own = cursor(versions, version => version.targets[id]); return [id, { status: own.current ? 'PENDING' : 'IDLE', current: own.current?.id ?? null, waiting: own.waiting, lastAccepted: own.lastAccepted?.id ?? null }]; }));
  }
  const required = config.release?.requireTargets;
  if (required?.length) {
    // FIFO per target means accepted versions form a prefix; the releasable version is the shortest prefix end.
    const releasable = [...versions].reverse().find(version => required.every(id => versions.slice(0, versions.indexOf(version) + 1).every(item => item.targets[id])));
    result.release = { requireTargets: required, version: releasable?.id ?? null, summary: releasable?.summary ?? null };
  }
  return result;
}

export class VersionOrderError extends Error {
  constructor(message, queue) {
    super(message);
    this.code = 'VERSION_ORDER';
    this.queue = { current: queue.current, waiting: queue.waiting };
  }
}

/**
 * Application work (context, execution, verification, repair) may only target the current version.
 * Review and baseline may also record decisions on versions that were already accepted.
 */
export async function assertCurrentVersion(root, config, manifestId, { allowAccepted = false, target } = {}) {
  if (config.schemaVersion === 2 && config.targets.length > 1 && !target) throw new Error(`This project has several targets (${config.targets.map(item => item.id).join(', ')}); pass --target`);
  const queue = await versionQueue(root, config, { target });
  if (!queue.sequential) return queue;
  const version = queue.versions.find(item => item.id === manifestId);
  if (!version) throw new Error(`Manifest not found: ${manifestId}`);
  if (version.acceptedBy) {
    if (allowAccepted) return queue;
    throw new VersionOrderError(`原型版本 ${manifestId} 已由 ${version.acceptedBy} 驗收；正式應用目前應處理 ${queue.current?.id ?? '（無待處理版本）'}`, queue);
  }
  if (queue.current.id !== manifestId) {
    throw new VersionOrderError(`正式應用需依原型版本順序推進：目前版本是 ${queue.current.id}（${queue.current.summary}），${manifestId} 排在其後；不能跨版本工作`, queue);
  }
  return queue;
}
