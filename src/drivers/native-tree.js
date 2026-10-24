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

/** Reading order: rows top to bottom (centres within half the smaller height share a row), then left to right. */
export function readingOrder(nodes) {
  return [...nodes].sort((a, b) => {
    const fa = frameOf(a), fb = frameOf(b);
    const ca = fa.y + fa.height / 2, cb = fb.y + fb.height / 2;
    const tolerance = Math.max(1, Math.min(fa.height, fb.height) / 2);
    return Math.abs(ca - cb) > tolerance ? ca - cb : fa.x - fb.x;
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
 * Visible text of a subtree, like the DOM's innerText: labels of text, buttons and controls in reading order, never
 * typed field values. Consecutive duplicates collapse, because native controls often repeat their visible label.
 */
export function subtreeText(node) {
  const parts = [];
  const visit = item => {
    if (TEXT_ENTRY.has(item.type) || item.visible === false) return;
    if (LABELLED.has(item.type) && item.label) { parts.push(item.label); return; }
    if (!item.children?.length) { if (item.label) parts.push(item.label); return; }
    for (const child of readingOrder(item.children)) visit(child);
  };
  visit(node);
  return parts.filter((part, index) => part !== parts[index - 1]).join(' ');
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
 * Text scrolled out of a scroll view belongs to the container that holds the scroll view.
 */
export function textWithin(tree, container, scrolled = scrolledOut(tree)) {
  const frame = frameOf(container);
  const found = [];
  const within = item => inside(frameOf(item), frame) || (scrolled.has(item) && within(scrolled.get(item)));
  const visit = item => {
    if (item === container || item.visible === false) return;
    if (within(item) && !TEXT_ENTRY.has(item.type)) {
      if (LABELLED.has(item.type) && item.label) { found.push(item); return; }
      if (!item.children?.length && item.label && item.type !== 'application' && item.type !== 'window') { found.push(item); return; }
    }
    for (const child of item.children ?? []) visit(child);
  };
  visit(tree);
  // A labelled leaf that encloses other text is a flattened container (a tab bar named "Main navigation"): its label
  // is an accessible name, which the DOM's innerText leaves out as well.
  const encloses = (outer, inner) => outer !== inner && inside(frameOf(inner), frameOf(outer));
  const text = found.filter(item => LABELLED.has(item.type) || !found.some(other => encloses(item, other)));
  const parts = readingOrder(text).map(item => item.label);
  return parts.filter((part, index) => part !== parts[index - 1]).join(' ');
}

/**
 * The element's own text: field value/placeholder, nothing for controls (web reports '' for checkboxes), the label of
 * text and buttons, else the visible text it contains (by hierarchy, or by geometry when the tree is flattened).
 */
export function elementText(node, tree = null, scrolled = undefined) {
  if (TEXT_ENTRY.has(node.type)) return fieldText(node);
  if (CONTROLS.has(node.type)) return '';
  if (LABELLED.has(node.type)) return node.label ?? '';
  if (node.children?.length) return subtreeText(node);
  return tree && !node.label ? textWithin(tree, node, scrolled) : node.label ?? '';
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
      text: elementText(node, tree, scrolled)
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

/**
 * Turn a normalised capture ({ status, tree, safeArea?, keyboardVisible?, reason? }) into a driver response.
 * `frame` is 'safe-area' (default: the device content area without system bars) or 'device'.
 * Returns { response, png } where png is the cropped screenshot to write next to the response.
 */
export function nativeResponse(raw, deviceScreenshot, { anchors, screen, frame = 'safe-area', safeArea = null }) {
  if (!raw || raw.status !== 'PASS') return { response: { schemaVersion: 1, status: raw?.status === 'FAIL' ? 'FAIL' : 'NOT_RUN', reason: raw?.reason ?? 'capture produced no result' } };
  if (raw.keyboardVisible) return { response: { schemaVersion: 1, status: 'FAIL', reason: 'the software keyboard is still visible after the steps; the app must dismiss it (end editing) before the state is captured' } };
  const device = frameOf(raw.tree);
  const area = raw.safeArea ?? safeArea;
  if (frame === 'safe-area' && !area) return { response: { schemaVersion: 1, status: 'NOT_RUN', reason: 'the device safe area could not be measured' } };
  const measured = frame === 'device' ? { x: 0, y: 0, width: device.width, height: device.height } : area;
  // Whole points, so the viewport and the cropped screenshot always agree (a 136 px status bar is 45.33 dp at 3×).
  const content = { ...measured, width: Math.floor(measured.width + 1e-6), height: Math.floor(measured.height + 1e-6) };
  const { png, scale } = cropScreenshot(deviceScreenshot, content, device.width);
  const { elements, missing } = anchorFacts(raw.tree, { anchors, screen, content });
  return {
    png,
    response: { schemaVersion: 1, status: 'PASS', screenshot: 'screen.png', viewport: { width: content.width, height: content.height, scale }, elements, missing }
  };
}
