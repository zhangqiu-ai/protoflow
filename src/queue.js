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

/** A prototype version is accepted once a PASS verification is bound to its exact manifest and prototype content. */
export function acceptedBy(manifest, verifications) {
  return verifications.filter(item => item.manifestId === manifest.id && item.status === 'PASS' && item.manifestHash === hash(manifest) && item.prototypeHash === manifest.afterHash)
    .sort(chronological).at(-1) ?? null;
}

/**
 * Prototype versions queue up freely; the application advances through them in checkpoint order.
 * `current` is the oldest version without accepted application verification.
 */
export async function versionQueue(root, config) {
  const manifests = (await records(root, 'manifests')).sort(chronological);
  const verifications = await records(root, 'verifications');
  const versions = manifests.map(manifest => {
    const accepted = acceptedBy(manifest, verifications);
    return { id: manifest.id, createdAt: manifest.createdAt, summary: manifest.summary, level: manifest.level, source: manifest.source ?? null, mappings: manifest.mappings, acceptedBy: accepted?.id ?? null };
  });
  const sequential = config.policy?.sequentialVersions !== false;
  const index = versions.findIndex(version => !version.acceptedBy);
  const current = index === -1 ? null : versions[index];
  return {
    status: current ? 'PENDING' : 'IDLE', sequential, current,
    waiting: index === -1 ? [] : versions.slice(index + 1).map(version => version.id),
    lastAccepted: [...versions].reverse().find(version => version.acceptedBy) ?? null,
    versions,
    nextSteps: current ? [`protoflow context --manifest ${current.id}`, 'protoflow execute --context <CONTEXT_ID> --execute', `protoflow verify --manifest ${current.id}`, `protoflow repair --manifest ${current.id} --execute`] : [],
  };
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
export async function assertCurrentVersion(root, config, manifestId, { allowAccepted = false } = {}) {
  const queue = await versionQueue(root, config);
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
