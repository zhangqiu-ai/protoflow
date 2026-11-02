import { validateScrollSteps, webScrollEnd } from './scroll-alignment.js';
/*
 * Playwright capture of one screen state, located purely by anchor attributes. The prototype side uses `data-pf`;
 * a web or Electron target uses its own testability attribute (default `data-testid`).
 */

const locate = (attribute, id) => `[${attribute}="${id}"]`;

async function perform(page, attribute, step) {
  const target = step.anchor ? page.locator(locate(attribute, step.anchor)).first() : null;
  const timeout = step.timeoutMs ?? 10000;
  switch (step.action) {
    case 'tap': return target.click({ timeout });
    case 'fill': return target.fill(String(step.value ?? ''), { timeout });
    case 'clear': return target.fill('', { timeout });
    case 'select': return target.selectOption(String(step.value ?? ''), { timeout });
    case 'toggle': return target.click({ timeout });
    case 'scroll-to': return ['start', 'end'].includes(step.value) ? webScrollEnd(page, attribute, step.anchor, { execute: true, endpoint: step.value }) : target.scrollIntoViewIfNeeded({ timeout });
    case 'back': return page.goBack({ timeout });
    case 'wait-for': return target.waitFor({ state: 'visible', timeout });
    default: throw new Error(`Unsupported step action: ${step.action}`);
  }
}

