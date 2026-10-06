import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectPath, hash, writeJson, readJson } from './util.js';
import { snapshot, snapshotHash } from './sessions.js';

/** Frozen prototype content per version, so the application can work on version N while the prototype moves on. */
export const versionFilesDir = manifestId => `.protoflow/versions/${manifestId}/files`;
const indexPath = manifestId => `.protoflow/versions/${manifestId}/index.json`;

export async function freezeVersion(root, manifestId, captured) {
  if (!captured.bytes) throw new Error('freezeVersion requires a snapshot captured with keepBytes');
  for (const [file, bytes] of captured.bytes) {
    const target = await projectPath(root, `${versionFilesDir(manifestId)}/${file}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
  }
  // The index is written last: a version without an index is incomplete and never read.
  const files = Object.fromEntries(Object.entries(captured.files).map(([file, entry]) => [file, { hash: entry.hash, size: entry.size }]));
  await writeJson(await projectPath(root, indexPath(manifestId)), { schemaVersion: 1, manifestId, hash: captured.hash, files });
}

/** Load and integrity-check one version; legacy manifests are frozen from the live prototype only if it still matches. */
export async function loadVersion(root, config, manifest) {
  let index = await readJson(await projectPath(root, indexPath(manifest.id)), null);
  if (!index) {
    const live = await snapshot(root, config, { keepBytes: true });
    if (live.hash !== manifest.afterHash) throw new Error(`Prototype version ${manifest.id} has no stored content and the live prototype has moved on; it cannot be reconstructed`);
    await freezeVersion(root, manifest.id, live);
    index = await readJson(await projectPath(root, indexPath(manifest.id)));
  }
  if (index.hash !== manifest.afterHash || snapshotHash(index.files) !== index.hash) throw new Error(`Prototype version store for ${manifest.id} does not match its manifest`);
  for (const [file, entry] of Object.entries(index.files)) {
    const content = await readFile(await projectPath(root, `${versionFilesDir(manifest.id)}/${file}`)).catch(() => null);
    if (!content || hash(content) !== entry.hash) throw new Error(`Prototype version store changed: ${manifest.id} ${file}`);
  }
  return { manifestId: manifest.id, hash: index.hash, files: index.files, directory: versionFilesDir(manifest.id), prototypeDir: path.posix.join(versionFilesDir(manifest.id), config.prototypeDir.split(path.sep).join('/')) };
}
