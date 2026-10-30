import { PNG } from 'pngjs';

/*
 * Platform-neutral interpretation of a native accessibility snapshot as driver-protocol facts. Each platform driver
 * normalises its raw nodes into this vocabulary first (iOS: XCUITest element types as-is, see
 * drivers/ios/UITests/CaptureTests.swift; Android: src/drivers/android-tree.js). Node shape:
 *   { type, identifier, label, value?, placeholder?, enabled, visible?, frame: { x, y, width, height } (points/dp), children? }
 * Pure functions, so the rules are testable without a simulator or emulator.
 */

const TEXT_ENTRY = new Set(['textField', 'secureTextField', 'searchField', 'textView']);
const CONTROLS = new Set(['switch', 'toggle', 'checkBox', 'radioButton', 'slider', 'stepper', 'picker', 'pickerWheel', 'datePicker', 'segmentedControl']);
const EDITABLE = new Set([...TEXT_ENTRY, ...CONTROLS]);
const INTERACTIVE = new Set([...EDITABLE, 'button', 'link', 'cell', 'menuItem', 'tab']);
const LABELLED = new Set(['button', 'link', 'staticText', 'menuItem', 'tab']);
const INPUT_TYPES = { textField: 'text', secureTextField: 'password', searchField: 'search', switch: 'checkbox', toggle: 'checkbox', checkBox: 'checkbox', radioButton: 'radio', slider: 'range' };

const frameOf = node => node.frame ?? { x: 0, y: 0, width: 0, height: 0 };

/**
 * Reading order: rows top to bottom, then left to right. Two elements share a row when their centres are within half
 * the smaller height, or when they sit side by side (no horizontal overlap) and one's centre lies within the other's
 * height: a tall ring or icon beside a stack of text lines reads first, as in the DOM of a media-object layout.
 */
export function readingOrder(nodes) {
  return [...nodes].sort((a, b) => {
    const fa = frameOf(a), fb = frameOf(b);
    const ca = fa.y + fa.height / 2, cb = fb.y + fb.height / 2;
    const tolerance = Math.max(1, Math.min(fa.height, fb.height) / 2);
    const sideBySide = fa.x + fa.width <= fb.x || fb.x + fb.width <= fa.x;
    const within = (centre, frame) => centre >= frame.y && centre <= frame.y + frame.height;
    const sameRow = Math.abs(ca - cb) <= tolerance || (sideBySide && (within(ca, fb) || within(cb, fa)));
    return sameRow ? fa.x - fb.x : ca - cb;
  });
}

/**
 * Text a text-entry field shows: its value, or the placeholder while empty (web: value || placeholder). Without a
 * platform placeholder the label stands in: Flutter on iOS exposes the hint as the field's accessibility label.
 */
function fieldText(node) {
  const value = node.value ?? '';
  return value && value !== node.placeholder ? value : node.placeholder || node.label || '';
}

/**
 * Join a container's text parts (nodes in reading order). Native controls often repeat a visible label as their
 * accessible name (a switch named like the title beside it), so a control's label that matches other text in the
 * container is left out wherever it stands, and consecutive duplicates collapse.
 */
const apart = (a, b) => area(frameOf(a)) > 0 && area(frameOf(b)) > 0 && overlap(frameOf(a), frameOf(b)) < 0.5;
function joinText(nodes) {
  const shown = new Set(nodes.filter(item => !CONTROLS.has(item.type)).map(item => item.label));
  const parts = nodes.filter(item => !CONTROLS.has(item.type) || !shown.has(item.label));
  return parts.filter((item, index) => index === 0 || item.label !== parts[index - 1].label || apart(item, parts[index - 1]))
    .map(item => item.label).join(' ');
}

/**
 * Visible text of a subtree, like the DOM's innerText: labels of text, buttons and controls in reading order, never
 * typed field values.
 */
export function subtreeText(node) {
  const parts = [];
  const visit = item => {
    if (TEXT_ENTRY.has(item.type) || item.visible === false) return;
    if (LABELLED.has(item.type) && item.label) { parts.push(item); return; }
    if (!item.children?.length) { if (item.label) parts.push(item); return; }
    for (const child of readingOrder(item.children)) visit(child);
  };
  visit(node);
  return joinText(parts);
}

