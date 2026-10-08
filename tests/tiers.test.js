import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { compareStructure, compareTokens, compareLayout, compareVisual, tierVerdict, deltaE2000, deltaE2000Lab, parseColor, flattenTokens, ssim } from '../src/tiers.js';

const screen = {
  anchors: [
    { id: 'home', role: 'screen', parent: null },
    { id: 'home.title', role: 'element', parent: 'home' },
    { id: 'home.go', role: 'action', parent: 'home' },
    { id: 'home.email', role: 'input', parent: 'home' },
    { id: 'home.item', role: 'element', parent: 'home', repeat: true },
    { id: 'home.clock', role: 'element', parent: 'home', dynamic: true },
    { id: 'home.art', role: 'element', parent: 'home', visualOnly: true }
  ]
};
const box = (x, y, width, height) => ({ x, y, width, height });
const style = { color: 'rgb(24, 50, 60)', backgroundColor: 'rgb(13, 118, 110)', fontSize: '14px', fontWeight: '700', borderRadius: '8px' };
function capture(overrides = {}) {
  const elements = {
    home: { count: 1, visible: true, index: 0, bounds: box(0, 0, 400, 300), text: '', style },
    'home.title': { count: 1, visible: true, index: 1, bounds: box(20, 20, 200, 30), text: 'Hello', style },
    'home.go': { count: 1, visible: true, index: 2, enabled: true, interactive: true, bounds: box(20, 70, 100, 40), text: 'Go', style },
    'home.email': { count: 1, visible: true, index: 3, enabled: true, interactive: true, editable: true, inputType: 'email', bounds: box(20, 130, 200, 40), text: '', style },
    'home.item': { count: 2, visible: true, index: 4, bounds: box(20, 190, 200, 20), text: 'One', style },
    'home.clock': { count: 1, visible: true, index: 6, bounds: box(300, 20, 80, 20), text: '12:00', style },
    'home.art': { count: 1, visible: true, index: 7, bounds: box(300, 200, 80, 80), text: '', style }
  };
  for (const [id, change] of Object.entries(overrides)) elements[id] = change === null ? { count: 0, visible: false } : { ...elements[id], ...change };
  return { viewport: { width: 400, height: 300, scale: 1 }, elements };
}
const state = { expect: { visible: [], hidden: [] } };

test('T1 structure: multiplicity, visibility, text, role, order and expectations', () => {
  assert.equal(compareStructure(screen, state, capture(), capture()).status, 'PASS');
  // Dynamic text and visual-only anchors are not compared as text/structure.
  assert.equal(compareStructure(screen, state, capture(), capture({ 'home.clock': { text: '13:37' }, 'home.art': null })).status, 'PASS');
  const failing = compareStructure(screen, { expect: { visible: ['home.toast'], hidden: ['home.go'] } }, capture(), capture({
    'home.title': { text: 'Hi' }, 'home.go': { interactive: false }, 'home.email': { editable: false, inputType: 'text' }, 'home.item': { count: 3 }
  }));
  assert.deepEqual(failing.reasons, [
    'home.title: text "Hello" vs "Hi"',
    'home.go: action is not interactive in the application',
    'home.email: input is not editable in the application',
    'home.email: input type email vs text',
    'home.item: expected 2 element(s), found 3',
    'state expects home.toast to be visible',
    'state expects home.go to be hidden'
  ]);
  assert.deepEqual(compareStructure(screen, state, capture(), capture({ 'home.go': null })).reasons, ['home.go: expected 1 element(s), found 0']);
  assert.match(compareStructure(screen, state, capture(), capture({ 'home.go': { index: 9 } })).reasons[0], /^home: child order home\.title, home\.go, home\.email, home\.clock vs/);
  assert.deepEqual(compareStructure(screen, state, capture({ 'home.title': null }), capture()).reasons, ['home.title: visible in application but absent from the prototype state']);
});

test('colour parsing and CIEDE2000 match reference values', () => {
  assert.deepEqual(parseColor('#0d766e'), { r: 13, g: 118, b: 110, a: 1 });
  assert.deepEqual(parseColor('rgba(13, 118, 110, 0.5)'), { r: 13, g: 118, b: 110, a: 0.5 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor('transparent').a, 0);
  // Sharma, Wu & Dalal (2005) test pairs 1, 7, 17 and 25.
  for (const [a, b, expected] of [[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 0, 0], [50, -1, 2], 2.3669], [[50, 2.5, 0], [73, 25, -18], 27.1492], [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644]]) {
    assert.equal(deltaE2000Lab({ L: a[0], a: a[1], b: a[2] }, { L: b[0], a: b[1], b: b[2] }).toFixed(4), expected.toFixed(4));
  }
  assert.ok(deltaE2000(parseColor('#000'), parseColor('#fff')) > 99);
  assert.equal(deltaE2000(parseColor('#0d766e'), parseColor('#0d766e')), 0);
});

test('T2 tokens: token names, colour tolerance, typography and radius', () => {
  const tokens = flattenTokens({ color: { $type: 'color', accent: { $value: '#0d766e' }, ink: { $value: '#18323c' } } });
  assert.deepEqual(tokens.map(token => token.name), ['color.accent', 'color.ink']);
  assert.equal(compareTokens(screen, capture(), capture(), { tokens }).status, 'PASS');
  // A nearly identical colour is within ΔE tolerance; a different hue is reported by token name.
  const near = { ...style, backgroundColor: 'rgb(14, 118, 110)' };
  assert.equal(compareTokens(screen, capture(), capture({ 'home.go': { style: near } }), { tokens }).status, 'PASS');
  const result = compareTokens(screen, capture(), capture({ 'home.go': { style: { ...style, backgroundColor: 'rgb(29, 78, 216)', fontSize: '16px', fontWeight: 'normal', borderRadius: '2px' } } }), { tokens });
  assert.deepEqual(result.reasons, [
    'home.go: backgroundColor color.accent vs rgb(29, 78, 216)',
    'home.go: font size 14 vs 16',
    'home.go: font weight 700 vs 400',
    'home.go: border radius 8 vs 2'
  ]);
});

