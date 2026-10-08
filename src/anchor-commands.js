import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { staticContract, suggestAnchors, lineDiff } from './anchors.js';
import { snapshot } from './sessions.js';
import { loadVersion } from './versions.js';
import { versionQueue } from './queue.js';
import { versionFiles } from './targets.js';
import { loadArtifact } from './workflow.js';
import { migrateAnchors } from './migrate.js';
import { projectPath, writeJson } from './util.js';

/**
 * Prototype files to inspect: a frozen version when --manifest is given (or, for a Git source whose prototype is
 * not checked out locally, the newest version), otherwise the live prototype directory.
 */
async function prototypeFiles(root, config, manifestId) {
  let id = manifestId;
  if (!id && config.source) {
    const live = await snapshot(root, config);
    if (!Object.keys(live.files).length) id = (await versionQueue(root, config)).versions.at(-1)?.id;
    if (!id) return { files: live.files, origin: 'live' };
  }
  if (!id) return { files: (await snapshot(root, config)).files, origin: 'live' };
  const manifest = await loadArtifact(root, 'manifests', id);
  return { files: (await versionFiles(root, await loadVersion(root, config, manifest))).files, origin: id, manifest };
}

/** Patch paths are relative to the prototype's own repository when it comes from a Git source. */
function repositoryPath(config, file) {
  if (!config.source) return file;
  const prefix = `${config.prototypeDir.split(path.sep).join('/')}/`;
  return file.startsWith(prefix) ? path.posix.join(config.source.path, file.slice(prefix.length)) : file;
}

export async function lintAnchors(root, config, { manifest } = {}) {
  const { files, origin } = await prototypeFiles(root, config, manifest);
  const contract = staticContract({ files }, config);
  return {
    status: contract.errors.length ? 'FAIL' : 'PASS', origin,
    screens: Object.fromEntries(Object.entries(contract.screens).map(([id, screen]) => [id, { page: screen.page, anchors: new Set(screen.anchors.map(anchor => anchor.id)).size, states: Object.keys(screen.states), sidecar: screen.sidecar }])),
    errors: contract.errors, warnings: contract.warnings
  };
}

async function writeProjectFile(root, relative, content) {
  const file = await projectPath(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return relative;
}

export async function suggestAnchorsCommand(root, config, { manifest, patchFile } = {}) {
  const { files, origin } = await prototypeFiles(root, config, manifest);
  const pages = [];
  let patch = '';
  for (const page of Object.keys(files).filter(file => /\.html?$/i.test(file) && typeof files[file].content === 'string').sort()) {
    const suggestion = suggestAnchors(page, files[page].content);
    const sidecar = page.replace(/\.html?$/i, '.pf.json');
    const addSidecar = !files[sidecar];
    if (!suggestion.suggestions.length && !addSidecar) continue;
    const target = repositoryPath(config, page);
    patch += lineDiff(target, files[page].content, suggestion.html);
    if (addSidecar) {
      const body = `${JSON.stringify(suggestion.sidecar, null, 2)}\n`.split('\n').slice(0, -1);
      patch += [`--- /dev/null`, `+++ b/${repositoryPath(config, sidecar)}`, `@@ -0,0 +1,${body.length} @@`, ...body.map(line => `+${line}`)].join('\n') + '\n';
    }
    pages.push({ page, screen: suggestion.screen, suggestions: suggestion.suggestions, sidecar: addSidecar ? sidecar : null });
  }
  const written = patchFile && patch ? await writeProjectFile(root, patchFile, patch) : null;
  return {
    status: 'DRAFT', origin, pages, patch, patchFile: written,
    notice: 'Draft anchors. Review the IDs (they become the design contract), apply the patch in the prototype source with `git apply`, and commit it as a new prototype version.'
  };
}

export async function showContract(root, config, manifestId) {
  const manifest = await loadArtifact(root, 'manifests', manifestId);
  const version = await loadVersion(root, config, manifest);
  return { manifestId, scope: manifest.scope ?? null, contract: staticContract(await versionFiles(root, version), config) };
}

export async function migrateCommand(root, config, { manifest, output = '.protoflow/migration' } = {}) {
  const { files, origin } = await prototypeFiles(root, config, manifest);
  const result = await migrateAnchors(root, config, files);
  const remapped = config.source ? result.prototypePatch.replace(/^(---|\+\+\+) (a|b)\/(.+)$/gm, (line, marker, side, file) => `${marker} ${side}/${repositoryPath(config, file)}`) : result.prototypePatch;
  const written = [];
  if (remapped) written.push(await writeProjectFile(root, `${output}/prototype.patch`, remapped));
  if (result.applicationPatch) written.push(await writeProjectFile(root, `${output}/application.patch`, result.applicationPatch));
  await writeJson(await projectPath(root, `${output}/protoflow.config.v2.json`), result.config);
  written.push(`${output}/protoflow.config.v2.json`);
  return { ...result, prototypePatch: remapped, origin, written };
}
