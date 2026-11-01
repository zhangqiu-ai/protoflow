import { elementText, layeredSubtreeText } from './native-tree.js';

const TEXT = new Set(['UILabel.text', 'UIButton.currentTitle', 'RCTParagraphComponentView.attributedText']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const overlap = (a, b) => ({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)) });
const positive = frame => frame.width > 0 && frame.height > 0;
const contains = (a, b) => b.x >= a.x - 1e-6 && b.y >= a.y - 1e-6 && b.x + b.width <= a.x + a.width + 1e-6 && b.y + b.height <= a.y + a.height + 1e-6;
const sameRect = (a, b) => contains(a, b) && contains(b, a);
// A complete nested viewport may differ only by numeric representation, not a physical pixel edge.
// This local exception never changes general containment, local leaf clipping, or text ownership.
const representedSameViewport = (capture, chain, a, b) => {
  const scale = capture.windows?.length === 1 && capture.windows[0].screenScale;
  if (capture.source !== 'currentUIKitViewTree' || capture.occlusion !== 'notComputed'
    || !finite(scale) || scale <= 0 || chain.some(node => node.inputRedacted || node.observedSemantics?.inputKind)) return false;
  const edges = frame => [frame.x, frame.y, frame.x + frame.width, frame.y + frame.height];
  const left = edges(a), right = edges(b);
  return positive(a) && positive(b) && left.every((edge, index) => finite(edge) && finite(right[index])
    && Math.abs(edge - right[index]) <= 1e-4
    && Number.isSafeInteger(Math.round(edge * scale)) && Number.isSafeInteger(Math.round(right[index] * scale))
    && Math.round(edge * scale) === Math.round(right[index] * scale));
};
const assert = (condition, reason) => { if (!condition) throw new Error(`UIKit interpretation: ${reason}`); };
function scrollGeometry(node) {
  const value = node.scrollGeometry;
  if (!value || value.source !== 'UIScrollView.publicGeometry' || value.isScrollView !== true) return null;
  assert(typeof value.scrollEnabled === 'boolean' && ['x', 'y'].every(key => finite(value.contentOffset?.[key])) && ['width', 'height'].every(key => finite(value.contentSize?.[key]) && value.contentSize[key] >= 0) && ['top', 'left', 'bottom', 'right'].every(key => finite(value.contentInset?.[key])), 'invalid public scroll geometry');
  return value;
}

