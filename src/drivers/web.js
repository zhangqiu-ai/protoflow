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
function inspect({ attribute, ids }) {
  const all = [...document.querySelectorAll(`[${attribute}]`)];
  const interactiveTags = ['BUTTON', 'SELECT', 'SUMMARY', 'TEXTAREA'];
  // Every input control a user can set counts as editable (text, checkbox, radio, range, file, colour...).
  const nonEditableTypes = ['hidden', 'button', 'submit', 'reset', 'image'];
  const facts = {};
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
      text: tag === 'INPUT' || tag === 'TEXTAREA' ? node.value || node.getAttribute('placeholder') || '' : node.innerText,
      style: { color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize, fontWeight: style.fontWeight, borderRadius: style.borderTopLeftRadius }
    };
  }
  return facts;
}

/**
 * Capture { viewport, screenshot, elements } for one screen state.
 * Throws when navigation or a step fails; the caller records that as the scene's failure.
 */
export async function captureWeb(browser, { url, attribute, anchors, steps = [], fixture = {}, viewport, locale = 'en-US', colorScheme = 'light', timeoutMs = 10000 }) {
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
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' });
    for (const step of steps) await perform(page, attribute, step);
    await settle(page, timeoutMs);
    const elements = await page.evaluate(inspect, { attribute, ids: anchors });
    const screenshot = await page.screenshot({ animations: 'disabled', scale: 'device' });
    return { viewport: { width: viewport.width, height: viewport.height, scale: viewport.scale ?? 1 }, screenshot, elements };
  } finally {
    await context.close();
  }
}