const inside = (inner, outer) => {
  const x = inner.x + inner.width / 2, y = inner.y + inner.height / 2;
  return inner.width > 0 && inner.height > 0 && x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
};

const SCROLLERS = new Set(['scrollView', 'table', 'collectionView']);
/**
 * Content a scroll view has scrolled out of sight is still on the page: the web counts an element below the fold as
 * visible, and its text as part of its container. Maps each node whose centre lies outside its nearest scroll view, or
 * whose scroll view is itself scrolled out (a horizontal row below the fold), to that scroll view, so visibility and
 * container text treat it as rendered rather than hidden.
 */
export function scrolledOut(tree) {
  const scrolled = new Map();
  const visit = (node, scroller) => {
    const frame = frameOf(node);
    if (scroller && frame.width > 0 && frame.height > 0 && (scrolled.has(scroller) || !inside(frame, frameOf(scroller)))) scrolled.set(node, scroller);
    for (const child of node.children ?? []) visit(child, SCROLLERS.has(node.type) ? node : scroller);
  };
  visit(tree, null);
  return scrolled;
}

/**
 * Visible text inside a frame, for containers that the platform reports as leaves: React Native (Fabric) flattens the
 * accessibility tree, so a View's text and buttons are siblings that lie within its frame rather than its children.
 * Text scrolled out of a scroll view belongs to the container that holds the scroll view. A scroll view's content reads
 * as one block placed where the scroll view is, like the DOM's document order: a tab bar floating over the scroll view
 * reads after it, not between the content above and below the fold. Units that overlap are layers (see layers()): an
 * overlay such as a side drawer reads after what it covers, like an element later in the DOM, and its items never count
 * as text enclosed by an element of the layer underneath. Scroll views are placed by the tree, not by clipped frames.
 */
export function textWithin(tree, container, scrolled = scrolledOut(tree), { screen = false } = {}) {
  const frame = frameOf(container);
  const found = [], owner = new Map(), outer = new Map(), parent = new Map(), order = new Map();
  // A scroll view's content is the text of a container outside it only when the scroll view lies in the container as
  // well: a message scrolled up under the header is not the header's text, nor are the cards under a floating composer
  // the composer's. Content scrolled out of sight lies where its scroll view is. A container in the scroll view scrolls
  // along with it and compares frames directly, but only within the scroll view's visible frame: the header over the
  // part of a message list scrolled out above it is not the list's text.
  const along = new Set();
  const enclose = (item, scrollers) => {
    if (item === container) { scrollers.forEach(scroller => along.add(scroller)); return true; }
    return (item.children ?? []).some(child => enclose(child, SCROLLERS.has(item.type) ? [...scrollers, item] : scrollers));
  };
  enclose(tree, []);
  const scrollers = scroller => { const list = new Set(); for (let item = scroller; item; item = outer.get(item)) list.add(item); return list; };
  const within = (item, scroller) => !scroller || along.has(scroller)
    ? inside(frameOf(item), frame) && [...along].every(clip => scrollers(scroller).has(clip) || inside(frameOf(item), frameOf(clip)))
    : within(scroller, outer.get(scroller)) && (scrolled.has(item) || inside(frameOf(item), frame));
  const visit = (item, scroller) => {
    order.set(item, order.size);
    if (item === container) owner.set(item, scroller);
    if (item === container || item.visible === false) return;
    if (within(item, scroller) && !TEXT_ENTRY.has(item.type)) {
      const leaf = (LABELLED.has(item.type) && item.label) || (!item.children?.length && item.label && item.type !== 'application' && item.type !== 'window');
      if (leaf) { found.push(item); owner.set(item, scroller); return; }
    }
    if (SCROLLERS.has(item.type)) outer.set(item, scroller);
    for (const child of item.children ?? []) { parent.set(child, item); visit(child, SCROLLERS.has(item.type) ? item : scroller); }
  };
  visit(tree, null);
  const chain = item => { const list = []; for (let scroller = owner.get(item); scroller; scroller = outer.get(scroller)) list.unshift(scroller); return list; };
  const top = item => chain(item)[0] ?? item;
  // A flattened container's own content are its siblings (and their descendants). A unit from outside its parent's
  // subtree that is drawn above it (a sheet's button over a note in the page underneath) is not its text, though its
  // centre lies within. The screen anchor reads every layer, as the prototype's root contains its sheets and tab bar.
  const home = top(container), base = parent.get(container);
  const under = node => { for (let item = node; item; item = parent.get(item)) if (item === base) return true; return false; };
  const above = new Map(screen ? [] : [...new Set(found.map(top))].filter(unit => unit !== home && !under(unit)).map(unit => {
    const pair = layers([home, unit], parent, order);
    return [unit, pair.get(unit).level > pair.get(home).level];
  }));
  for (let index = found.length - 1; index >= 0; index--) if (above.get(top(found[index]))) found.splice(index, 1);
  const placed = layers([...new Set(found.map(top))], parent, order);
  // A labelled leaf that encloses other text of its own layer is a flattened container (a tab bar named "Main
  // navigation"): its label is an accessible name, which the DOM's innerText leaves out as well. A drawer's item over a
  // progress ring is not the ring's content.
  const encloses = (outer, inner) => outer !== inner && inside(frameOf(inner), frameOf(outer)) && placed.get(top(outer)).level === placed.get(top(inner)).level;
  const text = found.filter(item => LABELLED.has(item.type) || !found.some(other => encloses(item, other)));
  const ordered = (items, depth) => {
    const units = new Map();
    for (const item of items) { const key = chain(item)[depth] ?? item; units.set(key, [...(units.get(key) ?? []), item]); }
    return stacked([...units.keys()], depth ? layers([...units.keys()], parent, order) : placed)
      .flatMap(key => units.get(key)[0] === key ? [key] : ordered(units.get(key), depth + 1));
  };
  return joinText(ordered(text, 0));
}

