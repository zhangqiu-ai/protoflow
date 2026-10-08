import { mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { projectPath } from './util.js';
import { superviseBrowser, urlFor } from './browser.js';
export { superviseBrowser, urlFor };

const DEFAULT_STYLES = ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'background-color', 'border-radius', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'gap', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'box-shadow', 'opacity', 'display', 'align-items', 'justify-content', 'transform'];
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');


const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf' };

/**
 * Serve the prototype scene from the frozen version under verification, because the live prototype may be newer.
 * Project-relative scenes are rewritten into the version store; http scenes are routed when their base maps to prototypeDir.
 */
async function prototypeTarget(root, config, scene, context, { version, liveMatches }) {
  if (!version) return { url: await urlFor(root, scene.prototypeUrl), source: 'live' };
  const prototypeDir = path.posix.normalize(config.prototypeDir.split(path.sep).join('/')).replace(/\/+$/, '');
  const value = scene.prototypeUrl;
  if (!value) throw new Error('Scene requires prototypeUrl and applicationUrl');
  if (/^https?:/.test(value)) {
    const url = new URL(value);
    const configured = config.visual?.prototypeBaseUrl;
    const base = configured ? new URL(configured.endsWith('/') ? configured : `${configured}/`) : url.pathname.startsWith(`/${prototypeDir}/`) ? new URL(`/${prototypeDir}/`, url.origin) : null;
    if (!base || !url.href.startsWith(base.href)) {
      if (liveMatches) return { url: value, source: 'live' };
      throw new Error(`Live prototype has moved past ${version.manifestId}; set visual.prototypeBaseUrl to the URL serving ${prototypeDir}/ so this version can be served from its frozen copy`);
    }
    await context.route(candidate => candidate.href.startsWith(base.href), async route => {
      let relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(base.pathname.length));
      if (!relative || relative.endsWith('/')) relative += 'index.html';
      const key = path.posix.normalize(`${prototypeDir}/${relative}`);
      if (!key.startsWith(`${prototypeDir}/`) || !version.files[key]) return route.fulfill({ status: 404, body: `Not in prototype version ${version.manifestId}` });
      const body = await readFile(await projectPath(root, `${version.directory}/${key}`));
      return route.fulfill({ status: 200, contentType: CONTENT_TYPES[path.extname(key).toLowerCase()] ?? 'application/octet-stream', body });
    });
    return { url: value, source: 'version' };
  }
  const parsed = new URL(value, pathToFileURL(`${path.resolve(root)}${path.sep}`));
  if (parsed.protocol !== 'file:') throw new Error(`Unsupported scene URL protocol: ${parsed.protocol}`);
  const relative = path.relative(path.resolve(root), fileURLToPath(parsed)).split(path.sep).join('/');
  if (relative !== prototypeDir && !relative.startsWith(`${prototypeDir}/`)) return { url: await urlFor(root, value), source: 'live' };
  const frozen = pathToFileURL(await projectPath(root, `${version.directory}/${relative}`));
  frozen.search = parsed.search;
  frozen.hash = parsed.hash;
  return { url: frozen.href, source: 'version' };
}

export function compareImages(beforeBuffer, afterBuffer, threshold = 0.1) {
  const before = PNG.sync.read(beforeBuffer);
  const after = PNG.sync.read(afterBuffer);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('Images must have identical dimensions');
  }
  const diff = new PNG({ width: before.width, height: before.height });
  const overlay = new PNG({ width: before.width, height: before.height });
  const sideBySide = new PNG({ width: before.width * 2, height: before.height });
  const count = pixelmatch(before.data, after.data, diff.data, before.width, before.height, { threshold, includeAA: false });
  for (let i = 0; i < before.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) overlay.data[i + channel] = Math.round((before.data[i + channel] + after.data[i + channel]) / 2);
    overlay.data[i + 3] = 255;
  }
  PNG.bitblt(before, sideBySide, 0, 0, before.width, before.height, 0, 0);
  PNG.bitblt(after, sideBySide, 0, 0, after.width, after.height, before.width, 0);
  return { count, ratio: count / (before.width * before.height), diff: PNG.sync.write(diff), overlay: PNG.sync.write(overlay), sideBySide: PNG.sync.write(sideBySide) };
}

function crop(buffer, box) {
  const source = PNG.sync.read(buffer);
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const width = Math.min(source.width - x, Math.ceil(box.width));
  const height = Math.min(source.height - y, Math.ceil(box.height));
  if (width <= 0 || height <= 0) throw new Error('Mapped element is outside the viewport');
  const result = new PNG({ width, height });
  PNG.bitblt(source, result, x, y, width, height, 0, 0);
  return PNG.sync.write(result);
}