async function settle(page, timeout) {
  await page.waitForFunction(() => document.fonts.status === 'loaded' && [...document.images].every(image => image.complete), undefined, { timeout });
  await page.evaluate(async limit => {
    const failed = [...document.images].find(image => image.currentSrc && image.naturalWidth === 0);
    if (failed) throw new Error(`Image failed: ${failed.currentSrc}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Visual readiness timed out')), limit);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
    });
  }, timeout);
}

/** Element facts for each anchor; runs in the page. */
function inspect({ attribute, ids, dynamicText = [], dynamicAnchors = [] }) {
  const all = [...document.querySelectorAll(`[${attribute}]`)];
  const interactiveTags = ['BUTTON', 'SELECT', 'SUMMARY', 'TEXTAREA'];
  // Every input control a user can set counts as editable (text, checkbox, radio, range, file, colour...).
  const nonEditableTypes = ['hidden', 'button', 'submit', 'reset', 'image'];
  const textEntryTypes = ['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week'];
  const facts = {};
  // Dynamic text outside any anchor (an unread badge in shared chrome), marked in the page or matched by the project's
  // anchors.dynamicText selectors, is data the application may not have: leave it out of every anchor's text, as
  // dynamic anchors are. Hidden only while text is read, so bounds and pixels keep it.
  const loose = [...new Set([...document.querySelectorAll('[data-pf-text="dynamic"]'), ...dynamicText.flatMap(selector => [...document.querySelectorAll(selector)])])]
    .filter(node => !node.hasAttribute(attribute));
  // Anchors the prototype marks dynamic are left out of their containers' text where they are, so a static word
  // equal to one (a sidebar heading "Settings" beside a title bar reading "Settings") stays. The comparison then
  // takes the text as it is instead of removing dynamic text by value.
  const marked = all.filter(node => dynamicAnchors.includes(node.getAttribute(attribute)));
  // innerText includes CSS-clipped accessibility-only text (an icon button's "Back"), as a native accessibility tree
  // includes the button's label. A driver that reads only drawn text compares with `visibleText`, the text without it.
  // Recognise only a proven empty legacy clip rectangle; positive/auto/unsupported regions keep their original
  // browser behaviour.
  const emptyClip = node => {
    const style = getComputedStyle(node);
    if (!['absolute', 'fixed'].includes(style.position)) return false;
    const match = /^rect\(\s*(.*?)\s*\)$/.exec(style.clip);
    if (!match) return false;
    const values = match[1].split(/\s*,\s*|\s+/);
    if (values.length !== 4 || values.some(value => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?px$/i.test(value))) return false;
    const [top, right, bottom, left] = values.map(Number.parseFloat);
    return [top, right, bottom, left].every(Number.isFinite) && (right <= left || bottom <= top);
  };
  const clipped = [...document.querySelectorAll('*')].filter(emptyClip);
  const roots = clipped.filter(node => !clipped.some(other => other !== node && other.contains(node)));
  const masked = [...new Set(roots.flatMap(node => [node, ...node.querySelectorAll('*')]))];
  const selector = element => {
    const path = [];
    for (let current = element; current; current = current.parentElement) {
      let index = 1;
      for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) index++;
      path.unshift(current.parentElement ? `:nth-child(${index})` : ':root');
    }
    return path.join(' > ');
  };
  let clipSheet;
  const renderedText = node => {
    if (!masked.length || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return node.innerText;
    // CSSOM changes avoid [style] selectors and DOM MutationObservers. No attributes/nodes are added.
    const saved = [...document.adoptedStyleSheets];
    try {
      if (!clipSheet) {
        clipSheet = new CSSStyleSheet();
        clipSheet.replaceSync(roots.map(root => { const at = selector(root); return `${at},${at} *{visibility:hidden!important}`; }).join('\n'));
      }
      document.adoptedStyleSheets = [...saved, clipSheet];
      // Inline !important or another cascade rule can defeat the mask. Never apply half a group.
      if (masked.every(element => getComputedStyle(element).visibility === 'hidden')) return node.innerText;
    } catch {
      // Unsupported CSSOM/cascade leaves the original observation authoritative.
    } finally { document.adoptedStyleSheets = saved; }
    return node.innerText;
  };
  const readText = (node, read) => {
    const hidden = [...loose, ...marked.filter(item => item !== node && !item.contains(node))];
    const saved = hidden.map(item => item.getAttribute('style'));
    for (const item of hidden) item.style.setProperty('display', 'none', 'important');
    try { return read(node); } finally {
      hidden.forEach((item, index) => {
        if (saved[index] !== null) item.setAttribute('style', saved[index]);
        else {
          // Synchronise dirty CSSOM first so removing a formerly absent attribute stays absent.
          item.getAttribute('style'); item.removeAttribute('style');
        }
      });
    }
  };
  // innerText runs neighbouring inline-block boxes together (two adjacent buttons, a list number in its own box) although
  // they are drawn apart, where a native tree reads separate texts. Lay those boxes out at block level only while text
  // is read, so each starts a new word. Each keeps its inner layout (an inline-flex avatar stack stays a flex container,
  // so its items stay apart too). Bounds, styles and pixels are read without it, and no DOM node or attribute changes.
  const blockLevel = { 'inline-block': 'flow-root', 'inline-flex': 'flex', 'inline-grid': 'grid', 'inline-table': 'table' };
  const atomic = [...document.body.querySelectorAll('*')].map(node => [node, blockLevel[getComputedStyle(node).display]]).filter(([, display]) => display);
  const separated = read => {
    if (!atomic.length || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return read();
    const saved = [...document.adoptedStyleSheets];
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(Object.values(blockLevel).map(display => [atomic.filter(item => item[1] === display).map(([node]) => selector(node)), display])
        .filter(([selectors]) => selectors.length).map(([selectors, display]) => `${selectors.join(',')}{display:${display}!important}`).join('\n'));
      document.adoptedStyleSheets = [...saved, sheet];
    } catch {
      // Unsupported CSSOM keeps the browser's own innerText.
    }
    try { return read(); } finally { document.adoptedStyleSheets = saved; }
  };
  const textual = [];
  for (const id of ids) {
    const nodes = all.filter(node => node.getAttribute(attribute) === id);
    if (!nodes.length) { facts[id] = { count: 0, visible: false }; continue; }
    const node = nodes[0];
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    const tag = node.tagName;
    const type = tag === 'INPUT' ? (node.getAttribute('type') || 'text').toLowerCase() : null;
    const role = node.getAttribute('role');
    const editable = tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable || (tag === 'INPUT' && !nonEditableTypes.includes(type));
    const interactive = editable || interactiveTags.includes(tag) || (tag === 'A' && node.hasAttribute('href')) || (tag === 'INPUT' && type !== 'hidden')
      || ['button', 'link', 'tab', 'menuitem', 'checkbox', 'switch', 'radio', 'option'].includes(role) || node.hasAttribute('onclick') || node.tabIndex >= 0 && node.hasAttribute('tabindex');
    facts[id] = {
      count: nodes.length, visible, index: all.indexOf(node),
      enabled: !(node.disabled || node.getAttribute('aria-disabled') === 'true'),
      interactive, editable, inputType: type,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      // Text-entry fields show their value or placeholder; other inputs (checkbox, radio, range...) show no text,
      // matching native controls whose label lives in a separate text element.
      text: tag === 'TEXTAREA' || (tag === 'INPUT' && textEntryTypes.includes(type)) ? node.value || node.getAttribute('placeholder') || '' : '',
      ...(dynamicAnchors.length && { dynamicExcluded: true }),
      style: { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontWeight: style.fontWeight, borderRadius: style.borderTopLeftRadius }
    };
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') textual.push([id, node]);
  }
  separated(() => {
    for (const [id, node] of textual) {
      facts[id].text = loose.length || marked.length ? readText(node, item => item.innerText) : node.innerText;
      if (masked.some(item => node === item || node.contains(item))) {
        const shown = loose.length || marked.length ? readText(node, renderedText) : renderedText(node);
        if (shown !== facts[id].text) facts[id].visibleText = shown;
      }
    }
  });
  return facts;
}

/**
 * Replay a state on an already loaded page and collect anchor facts and a device-pixel screenshot.
 * Shared by the web and Electron drivers so both sides of a comparison use identical logic.
 */
export async function captureOnPage(page, { attribute, anchors, steps = [], dynamicText = [], dynamicAnchors = [], timeoutMs = 10000 }) {
  const endAnchors = validateScrollSteps(steps);
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' });
  for (const step of steps) await perform(page, attribute, step);
  await settle(page, timeoutMs);
  for (const anchor of endAnchors) await webScrollEnd(page, attribute, anchor, { endpoint: steps.find(step => step.action === 'scroll-to' && step.anchor === anchor && step.value !== undefined).value });
  const elements = await page.evaluate(inspect, { attribute, ids: anchors, dynamicText, dynamicAnchors });
  const screenshot = await page.screenshot({ animations: 'disabled', scale: 'device' });
  return { elements, screenshot };
}

/**
 * Capture { viewport, screenshot, elements } for one screen state.
 * Throws when navigation or a step fails; the caller records that as the scene's failure.
 */
export async function captureWeb(browser, { url, attribute, anchors, steps = [], dynamicText = [], dynamicAnchors = [], fixture = {}, viewport, locale = 'en-US', colorScheme = 'light', timeoutMs = 10000 }) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.scale ?? 1,
    locale, colorScheme, timezoneId: 'UTC', reducedMotion: 'reduce'
  });
  try {
    await context.addInitScript(data => {
      window.__PROTOFLOW_FIXTURE__ = data;
      for (const [key, value] of Object.entries(data?.localStorage ?? {})) localStorage.setItem(key, String(value));
    }, fixture);
    if (fixture?.cookies?.length) await context.addCookies(fixture.cookies);
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url, { waitUntil: 'networkidle' });
    const { elements, screenshot } = await captureOnPage(page, { attribute, anchors, steps, dynamicText, dynamicAnchors, timeoutMs });
    return { viewport: { width: viewport.width, height: viewport.height, scale: viewport.scale ?? 1 }, screenshot, elements };
  } finally {
    await context.close();
  }
}
