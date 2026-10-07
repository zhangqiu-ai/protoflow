import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, projectPath, readJson, writeJson } from './util.js';
import { classifyChanges, snapshotHash } from './sessions.js';
import { freezeVersion, loadVersion } from './versions.js';

const exec = promisify(execFile);
export const sourceStatePath = '.protoflow/source/state.json';
const sourceIdentity = source => hash({ repository: source.repository, branch: source.branch, path: source.path, startSha: source.startSha ?? null });
export async function git(root, args, options = {}) {
  return (await exec('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 60000, ...options })).stdout;
}
export function validateSource(source) {
  if (!source || source.kind !== 'git') throw new Error('Configure source.kind=git and repository/branch/path first');
  const repository = source.repository;
  if (!repository || repository.startsWith('-') || /[\n\r\0]/.test(repository)) throw new Error('Invalid source repository');
  // Local repositories are explicitly supported for fixtures; remote credentials never live in config.
  if (!path.isAbsolute(repository) && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repository) && !/^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repository)) throw new Error('Use a GitHub repository URL or an absolute local Git fixture path');
  if (!source.branch || source.branch.startsWith('-') || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\/$/.test(source.branch)) throw new Error('Invalid source branch');
  if (!source.path || source.path.startsWith('/') || /[\0\r\n:]/.test(source.path) || source.path.split('/').some(part => part === '..' || part === '.git' || part === '.protoflow' || !part)) throw new Error('source.path must be a repository-relative subtree (or .)');
  if (source.startSha && !/^[a-f0-9]{40}$/.test(source.startSha)) throw new Error('source.startSha must be an exact 40-character commit SHA');
}
export async function sourceStatus(root) {
  return readJson(await projectPath(root, sourceStatePath), { schemaVersion: 1, status: 'NEW', scannedSha: null, completedSha: null, entries: [] });
}
export async function saveSourceState(root, state) {
  await writeJson(await projectPath(root, sourceStatePath), state);
}
async function repositoryFor(root, source) {
  validateSource(source);
  const repository = await projectPath(root, '.protoflow/source/repository.git');
  await fs.mkdir(path.dirname(repository), { recursive: true });
  try { await fs.access(path.join(repository, 'HEAD')); }
  catch { await git(root, ['init', '--bare', repository]); }
  return repository;
}

const resourceAttributes = new Map(Object.entries({
  base: ['href'], script: ['src', 'href', 'xlink:href'], img: ['src', 'srcset'], source: ['src', 'srcset'],
  video: ['src', 'poster'], audio: ['src'], iframe: ['src'], link: ['href', 'imagesrcset'],
  track: ['src'], embed: ['src'], object: ['data'], input: ['src'],
  image: ['href', 'xlink:href'], use: ['href', 'xlink:href'], feimage: ['href', 'xlink:href'],
  body: ['background'], table: ['background'], td: ['background'], th: ['background'], html: ['manifest']
}));
function decodeHtml(value, { resource = false } = {}) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', Tab: '\t', NewLine: '\n' };
  if (resource && [...value.matchAll(/&([a-z][a-z\d]*);/gi)].some(match => !Object.hasOwn(named, match[1]))) throw new Error('Prototype resource is not frozen: unsupported HTML entity in a resource value');
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|colon|Tab|NewLine);?/gi, (entity, code) => {
    if (!code.startsWith('#')) return named[code] ?? entity;
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '\ufffd';
  });
}
function srcsetReferences(value) {
  const references = [];
  let rest = value;
  while (rest) {
    rest = rest.replace(/^[\s,]+/, '');
    const match = /^\S+/.exec(rest);
    if (!match) break;
    const url = match[0]; rest = rest.slice(url.length);
    references.push(url.replace(/,+$/, ''));
    if (url.endsWith(',')) continue;
    // Descriptors end at the next comma; commas within a data URL belong to
    // the URL token, so self-contained images do not hide later candidates.
    let parentheses = 0, position = 0;
    for (; position < rest.length; position++) {
      if (rest[position] === '(') parentheses++;
      else if (rest[position] === ')') parentheses--;
      else if (rest[position] === ',' && parentheses === 0) break;
    }
    rest = rest.slice(position + 1);
  }
  return references;
}
function auditJavaScript(content) {
  // No module parser is bundled. Conservatively reject module-loading tokens,
  // including comment-separated and computed imports, rather than miss URLs.
  if (/\bimport\b|\bexport\b[\s\S]*\bfrom\b/.test(content)) throw new Error('Prototype resource is not frozen: JavaScript import/re-export syntax is not auditable; vendor a bundled script without module-loading syntax');
}

