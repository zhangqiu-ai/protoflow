import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { normalizeText } from './anchors.js';

/*
 * Tiered acceptance over two captures of the same screen state: the frozen prototype and one application target.
 * A capture is { viewport: {width, height, scale}, screenshot: PNG Buffer, elements: { [anchorId]: element } } where
 * element = { count, visible, enabled, interactive, editable, bounds: {x,y,width,height}, text, index?, inputType?, style? }.
 * Bounds and style lengths are in viewport units (CSS px or platform points); screenshots are in device pixels.
 */

export const TIERS = ['structure', 'tokens', 'layout', 'visual'];
const result = (reasons, checked, status) => ({ status: status ?? (reasons.length ? 'FAIL' : 'PASS'), reasons, checked });

function uniqueAnchors(screen) {
  const seen = new Map();
  for (const anchor of screen.anchors) if (!seen.has(anchor.id)) seen.set(anchor.id, anchor);
  return [...seen.values()];
}
const element = (capture, id) => capture.elements?.[id] ?? { count: 0, visible: false };

/** Sibling order by document index when both sides report it, otherwise by reading order of bounds. */
function siblingOrder(capture, ids, byIndex) {
  return [...ids].sort((a, b) => {
    const left = element(capture, a), right = element(capture, b);
    if (byIndex) return left.index - right.index;
    const dy = left.bounds.y - right.bounds.y;
    return Math.abs(dy) > 1 ? dy : left.bounds.x - right.bounds.x;
  });
}

/** T1: every anchor exists with the right multiplicity, visibility, text, role and order; state expectations hold. */
export function compareStructure(screen, state, prototype, application) {
  const reasons = [];
  let checked = 0;
  const anchors = uniqueAnchors(screen).filter(anchor => !anchor.visualOnly);
  for (const anchor of anchors) {
    checked++;
    const left = element(prototype, anchor.id), right = element(application, anchor.id);
    if (!left.count) {
      if (right.count && right.visible) reasons.push(`${anchor.id}: visible in application but absent from the prototype state`);
      continue;
    }
    if (anchor.repeat ? right.count !== left.count : right.count !== 1) {
      reasons.push(`${anchor.id}: expected ${anchor.repeat ? left.count : 1} element(s), found ${right.count}`);
      continue;
    }
    if (left.visible !== right.visible) { reasons.push(`${anchor.id}: visible ${left.visible} in prototype vs ${right.visible} in application`); continue; }
    if (!left.visible) continue;
    if (!anchor.dynamic && normalizeText(left.text) !== normalizeText(right.text)) reasons.push(`${anchor.id}: text "${normalizeText(left.text)}" vs "${normalizeText(right.text)}"`);
    if (anchor.role === 'action' && !right.interactive) reasons.push(`${anchor.id}: action is not interactive in the application`);
    if (anchor.role === 'input' && !right.editable) reasons.push(`${anchor.id}: input is not editable in the application`);
    if (['action', 'input'].includes(anchor.role) && left.enabled !== undefined && right.enabled !== undefined && left.enabled !== right.enabled) reasons.push(`${anchor.id}: enabled ${left.enabled} vs ${right.enabled}`);
    if (left.inputType && right.inputType && left.inputType !== right.inputType) reasons.push(`${anchor.id}: input type ${left.inputType} vs ${right.inputType}`);
  }
  const parents = new Map();
  for (const anchor of anchors) {
    if (anchor.repeat) continue;
    const left = element(prototype, anchor.id), right = element(application, anchor.id);
    if (left.visible && right.visible && left.count === 1 && right.count === 1) parents.set(anchor.parent, [...(parents.get(anchor.parent) ?? []), anchor.id]);
  }
  for (const [parent, ids] of parents) {
    if (ids.length < 2) continue;
    const byIndex = ids.every(id => Number.isInteger(element(prototype, id).index) && Number.isInteger(element(application, id).index));
    const expected = siblingOrder(prototype, ids, byIndex), actual = siblingOrder(application, ids, byIndex);
    if (expected.join() !== actual.join()) reasons.push(`${parent ?? 'root'}: child order ${expected.join(', ')} vs ${actual.join(', ')}`);
  }
  for (const id of state.expect?.visible ?? []) if (!element(application, id).visible) reasons.push(`state expects ${id} to be visible`);
  for (const id of state.expect?.hidden ?? []) if (element(application, id).visible) reasons.push(`state expects ${id} to be hidden`);
  return result(reasons, checked);
}