/** Separate derived rendered-content interpretation; the raw UIKit tree/clip/eligibility are never edited. */
export function interpretUIKitCapture(capture, semanticFacts) {
  const root = capture.windows[0].tree;
  const rawNodes = [], paths = new Map(), parents = new Map(), chains = new Map(), eligibility = new Map();
  const scan = (node, at, ancestors) => {
    rawNodes.push(node); paths.set(node, at); chains.set(node, ancestors);
    for (const [index, child] of (node.children ?? []).entries()) { parents.set(child, node); scan(child, [...at, index], [...ancestors, node]); }
  };
  scan(root, [0], []);
  for (const node of rawNodes) {
    const ancestors = chains.get(node), scrollers = ancestors.filter(parent => scrollGeometry(parent));
    const base = { scrollContentEligible: false, scrollContentReason: 'viewportRendered', scrollAncestorPaths: scrollers.map(parent => paths.get(parent)) };
    eligibility.set(node, base);
    if (node.renderEligible) continue;
    if (!node.attachedToWindow) { base.scrollContentReason = 'detached'; continue; }
    if (node.ancestorOrSelfHidden) { base.scrollContentReason = 'hidden'; continue; }
    if (node.effectiveAlpha <= 0) { base.scrollContentReason = 'zeroAlpha'; continue; }
    if (!positive(node.frameInScreen)) { base.scrollContentReason = 'zeroBounds'; continue; }
    if (!scrollers.length) { base.scrollContentReason = 'noObservedScrollAncestor'; continue; }
    if (scrollers.length > 1) {
      // A nested viewport is its outer scroll's content. Never test a distant inner content leaf against an
      // outer cross-axis extent: only the next observed viewport belongs to that coordinate system.
      const chain = [...ancestors, node];
      const observedFrame = frame => frame && ['x', 'y', 'width', 'height'].every(key => finite(frame[key])) && frame.width >= 0 && frame.height >= 0;
      if (chain.some(parent => parent.attachedToWindow !== true || typeof parent.ancestorOrSelfHidden !== 'boolean'
        || parent.ancestorOrSelfHidden || typeof parent.hidden !== 'boolean' || parent.hidden
        || !finite(parent.effectiveAlpha) || parent.effectiveAlpha <= 0 || typeof parent.clipsToBounds !== 'boolean'
        || !observedFrame(parent.frameInScreen))) { base.scrollContentReason = 'incompleteOrIneligibleNestedChain'; continue; }
      if (chain.some(parent => parent.transformed !== false)) { base.scrollContentReason = 'transformedGeometryUnsupported'; continue; }
      if (chain.some(parent => parent.scrollGeometry != null && !scrollGeometry(parent))) { base.scrollContentReason = 'untrustedNestedScrollGeometry'; continue; }
      if (scrollers[0].renderEligible !== true || !positive(scrollers[0].frameInScreen)) { base.scrollContentReason = 'scrollViewportNotRendered'; continue; }
      let reason = null;
      for (const [index, scroll] of scrollers.entries()) {
        const geometry = scrollGeometry(scroll), next = scrollers[index + 1], target = next ?? node;
        if (!geometry || !geometry.scrollEnabled || !positive(scroll.frameInScreen)) { reason = 'unsupportedNestedScrollViewport'; break; }
        const local = { ...target.frameInScreen, x: target.frameInScreen.x - scroll.frameInScreen.x + geometry.contentOffset.x,
          y: target.frameInScreen.y - scroll.frameInScreen.y + geometry.contentOffset.y };
        const extent = { x: -geometry.contentInset.left, y: -geometry.contentInset.top,
          width: geometry.contentSize.width + geometry.contentInset.left + geometry.contentInset.right,
          height: geometry.contentSize.height + geometry.contentInset.top + geometry.contentInset.bottom };
        if (!positive(target.frameInScreen) || !contains(extent, local)) { reason = 'outsideObservedContentExtent'; break; }
        const start = ancestors.indexOf(scroll) + 1, end = next ? ancestors.indexOf(next) : ancestors.length;
        if (start <= 0 || end < start) { reason = 'inconsistentNestedScrollChain'; break; }
        const clips = ancestors.slice(start, end).filter(parent => parent.clipsToBounds);
        if (next) {
          // Partial intermediate clipping needs composed scroll/clip reasoning that is not observed here.
          // Support only a complete next viewport; a positive overlap alone would admit permanently hidden text.
          if (clips.some(parent => !contains(parent.frameInScreen, next.frameInScreen)
            && !representedSameViewport(capture, chain, parent.frameInScreen, next.frameInScreen))) { reason = 'partialNestedViewportClipUnsupported'; break; }
        } else {
          let localClip = node.frameInScreen;
          for (const parent of clips) localClip = overlap(localClip, parent.frameInScreen);
          if (!positive(localClip)) { reason = 'nonScrollContentClip'; break; }
        }
      }
      if (reason) { base.scrollContentReason = reason; continue; }
      base.scrollContentEligible = true; base.scrollContentReason = 'observedNestedScrollContentOutsideViewport';
      continue;
    }
    if ([...ancestors, node].some(parent => parent.transformed)) { base.scrollContentReason = 'transformedGeometryUnsupported'; continue; }
    const scroll = scrollers[0], geometry = scrollGeometry(scroll);
    if (!scroll.renderEligible || !positive(scroll.frameInScreen)) { base.scrollContentReason = 'scrollViewportNotRendered'; continue; }
    const local = { ...node.frameInScreen, x: node.frameInScreen.x - scroll.frameInScreen.x + geometry.contentOffset.x, y: node.frameInScreen.y - scroll.frameInScreen.y + geometry.contentOffset.y };
    const extent = { x: -geometry.contentInset.left, y: -geometry.contentInset.top, width: geometry.contentSize.width + geometry.contentInset.left + geometry.contentInset.right, height: geometry.contentSize.height + geometry.contentInset.top + geometry.contentInset.bottom };
    if (!contains(extent, local)) { base.scrollContentReason = 'outsideObservedContentExtent'; continue; }
    let localClip = node.frameInScreen;
    for (const parent of ancestors.slice(ancestors.indexOf(scroll) + 1)) if (parent.clipsToBounds) localClip = overlap(localClip, parent.frameInScreen);
    if (!positive(localClip)) { base.scrollContentReason = 'nonScrollContentClip'; continue; }
    base.scrollContentEligible = true; base.scrollContentReason = 'observedScrollContentOutsideViewport';
  }
  const rawFor = new Map(), normalizedFor = new Map();
  const normalize = node => {
    const semantics = semanticFacts(node), ownText = TEXT.has(node.textSource) ? node.text : '';
    let type = node.inputRedacted ? 'textField' : scrollGeometry(node) ? 'scrollView' : semantics.role ?? 'other';
    if (TEXT.has(node.textSource) && !['checkBox', 'radioButton', 'switch'].includes(type)) type = semantics.role === 'button' && ownText ? 'button' : 'staticText';
    else if (['button', 'link'].includes(type) && !ownText) type = 'other';
    const normalized = { type, identifier: node.identifier, label: ownText, frame: node.frameInScreen,
      visible: node.renderEligible || eligibility.get(node).scrollContentEligible, children: (node.children ?? []).map(normalize) };
    rawFor.set(normalized, node); normalizedFor.set(node, normalized);
    return normalized;
  };
  const tree = normalize(root);
  const under = (node, ancestor) => node === ancestor || chains.get(node).includes(ancestor);
  const facts = (node, { screen = false } = {}) => {
    const scope = screen ? root : node, normalized = normalizedFor.get(scope);
    const selected = [];
    const onTextParts = parts => selected.push(...parts);
    // Fabric's flattened content is in actual siblings and their descendants, not another parent branch.
    // Keep full-window layering for the screen; derive local scroll ordering only when geometry needs it.
    const localTree = normalizedFor.get(parents.get(node)) ?? tree;
    let text = screen ? layeredSubtreeText(normalized, { onTextParts, renderedHierarchy: true })
      : elementText(normalized, localTree, undefined, { onTextParts, renderedHierarchy: true, excludeAncestorLabels: true });
    let parts = selected.map(part => rawFor.get(part)).filter(Boolean);
    if (!normalized.visible) { text = ''; parts = []; }
    // A named accessibility-only leaf supplies no physical text ownership. Do not collect unrelated
    // enclosing siblings as its label; its raw metadata remains distinct and its actual subtree is empty.
    if (!screen && !node.children?.length && !TEXT.has(node.textSource) && node.accessibilityLabel) { text = ''; parts = []; }
    const flattened = !screen && !node.inputRedacted && !node.children?.length && !TEXT.has(node.textSource) && parts.some(part => !under(part, node));
    if (flattened) {
      for (const part of parts) {
        assert(![node, ...chains.get(node), part, ...chains.get(part)].some(item => item.transformed), 'transformed flattened text geometry');
        const peers = rawNodes.filter(other => other !== node && other.identifier && !other.children?.length && !TEXT.has(other.textSource) && !other.inputRedacted && parents.get(other) === parents.get(node) && normalizedFor.get(other).visible);
        for (const other of peers) {
          const coversText = positive(overlap(other.frameInScreen, part.frameInScreen));
          const nested = contains(node.frameInScreen, other.frameInScreen) || contains(other.frameInScreen, node.frameInScreen);
          assert(!coversText || nested && !sameRect(node.frameInScreen, other.frameInScreen), 'ambiguous flattened sibling geometry');
        }
      }
    }
    return { text, textScope: screen ? 'ownedWindow' : flattened ? 'flattenedSiblingGeometry' : 'subtree', textNodePaths: parts.map(part => paths.get(part)),
      ...eligibility.get(node), visible: node.renderEligible || eligibility.get(node).scrollContentEligible };
  };
  return { facts, eligibility, paths };
}