const area = frame => Math.max(0, frame.width) * Math.max(0, frame.height);
const contains = (outer, inner) => inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
/** Share of the smaller frame that the two frames have in common. */
function overlap(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const smaller = Math.min(area(a), area(b));
  return width > 0 && height > 0 && smaller > 0 ? width * height / smaller : 0;
}

/**
 * Layers of reading units (leaves and scroll views), from the tree: where two units part ways, the branch that comes
 * later is drawn above the earlier one when the units of the two branches cover at least half of the smaller extent, as
 * in the DOM, where an overlay later in the document reads after the page underneath whatever its position. A branch
 * wholly inside an earlier leaf (a badge on a button, a drawer's items on its flattened background) is that leaf's
 * content and lies on the leaf's layer and in its overlay, not above it. Branches that only touch or graze stay on one
 * layer, so plain layouts keep their geometric reading order. Maps each unit to { level, overlay, rank }: the overlay
 * is the branch that lifted it, ranked by its position in the tree (`order`).
 */
function layers(units, parent, order) {
  const path = new Map(units.map(unit => { const list = []; for (let node = unit; node; node = parent.get(node)) list.unshift(node); return [unit, list]; }));
  const extents = new Map();
  const extent = branch => {
    if (!extents.has(branch)) {
      const frames = units.filter(unit => path.get(unit).includes(branch)).map(frameOf);
      const x = Math.min(...frames.map(f => f.x)), y = Math.min(...frames.map(f => f.y));
      extents.set(branch, { x, y, width: Math.max(...frames.map(f => f.x + f.width)) - x, height: Math.max(...frames.map(f => f.y + f.height)) - y });
    }
    return extents.get(branch);
  };
  const parting = (unit, other) => {
    const a = path.get(unit), b = path.get(other);
    let at = 0;
    while (a[at] === b[at] && at < a.length && at < b.length) at++;
    return at < a.length && at < b.length ? [a[at], b[at]] : null;
  };
  const branch = (unit, other) => parting(unit, other)[0];
  // How far above the earlier unit `other` the unit lies: 1 above it, 0 on its layer (its content), null unrelated.
  const lift = (unit, other) => {
    const pair = parting(unit, other);
    if (!pair) return null;
    const mine = extent(pair[0]), theirs = extent(pair[1]);
    if (pair[1] === other && !SCROLLERS.has(other.type) && contains(frameOf(other), mine)) return 0;
    return overlap(mine, theirs) >= 0.5 ? 1 : null;
  };
  const placed = new Map(), earlier = [];
  for (const unit of [...units].sort((a, b) => order.get(a) - order.get(b))) {
    let place = { level: 0, overlay: null, rank: 0 };
    for (const other of earlier) {
      const by = lift(unit, other);
      if (by === null) continue;
      const level = placed.get(other).level + by;
      // On a tie the leaf the unit lies in wins: a drawer's items belong to the drawer, not to what they cover.
      if (level < place.level || (level === place.level && (by || !level))) continue;
      const overlay = by ? branch(unit, other) : placed.get(other).overlay;
      place = { level, overlay, rank: order.get(overlay) ?? 0 };
    }
    placed.set(unit, place);
    earlier.push(unit);
  }
  return placed;
}

