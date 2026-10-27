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

test('T1 structure: sibling order is reading order, so a taller touch target beside a title stays to its right', () => {
  const row = { anchors: [{ id: 'bar', role: 'screen', parent: null }, { id: 'bar.title', role: 'element', parent: 'bar' }, { id: 'bar.action', role: 'action', parent: 'bar' }] };
  const capture = (title, action) => ({ elements: {
    bar: { count: 1, visible: true, bounds: box(0, 0, 360, 100), text: '' },
    'bar.title': { count: 1, visible: true, bounds: title, text: '' },
    'bar.action': { count: 1, visible: true, interactive: true, bounds: action, text: '' }
  } });
  // Android: the 48 dp action starts 7 dp above the 33 dp title on the same row.
  const web = capture(box(20, 21, 79, 34), box(320, 28, 62, 20));
  assert.equal(compareStructure(row, state, web, capture(box(20, 22, 75, 33), box(278, 14, 62, 48))).status, 'PASS');
  // Really above: a different row.
  assert.match(compareStructure(row, state, web, capture(box(20, 60, 75, 33), box(278, 0, 62, 20))).reasons[0], /child order/);
});

test('T1 structure: an anchor hidden in the prototype may be absent from a native application', () => {
  const hidden = { ...capture().elements['home.go'], visible: false };
  // Native UI does not keep invisible views: hidden in the prototype ≈ not rendered in the application.
  assert.equal(compareStructure(screen, state, capture({ 'home.go': hidden }), capture({ 'home.go': null })).status, 'PASS');
  // A visible prototype anchor must still exist exactly once.
  assert.deepEqual(compareStructure(screen, state, capture(), capture({ 'home.go': null })).reasons, ['home.go: expected 1 element(s), found 0']);
  // Repeated anchors keep their exact count.
  assert.deepEqual(compareStructure(screen, state, capture({ 'home.item': { visible: false } }), capture({ 'home.item': null })).reasons, ['home.item: expected 2 element(s), found 0']);
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
  // Screenshots without one prevailing colour in any anchor: compared, nothing to sample, so not NOT_RUN.
  const stripes = () => { const png = solid(400, 300, [255, 255, 255]); for (let x = 0; x < 400; x += 3) { paint(png, box(x, 0, 1, 300), [13, 118, 110]); paint(png, box(x + 1, 0, 1, 300), [185, 28, 28]); } return PNG.sync.write(png); };
  left.screenshot = stripes(); right.screenshot = stripes();
  const unsampled = compareTokens(screen, left, right);
  assert.deepEqual([unsampled.status, unsampled.sampled], ['PASS', 0]);
  assert.match(unsampled.note, /nothing was sampled/);
});

test('T1 structure takes a DOM capture\'s text as it is: its dynamic anchors were already left out where they are', () => {
  const dom = overrides => { const result = capture(overrides); for (const facts of Object.values(result.elements)) facts.dynamicExcluded = true; return result; };
  // "12:00" is static text here, beside the clock: by value it would be removed as the clock's text.
  assert.equal(compareStructure(screen, state, dom({ home: { text: 'Hello Go 12:00' } }), dom({ home: { text: 'Hello Go 12:00' } })).status, 'PASS');
  assert.deepEqual(compareStructure(screen, state, dom({ home: { text: 'Hello Go 12:00' } }), dom({ home: { text: 'Hello Go' } })).reasons, ['home: text "Hello Go 12:00" vs "Hello Go"']);
  assert.equal(compareStructure(screen, state, capture({ home: { text: 'Hello Go 12:00' } }), capture({ home: { text: 'Hello Go' } })).status, 'PASS', 'a native capture removes it by value');
});