async function inspectMapping(page, selector, properties) {
  const locator = page.locator(selector);
  if (await locator.count() !== 1) throw new Error(`Mapping selector must match exactly one element: ${selector}`);
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`Mapping element is not visible: ${selector}`);
  const styles = await locator.evaluate((element, names) => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`))]));
  }, properties);
  return { box, styles };
}

async function prepare(page, url, scene, side) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}' });
  for (const step of scene.steps ?? []) {
    const selector = step[side];
    if (!selector) throw new Error(`Interaction step requires ${side} selector`);
    if (step.action === 'click') await page.locator(selector).click();
    else if (step.action === 'fill') await page.locator(selector).fill(String(step.value ?? ''));
    else throw new Error(`Unsupported interaction: ${step.action}`);
  }
  await page.waitForFunction(() => document.fonts.status === 'loaded' && [...document.images].every((image) => image.complete), undefined, { timeout: scene.timeoutMs ?? 10000 });
  await page.evaluate(async (timeout) => {
    const failed = [...document.images].find((image) => image.currentSrc && image.naturalWidth === 0);
    if (failed) throw new Error(`Image failed: ${failed.currentSrc}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Visual readiness timed out')), timeout);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
    });
  }, scene.timeoutMs ?? 10000);
}

/** Browser evidence only: missing browsers and unsupported native surfaces never pass. */
export async function verifyVisual(root, config, outDir, { version = null, liveMatches = true, signal, onBeforeSpawn, onStart, onFinish } = {}) {
  const visual = config.visual ?? {};
  if (!visual.scenes?.length || visual.mode === 'native') {
    return { status: 'NOT_RUN', reason: visual.mode === 'native' ? 'Native UI requires a separately configured acceptance adapter; browser verification cannot cover it.' : 'No visual scenes configured.', scenes: [], artifacts: [] };
  }
  return superviseBrowser(outDir, { signal, onBeforeSpawn, onStart, onFinish }, browser => collectVisualEvidence(root, config, outDir, browser, { version, liveMatches, signal }));
}