function solid(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; }
  return png;
}
function paint(png, { x, y, width, height }, [r, g, b]) {
  for (let j = y; j < y + height; j++) for (let i = x; i < x + width; i++) { const k = (j * png.width + i) * 4; png.data[k] = r; png.data[k + 1] = g; png.data[k + 2] = b; }
  return png;
}

test('T2 sampling compares dominant colour inside each side’s bounds when the platform has no style data', () => {
  const left = capture(), right = capture();
  left.screenshot = PNG.sync.write(paint(solid(400, 300, [255, 255, 255]), box(20, 70, 100, 40), [13, 118, 110]));
  right.screenshot = PNG.sync.write(paint(solid(400, 300, [255, 255, 255]), box(20, 70, 100, 40), [13, 118, 110]));
  for (const element of Object.values(right.elements)) delete element.style;
  const same = compareTokens(screen, left, right);
  assert.equal(same.status, 'PASS');
  assert.ok(same.sampled > 0);
  right.screenshot = PNG.sync.write(paint(solid(400, 300, [255, 255, 255]), box(20, 70, 100, 40), [185, 28, 28]));
  assert.match(compareTokens(screen, left, right).reasons.join(), /home\.go: sampled background differs/);
  delete right.screenshot;
  assert.equal(compareTokens(screen, left, right).status, 'NOT_RUN');
});

test('T3 layout: relative position and size, sibling relations and optional absolute tolerance', () => {
  assert.equal(compareLayout('home', screen, capture(), capture()).status, 'PASS');
  // A uniformly scaled screen (another device width) keeps relative layout.
  const scaled = capture();
  for (const element of Object.values(scaled.elements)) element.bounds = { x: element.bounds.x * 2, y: element.bounds.y * 2, width: element.bounds.width * 2, height: element.bounds.height * 2 };
  assert.equal(compareLayout('home', screen, capture(), scaled).status, 'PASS');
  assert.match(compareLayout('home', screen, capture(), scaled, { absolute: 1 }).reasons.join(), /home\.title: x 20 vs 40 \(±1\)/);
  const swapped = compareLayout('home', screen, capture(), capture({ 'home.go': { bounds: box(20, 250, 100, 40) } }));
  assert.match(swapped.reasons.join('\n'), /home\.go: y 23\.3% vs 83\.3%/);
  assert.match(swapped.reasons.join('\n'), /home\.go is above home\.email in the prototype but below in the application/);
});

test('T4 visual: pixel mode and perceptual SSIM, with dynamic anchors masked', () => {
  const background = PNG.sync.write(solid(400, 300, [240, 240, 240]));
  const left = { ...capture(), screenshot: background }, right = { ...capture(), screenshot: background };
  const pixel = compareVisual(screen, left, right, { mode: 'pixel' });
  assert.equal(pixel.status, 'PASS');
  assert.equal(pixel.score, 0);
  // Differences inside a dynamic anchor are masked away.
  right.screenshot = PNG.sync.write(paint(solid(400, 300, [240, 240, 240]), box(300, 20, 80, 20), [0, 0, 0]));
  assert.equal(compareVisual(screen, left, right, { mode: 'pixel' }).status, 'PASS');
  right.screenshot = PNG.sync.write(paint(solid(400, 300, [240, 240, 240]), box(20, 70, 100, 40), [0, 0, 0]));
  const changed = compareVisual(screen, left, right, { mode: 'pixel', maxDiffRatio: 0.01 });
  assert.equal(changed.status, 'FAIL');
  assert.match(changed.reasons.join(), /viewport pixel difference 0\.033333 exceeds 0\.01/);
  assert.match(changed.reasons.join(), /home\.go: region pixel difference 1\.000000/);
  const perceptual = compareVisual(screen, left, { ...right, screenshot: background }, { mode: 'perceptual' });
  assert.equal(perceptual.status, 'PASS');
  assert.equal(perceptual.score, 1);
  assert.ok(ssim(solid(64, 64, [255, 255, 255]), paint(solid(64, 64, [255, 255, 255]), box(0, 0, 64, 32), [0, 0, 0])) < 0.6);
  assert.equal(compareVisual(screen, left, { ...right, screenshot: PNG.sync.write(solid(200, 150, [240, 240, 240])) }, { mode: 'pixel' }).status, 'FAIL');
});

test('tier verdict honours required, advisory and off policies', () => {
  const tiers = { structure: { status: 'PASS' }, tokens: { status: 'PASS' }, layout: { status: 'PASS' }, visual: { status: 'FAIL' } };
  assert.equal(tierVerdict(tiers, {}), 'FAIL');
  assert.equal(tierVerdict(tiers, { visual: 'advisory' }), 'PASS');
  assert.equal(tierVerdict({ ...tiers, structure: { status: 'NOT_RUN' } }, { visual: 'advisory' }), 'NOT_RUN');
  assert.equal(tierVerdict({ ...tiers, tokens: { status: 'NOT_RUN' } }, { tokens: 'off', visual: 'off' }), 'PASS');
});