test('T2 sampling skips dynamic content and elements without one prevailing colour', () => {
  const left = capture(), right = capture();
  for (const element of Object.values(right.elements)) delete element.style;
  // Four equal stripes (a gradient, a switch's track and knob): no colour covers half the element.
  const stripes = (png, colours) => { colours.forEach((colour, i) => paint(png, box(20 + i * 25, 70, 25, 40), colour)); return png; };
  left.screenshot = PNG.sync.write(stripes(solid(400, 300, [255, 255, 255]), [[13, 118, 110], [30, 64, 175], [185, 28, 28], [202, 138, 4]]));
  right.screenshot = PNG.sync.write(stripes(solid(400, 300, [255, 255, 255]), [[202, 138, 4], [13, 118, 110], [30, 64, 175], [185, 28, 28]]));
  assert.doesNotMatch(compareTokens(screen, left, right).reasons.join(), /home\.go/);
  // A dynamic anchor's fill follows its data.
  left.screenshot = PNG.sync.write(paint(solid(400, 300, [255, 255, 255]), box(300, 20, 80, 20), [13, 118, 110]));
  right.screenshot = PNG.sync.write(paint(solid(400, 300, [255, 255, 255]), box(300, 20, 80, 20), [185, 28, 28]));
  assert.doesNotMatch(compareTokens(screen, left, right).reasons.join(), /home\.clock/);
});

test('T1 structure ignores separator glyphs a platform leaves out of combined text', () => {
  const page = { anchors: [
    { id: 'about', role: 'screen', parent: null },
    { id: 'about.version', role: 'element', parent: 'about', dynamic: true }
  ] };
  const shot = (container, version) => ({ elements: {
    about: { count: 1, visible: true, bounds: box(0, 0, 400, 300), text: container },
    'about.version': { count: 1, visible: true, bounds: box(0, 260, 400, 20), text: version }
  } });
  assert.equal(compareStructure(page, state, shot('Settings Siyue · prototype', 'Siyue · prototype'), shot('Settings Siyue 0.0.1', 'Siyue · 0.0.1')).status, 'PASS');
  assert.deepEqual(compareStructure(page, state, shot('Settings · Siyue · prototype', 'Siyue · prototype'), shot('Setting Siyue 0.0.1', 'Siyue · 0.0.1')).reasons, ['about: text "Settings" vs "Setting"']);
});

test('T3 layout compares only the vertical extent of dynamic text', () => {
  const moved = capture({ 'home.clock': { bounds: box(260, 20, 120, 20) } });
  assert.equal(compareLayout('home', screen, capture(), moved).status, 'PASS');
  assert.match(compareLayout('home', screen, capture(), capture({ 'home.clock': { bounds: box(300, 60, 80, 20) } })).reasons.join(), /home\.clock: y/);
});

test('T3 layout removes a dynamic block\'s height difference from the anchors below it', () => {
  const page = { anchors: [
    { id: 'del', role: 'screen', parent: null },
    { id: 'del.list', role: 'element', parent: 'del', dynamic: true },
    { id: 'del.ack', role: 'action', parent: 'del' }
  ] };
  const shot = (listHeight, ackY) => ({ viewport: { width: 400, height: 800, scale: 1 }, elements: {
    del: { count: 1, visible: true, bounds: box(0, 0, 400, 800), text: '' },
    'del.list': { count: 1, visible: true, bounds: box(20, 60, 360, listHeight), text: '' },
    'del.ack': { count: 1, visible: true, interactive: true, bounds: box(20, 60 + listHeight + 12, 360, 44), text: '' }
  } });
  // Three lines of data in the prototype, two in the application: the checkbox follows the list.
  assert.equal(compareLayout('del', page, shot(90, 0), shot(60, 0)).status, 'PASS');
  // A gap that is not the dynamic block's doing still fails.
  const moved = shot(60, 0); moved.elements['del.ack'].bounds.y += 80;
  assert.match(compareLayout('del', page, shot(90, 0), moved).reasons.join(), /del\.ack: y/);
});