async function collectVisualEvidence(root, config, outDir, browser, { version, liveMatches, signal }) {
  const visual = config.visual ?? {};
  const results = [];
  const artifacts = [];
  const sources = new Set();
  for (const [index, scene] of visual.scenes.entries()) {
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    const result = { id: scene.id ?? `scene-${index + 1}`, status: 'PASS', reasons: [], mappings: [], artifacts: [] };
    let prototypeContext;
    let applicationContext;
    try {
      const options = { viewport: scene.viewport ?? { width: 1280, height: 720 }, deviceScaleFactor: scene.deviceScaleFactor ?? 1, locale: scene.locale ?? 'en-US', colorScheme: scene.colorScheme ?? 'light', timezoneId: scene.timezoneId ?? 'UTC', reducedMotion: 'reduce' };
      prototypeContext = await browser.newContext(options);
      applicationContext = await browser.newContext(options);
      for (const context of [prototypeContext, applicationContext]) {
        if (scene.fixture?.cookies?.length) await context.addCookies(scene.fixture.cookies);
        await context.addInitScript((fixture) => {
          window.__PROTOFLOW_FIXTURE__ = fixture;
          for (const [key, value] of Object.entries(fixture.localStorage ?? {})) localStorage.setItem(key, String(value));
        }, scene.fixture ?? {});
      }
      const prototype = await prototypeContext.newPage();
      const application = await applicationContext.newPage();
      prototype.setDefaultTimeout(scene.timeoutMs ?? 10000);
      application.setDefaultTimeout(scene.timeoutMs ?? 10000);
      const target = await prototypeTarget(root, config, scene, prototypeContext, { version, liveMatches });
      sources.add(target.source);
      result.prototypeSource = target.source;
      const prototypeUrl = target.url;
      const applicationUrl = await urlFor(root, scene.applicationUrl);
      await Promise.all([prepare(prototype, prototypeUrl, scene, 'prototype'), prepare(application, applicationUrl, scene, 'application')]);
      const masksFor = async (page, side) => {
        const masks = [];
        for (const mask of scene.masks ?? []) {
          if (!mask.prototype || !mask.application) throw new Error('Each mask requires prototype and application selectors');
          const locator = page.locator(mask[side]);
          if (await locator.count() === 0) throw new Error(`Mask selector not found: ${mask[side]}`);
          masks.push(locator);
        }
        return masks;
      };
      const prototypeShot = await prototype.screenshot({ animations: 'disabled', scale: 'css', mask: await masksFor(prototype, 'prototype') });
      const applicationShot = await application.screenshot({ animations: 'disabled', scale: 'css', mask: await masksFor(application, 'application') });
      const comparison = compareImages(prototypeShot, applicationShot, visual.pixelThreshold ?? 0.1);
      result.pixelDiffRatio = comparison.ratio;
      const maxRatio = scene.maxDiffRatio ?? visual.maxDiffRatio ?? 0.01;
      if (comparison.ratio > maxRatio) result.reasons.push(`Viewport pixel difference ${comparison.ratio.toFixed(6)} exceeds ${maxRatio}`);
      const mappings = scene.mappings ? scene.mappings.map((id) => {
        const mapping = (config.mappings ?? []).find((item) => item.id === id);
        if (!mapping) {
          result.reasons.push(`Unknown mapping: ${id}`);
          result.mappings.push({ id, status: 'FAIL', reasons: [`Unknown mapping: ${id}`] });
        }
        return mapping;
      }).filter(Boolean) : config.mappings ?? [];
      if (!mappings.length) result.reasons.push('No component mappings configured for scene; geometry and style verification was not performed');
      for (const mapping of mappings) {
        const check = { id: mapping.id, priority: mapping.priority ?? 'normal', status: 'PASS', reasons: [] };
        try {
          const properties = visual.styleProperties ?? DEFAULT_STYLES;
          const left = await inspectMapping(prototype, mapping.prototype, properties);
          const right = await inspectMapping(application, mapping.application, properties);
          check.prototype = left;
          check.application = right;
          const tolerance = mapping.geometryTolerance ?? visual.geometryTolerance ?? 1;
          for (const key of ['x', 'y', 'width', 'height']) if (Math.abs(left.box[key] - right.box[key]) > tolerance) check.reasons.push(`Geometry ${key}: ${left.box[key]} vs ${right.box[key]} (tolerance ${tolerance})`);
          for (const property of properties) if (left.styles[property] !== right.styles[property]) check.reasons.push(`Style ${property}: ${left.styles[property]} vs ${right.styles[property]}`);
          const leftCrop = crop(prototypeShot, left.box);
          const rightCrop = crop(applicationShot, right.box);
          const leftSize = PNG.sync.read(leftCrop);
          const rightSize = PNG.sync.read(rightCrop);
          if (leftSize.width === rightSize.width && leftSize.height === rightSize.height) {
            check.pixelDiffRatio = compareImages(leftCrop, rightCrop, visual.pixelThreshold ?? 0.1).ratio;
            if (check.pixelDiffRatio > (mapping.maxDiffRatio ?? maxRatio)) check.reasons.push(`Region pixel difference ${check.pixelDiffRatio.toFixed(6)} exceeds ${mapping.maxDiffRatio ?? maxRatio}`);
          } else check.reasons.push('Region dimensions differ');
        } catch (error) { check.reasons.push(error.message); }
        if (check.reasons.length) {
          check.status = 'FAIL';
          result.reasons.push(`Mapping ${mapping.id} failed: ${check.reasons.join('; ')}`);
        }
        result.mappings.push(check);
      }
      const prefix = `${index + 1}-${safeName(result.id)}`;
      for (const [name, buffer] of Object.entries({ prototype: prototypeShot, application: applicationShot, diff: comparison.diff, overlay: comparison.overlay, 'side-by-side': comparison.sideBySide })) {
        const filename = path.join(outDir, `${prefix}-${name}.png`);
        await writeFile(filename, buffer);
        result.artifacts.push(filename);
        artifacts.push(filename);
      }
    } catch (error) { result.reasons.push(error.message); }
    finally {
      await prototypeContext?.close();
      await applicationContext?.close();
    }
    if (signal?.aborted) throw new Error('STOPPED: visual verification was interrupted');
    result.status = result.reasons.length ? 'FAIL' : 'PASS';
    results.push(result);
  }
  const report = path.join(outDir, 'visual-review.html');
  await writeFile(report, renderReport(results));
  artifacts.push(report);
  return { status: results.every((scene) => scene.status === 'PASS') ? 'PASS' : 'FAIL', scenes: results, artifacts, prototypeSource: sources.has('live') ? 'live' : 'version' };
}

function renderReport(scenes) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>ProtoFlow visual review</title><style>body{font:16px system-ui;margin:24px;background:#fafafa}section{border:1px solid #ddd;padding:16px;margin:24px 0}img{max-width:100%;display:block}.blink{display:grid}.blink img{grid-area:1/1}.blink img:last-child{animation:blink 1.2s steps(1) infinite}@keyframes blink{50%{opacity:0}}@media(prefers-reduced-motion:reduce){.blink img:last-child{animation:none;opacity:.5}}</style><h1>ProtoFlow visual review</h1><p>Browser evidence. Review geometry, styles, region differences and the full viewport. Blink view alternates prototype and application.</p>${scenes.map((scene) => {
    const artifact = (suffix) => scene.artifacts.find((item) => item.endsWith(`-${suffix}.png`));
    const img = (suffix) => artifact(suffix) ? `<img alt="${escapeHtml(suffix)}" src="${escapeHtml(path.basename(artifact(suffix)))}">` : '';
    return `<section><h2>${escapeHtml(scene.id)} — ${escapeHtml(scene.status)}</h2><ul>${scene.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul><h3>Blink</h3><div class="blink">${img('prototype')}${img('application')}</div><h3>Side by side</h3>${img('side-by-side')}<h3>Difference</h3>${img('diff')}<h3>Overlay</h3>${img('overlay')}<details><summary>Mapping evidence</summary><pre>${escapeHtml(JSON.stringify(scene.mappings, null, 2))}</pre></details></section>`;
  }).join('')}</html>`;
}