/**
 * Units in reading order by layer: the page underneath by geometry, then each layer above it, overlay by overlay in tree
 * order (a tab bar before a drawer that comes later in the tree, even where they do not overlap), each by geometry.
 */
function stacked(units, placed) {
  const groups = new Map();
  for (const unit of units) {
    const { level, rank } = placed.get(unit), id = `${level}:${rank}`;
    groups.set(id, { level, rank, units: [...(groups.get(id)?.units ?? []), unit] });
  }
  return [...groups.values()].sort((a, b) => a.level - b.level || a.rank - b.rank).flatMap(group => readingOrder(group.units));
}

/**
 * The element's own text: field value/placeholder, nothing for controls (web reports '' for checkboxes), the label of
 * text and buttons, else the visible text it contains (by hierarchy, or by geometry when the tree is flattened).
 */
export function elementText(node, tree = null, scrolled = undefined, { screen = false } = {}) {
  if (TEXT_ENTRY.has(node.type)) return fieldText(node);
  if (CONTROLS.has(node.type)) return '';
  if (LABELLED.has(node.type)) return node.label ?? '';
  if (node.children?.length) return subtreeText(node);
  return tree && !node.label ? textWithin(tree, node, scrolled, { screen }) : node.label ?? '';
}

function collect(node, byId = new Map()) {
  if (node.identifier) byId.set(node.identifier, [...(byId.get(node.identifier) ?? []), node]);
  for (const child of node.children ?? []) collect(child, byId);
  return byId;
}

const intersects = (a, b) => a.width > 0 && a.height > 0 && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Facts for every requested anchor, in points relative to the content frame.
 * `content` is the frame the capture represents (the device safe area, or the whole screen); the screen anchor is
 * reported as exactly that frame, because on native platforms a screen is the content area itself while SwiftUI and
 * React Native containers only report the union of their children.
 */
export function anchorFacts(tree, { anchors, screen, content }) {
  const byId = collect(tree);
  const scrolled = scrolledOut(tree);
  const elements = [], missing = [];
  for (const anchor of anchors) {
    const nodes = byId.get(anchor) ?? [];
    if (!nodes.length) { missing.push(anchor); continue; }
    const node = nodes[0];
    const frame = frameOf(node);
    const bounds = anchor === screen
      ? { x: 0, y: 0, width: content.width, height: content.height }
      : { x: frame.x - content.x, y: frame.y - content.y, width: frame.width, height: frame.height };
    elements.push({
      anchor, count: nodes.length,
      visible: anchor === screen || (node.visible !== false && (intersects(frame, content) || scrolled.has(node))),
      enabled: node.enabled !== false,
      interactive: INTERACTIVE.has(node.type),
      editable: EDITABLE.has(node.type),
      inputType: INPUT_TYPES[node.type] ?? null,
      role: node.type,
      bounds,
      text: elementText(node, tree, scrolled, { screen: anchor === screen })
    });
  }
  return { elements, missing };
}

/** Crop a device screenshot (PNG buffer) to a frame in points; returns { png, scale }. */
export function cropScreenshot(buffer, frame, screenWidthPoints) {
  const image = PNG.sync.read(buffer);
  const scale = image.width / screenWidthPoints;
  const left = Math.round(frame.x * scale), top = Math.round(frame.y * scale);
  const width = Math.min(Math.round(frame.width * scale), image.width - left), height = Math.min(Math.round(frame.height * scale), image.height - top);
  const out = new PNG({ width, height });
  PNG.bitblt(image, out, left, top, width, height, 0, 0);
  return { png: PNG.sync.write(out), scale: Math.round(scale * 100) / 100 };
}