export function parseColor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let match = /^#([0-9a-f]{3,8})$/.exec(text);
  if (match) {
    let hex = match[1];
    if (hex.length <= 4) hex = [...hex].map(char => char + char).join('');
    const value = parseInt(hex, 16);
    return hex.length === 8 ? { r: value >>> 24 & 255, g: value >>> 16 & 255, b: value >>> 8 & 255, a: (value & 255) / 255 } : { r: value >> 16 & 255, g: value >> 8 & 255, b: value & 255, a: 1 };
  }
  match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text);
  if (match) {
    const alpha = match[4] === undefined ? 1 : match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
    return { r: +match[1], g: +match[2], b: +match[3], a: alpha };
  }
  return null;
}

function toLab({ r, g, b }) {
  const linear = channel => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const xyz = [(R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047, R * 0.2126729 + G * 0.7151522 + B * 0.072175, (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883];
  const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const [fx, fy, fz] = xyz.map(f);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIEDE2000 colour difference between two sRGB colours. */
export const deltaE2000 = (first, second) => deltaE2000Lab(toLab(first), toLab(second));
/** CIEDE2000 on CIELAB values (Sharma, Wu & Dalal 2005). */
export function deltaE2000Lab(x, y) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(x.a, x.b), C2 = Math.hypot(y.a, y.b), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1 = (1 + G) * x.a, a2 = (1 + G) * y.a;
  const C1p = Math.hypot(a1, x.b), C2p = Math.hypot(a2, y.b);
  const hue = (b, a) => { if (!a && !b) return 0; const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; };
  const h1 = hue(x.b, a1), h2 = hue(y.b, a2);
  const dL = y.L - x.L, dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh / 2 * rad);
  const Lm = (x.L + y.L) / 2, Cmp = (C1p + C2p) / 2;
  let hm = h1 + h2;
  if (C1p * C2p) { if (Math.abs(h1 - h2) > 180) hm += h1 + h2 < 360 ? 360 : -360; hm /= 2; }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + 0.015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), Sc = 1 + 0.045 * Cmp, Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** Flatten a W3C design-token document into colour and dimension entries. */
export function flattenTokens(document) {
  const tokens = [];
  const walk = (node, trail, inheritedType) => {
    if (!node || typeof node !== 'object') return;
    const type = node.$type ?? inheritedType;
    if ('$value' in node) { tokens.push({ name: trail.join('.'), type, value: node.$value }); return; }
    for (const [key, child] of Object.entries(node)) if (!key.startsWith('$')) walk(child, [...trail, key], type);
  };
  walk(document, [], undefined);
  return tokens;
}
function tokenFor(color, tokens) {
  let best = null;
  for (const token of tokens) {
    const value = token.type === 'color' || typeof token.value === 'string' ? parseColor(String(token.value)) : null;
    if (!value || value.a !== color.a) continue;
    const difference = deltaE2000(color, value);
    if (difference <= 1 && (!best || difference < best.difference)) best = { name: token.name, difference };
  }
  return best?.name ?? null;
}
const px = value => { const number = parseFloat(value); return Number.isFinite(number) ? number : null; };
const weight = value => ({ normal: 400, bold: 700 })[String(value).toLowerCase()] ?? px(value);

function crop(png, box, scale) {
  const x = Math.max(0, Math.floor(box.x * scale)), y = Math.max(0, Math.floor(box.y * scale));
  const width = Math.min(png.width - x, Math.ceil(box.width * scale)), height = Math.min(png.height - y, Math.ceil(box.height * scale));
  if (width <= 0 || height <= 0) return null;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, x, y, width, height, 0, 0);
  return out;
}
/** Most frequent colour in a region, quantised to 4 bits per channel. */
function dominantColor(png) {
  const counts = new Map();
  for (let i = 0; i < png.data.length; i += 4) {
    const key = (png.data[i] >> 4) << 8 | (png.data[i + 1] >> 4) << 4 | png.data[i + 2] >> 4;
    const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    entry.n++; entry.r += png.data[i]; entry.g += png.data[i + 1]; entry.b += png.data[i + 2];
    counts.set(key, entry);
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return top ? { r: top.r / top.n, g: top.g / top.n, b: top.b / top.n, a: 1 } : null;
}

/** T2: colours, typography and radius match by design-token name or within tolerance; native targets may be sampled. */
export function compareTokens(screen, prototype, application, { tokens = [], deltaE = 3, fontSize = 1, radius = 1 } = {}) {
  const reasons = [];
  let checked = 0, sampled = 0, skipped = 0;
  const protoPng = prototype.screenshot ? PNG.sync.read(prototype.screenshot) : null;
  const appPng = application.screenshot ? PNG.sync.read(application.screenshot) : null;
  for (const anchor of uniqueAnchors(screen).filter(item => !item.visualOnly)) {
    const left = element(prototype, anchor.id), right = element(application, anchor.id);
    if (!left.visible || !right.visible || !left.style) continue;
    checked++;
    if (right.style) {
      for (const property of ['color', 'backgroundColor']) {
        const a = parseColor(left.style[property]), b = parseColor(right.style[property]);
        if (!a || !b) continue;
        if (!a.a && !b.a) continue;
        const names = [tokenFor(a, tokens), tokenFor(b, tokens)];
        if (names[0] && names[1] ? names[0] !== names[1] : a.a !== b.a || deltaE2000(a, b) > deltaE) {
          reasons.push(`${anchor.id}: ${property} ${names[0] ?? left.style[property]} vs ${names[1] ?? right.style[property]}`);
        }
      }
      const sizes = [px(left.style.fontSize), px(right.style.fontSize)];
      if (sizes.every(value => value !== null) && Math.abs(sizes[0] - sizes[1]) > fontSize) reasons.push(`${anchor.id}: font size ${sizes[0]} vs ${sizes[1]}`);
      const weights = [weight(left.style.fontWeight), weight(right.style.fontWeight)];
      if (weights.every(value => value !== null) && weights[0] !== weights[1]) reasons.push(`${anchor.id}: font weight ${weights[0]} vs ${weights[1]}`);
      const radii = [px(left.style.borderRadius), px(right.style.borderRadius)];
      if (radii.every(value => value !== null) && Math.abs(radii[0] - radii[1]) > radius) reasons.push(`${anchor.id}: border radius ${radii[0]} vs ${radii[1]}`);
    } else if (protoPng && appPng && left.bounds && right.bounds) {
      // Without platform style data, compare the dominant colour inside each side's own bounds.
      const a = crop(protoPng, left.bounds, prototype.viewport?.scale ?? 1), b = crop(appPng, right.bounds, application.viewport?.scale ?? 1);
      if (!a || !b) { skipped++; continue; }
      sampled++;
      const colors = [dominantColor(a), dominantColor(b)];
      if (deltaE2000(colors[0], colors[1]) > deltaE) reasons.push(`${anchor.id}: sampled background differs (ΔE ${deltaE2000(colors[0], colors[1]).toFixed(1)})`);
    } else skipped++;
  }
  if (checked && skipped === checked) return result(['application capture has neither style data nor screenshots'], checked, 'NOT_RUN');
  return { ...result(reasons, checked), sampled };
}

function relation(a, b, epsilon) {
  if (a.y + a.height <= b.y + epsilon) return 'above';
  if (b.y + b.height <= a.y + epsilon) return 'below';
  if (a.x + a.width <= b.x + epsilon) return 'left-of';
  if (b.x + b.width <= a.x + epsilon) return 'right-of';
  return 'overlaps';
}

/** T3: positions and sizes relative to the screen anchor, sibling relations, and optional absolute geometry. */
export function compareLayout(screenId, screen, prototype, application, { position = 0.02, size = 0.05, absolute = null } = {}) {
  const reasons = [];
  let checked = 0;
  const leftScreen = element(prototype, screenId).bounds, rightScreen = element(application, screenId).bounds;
  if (!leftScreen || !rightScreen || !leftScreen.width || !rightScreen.width) return result([`screen anchor ${screenId} has no bounds`], 0, 'FAIL');
  const normalized = (box, frame) => ({ x: (box.x - frame.x) / frame.width, y: (box.y - frame.y) / frame.height, width: box.width / frame.width, height: box.height / frame.height });
  const anchors = uniqueAnchors(screen).filter(anchor => !anchor.repeat && anchor.id !== screenId);
  const visible = anchors.filter(anchor => element(prototype, anchor.id).visible && element(application, anchor.id).visible && element(prototype, anchor.id).bounds && element(application, anchor.id).bounds);
  for (const anchor of visible) {
    checked++;
    const left = element(prototype, anchor.id).bounds, right = element(application, anchor.id).bounds;
    const a = normalized(left, leftScreen), b = normalized(right, rightScreen);
    const issues = [];
    for (const key of ['x', 'y']) if (Math.abs(a[key] - b[key]) > position) issues.push(`${key} ${(a[key] * 100).toFixed(1)}% vs ${(b[key] * 100).toFixed(1)}%`);
    for (const key of ['width', 'height']) if (Math.abs(a[key] - b[key]) > size) issues.push(`${key} ${(a[key] * 100).toFixed(1)}% vs ${(b[key] * 100).toFixed(1)}%`);
    if (absolute !== null) for (const key of ['x', 'y', 'width', 'height']) if (Math.abs(left[key] - right[key]) > absolute) issues.push(`${key} ${left[key]} vs ${right[key]} (±${absolute})`);
    if (issues.length) reasons.push(`${anchor.id}: ${issues.join(', ')}`);
  }
  const byParent = new Map();
  for (const anchor of visible) byParent.set(anchor.parent, [...(byParent.get(anchor.parent) ?? []), anchor.id]);
  for (const ids of byParent.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const expected = relation(element(prototype, ids[i]).bounds, element(prototype, ids[j]).bounds, 1);
      const actual = relation(element(application, ids[i]).bounds, element(application, ids[j]).bounds, 1);
      if (expected !== actual) reasons.push(`${ids[i]} is ${expected} ${ids[j]} in the prototype but ${actual} in the application`);
    }
  }
  return result(reasons, checked);
}

