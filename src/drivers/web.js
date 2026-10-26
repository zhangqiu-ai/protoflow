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
    case 'scroll-to': return target.scrollIntoViewIfNeeded({ timeout });
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
  const readText = node => {
    const hidden = [...loose, ...marked.filter(item => item !== node && !item.contains(node))];
    const saved = hidden.map(item => item.style.getPropertyValue('display'));
    for (const item of hidden) item.style.setProperty('display', 'none');
    try { return node.innerText; } finally { hidden.forEach((item, index) => saved[index] ? item.style.setProperty('display', saved[index]) : item.style.removeProperty('display')); }
  };
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
      text: tag === 'TEXTAREA' || (tag === 'INPUT' && textEntryTypes.includes(type)) ? node.value || node.getAttribute('placeholder') || '' : tag === 'INPUT' ? '' : (loose.length || marked.length ? readText(node) : node.innerText),
      ...(dynamicAnchors.length && { dynamicExcluded: true }),
      style: { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontWeight: style.fontWeight, borderRadius: style.borderTopLeftRadius }
    };
  }
  return facts;
}

/**
 * Replay a state on an already loaded page and collect anchor facts and a device-pixel screenshot.
 * Shared by the web and Electron drivers so both sides of a comparison use identical logic.
 */
export async function captureOnPage(page, { attribute, anchors, steps = [], dynamicText = [], dynamicAnchors = [], timeoutMs = 10000 }) {
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' });
  for (const step of steps) await perform(page, attribute, step);
  await settle(page, timeoutMs);
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