function auditableLocalFormat(value, extension) {
  const resource = value.trim().replace(/[\t\r\n]/g, '').split(/[?#]/)[0];
  return !/^(?:[a-z][\w+.-]*:|\/)/i.test(resource) && extension.test(resource);
}

function cssResourceReferences(content) {
  const references = [];
  let position = 0;
  const fail = () => { throw new Error('Prototype resource is not frozen: CSS URL/import syntax or escape is not auditable'); };
  const skip = () => {
    while (position < content.length) {
      if (/\s/.test(content[position])) { position++; continue; }
      if (content.startsWith('/*', position)) {
        const end = content.indexOf('*/', position + 2);
        if (end === -1) fail();
        position = end + 2; continue;
      }
      break;
    }
  };
  const quoted = () => {
    const quote = content[position++], start = position;
    while (position < content.length && content[position] !== quote) {
      if (/[\\\n\r\f]/.test(content[position])) fail();
      position++;
    }
    if (position === content.length) fail();
    const value = content.slice(start, position); position++;
    return value;
  };
  const identifier = () => {
    const start = position;
    while (position < content.length && /[a-z\d_-]/i.test(content[position])) position++;
    return content.slice(start, position).toLowerCase();
  };
  const url = () => {
    skip();
    if (content[position++] !== '(') fail();
    skip();
    let value;
    if (content[position] === '"' || content[position] === "'") value = quoted();
    else {
      const start = position;
      while (position < content.length && content[position] !== ')' && !/\s/.test(content[position])) {
        if (/[\\("']/.test(content[position])) fail();
        position++;
      }
      value = content.slice(start, position);
    }
    skip();
    if (content[position++] !== ')') fail();
    references.push(value);
  };
  while (position < content.length) {
    skip();
    if (position === content.length) break;
    const character = content[position];
    if (character === '\\') fail(); // Includes escaped url/import identifiers.
    if (character === '"' || character === "'") { quoted(); continue; }
    if (character === '@') {
      position++;
      if (identifier() === 'import') {
        skip();
        const start = references.length;
        if (content[position] === '"' || content[position] === "'") references.push(quoted());
        else if (identifier() === 'url') url();
        else fail();
        if (/^data:/i.test(references[start].trim().replace(/[\t\r\n]/g, ''))) throw new Error('Prototype resource is not frozen: opaque CSS data imports are not auditable');
        if (!auditableLocalFormat(references[start], /\.css$/i)) throw new Error('Prototype resource is not frozen: CSS imports require auditable local .css text files');
      }
      continue;
    }
    if (/[a-z_-]/i.test(character)) {
      const name = identifier();
      if (['image', 'image-set', '-webkit-image-set', 'src'].includes(name)) {
        skip();
        if (content[position] === '(') throw new Error(`Prototype resource is not frozen: CSS ${name} resource function is not auditable; use url()`);
      }
      if (name === 'url') {
        skip();
        if (content[position] === '(') url();
      }
      continue;
    }
    position++;
  }
  return references;
}

const cssResourceAttributes = new Set(['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'cursor', 'marker', 'marker-start', 'marker-mid', 'marker-end']);


function rawTextBoundary(content, start, name) {
  const tail = content.slice(start);
  const first = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'i').exec(tail);
  if (!first) throw new Error(name === 'style' ? 'Prototype resource is not frozen: CSS style text is not auditable without a closing tag' : 'Prototype resource is not frozen: inline script text is not auditable without a closing tag');
  const close = new RegExp(`^</${name}[\\t\\n\\f\\r ]*>`, 'i').exec(tail.slice(first.index));
  if (!close) throw new Error('Prototype resource is not frozen: noncanonical raw script/style closing tag is not auditable');
  const body = tail.slice(0, first.index);
  if (name === 'script' && body.includes('<!--')) throw new Error('Prototype resource is not frozen: escaped HTML script state is not auditable');
  return { body, end: start + first.index + close[0].length };
}

function auditSvgRawText(body) {
  // SVG script/style can contain parsed child elements, unlike HTML raw text.
  // Reject resource-bearing children rather than skip them without an XML parser.
  for (const candidate of body.matchAll(/<(?:[a-z][\w.-]*:)?([a-z][\w-]*)\b/gi)) {
    const name = candidate[1].toLowerCase();
    if (resourceAttributes.has(name) || ['meta', 'script', 'style'].includes(name)) throw new Error('Prototype resource is not frozen: resource-bearing child markup in SVG script/style is not auditable');
  }
}

function htmlResourceReferences(content, depth = 0, svgDocument = false) {
  if (/<\?xml-stylesheet\b/i.test(content)) throw new Error('Prototype resource is not frozen: XML stylesheet processing instructions are not auditable; use a vendored CSS link');
  if (depth > 20) throw new Error('Prototype resource audit cannot inspect deeply nested srcdoc');
  // Conservatively apply SVG body rules throughout mixed documents; no namespace parser is bundled.
  const svgContent = svgDocument || /<svg(?=[\t\n\f\r />])/i.test(content);
  const references = [];
  const starts = /<[a-z][\w:-]*\b/gi;
  let candidate;
  while ((candidate = starts.exec(content))) {
    const tag = /^<([a-z][\w:-]*)\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i.exec(content.slice(candidate.index));
    if (!tag) throw new Error('Prototype resource is not frozen: malformed starting tag cannot be completely audited');
    tag.index = candidate.index;
    starts.lastIndex = tag.index + tag[0].length;
    const name = tag[1].toLowerCase(), attributes = resourceAttributes.get(name) ?? [];
    if (name.includes(':')) throw new Error('Prototype resource is not frozen: namespace-prefixed document elements are not auditable; use unprefixed SVG/HTML markup');
    if (name === 'style') {
      const raw = rawTextBoundary(content, tag.index + tag[0].length, name);
      starts.lastIndex = raw.end;
      if (svgContent) auditSvgRawText(raw.body);
      references.push(...cssResourceReferences(decodeHtml(raw.body, { resource: true })));
    }
    let scriptType = null, hasSource = false;
    const parsedAttributes = [...tag[2].matchAll(/([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)];
    const stylesheet = name === 'link' && parsedAttributes.some(attribute => attribute[1].toLowerCase() === 'rel' && /(?:^|\s)stylesheet(?:\s|$)/i.test(decodeHtml(attribute[2] ?? attribute[3] ?? attribute[4])));
    if (name === 'meta' && parsedAttributes.some(attribute => attribute[1].toLowerCase() === 'http-equiv' && decodeHtml(attribute[2] ?? attribute[3] ?? attribute[4]).trim().toLowerCase() === 'refresh')) throw new Error('Prototype resource is not frozen: automatic meta refresh navigation is not auditable');
    for (const attribute of parsedAttributes) {
      const key = attribute[1].toLowerCase();
      const value = decodeHtml(attribute[2] ?? attribute[3] ?? attribute[4], { resource: attributes.includes(key) || cssResourceAttributes.has(key) || (name === 'iframe' && key === 'srcdoc') });
      if (stylesheet && key === 'href' && !auditableLocalFormat(value, /\.css$/i)) throw new Error('Prototype resource is not frozen: stylesheets require auditable local .css text files');
      if (key.startsWith('on')) auditJavaScript(value);
      if (['href', 'xlink:href', 'src', 'action', 'formaction'].includes(key)) {
        const normalized = value.trim().replace(/[\t\r\n]/g, '');
        if (/^javascript:/i.test(normalized)) {
          let code;
          try { code = decodeURIComponent(normalized.slice('javascript:'.length)); }
          catch { throw new Error('Prototype resource is not frozen: JavaScript URL encoding is not auditable'); }
          auditJavaScript(code);
        }
      }
      if (name === 'script' && key === 'type') scriptType ??= value.trim().toLowerCase();
      if (name === 'script' && key === 'src') hasSource = true;
      if (name === 'script' && attributes.includes(key) && !auditableLocalFormat(value, /\.[cm]?js$/i)) throw new Error('Prototype resource is not frozen: script references require auditable local JS text files (.js/.mjs/.cjs)');
      if (['iframe', 'embed', 'object'].includes(name) && attributes.includes(key) && !auditableLocalFormat(value, /\.(?:html?|svg)$/i)) throw new Error('Prototype resource is not frozen: embedded documents require auditable local HTML/SVG text files (.html/.htm/.svg)');
      if (['script', 'iframe', 'embed', 'object'].includes(name) && attributes.includes(key) && /^data:/i.test(value.trim().replace(/[\t\r\n]/g, ''))) throw new Error('Prototype resource is not frozen: executable data resources are not auditable; use vendored script/HTML files');

      if (name === 'iframe' && key === 'srcdoc') references.push(...htmlResourceReferences(value, depth + 1));
      if (cssResourceAttributes.has(key)) references.push(...cssResourceReferences(value));
      if (attributes.includes(key)) references.push(...(key.endsWith('srcset') ? srcsetReferences(value) : [value]));
    }
    // Complete inline JavaScript/import-map resolution needs a module parser.
    // Fail closed rather than freeze a SHA that can import mutable URLs.
    if (name === 'script' && (scriptType === 'importmap' || (scriptType === 'module' && !hasSource))) {
      throw new Error('Prototype resource is not frozen: inline modules and import maps are not auditable; use vendored module files with script src');
    }
    if (name === 'script') {
      const raw = rawTextBoundary(content, tag.index + tag[0].length, name);
      starts.lastIndex = raw.end;
      if (svgContent) auditSvgRawText(raw.body);
      if ((!hasSource || svgContent) && !['application/json', 'application/ld+json'].includes(scriptType)) auditJavaScript(svgContent ? decodeHtml(raw.body, { resource: true }) : raw.body);
    }
  }
  return references;
}

export async function gitSnapshot(repository, sha, config, { allowEmpty = false } = {}) {
  const subtree = config.source.path;
  let tree;
  try { tree = await git(repository, ['ls-tree', '-r', '-z', '--full-tree', subtree === '.' ? sha : `${sha}:${subtree}`]); }
  catch (error) {
    if (allowEmpty && /not a valid object name|not a tree object|does not exist/i.test(error.stderr ?? '')) tree = '';
    else throw new Error(`Prototype subtree ${subtree} is missing at ${sha}: ${error.message}`);
  }
  const files = Object.create(null), bytes = new Map();
  let total = 0;
  for (const record of tree.split('\0').filter(Boolean).sort((a, b) => a.split('\t')[1].localeCompare(b.split('\t')[1], 'en'))) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) throw new Error(`Unsupported prototype Git entry (symlink/submodule): ${record}`);
    const relative = match[4];
    if (relative.split('/').some(part => ['..', '.git', '.protoflow'].includes(part)) || relative.startsWith('/')) throw new Error(`Unsafe prototype path: ${relative}`);
    const content = await git(repository, ['cat-file', 'blob', match[3]], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 + 1 });
    total += content.length;
    if (content.length > 2 * 1024 * 1024 || total > 20 * 1024 * 1024 || bytes.size >= 1000) throw new Error('Git prototype exceeds snapshot limits');
    const file = path.posix.join(config.prototypeDir.split(path.sep).join('/'), relative);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { /* hash binary bytes */ }
    files[file] = { hash: hash(content), size: content.length, ...(text === undefined ? { binary: true } : { content: text }) };
    bytes.set(file, content);
  }
  if (!bytes.size && !allowEmpty) throw new Error(`Empty prototype subtree at ${sha}`);
  // Match the existing session snapshot's lexical file ordering exactly.
  const ordered = Object.assign(Object.create(null), Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  // Keep referenced static resources inside the checkpoint; mutable URLs cannot represent a fixed SHA.
  for (const [file, entry] of Object.entries(ordered)) {
    if (/\.(?:xml|xhtml|xht)$/i.test(file)) throw new Error(`Prototype resource is not frozen: XML/XHTML document formats are not auditable: ${file}`);
    if (typeof entry.content === 'string' && /<\?xml-stylesheet\b/i.test(entry.content)) throw new Error('Prototype resource is not frozen: XML stylesheet processing instructions are not auditable; use a vendored CSS link');
    if (/\.(?:html?|css|svg|[cm]?js)$/i.test(file) && typeof entry.content !== 'string') throw new Error(`Prototype resource is not frozen: auditable text file must be UTF-8: ${file}`);
    if (!entry.content) continue;
    const references = [];
    if (/\.(html?|svg)$/i.test(file)) references.push(...htmlResourceReferences(entry.content, 0, /\.svg$/i.test(file)));
    if (/\.css$/i.test(file)) references.push(...cssResourceReferences(entry.content));
    if (/\.[cm]?js$/i.test(file)) auditJavaScript(entry.content);
    for (let reference of references) {
      if (/[\\\u0000-\u001f\u007f]/.test(reference)) throw new Error('Prototype resource is not frozen: resource URLs cannot contain backslashes or control characters');
      reference = reference.trim();
      if (/^(?:data:|#)/i.test(reference)) continue;
      const resource = reference.split(/[?#]/)[0];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), resource));
      if (/^(?:[a-z]+:|\/)/i.test(resource) || !Object.hasOwn(ordered, resolved)) throw new Error(`Prototype resource is not frozen: ${file} -> ${reference}; vendor it inside source.path`);
    }
  }
  const result = { files: ordered, hash: snapshotHash(ordered) };
  Object.defineProperty(result, 'bytes', { value: bytes });
  return result;
}
async function publishCheckpoint(root, config, repository, sha, before, after, ordinal) {
  const manifestId = `git-${sha}`;
  const target = await projectPath(root, `.protoflow/manifests/${manifestId}.json`);
  const existing = await readJson(target, null);
  if (existing) {
    if (existing.afterHash !== after.hash || existing.source?.identity !== sourceIdentity(config.source)) throw new Error(`Conflicting checkpoint for ${sha}`);
    await loadVersion(root, config, existing);
    return existing;
  }
  // A crash before publishing a manifest leaves only this deterministic incomplete store.
  await fs.rm(await projectPath(root, `.protoflow/versions/${manifestId}`), { recursive: true, force: true });
  await freezeVersion(root, manifestId, after);
  const classification = classifyChanges(before, after, config);
  const subject = (await git(repository, ['show', '-s', '--format=%s', sha])).trim();
  const manifest = { schemaVersion: 1, version: 1, id: manifestId, sessionId: null, createdAt: new Date().toISOString(),
    summary: subject, beforeHash: before.hash, afterHash: after.hash, ...classification,
    source: { kind: 'git', identity: sourceIdentity(config.source), repository: config.source.repository, branch: config.source.branch, path: config.source.path, sha, ordinal },
    requires: { spec: ['L2', 'L3'].includes(classification.level), architecture: classification.level === 'L3', humanReview: config.policy?.requireHumanReview !== false },
    git: { available: true, head: sha, status: '', diff: classification.changes.map(change => change.diff).join('\n') },
    review: { required: config.policy?.requireHumanReview !== false, status: 'pending' } };
  await writeJson(target, manifest);
  return manifest;
}

/** Scan the first-parent branch stream. Advance the durable cursor only after each frozen checkpoint exists. */
export async function scanSource(root, config) {
  const source = config.source;
  const repository = await repositoryFor(root, source);
  let state = await sourceStatus(root);
  const identity = sourceIdentity(source);
  if (state.identity && state.identity !== identity) throw new Error('Source configuration changed; use a new explicitly initialized stream instead of reusing progress');
  state = { ...state, identity, repository: source.repository, branch: source.branch, path: source.path };
  try {
    await git(repository, ['-c', 'credential.interactive=false', 'fetch', '--no-tags', source.repository, `+refs/heads/${source.branch}:refs/protoflow/source`], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const tip = (await git(repository, ['rev-parse', 'refs/protoflow/source^{commit}'])).trim();
    const cursor = state.scannedSha ?? source.startSha ?? null;
    if (cursor) {
      const chain = (await git(repository, ['rev-list', '--first-parent', tip])).trim().split('\n');
      if (!chain.includes(cursor)) { const error = new Error(`SOURCE_HISTORY_REWRITTEN: ${cursor} is no longer on ${source.branch}'s first-parent history (${tip}); no versions were skipped`); error.code = 'SOURCE_HISTORY_REWRITTEN'; throw error; }
    }
    // A previous rewrite remains a durable barrier until fetch and ancestry
    // validation succeed; transport errors cannot authorize the old queue.
    state.status = 'READY'; state.error = null; state.lastScanError = null;
    const commits = cursor ? (await git(repository, ['rev-list', '--first-parent', '--reverse', `${cursor}..${tip}`])).trim().split('\n').filter(Boolean) : [tip];
    let before = cursor ? await gitSnapshot(repository, cursor, config, { allowEmpty: true }) : { files: {}, hash: snapshotHash({}) };
    const added = [];
    for (const sha of commits) {
      const after = await gitSnapshot(repository, sha, config, { allowEmpty: !!cursor });
      if (before.hash !== after.hash) {
        const manifest = await publishCheckpoint(root, config, repository, sha, before, after, state.entries.length + 1);
        if (!state.entries.some(entry => entry.sha === sha)) state.entries.push({ sha, manifestId: manifest.id, prototypeHash: manifest.afterHash, ordinal: manifest.source.ordinal, status: 'PENDING', attempts: [] });
        added.push(manifest.id);
      }
      state.scannedSha = sha;
      state.status = 'READY'; state.error = null; state.lastScanAt = new Date().toISOString();
      await saveSourceState(root, state);
      before = after;
    }
    state.scannedSha = tip; state.status = 'READY'; state.error = null; state.lastScanAt = new Date().toISOString();
    await saveSourceState(root, state);
    return { status: 'PASS', tip, added, state };
  } catch (error) {
    if (error.code === 'SOURCE_HISTORY_REWRITTEN') {
      state.status = 'HISTORY_REWRITTEN'; state.error = error.message;
    } else if (state.status !== 'HISTORY_REWRITTEN') {
      state.status = 'SCAN_FAILED'; state.error = error.message;
    }
    state.lastScanError = error.message; await saveSourceState(root, state);
    throw error;
  }
}