function resize(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (Math.min(png.height - 1, Math.floor(y * png.height / height)) * png.width + Math.min(png.width - 1, Math.floor(x * png.width / width))) * 4;
    png.data.copy(out.data, (y * width + x) * 4, source, source + 4);
  }
  return out;
}
function luminance(png) {
  const values = new Float64Array(png.width * png.height);
  for (let i = 0; i < values.length; i++) values[i] = 0.299 * png.data[i * 4] + 0.587 * png.data[i * 4 + 1] + 0.114 * png.data[i * 4 + 2];
  return values;
}
/** Mean SSIM over 8×8 windows with stride 4 on luminance. */
export function ssim(first, second) {
  const width = Math.min(first.width, second.width), height = Math.min(first.height, second.height);
  const a = luminance(resize(first, width, height)), b = luminance(resize(second, width, height));
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, size = Math.min(8, width, height);
  let total = 0, windows = 0;
  for (let y = 0; y + size <= height; y += Math.max(1, size / 2)) for (let x = 0; x + size <= width; x += Math.max(1, size / 2)) {
    let ma = 0, mb = 0;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) { const k = (y + j) * width + x + i; ma += a[k]; mb += b[k]; }
    const n = size * size; ma /= n; mb /= n;
    let va = 0, vb = 0, cov = 0;
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) { const k = (y + j) * width + x + i; va += (a[k] - ma) ** 2; vb += (b[k] - mb) ** 2; cov += (a[k] - ma) * (b[k] - mb); }
    va /= n - 1 || 1; vb /= n - 1 || 1; cov /= n - 1 || 1;
    total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma ** 2 + mb ** 2 + C1) * (va + vb + C2));
    windows++;
  }
  return windows ? total / windows : 1;
}