test('T3 layout: relative position and size, sibling relations and optional absolute tolerance', () => {
  assert.equal(compareLayout('home', screen, capture(), capture()).status, 'PASS');
  // A uniformly scaled screen (another device width) keeps relative layout.
  const scaled = capture();
  for (const element of Object.values(scaled.elements)) element.bounds = { x: element.bounds.x * 2, y: element.bounds.y * 2, width: element.bounds.width * 2, height: element.bounds.height * 2 };
  scaled.viewport = { width: 800, height: 600, scale: 1 };
  assert.equal(compareLayout('home', screen, capture(), scaled).status, 'PASS');
  assert.match(compareLayout('home', screen, capture(), scaled, { absolute: 1 }).reasons.join(), /home\.title: x 20 vs 40 \(±1\)/);
  const swapped = compareLayout('home', screen, capture(), capture({ 'home.go': { bounds: box(20, 250, 100, 40) } }));
  assert.match(swapped.reasons.join('\n'), /home\.go: y 23\.3% vs 83\.3%/);
  assert.match(swapped.reasons.join('\n'), /home\.go is above home\.email in the prototype but below in the application/);
});

test('T3 layout checks the screen root against the viewport, even when it is the only anchor', () => {
  // The frozen login root: a BODY whose first margin collapses through it (0,44,1440,646) in a 1440×1000 viewport.
  const only = { id: 'login', anchors: [{ id: 'login', role: 'screen' }] };
  const viewport = { width: 1440, height: 1000, scale: 1 };
  const root = bounds => ({ viewport, elements: { login: { count: 1, visible: true, index: 0, bounds, text: '' } } });
  const prototype = root(box(0, 44, 1440, 646));
  const fullViewport = compareLayout('login', only, prototype, root(box(0, 0, 1440, 1000)));
  assert.equal(fullViewport.status, 'FAIL');
  assert.equal(fullViewport.checked, 1);
  assert.match(fullViewport.reasons.join(), /login \(screen root, relative to the viewport\): y 4\.4% vs 0\.0%, height 64\.6% vs 100\.0%/);
  const matching = compareLayout('login', only, prototype, root(box(0, 44, 1440, 646)));
  assert.deepEqual([matching.status, matching.checked], ['PASS', 1]);
  // Without a viewport the root cannot be placed: never a silent PASS.
  assert.equal(compareLayout('login', only, { elements: prototype.elements }, { elements: prototype.elements }).status, 'FAIL');
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

test('T2 and T4 leave a region the application reports as occluded (a keyboard kept up after fill) out on both sides', () => {
  const left = capture(), right = { ...capture(), occluded: [box(0, 180, 400, 120)] };
  for (const element of Object.values(right.elements)) delete element.style;
  left.screenshot = PNG.sync.write(paint(solid(400, 300, [240, 240, 240]), box(20, 190, 200, 20), [13, 118, 110]));
  // The keyboard covers the bottom of the application screen, including the list item's background.
  right.screenshot = PNG.sync.write(paint(solid(400, 300, [240, 240, 240]), box(0, 180, 400, 120), [30, 30, 30]));
  const tokens = compareTokens(screen, left, right);
  assert.doesNotMatch(tokens.reasons.join(), /home\.item/);
  assert.equal(compareVisual(screen, left, right, { mode: 'pixel' }).status, 'PASS');
  assert.equal(compareVisual(screen, left, { ...right, occluded: undefined }, { mode: 'pixel' }).status, 'FAIL');
  assert.match(compareTokens(screen, left, { ...right, occluded: undefined }).reasons.join(), /home\.item: sampled background differs/);
});

test('tier verdict honours required, advisory and off policies', () => {
  const tiers = { structure: { status: 'PASS' }, tokens: { status: 'PASS' }, layout: { status: 'PASS' }, visual: { status: 'FAIL' } };
  assert.equal(tierVerdict(tiers, {}), 'FAIL');
  assert.equal(tierVerdict(tiers, { visual: 'advisory' }), 'PASS');
  assert.equal(tierVerdict({ ...tiers, structure: { status: 'NOT_RUN' } }, { visual: 'advisory' }), 'NOT_RUN');
  assert.equal(tierVerdict({ ...tiers, tokens: { status: 'NOT_RUN' } }, { tokens: 'off', visual: 'off' }), 'PASS');
});

test('T1 structure on a native target compares an email input as a text field but keeps password distinct', () => {
  // A native accessibility tree cannot report the keyboard type.
  assert.equal(compareStructure(screen, state, capture(), capture({ 'home.email': { inputType: 'text' } }), { native: true }).status, 'PASS');
  assert.deepEqual(compareStructure(screen, state, capture(), capture({ 'home.email': { inputType: 'password' } }), { native: true }).reasons, ['home.email: input type email vs password']);
  // On the web the input type stays exact.
  assert.deepEqual(compareStructure(screen, state, capture(), capture({ 'home.email': { inputType: 'text' } })).reasons, ['home.email: input type email vs text']);
});

test('T1 structure leaves dynamic descendants out of a container text', () => {
  const page = { anchors: [
    { id: 'verify', role: 'screen', parent: null },
    { id: 'verify.title', role: 'element', parent: 'verify' },
    { id: 'verify.timer', role: 'element', parent: 'verify', dynamic: true }
  ] };
  const shot = (timer, title = 'Enter the code') => ({ elements: {
    verify: { count: 1, visible: true, bounds: box(0, 0, 400, 300), text: `${title} Resend in ${timer} s` },
    'verify.title': { count: 1, visible: true, bounds: box(0, 0, 400, 40), text: title },
    'verify.timer': { count: 1, visible: true, bounds: box(0, 60, 400, 20), text: `Resend in ${timer} s` }
  } });
  assert.equal(compareStructure(page, state, shot(45), shot(44)).status, 'PASS');
  // Static text around it is still compared.
  assert.deepEqual(compareStructure(page, state, shot(45), shot(44, 'Enter code')).reasons, ['verify: text "Enter the code" vs "Enter code"', 'verify.title: text "Enter the code" vs "Enter code"']);
});

test('T1 structure keeps static text that repeats a dynamic field text', () => {
  const page = { anchors: [
    { id: 'signin', role: 'screen', parent: null },
    { id: 'signin.label', role: 'element', parent: 'signin' },
    { id: 'signin.password', role: 'input', parent: 'signin', dynamic: true }
  ] };
  const shot = (container, field) => ({ elements: {
    signin: { count: 1, visible: true, bounds: box(0, 0, 400, 300), text: container },
    'signin.label': { count: 1, visible: true, bounds: box(0, 0, 400, 20), text: 'Password' },
    'signin.password': { count: 1, visible: true, interactive: true, editable: true, bounds: box(0, 30, 400, 40), text: field }
  } });
  // The web container omits input values; the native one may or may not include the placeholder.
  assert.deepEqual(compareStructure(page, state, shot('Password Sign in', ''), shot('Password Sign in', 'Password')).reasons, []);
  assert.equal(compareStructure(page, state, shot('Password Sign in', ''), shot('Password Password Sign in', 'Password')).status, 'PASS');
  assert.equal(compareStructure(page, state, shot('Password Sign in', ''), shot('Sign in', 'Password')).status, 'FAIL');
});

test('T1 structure keeps static row text that repeats a search field value when the rows have dynamic children', () => {
  // siyue ai.history.search: the field reads "phrases", and each matching row title contains it beside a dynamic date.
  const page = { anchors: [
    { id: 'history', role: 'screen', parent: null },
    { id: 'history.search', role: 'input', parent: 'history', dynamic: true },
    { id: 'history.items', role: 'region', parent: 'history' },
    { id: 'history.items.1', role: 'action', parent: 'history.items' },
    { id: 'history.items.1-value', role: 'element', parent: 'history.items.1', dynamic: true },
    { id: 'history.items.2', role: 'action', parent: 'history.items' },
    { id: 'history.items.2-value', role: 'element', parent: 'history.items.2', dynamic: true }
  ] };
  const shot = (container, items, rows, dates, dom = false) => {
    const result = { elements: {
      history: { count: 1, visible: true, bounds: box(0, 0, 400, 300), text: container },
      'history.search': { count: 1, visible: true, interactive: true, editable: true, bounds: box(0, 0, 400, 40), text: 'phrases' },
      'history.items': { count: 1, visible: true, bounds: box(0, 40, 400, 100), text: items },
      'history.items.1': { count: 1, visible: true, interactive: true, bounds: box(0, 40, 400, 50), text: rows[0] },
      'history.items.1-value': { count: 1, visible: true, bounds: box(300, 40, 100, 50), text: dates[0] },
      'history.items.2': { count: 1, visible: true, interactive: true, bounds: box(0, 90, 400, 50), text: rows[1] },
      'history.items.2-value': { count: 1, visible: true, bounds: box(300, 90, 100, 50), text: dates[1] }
    } };
    if (dom) for (const facts of Object.values(result.elements)) facts.dynamicExcluded = true;
    return result;
  };
  const prototype = shot('Back Returns phrases Ordering phrases Note', 'Returns phrases Ordering phrases', ['Returns phrases', 'Ordering phrases'], ['Today', 'Sep 18'], true);
  // The iOS container leaves the field out and reads the rows without their dates.
  assert.deepEqual(compareStructure(page, state, prototype, shot('Back Returns phrases Ordering phrases Note', 'Returns phrases Ordering phrases', ['Returns phrases', 'Ordering phrases'], ['Today', 'Sep 20'])).reasons, []);
  // Rows and a container that read the dates too still compare equal.
  assert.deepEqual(compareStructure(page, state, prototype, shot('Back Returns phrases Today Ordering phrases Sep 20 Note', 'Returns phrases Today Ordering phrases Sep 20', ['Returns phrases Today', 'Ordering phrases Sep 20'], ['Today', 'Sep 20'])).reasons, []);
  // A row title that lost the word still fails.
  assert.deepEqual(compareStructure(page, state, prototype, shot('Back Returns Ordering phrases Note', 'Returns Ordering phrases', ['Returns', 'Ordering phrases'], ['Today', 'Sep 20'])).reasons,
    ['history: text "Back Returns phrases Ordering phrases Note" vs "Back Returns Ordering phrases Note"', 'history.items: text "Returns phrases Ordering phrases" vs "Returns Ordering phrases"', 'history.items.1: text "Returns phrases" vs "Returns"']);
});

test('T1 structure removes a longer dynamic text before a shorter one it contains', () => {
  const page = { anchors: [
    { id: 'tasks', role: 'screen', parent: null },
    { id: 'tasks.titlebar', role: 'element', parent: 'tasks', dynamic: true },
    { id: 'tasks.context', role: 'element', parent: 'tasks', dynamic: true },
    { id: 'tasks.board', role: 'element', parent: 'tasks' }
  ] };
  const shot = board => ({ elements: {
    tasks: { count: 1, visible: true, bounds: box(0, 0, 400, 300), text: `Tasks Work Tasks Quotes ${board}` },
    'tasks.titlebar': { count: 1, visible: true, bounds: box(0, 0, 400, 20), text: 'Tasks' },
    'tasks.context': { count: 1, visible: true, bounds: box(0, 20, 100, 280), text: 'Work Tasks Quotes' },
    'tasks.board': { count: 1, visible: true, bounds: box(100, 20, 300, 280), text: board }
  } });
  assert.deepEqual(compareStructure(page, state, shot('Table Board New task'), shot('Table Board New task')).reasons, []);
  assert.deepEqual(compareStructure(page, state, shot('Table Board New task'), shot('Table Board')).reasons, ['tasks: text "Table Board New task" vs "Table Board"', 'tasks.board: text "Table Board New task" vs "Table Board"']);
});
