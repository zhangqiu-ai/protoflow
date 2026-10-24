import { nativeResponse } from './native-tree.js';

/*
 * Normalise the raw UiAutomator snapshot written by drivers/android (CaptureTest) into the native-tree vocabulary.
 * Raw capture: { status, reason?, density, screen: { width, height } (px), insets: { left, top, right, bottom } (px),
 * keyboardVisible, tree } with nodes { className, resourceId, text, contentDescription, hint, showingHint, checkable,
 * clickable, editable, password, enabled, visible, bounds: { left, top, right, bottom } (px), size: { width, height } (px),
 * scrollable, children }.
 */

/**
 * Anchor ID of a resource id. Compose (testTagsAsResourceId), React Native and Flutter expose the anchor as-is.
 * Android View ids cannot contain `.` or `-`, so views use the reversible transform `.` → `__`, `-` → `_`
 * (anchor IDs never contain `_`); the `<package>:id/` prefix is dropped.
 */
export function anchorFromResource(resourceId) {
  if (!resourceId) return null;
  const name = resourceId.includes(':id/') ? resourceId.slice(resourceId.indexOf(':id/') + 4) : resourceId;
  return name.includes('.') || !name.includes('_') ? name : name.replaceAll('__', '.').replaceAll('_', '-');
}
/** The View id for an anchor ID (inverse of anchorFromResource for view-based apps). */
export const resourceFromAnchor = anchor => anchor.replaceAll('-', '_').replaceAll('.', '__');

const shortClass = className => String(className ?? '').split('.').pop();

/** Map an Android node to the shared element types (see native-tree.js). */
export function nodeType(node) {
  const cls = shortClass(node.className);
  const label = node.text || node.contentDescription;
  if (node.editable || /EditText|AutoCompleteTextView/.test(cls)) return node.password ? 'secureTextField' : 'textField';
  // A checkable Button (ToggleButton, or a React Native pressable with a checked state) is a toggle button: its label is
  // its text, like a web button with aria-pressed.
  if (node.checkable) return /Switch/.test(cls) ? 'switch' : /RadioButton/.test(cls) ? 'radioButton' : /CheckBox/.test(cls) ? 'checkBox' : /Button$/.test(cls) ? 'button' : 'checkBox';
  if (/SeekBar|Slider/.test(cls)) return 'slider';
  if (scrolls(node)) return 'scrollView';
  if (/Button/.test(cls)) return 'button';
  if (node.clickable && label && !node.children?.length) return 'button';
  // Compose / React Native pressables: a clickable container whose content is only text is one action.
  if (node.clickable && node.children?.length && onlyText(node.children)) return 'button';
  if (/TextView|Text$/.test(cls) && label) return 'staticText';
  if (/Image/.test(cls)) return 'image';
  if (/WebView/.test(cls)) return 'webView';
  return 'other';
}

const interactive = node => node.clickable || node.editable || node.checkable;
const scrolls = node => node.scrollable === true || /(?:Horizontal)?ScrollView$|RecyclerView|ListView/.test(shortClass(node.className));

/**
 * UiAutomator clips a node's screen bounds to each ancestor and reports content a scroll view has scrolled out of
 * sight as not visible to the user, though it is rendered (the web counts it as visible below the fold). The driver
 * also reports the node's own size, so its bounds are restored: an edge clamped to the nearest scroll view's edge
 * moves out by the missing size (a node below keeps its true top, a node above its true bottom), and a node that was
 * clipped away is visible again. A node hidden inside a scroll view is not clipped and stays hidden.
 */
export function restoreScrolled(node, clip = null) {
  let restored = node;
  if (clip && node.size && node.bounds) {
    const bounds = { ...node.bounds };
    const extend = (start, end, length) => {
      if (bounds[end] - bounds[start] >= length) return false;
      if (bounds[start] === clip[start] && bounds[end] !== clip[end]) bounds[start] = bounds[end] - length;
      else bounds[end] = bounds[start] + length;
      return true;
    };
    const vertical = extend('top', 'bottom', node.size.height), horizontal = extend('left', 'right', node.size.width);
    if (vertical || horizontal) restored = { ...node, bounds, visible: true };
  }
  const children = node.children?.map(child => restoreScrolled(child, scrolls(node) ? node.bounds : clip));
  return children ? { ...restored, children } : restored;
}
function onlyText(children) {
  return children.every(child => !interactive(child) && (child.children?.length ? onlyText(child.children) : true)) && texts(children).length > 0;
}
/** Visible descendant texts in tree order (labels of a composed button, or a field's placeholder). */
function texts(children) {
  return children.flatMap(child => child.visible === false ? [] : [child.text || child.contentDescription, ...texts(child.children ?? [])]).filter(Boolean);
}

const toFrame = (bounds, density) => ({
  x: bounds.left / density, y: bounds.top / density,
  width: Math.max(0, bounds.right - bounds.left) / density, height: Math.max(0, bounds.bottom - bounds.top) / density
});

export function normalizeNode(node, density) {
  const type = nodeType(node);
  const field = type === 'textField' || type === 'secureTextField';
  const value = field ? (node.showingHint ? '' : node.text ?? '') : null;
  // A composed button takes its label from its text; a field without a platform hint shows its placeholder as child
  // text (Compose decorationBox, Flutter). Both absorb those children, so containers do not count the text twice.
  const absorbed = field || (type === 'button' && !node.text && !node.contentDescription && node.children?.length);
  return {
    type,
    identifier: anchorFromResource(node.resourceId),
    label: field ? '' : node.text || node.contentDescription || (absorbed ? texts(node.children).join(' ') : ''),
    ...(field && { value, placeholder: node.hint || (!value ? texts(node.children ?? []).join(' ') : '') }),
    enabled: node.enabled !== false,
    visible: node.visible !== false,
    frame: toFrame(node.bounds, density),
    ...(!absorbed && node.children?.length && { children: node.children.map(child => normalizeNode(child, density)) })
  };
}

/** Normalised capture for nativeResponse: a screen-sized root, the content area in dp, the keyboard flag and its frame. */
export function normalizeCapture(raw) {
  if (!raw || raw.status !== 'PASS') return raw;
  const { density, screen, insets = { left: 0, top: 0, right: 0, bottom: 0 } } = raw;
  return {
    status: 'PASS',
    keyboardVisible: raw.keyboardVisible === true,
    ...(raw.keyboardFrame && { keyboardFrame: toFrame(raw.keyboardFrame, density) }),
    safeArea: {
      x: insets.left / density, y: insets.top / density,
      width: (screen.width - insets.left - insets.right) / density, height: (screen.height - insets.top - insets.bottom) / density
    },
    tree: { type: 'application', label: '', enabled: true, frame: { x: 0, y: 0, width: screen.width / density, height: screen.height / density }, children: [normalizeNode(restoreScrolled(raw.tree), density)] }
  };
}

export const androidResponse = (raw, deviceScreenshot, options) => nativeResponse(normalizeCapture(raw), deviceScreenshot, options);
