import fs from 'node:fs/promises';
import path from 'node:path';
import { projectPath, readJson } from './util.js';

/**
 * Executors take a bounded prompt (Codex rejects more than 1,048,576 characters). A prototype whose generated pages keep
 * their markup on one line turns a one-attribute change into a diff of the whole page, twice over: once per change and
 * once in the version's git diff. The Context Package carries each such change by reference instead — the frozen files
 * the executor can read — and one copy of the diff, so frozen manifests from older engines fit as well.
 */
export const DIFF_INLINE_LIMIT = 32 * 1024;
export const DIFF_LINE_LIMIT = 2000;
export const CONTEXT_BUDGET = 900 * 1024;
const EXCERPT_CONTEXT = 160, EXCERPT_LIMIT = 2000, EXCERPTS = 6;

const inlineable = diff => typeof diff === 'string' && diff.length <= DIFF_INLINE_LIMIT && !diff.split('\n').some(line => line.length > DIFF_LINE_LIMIT);
const cut = text => text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…[${text.length - EXCERPT_LIMIT} more characters]` : text;

/** Where each change sits in a unified diff, as the changed characters with a little context on both sides. */
export function diffExcerpts(diff) {
  const excerpts = [];
  let removed = [], added = [];
  const flush = () => {
    if (!removed.length && !added.length) return;
    const before = removed.join('\n'), after = added.join('\n');
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const from = Math.max(0, start - EXCERPT_CONTEXT);
    excerpts.push({ offset: start, before: cut(before.slice(from, Math.min(before.length, before.length - end + EXCERPT_CONTEXT))), after: cut(after.slice(from, Math.min(after.length, after.length - end + EXCERPT_CONTEXT))) });
    removed = []; added = [];
  };
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
    else flush();
  }
  flush();
  return excerpts.length > EXCERPTS ? [...excerpts.slice(0, EXCERPTS), { more: excerpts.length - EXCERPTS }] : excerpts;
}

/** The frozen copy of a prototype file with this hash, in the version that holds it (the previous version for `beforeHash`). */
async function frozenIndex(root) {
  const directory = await projectPath(root, '.protoflow/versions');
  const names = await fs.readdir(directory).catch(() => []);
  const indexes = [];
  for (const name of names) {
    const index = await readJson(path.join(directory, name, 'index.json'), null);
    if (index?.files) indexes.push({ id: name, files: index.files });
  }
  return (file, hash) => {
    const version = hash && indexes.find(item => item.files[file]?.hash === hash);
    return version ? `.protoflow/versions/${version.id}/files/${file}` : null;
  };
}

/**
 * The manifest as the executor sees it: a diff that is too large, or has a line too long to read, becomes a reference
 * to the frozen before/after files with excerpts of what changed; the version's git diff, the same text as the changes'
 * diffs, is not repeated. `all` references every diff (the request is still over budget).
 */
export async function briefManifest(root, manifest, { all = false } = {}) {
  if (!manifest || !Array.isArray(manifest.changes)) return manifest;
  const frozen = await frozenIndex(root);
  const changes = manifest.changes.map(change => {
    if (typeof change.diff !== 'string' || (!all && inlineable(change.diff))) return change;
    const { diff, ...rest } = change;
    return {
      ...rest, diffOmitted: true, diffSize: diff.length, diffLines: diff.split('\n').length,
      frozenAfter: change.type === 'deleted' ? null : frozen(change.path, change.afterHash) ?? `.protoflow/versions/${manifest.id}/files/${change.path}`,
      frozenBefore: change.type === 'added' ? null : frozen(change.path, change.beforeHash),
      excerpts: diffExcerpts(diff)
    };
  });
  const perChange = manifest.changes.some(change => typeof change.diff === 'string');
  const git = manifest.git && typeof manifest.git.diff === 'string' && (perChange || manifest.git.diff.length > DIFF_INLINE_LIMIT)
    ? { ...Object.fromEntries(Object.entries(manifest.git).filter(([key]) => key !== 'diff')), diffOmitted: true, diffSize: manifest.git.diff.length, diffNote: perChange ? 'The same diff is in manifest.changes[].diff (or referenced there when omitted).' : 'Too large to include; read the frozen version under .protoflow/versions/.' }
    : manifest.git;
  return { ...manifest, changes, ...(manifest.git !== undefined && { git }) };
}

/** Sizes of the largest parts of a request, two levels deep, for an error that says what to shrink. */
export function contextSizes(request, count = 6) {
  const sizes = [];
  for (const [key, value] of Object.entries(request)) {
    const size = JSON.stringify(value ?? null).length;
    if (value && typeof value === 'object' && !Array.isArray(value) && size > 64 * 1024) for (const [inner, part] of Object.entries(value)) sizes.push([`${key}.${inner}`, JSON.stringify(part ?? null).length]);
    else sizes.push([key, size]);
  }
  return sizes.sort((a, b) => b[1] - a[1]).slice(0, count);
}

// Executors print the Context Package indented, so the budget counts it that way.
const measure = value => JSON.stringify(value, null, 2).length;
/** The request for the executor within the budget: large diffs by reference first, then every diff, else a clear error. */
export async function fitContext(root, request, { budget = CONTEXT_BUDGET } = {}) {
  let fitted = { ...request, manifest: await briefManifest(root, request.manifest) };
  if (measure(fitted) > budget) fitted = { ...fitted, manifest: await briefManifest(root, request.manifest, { all: true }) };
  const size = measure(fitted);
  if (size > budget) throw Object.assign(new Error(`Context Package is ${size} characters, above the executor budget of ${budget} even with every prototype diff referenced by its frozen files; largest parts: ${contextSizes(fitted).map(([key, part]) => `${key} (${part})`).join(', ')}`), { reasonCode: 'context-too-large' });
  return fitted;
}