function mask(png, boxes, scale) {
  for (const box of boxes) {
    const x0 = Math.max(0, Math.floor(box.x * scale)), y0 = Math.max(0, Math.floor(box.y * scale));
    const x1 = Math.min(png.width, Math.ceil((box.x + box.width) * scale)), y1 = Math.min(png.height, Math.ceil((box.y + box.height) * scale));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) png.data.fill(128, (y * png.width + x) * 4, (y * png.width + x) * 4 + 3);
  }
}

/** T4: pixel equality (same-technology targets) or perceptual similarity (native targets), whole view and per anchor. */
export function compareVisual(screen, prototype, application, { mode = 'pixel', maxDiffRatio = 0.01, pixelThreshold = 0.1, minSimilarity = 0.92 } = {}) {
  if (!prototype.screenshot || !application.screenshot) return { ...result(['missing screenshot'], 0, 'NOT_RUN'), images: null };
  const left = PNG.sync.read(prototype.screenshot), right = PNG.sync.read(application.screenshot);
  const scale = prototype.viewport?.scale ?? 1, appScale = application.viewport?.scale ?? scale;
  // Dynamic text differs by design; mask it on both sides at each side's own position.
  mask(left, screen.anchors.filter(anchor => anchor.dynamic).map(anchor => element(prototype, anchor.id).bounds).filter(Boolean), scale);
  mask(right, screen.anchors.filter(anchor => anchor.dynamic).map(anchor => element(application, anchor.id).bounds).filter(Boolean), appScale);
  const reasons = [];
  let checked = 0, images = null, score;
  const regions = screen.anchors.filter(anchor => !anchor.repeat && anchor.role !== 'screen' && element(prototype, anchor.id).visible && element(application, anchor.id).visible);
  if (mode === 'pixel') {
    if (left.width !== right.width || left.height !== right.height) return { ...result([`screenshot size ${left.width}×${left.height} vs ${right.width}×${right.height}`], 0), images: null };
    const diff = new PNG({ width: left.width, height: left.height });
    const count = pixelmatch(left.data, right.data, diff.data, left.width, left.height, { threshold: pixelThreshold, includeAA: false });
    score = count / (left.width * left.height);
    if (score > maxDiffRatio) reasons.push(`viewport pixel difference ${score.toFixed(6)} exceeds ${maxDiffRatio}`);
    for (const anchor of regions) {
      // Compare the same pixels on both sides: the prototype's box is the design's position.
      const a = crop(left, element(prototype, anchor.id).bounds, scale), b = crop(right, element(prototype, anchor.id).bounds, scale);
      if (!a || !b) continue;
      checked++;
      const ratio = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: pixelThreshold, includeAA: false }) / (a.width * a.height);
      if (ratio > maxDiffRatio) reasons.push(`${anchor.id}: region pixel difference ${ratio.toFixed(6)} exceeds ${maxDiffRatio}`);
    }
    images = { diff: PNG.sync.write(diff), left: PNG.sync.write(left), right: PNG.sync.write(right) };
  } else {
    score = ssim(left, right);
    if (score < minSimilarity) reasons.push(`viewport similarity ${score.toFixed(4)} below ${minSimilarity}`);
    for (const anchor of regions) {
      const a = crop(left, element(prototype, anchor.id).bounds, scale), b = crop(right, element(application, anchor.id).bounds, appScale);
      if (!a || !b) continue;
      checked++;
      const similarity = ssim(a, b);
      if (similarity < minSimilarity) reasons.push(`${anchor.id}: similarity ${similarity.toFixed(4)} below ${minSimilarity}`);
    }
    images = { left: PNG.sync.write(left), right: PNG.sync.write(right) };
  }
  return { ...result(reasons, checked), score, images };
}

/** Combine per-tier results using the target's required/advisory/off policy. */
export function tierVerdict(tiers, policy) {
  const required = TIERS.filter(tier => (policy[tier] ?? 'required') === 'required');
  const statuses = required.map(tier => tiers[tier]?.status ?? 'NOT_RUN');
  return statuses.includes('FAIL') ? 'FAIL' : statuses.every(status => status === 'PASS') ? 'PASS' : 'NOT_RUN';
}