/** Steps after which a software keyboard may stay up: the state is "while typing", as in the prototype. */
const EDITING_STEPS = new Set(['fill', 'clear']);

/** The tree without the software keyboard's own nodes: its keys are not part of the app's screen. */
function withoutKeyboard(node) {
  if (!node.children?.length) return node;
  return { ...node, children: node.children.filter(child => child.type !== 'keyboard').map(withoutKeyboard) };
}

/** The part of `box` inside `content`, in content coordinates; null when they do not overlap. */
function clipTo(box, content) {
  const x = Math.max(box.x, content.x), y = Math.max(box.y, content.y);
  const right = Math.min(box.x + box.width, content.x + content.width), bottom = Math.min(box.y + box.height, content.y + content.height);
  return right > x && bottom > y ? { x: x - content.x, y: y - content.y, width: right - x, height: bottom - y } : null;
}

/**
 * Turn a normalised capture ({ status, tree, safeArea?, keyboardVisible?, keyboardFrame?, reason? }) into a driver
 * response. `frame` is 'safe-area' (default: the device content area without system bars) or 'device'.
 * A software keyboard still up after the steps is FAIL, unless the last step is `fill` or `clear`: then the state is
 * the field being edited (focus kept, as the prototype keeps it), and the keyboard's frame is reported as `occluded`
 * so the tiers leave those pixels out. Elements behind it stay in the tree as rendered, like content scrolled away.
 * Returns { response, png } where png is the cropped screenshot to write next to the response.
 */
export function nativeResponse(raw, deviceScreenshot, { anchors, screen, frame = 'safe-area', safeArea = null, steps = [] }) {
  if (!raw || raw.status !== 'PASS') return { response: { schemaVersion: 1, status: raw?.status === 'FAIL' ? 'FAIL' : 'NOT_RUN', reason: raw?.reason ?? 'capture produced no result' } };
  const device = frameOf(raw.tree);
  // XCUITest reports a keyboard element whenever a field has focus, even one parked below the screen (a Simulator
  // with a connected hardware keyboard): only a keyboard frame that reaches the screen covers anything.
  const keyboardUp = raw.keyboardVisible === true && (!raw.keyboardFrame || clipTo(raw.keyboardFrame, device) !== null);
  const editing = EDITING_STEPS.has(steps?.at(-1)?.action);
  if (keyboardUp && !editing) return { response: { schemaVersion: 1, status: 'FAIL', reason: 'the software keyboard is still visible after the steps; the app must dismiss it (end editing) before the state is captured (only a state whose last step is fill or clear may keep it up)' } };
  if (keyboardUp && !raw.keyboardFrame) return { response: { schemaVersion: 1, status: 'NOT_RUN', reason: 'the software keyboard is up after the last fill/clear step but its frame could not be measured' } };
  const area = raw.safeArea ?? safeArea;
  if (frame === 'safe-area' && !area) return { response: { schemaVersion: 1, status: 'NOT_RUN', reason: 'the device safe area could not be measured' } };
  const measured = frame === 'device' ? { x: 0, y: 0, width: device.width, height: device.height } : area;
  // Whole points, so the viewport and the cropped screenshot always agree (a 136 px status bar is 45.33 dp at 3×).
  const content = { ...measured, width: Math.floor(measured.width + 1e-6), height: Math.floor(measured.height + 1e-6) };
  const { png, scale } = cropScreenshot(deviceScreenshot, content, device.width);
  const { elements, missing } = anchorFacts(withoutKeyboard(raw.tree), { anchors, screen, content });
  const keyboard = keyboardUp ? clipTo(raw.keyboardFrame, content) : null;
  return {
    png,
    response: { schemaVersion: 1, status: 'PASS', screenshot: 'screen.png', viewport: { width: content.width, height: content.height, scale }, elements, missing, ...(keyboard && { occluded: [keyboard] }) }
  };
}
