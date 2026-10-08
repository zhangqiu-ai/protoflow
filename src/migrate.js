import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAnchors, suggestAnchors, lineDiff, staticContract } from './anchors.js';
import { patternMatches } from './sessions.js';
import { projectPath } from './util.js';

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'region';

/** Simple selectors that map to one attribute: #id, [attr=value], [attr='value'], [attr="value"]. */
function selectorAttribute(selector) {
  let match = /^#([A-Za-z][\w-]*)$/.exec(selector.trim());
  if (match) return { name: 'id', value: match[1] };
  match = /^\[([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\]$/.exec(selector.trim());
  return match ? { name: match[1].toLowerCase(), value: match[2] ?? match[3] ?? match[4] } : null;
}

/** Insert an attribute into the first start tag carrying name="value"; null when absent or ambiguous. */
function insertAttribute(html, { name, value }, attribute, id) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<([a-zA-Z][\\w-]*)(?=[^>]*\\s${name}\\s*=\\s*["']?${escaped}["'\\s>/])[^>]*>`, 'g');
  const matches = [...html.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const tag = matches[0];
  if (new RegExp(`\\s${attribute}\\s*=`).test(tag[0])) return html;
  const at = tag.index + 1 + tag[1].length;
  return `${html.slice(0, at)} ${attribute}="${id}"${html.slice(at)}`;
}

/** Derive a urlTemplate from a v1 scene by locating the prototype page name inside the application URL. */
function urlTemplate(scene, prototypeDir) {
  if (!scene) return { template: null, note: 'no v1 scenes; set driver.urlTemplate manually' };
  const pathname = (/^https?:/.test(scene.prototypeUrl) ? new URL(scene.prototypeUrl).pathname : scene.prototypeUrl).split(/[?#]/)[0];
  const marker = `${prototypeDir}/`;
  const at = pathname.indexOf(marker);
  const page = (at === -1 ? path.posix.basename(pathname) : pathname.slice(at + marker.length)).replace(/\.html?$/i, '');
  for (const candidate of [page, path.posix.basename(page)]) {
    if (candidate && scene.applicationUrl.includes(candidate)) return { template: scene.applicationUrl.replace(candidate, '{page}'), note: null };
  }
  return { template: scene.applicationUrl, note: `could not locate "${page}" in ${scene.applicationUrl}; template points at one screen only` };
}

/**
 * Draft a v1 → v2 migration: anchor attributes for the prototype, data-testid attributes for mapped application
 * elements, and a schemaVersion 2 config. Nothing is written into the prototype or application.
 */
export async function migrateAnchors(root, config, prototypeFiles) {
  if (config.schemaVersion !== 1) throw new Error('migrate anchors reads a schemaVersion 1 config');
  const prototypeDir = config.prototypeDir.split(path.sep).join('/');
  const pages = Object.keys(prototypeFiles).filter(file => /\.html?$/i.test(file) && typeof prototypeFiles[file].content === 'string').sort();
  const edited = Object.fromEntries(pages.map(page => [page, prototypeFiles[page].content]));
  const screens = {};
  const manual = [];
  for (const page of pages) {
    const existing = parseAnchors(edited[page]).anchors.find(anchor => anchor.role === 'screen');
    if (existing) { screens[page] = existing.id; continue; }
    // Reuse suggest only for the screen anchor; element anchors come from the existing mappings.
    const suggestion = suggestAnchors(page, edited[page]);
    const screen = suggestion.suggestions.find(item => item.role === 'screen');
    if (!screen) { manual.push(`${page}: no <body> to carry the screen anchor`); continue; }
    const tag = new RegExp(`<${screen.tag}\\b`, 'i').exec(edited[page]);
    const at = tag.index + 1 + screen.tag.length;
    edited[page] = `${edited[page].slice(0, at)} data-pf="${screen.id}" data-pf-role="screen"${edited[page].slice(at)}`;
    screens[page] = screen.id;
  }
  const application = {};
  const anchors = [];
  for (const mapping of config.mappings) {
    const htmlPages = pages.filter(page => mapping.prototypeFiles.some(pattern => patternMatches(pattern, page)));
    const prototypeTarget = selectorAttribute(mapping.prototype);
    const placed = [];
    for (const page of htmlPages) {
      if (!screens[page]) continue;
      const id = `${screens[page]}.${slug(mapping.id)}`;
      const updated = prototypeTarget ? insertAttribute(edited[page], prototypeTarget, 'data-pf', id) : null;
      if (updated) { edited[page] = updated; placed.push({ page, id }); }
    }
    if (!placed.length) { manual.push(`mapping ${mapping.id}: prototype selector ${mapping.prototype} needs a data-pf anchor added by hand`); continue; }
    const applicationTarget = selectorAttribute(mapping.application);
    // The mapped element may live in the component or in the application page a v1 scene showed it on.
    const sceneFiles = (config.visual?.scenes ?? []).filter(scene => scene.mappings?.includes(mapping.id))
      .map(scene => (/^https?:/.test(scene.applicationUrl) ? new URL(scene.applicationUrl).pathname.replace(/^\/+/, '') : scene.applicationUrl).split(/[?#]/)[0]);
    const candidates = [...new Set([mapping.component, ...sceneFiles])];
    for (const file of candidates) {
      if (application[file] !== undefined) continue;
      try { const source = await readFile(await projectPath(root, file), 'utf8'); application[file] = { before: source, after: source }; }
      catch { application[file] = null; }
    }
    for (const { id } of placed) {
      anchors.push({ mapping: mapping.id, anchor: id, prototypeSelector: mapping.prototype, applicationSelector: mapping.application, component: mapping.component });
      const file = applicationTarget && candidates.find(candidate => application[candidate] && insertAttribute(application[candidate].after, applicationTarget, 'data-testid', id) !== null);
      if (file) application[file].after = insertAttribute(application[file].after, applicationTarget, 'data-testid', id);
      else manual.push(`mapping ${mapping.id}: add data-testid="${id}" to the element matching ${mapping.application} (searched ${candidates.join(', ')})`);
    }
  }
  // Application screens: the page the URL template resolves to carries the screen anchor on <body>.
  const { template, note } = urlTemplate(config.visual?.scenes?.[0], prototypeDir);
  for (const [page, screen] of Object.entries(screens)) {
    if (!template) break;
    const relative = path.posix.relative(prototypeDir, page).replace(/\.html?$/i, '');
    const filled = template.replaceAll('{page}', relative).replaceAll('{screen}', screen);
    const file = (/^https?:/.test(filled) ? new URL(filled).pathname.replace(/^\/+/, '') : filled).split(/[?#]/)[0];
    if (application[file] === undefined) {
      try { const source = await readFile(await projectPath(root, file), 'utf8'); application[file] = { before: source, after: source }; }
      catch { application[file] = null; }
    }
    const body = application[file] && /<body\b/i.exec(application[file].after);
    if (body && !/<body\b[^>]*\sdata-testid=/i.test(application[file].after)) {
      const at = body.index + 5;
      application[file].after = `${application[file].after.slice(0, at)} data-testid="${screen}"${application[file].after.slice(at)}`;
    } else if (!body) manual.push(`screen ${screen}: add data-testid="${screen}" to the application page for ${page} (${file})`);
  }
  const prototypePatch = pages.map(page => edited[page] === prototypeFiles[page].content ? '' : lineDiff(page, prototypeFiles[page].content, edited[page])).join('');
  const applicationPatch = Object.entries(application).filter(([, entry]) => entry && entry.before !== entry.after).map(([file, { before, after }]) => lineDiff(file, before, after)).join('');
  const firstScene = config.visual?.scenes?.[0];
  if (note) manual.push(note);
  const draft = {
    schemaVersion: 2, prototypeDir: config.prototypeDir,
    anchors: { attribute: 'data-pf', requireScreenAnchor: true },
    targets: [{
      id: 'web', platform: 'web', root: '.',
      driver: { kind: 'playwright-web', urlTemplate: template ?? '<application url with {page} or {screen}>' },
      build: config.verification?.build ?? null, functional: config.verification?.functional ?? null,
      viewport: firstScene ? { width: firstScene.viewport.width, height: firstScene.viewport.height, scale: firstScene.deviceScaleFactor ?? 1 } : undefined,
      visual: { mode: 'pixel', maxDiffRatio: config.visual?.maxDiffRatio ?? 0.01, pixelThreshold: config.visual?.pixelThreshold ?? 0.1 }
    }],
    ...Object.fromEntries(['source', 'runner', 'classification', 'policy', 'watch', 'adapters'].filter(key => config[key]).map(key => [key, config[key]]))
  };
  if (!draft.targets[0].viewport) delete draft.targets[0].viewport;
  const migratedContract = staticContract({ files: Object.fromEntries(Object.entries(prototypeFiles).map(([file, entry]) => [file, edited[file] === undefined ? entry : { ...entry, content: edited[file] }])) }, draft);
  return {
    status: 'DRAFT', screens: Object.values(screens), anchors,
    prototypePatch, applicationPatch, config: draft, manual,
    // Lint of the prototype as it would look after applying prototypePatch.
    lint: { errors: migratedContract.errors, warnings: migratedContract.warnings },
    notice: 'Drafts only. Apply prototypePatch in the prototype source (a new prototype version), have the executor or a developer apply applicationPatch, review the config draft, then switch schemaVersion.'
  };
}
