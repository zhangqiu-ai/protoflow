import path from 'node:path';
import Ajv from 'ajv';
import { patternMatches } from './sessions.js';

export const EXTRACTOR_VERSION = '1.0.0';
export const ANCHOR_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
export const ROLES = ['screen', 'region', 'element', 'action', 'input'];
export const ACTIONS = ['tap', 'fill', 'clear', 'select', 'toggle', 'scroll-to', 'back', 'wait-for'];
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
// Start tags that implicitly close an open element of the same kind, as browsers do.
const SELF_NESTING = new Set(['p', 'li', 'option', 'tr', 'td', 'th', 'dt', 'dd']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export const sidecarSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'screen'],
  properties: {
    schemaVersion: { const: 1 },
    screen: { type: 'string', pattern: ANCHOR_ID.source },
    states: { type: 'object', propertyNames: { pattern: '^[a-z][a-z0-9-]*$' }, additionalProperties: {
      type: 'object', additionalProperties: false,
      properties: {
        from: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
        fixture: { type: 'string', minLength: 1 },
        steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['action'], properties: {
          action: { enum: ACTIONS }, anchor: { type: 'string', pattern: ANCHOR_ID.source }, value: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 }
        } } },
        expect: { type: 'object', additionalProperties: false, properties: {
          visible: { type: 'array', items: { type: 'string', pattern: ANCHOR_ID.source } },
          hidden: { type: 'array', items: { type: 'string', pattern: ANCHOR_ID.source } }
        } }
      }
    } },
    fixtures: { type: 'object', additionalProperties: { type: 'object' } }
  }
};
const validateSidecar = new Ajv({ allErrors: true, strict: false }).compile(sidecarSchema);

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}
export const normalizeText = text => decode(String(text ?? '')).replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

function parseAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attributes[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * Minimal HTML tokenizer for anchor extraction. Prototype HTML already passed the source audit, so it only needs
 * to follow tags, nesting and text; it is not a general HTML5 parser.
 */
export function parseAnchors(html) {
  const anchors = [];
  const stack = [];
  const errors = [];
  const tagPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/gi;
  let cursor = 0;
  // Each anchor records its own text only: text inside a nested anchor belongs to that anchor, so a change to a
  // child does not mark every ancestor (and the screen) as changed.
  const addText = text => {
    if (!text) return;
    const innermost = [...stack].reverse().find(entry => entry.anchor);
    if (innermost) innermost.anchor.textParts.push(text);
  };
  let match;
  while ((match = tagPattern.exec(html))) {
    addText(html.slice(cursor, match.index));
    cursor = tagPattern.lastIndex;
    if (match[1]) {
      const name = match[1].toLowerCase();
      const index = stack.map(entry => entry.name).lastIndexOf(name);
      if (index !== -1) stack.length = index;
      continue;
    }
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    const attributes = parseAttributes(match[3] ?? '');
    if (SELF_NESTING.has(name) && stack.at(-1)?.name === name) stack.pop();
    let anchor = null;
    if ('data-pf' in attributes) {
      const parent = [...stack].reverse().find(entry => entry.anchor)?.anchor ?? null;
      const role = attributes['data-pf-role'] || 'element';
      anchor = {
        id: attributes['data-pf'], role, parent: parent?.id ?? null,
        order: parent ? parent.children++ : anchors.filter(item => item.parent === null).length,
        repeat: 'data-pf-repeat' in attributes, dynamic: attributes['data-pf-text'] === 'dynamic', visualOnly: 'data-pf-visual-only' in attributes,
        tag: name, inputType: name === 'input' ? (attributes.type || 'text').toLowerCase() : null,
        // Source offsets let `anchors suggest` and diagnostics point at the exact start tag.
        offset: match.index, children: 0, textParts: []
      };
      if (!ANCHOR_ID.test(anchor.id)) errors.push(`Invalid anchor id "${anchor.id}"`);
      if (!ROLES.includes(role)) errors.push(`Invalid data-pf-role "${role}" on ${anchor.id}`);
      anchors.push(anchor);
    }
    const selfClosing = VOID.has(name) || match[4] === '/';
    if (RAW_TEXT.has(name) && !selfClosing) {
      const close = html.toLowerCase().indexOf(`</${name}`, cursor);
      const body = close === -1 ? html.slice(cursor) : html.slice(cursor, close);
      // Only visible raw text (textarea/title) contributes to anchor text; scripts and styles never do.
      if (anchor && name === 'textarea') anchor.textParts.push(body);
      cursor = close === -1 ? html.length : close;
      tagPattern.lastIndex = cursor;
      if (anchor) stack.push({ name, anchor });
      continue;
    }
    if (!selfClosing) stack.push({ name, anchor });
  }
  addText(html.slice(cursor));
  return {
    anchors: anchors.map(({ textParts, children, ...anchor }) => ({ ...anchor, text: anchor.dynamic ? null : normalizeText(textParts.join(' ')) })),
    errors
  };
}

const sidecarPathFor = page => page.replace(/\.html?$/i, '.pf.json');

/** Resolve a state's full step list through its `from` chain; cycles and unknown parents are lint errors. */
function resolveStates(sidecar, errors) {
  const declared = { initial: {}, ...(sidecar?.states ?? {}) };
  const resolved = {};
  const visit = (name, trail = []) => {
    if (resolved[name]) return resolved[name];
    if (trail.includes(name)) { errors.push(`State cycle: ${[...trail, name].join(' -> ')}`); return null; }
    const state = declared[name];
    if (!state) { errors.push(`Unknown state "${name}"${trail.length ? ` referenced from ${trail.at(-1)}` : ''}`); return null; }
    const parent = state.from ? visit(state.from, [...trail, name]) : null;
    if (state.from && !parent) return null;
    resolved[name] = {
      fixture: state.fixture ?? parent?.fixture ?? null,
      steps: [...(parent?.steps ?? []), ...(state.steps ?? [])],
      expect: { visible: state.expect?.visible ?? [], hidden: state.expect?.hidden ?? [] }
    };
    return resolved[name];
  };
  for (const name of Object.keys(declared)) visit(name);
  for (const [name, state] of Object.entries(resolved)) {
    if (state.fixture && !sidecar?.fixtures?.[state.fixture]) errors.push(`State "${name}" uses undefined fixture "${state.fixture}"`);
  }
  return resolved;
}

function htmlReferences(content) {
  const references = [];
  for (const match of content.matchAll(/<(?:link|script|img|source|video|audio|iframe|embed|use|image)\b[^>]*?\s(?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) references.push(match[1] ?? match[2] ?? match[3]);
  for (const match of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) references.push(match[1] ?? match[2]);
  return references;
}
function localResource(file, reference, files) {
  const clean = String(reference ?? '').trim().split(/[?#]/)[0];
  if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(clean)) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
  return Object.hasOwn(files, resolved) ? resolved : null;
}
/** Files each page loads, transitively through stylesheets and scripts. */
function resourceGraph(page, files) {
  const seen = new Set();
  const queue = [page];
  while (queue.length) {
    const file = queue.shift();
    const content = files[file]?.content;
    if (typeof content !== 'string') continue;
    for (const reference of htmlReferences(content)) {
      const resolved = localResource(file, reference, files);
      if (resolved && resolved !== page && !seen.has(resolved)) { seen.add(resolved); queue.push(resolved); }
    }
    if (/\.[cm]?js$/i.test(file)) {
      for (const match of content.matchAll(/(?:import|from)\s*["']([^"']+)["']/g)) {
        const resolved = localResource(file, match[1], files);
        if (resolved && !seen.has(resolved)) { seen.add(resolved); queue.push(resolved); }
      }
    }
  }
  return [...seen].sort();
}

/**
 * Static UI contract: screens, anchors, sidecar states and resource consumers parsed from a prototype snapshot.
 * Deterministic and browser-free, so checkpoints and scans can compute it; rendered measurements are verification evidence.
 */
export function staticContract(snapshot, config) {
  const files = snapshot.files ?? {};
  const options = config.anchors ?? {};
  const ignore = options.ignore ?? [];
  const errors = [];
  const warnings = [];
  const screens = {};
  const pages = {};
  for (const page of Object.keys(files).filter(file => /\.html?$/i.test(file)).sort()) {
    if (ignore.some(pattern => patternMatches(pattern, page))) continue;
    const content = files[page].content;
    if (typeof content !== 'string') { errors.push(`${page}: HTML must be UTF-8 text`); continue; }
    const parsed = parseAnchors(content);
    errors.push(...parsed.errors.map(message => `${page}: ${message}`));
    const screenAnchors = parsed.anchors.filter(anchor => anchor.role === 'screen');
    if (screenAnchors.length !== 1) {
      if (options.requireScreenAnchor !== false || screenAnchors.length > 1) errors.push(`${page}: expected exactly one data-pf-role="screen" anchor, found ${screenAnchors.length}`);
      continue;
    }
    const screen = screenAnchors[0].id;
    if (screens[screen]) { errors.push(`${page}: screen "${screen}" is already defined by ${screens[screen].page}`); continue; }
    const counts = new Map();
    for (const anchor of parsed.anchors) if (!anchor.repeat) counts.set(anchor.id, (counts.get(anchor.id) ?? 0) + 1);
    for (const [id, count] of counts) if (count > 1) errors.push(`${page}: anchor "${id}" appears ${count} times; mark list items with data-pf-repeat`);
    for (const anchor of parsed.anchors) {
      if (anchor.role !== 'screen' && anchor.id !== screen && !anchor.id.startsWith(`${screen}.`)) warnings.push(`${page}: anchor "${anchor.id}" is not namespaced under screen "${screen}"`);
    }
    const sidecarFile = sidecarPathFor(page);
    let sidecar = null;
    if (files[sidecarFile]) {
      try { sidecar = JSON.parse(files[sidecarFile].content); }
      catch (error) { errors.push(`${sidecarFile}: invalid JSON (${error.message})`); }
      if (sidecar && !validateSidecar(sidecar)) { errors.push(`${sidecarFile}: ${JSON.stringify(validateSidecar.errors)}`); sidecar = null; }
      if (sidecar && sidecar.screen !== screen) errors.push(`${sidecarFile}: screen "${sidecar.screen}" does not match page screen "${screen}"`);
    }
    const stateErrors = [];
    const states = resolveStates(sidecar, stateErrors);
    errors.push(...stateErrors.map(message => `${sidecarFile}: ${message}`));
    const known = new Set(parsed.anchors.map(anchor => anchor.id));
    for (const [name, state] of Object.entries(states)) {
      for (const id of [...state.steps.map(step => step.anchor).filter(Boolean), ...state.expect.visible, ...state.expect.hidden]) {
        // Script-created elements are legal; the verifier reports them if they never appear.
        if (!known.has(id)) warnings.push(`${sidecarFile}: state "${name}" references "${id}", which is not in the static HTML`);
      }
    }
    screens[screen] = {
      page, sidecar: files[sidecarFile] ? sidecarFile : null,
      anchors: parsed.anchors.map(({ offset, ...anchor }) => anchor),
      states,
      fixtures: sidecar?.fixtures ?? {},
      resources: resourceGraph(page, files)
    };
    pages[page] = screen;
  }
  return { schemaVersion: 1, extractorVersion: EXTRACTOR_VERSION, screens, pages, errors, warnings };
}

export class AnchorLintError extends Error {
  constructor(errors) {
    super(`Prototype anchors are invalid:\n- ${errors.join('\n- ')}`);
    this.code = 'ANCHOR_LINT';
    this.errors = errors;
  }
}

const anchorFields = ['role', 'parent', 'order', 'repeat', 'dynamic', 'visualOnly', 'tag', 'inputType', 'text'];

/** Scope of a version: which screens, anchors and states changed, from static contracts plus file-level changes. */
export function contractScope(before, after, changedFiles) {
  const screens = {};
  const ensure = id => screens[id] ??= { status: 'changed', reasons: [], anchors: { added: [], removed: [], changed: [] }, states: { added: [], removed: [], changed: [] }, lowPrecision: false };
  for (const [id, screen] of Object.entries(after.screens)) {
    const previous = before.screens[id];
    if (!previous) { Object.assign(ensure(id), { status: 'added' }).reasons.push('new screen'); continue; }
    const left = new Map(previous.anchors.map(anchor => [`${anchor.id}#${anchor.repeat ? 'r' : 's'}`, anchor]));
    const right = new Map(screen.anchors.map(anchor => [`${anchor.id}#${anchor.repeat ? 'r' : 's'}`, anchor]));
    for (const [key, anchor] of right) {
      const old = left.get(key);
      if (!old) ensure(id).anchors.added.push(anchor.id);
      else {
        const fields = anchorFields.filter(field => JSON.stringify(old[field]) !== JSON.stringify(anchor[field]));
        if (fields.length) ensure(id).anchors.changed.push({ id: anchor.id, fields });
      }
    }
    for (const [key, anchor] of left) if (!right.has(key)) ensure(id).anchors.removed.push(anchor.id);
    for (const name of Object.keys(screen.states)) {
      if (!previous.states[name]) ensure(id).states.added.push(name);
      else if (JSON.stringify(previous.states[name]) !== JSON.stringify(screen.states[name])) ensure(id).states.changed.push(name);
    }
    for (const name of Object.keys(previous.states)) if (!screen.states[name]) ensure(id).states.removed.push(name);
    if (JSON.stringify(previous.fixtures) !== JSON.stringify(screen.fixtures)) ensure(id).reasons.push('fixtures changed');
    if (screens[id]) screens[id].reasons.push('anchors or states changed');
    // File changes without a contract difference still affect rendering; record them at screen precision.
    const touched = changedFiles.filter(file => file === screen.page || file === screen.sidecar || screen.resources.includes(file) || previous.resources.includes(file));
    if (touched.length) {
      const entry = ensure(id);
      entry.reasons.push(...touched.map(file => file === screen.page ? `page changed: ${file}` : `resource changed: ${file}`));
      const hasAnchorDiff = entry.anchors.added.length || entry.anchors.removed.length || entry.anchors.changed.length || entry.states.added.length || entry.states.changed.length;
      if (!hasAnchorDiff) entry.lowPrecision = true;
    }
  }
  for (const id of Object.keys(before.screens)) if (!after.screens[id]) Object.assign(ensure(id), { status: 'removed' }).reasons.push('screen removed');
  for (const entry of Object.values(screens)) entry.reasons = [...new Set(entry.reasons)];
  const accounted = new Set(Object.values(after.screens).flatMap(screen => [screen.page, screen.sidecar, ...screen.resources]).concat(Object.values(before.screens).flatMap(screen => [screen.page, screen.sidecar, ...screen.resources])).filter(Boolean));
  return {
    screens,
    affected: Object.entries(screens).filter(([, entry]) => entry.status !== 'removed').map(([id]) => id).sort(),
    removed: Object.entries(screens).filter(([, entry]) => entry.status === 'removed').map(([id]) => id).sort(),
    // Changed prototype files no screen consumes (for example an unused asset); reported, never silently dropped.
    unscreened: changedFiles.filter(file => !accounted.has(file)).sort()
  };
}

/** Contract-derived minimum level: new interactions or states are at least L1. Rules elsewhere may only raise it. */
export function scopeLevel(scope, after) {
  for (const [id, entry] of Object.entries(scope.screens)) {
    if (entry.status === 'removed') continue;
    const anchors = after.screens[id]?.anchors ?? [];
    const interactive = new Set(anchors.filter(anchor => ['action', 'input'].includes(anchor.role)).map(anchor => anchor.id));
    if (entry.status === 'added' || entry.states.added.length || entry.states.changed.length || entry.anchors.added.some(anchorId => interactive.has(anchorId))
      || entry.anchors.changed.some(change => change.fields.includes('role') && interactive.has(change.id))) return 'L1';
  }
  return 'L0';
}

const slug = value => normalizeText(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
const REGION_TAGS = new Set(['header', 'nav', 'main', 'section', 'aside', 'footer', 'form', 'article', 'dialog']);
const ELEMENT_TAGS = new Set(['h1', 'h2', 'h3', 'button', 'a', 'input', 'textarea', 'select', 'img', 'label', 'ul', 'ol', 'table']);

/**
 * Draft anchor attributes for a page that lacks them. Returns the edited HTML; callers turn it into a patch.
 * Suggestions are drafts: designers own the final IDs.
 */
export function suggestAnchors(page, html) {
  const existing = parseAnchors(html).anchors;
  const used = new Set(existing.map(anchor => anchor.id));
  const unique = base => { let id = base; for (let n = 2; used.has(id); n++) id = `${base}-${n}`; used.add(id); return id; };
  const screenAnchor = existing.find(anchor => anchor.role === 'screen');
  const screen = screenAnchor?.id ?? unique(slug(path.posix.basename(page).replace(/\.html?$/i, '')) || 'screen');
  const insertions = [];
  const suggestions = [];
  const tagPattern = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let screenPlaced = Boolean(screenAnchor);
  let match;
  while ((match = tagPattern.exec(html))) {
    const name = match[1].toLowerCase();
    const attributes = parseAttributes(match[2] ?? '');
    if ('data-pf' in attributes || RAW_TEXT.has(name) && name !== 'textarea') continue;
    const at = match.index + 1 + match[1].length;
    if (!screenPlaced && name === 'body') {
      // The screen is the whole page, so every anchor (navigation included) lies inside it.
      insertions.push({ at, text: ` data-pf="${screen}" data-pf-role="screen"` });
      suggestions.push({ id: screen, role: 'screen', tag: name });
      screenPlaced = true;
      continue;
    }
    let role = null;
    if (REGION_TAGS.has(name) && name !== 'main') role = 'region';
    else if (['button'].includes(name) || name === 'a' || name === 'input' && ['submit', 'button'].includes(attributes.type)) role = 'action';
    else if (['input', 'textarea', 'select'].includes(name)) role = 'input';
    else if (ELEMENT_TAGS.has(name)) role = 'element';
    if (!role) continue;
    const close = html.toLowerCase().indexOf(`</${name}`, tagPattern.lastIndex);
    const inner = close === -1 || VOID.has(name) ? '' : html.slice(tagPattern.lastIndex, close).replace(/<[^>]+>/g, ' ');
    // Regions are named by explicit labels only; their inner text belongs to their children.
    const label = attributes.id || attributes.name || attributes['aria-label'] || attributes.alt || attributes.placeholder || (role === 'region' ? name : inner) || name;
    const id = unique(`${screen}.${slug(label) || name}`);
    insertions.push({ at, text: ` data-pf="${id}"${role === 'element' ? '' : ` data-pf-role="${role}"`}` });
    suggestions.push({ id, role, tag: name });
  }
  let edited = html;
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) edited = edited.slice(0, insertion.at) + insertion.text + edited.slice(insertion.at);
  return { page, screen, suggestions, html: edited, sidecar: { schemaVersion: 1, screen, states: {}, fixtures: {} } };
}

/** Unified diff for edits that keep line counts (attribute insertions), suitable for `git apply`. */
export function lineDiff(file, before, after, context = 3) {
  const terminated = before.endsWith('\n');
  if (terminated !== after.endsWith('\n')) throw new Error('lineDiff requires the same trailing newline');
  const left = before.split('\n');
  const right = after.split('\n');
  // A trailing newline is a terminator, not an empty last line.
  if (terminated) { left.pop(); right.pop(); }
  if (left.length !== right.length) throw new Error('lineDiff requires equal line counts');
  const last = left.length - 1;
  const noNewline = index => !terminated && index === last ? ['\\ No newline at end of file'] : [];
  const changed = left.map((line, index) => line !== right[index]);
  const hunks = [];
  for (let index = 0; index < left.length; index++) {
    if (!changed[index]) continue;
    const start = Math.max(0, index - context);
    let end = index;
    while (end + 1 < left.length && (changed[end + 1] || changed.slice(end + 1, end + 1 + context * 2).some(Boolean))) end++;
    end = Math.min(left.length - 1, end + context);
    if (hunks.length && start <= hunks.at(-1).end + 1) hunks.at(-1).end = end; else hunks.push({ start, end });
    index = end;
  }
  if (!hunks.length) return '';
  const lines = [`--- a/${file}`, `+++ b/${file}`];
  for (const { start, end } of hunks) {
    const count = end - start + 1;
    lines.push(`@@ -${start + 1},${count} +${start + 1},${count} @@`);
    for (let index = start; index <= end; index++) {
      if (changed[index]) lines.push(`-${left[index]}`, ...noNewline(index), `+${right[index]}`, ...noNewline(index));
      else lines.push(` ${left[index]}`, ...noNewline(index));
    }
  }
  return `${lines.join('\n')}\n`;
}
