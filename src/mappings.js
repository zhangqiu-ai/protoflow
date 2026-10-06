import path from 'node:path';
import { snapshot, patternMatches } from './sessions.js';

const PAGE = /\.html?$/i;
const quoted = String.raw`\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`;
const HTML_REFERENCES = [
  new RegExp(String.raw`<link\b[^>]*?\bhref${quoted}`, 'gi'),
  new RegExp(String.raw`<(?:script|img|source|video|audio|iframe|embed|track|input)\b[^>]*?\bsrc${quoted}`, 'gi'),
  new RegExp(String.raw`<(?:img|source)\b[^>]*?\bsrcset${quoted}`, 'gi'),
];
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_REFERENCES = [/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi, /url\(\s*["']?([^"')]+?)["']?\s*\)/gi];
const JS_REFERENCES = [/\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];

function matches(text, expressions) {
  const found = [];
  for (const expression of expressions) {
    for (const match of text.matchAll(expression)) {
      const value = match.slice(1).find(group => group !== undefined);
      if (value) found.push(value);
    }
  }
  return found;
}

function references(file, content) {
  const extension = path.extname(file).toLowerCase();
  if (PAGE.test(file)) {
    const srcset = /srcset/i;
    const values = [];
    for (const expression of HTML_REFERENCES) {
      for (const value of matches(content, [expression])) {
        values.push(...(srcset.test(expression.source) ? value.split(',').map(entry => entry.trim().split(/\s+/)[0]) : [value]));
      }
    }
    for (const [, css] of content.matchAll(STYLE_BLOCK)) values.push(...matches(css, CSS_REFERENCES));
    return values;
  }
  if (extension === '.css') return matches(content, CSS_REFERENCES);
  if (['.js', '.mjs'].includes(extension)) return matches(content, JS_REFERENCES);
  return [];
}

/** Resolve a reference to a prototype snapshot path; external, data and fragment URLs are not resources. */
function resolve(prototypeDir, file, reference) {
  const value = reference.trim().replace(/[?#].*$/, '');
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(reference.trim()) || reference.trim().startsWith('//') || reference.trim().startsWith('#')) return null;
  const base = value.startsWith('/') ? prototypeDir : path.posix.dirname(file);
  return path.posix.normalize(path.posix.join(base, value.replace(/^\/+/, '')));
}

function slug(prototypeDir, page) {
  const relative = path.posix.relative(prototypeDir, page).replace(/\.html?$/i, '');
  return relative.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
}

/**
 * Draft mappings from the target project's own prototype pages and the resources they reference.
 * Application selectors and component paths are left null: only the developer knows their components.
 */
export async function suggestMappings(root, config) {
  const prototypeDir = path.posix.normalize(config.prototypeDir.split(path.sep).join('/')).replace(/\/+$/, '');
  const { files } = await snapshot(root, config);
  const pages = [];
  const referenced = new Set();
  for (const page of Object.keys(files).filter(file => PAGE.test(file)).sort()) {
    const resources = new Set();
    const unresolved = new Set();
    const queue = [page];
    while (queue.length) {
      const current = queue.shift();
      const content = files[current]?.content;
      if (content === undefined) continue;
      for (const reference of references(current, content)) {
        const target = resolve(prototypeDir, current, reference);
        if (target === null) continue;
        if (!files[target]) { unresolved.add(reference); continue; }
        if (target === page || resources.has(target)) continue;
        resources.add(target);
        referenced.add(target);
        // Follow stylesheet and module graphs; linked pages are navigation, not dependencies.
        if (!PAGE.test(target)) queue.push(target);
      }
    }
    pages.push({ path: page, resources: [...resources].sort(), unresolved: [...unresolved].sort() });
  }
  const consumers = new Map();
  for (const page of pages) for (const resource of page.resources) consumers.set(resource, [...(consumers.get(resource) ?? []), page.path]);
  const pagePaths = new Set(pages.map(page => page.path));
  const configured = config.mappings ?? [];
  return {
    status: 'DRAFT',
    prototypeDir,
    pages,
    sharedResources: [...consumers].filter(([, users]) => users.length > 1).map(([resource, users]) => ({ path: resource, pages: users })).sort((a, b) => a.path.localeCompare(b.path)),
    orphanFiles: Object.keys(files).filter(file => !pagePaths.has(file) && !referenced.has(file)).sort(),
    unmappedFiles: Object.keys(files).filter(file => !configured.some(mapping => mapping.prototypeFiles.some(pattern => patternMatches(pattern, file)))).sort(),
    mappings: pages.map(page => ({ id: slug(prototypeDir, page.path), prototypeFiles: [page.path, ...page.resources], prototype: null, application: null, component: null })),
    notice: '草稿只依原型頁面及其引用資源產生，不會寫入配置。依目標專案實際元件填寫 component、prototype／application selector；一個頁面可拆成多筆 mapping，間接影響布局的共用資源與 orphanFiles 需人工判斷是否列入。',
  };
}
