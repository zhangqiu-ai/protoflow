/** Explicit scroll preconditions are separate from visual comparison thresholds. */
export function validateScrollSteps(steps = [], { requireUIKit = false, hasUIKit = false } = {}) {
  const anchors = [];
  for (const step of steps) {
    if (step.action !== 'scroll-to' || step.value === undefined) continue;
    if (!['start', 'end'].includes(step.value)) throw new Error('unsupported scroll-to value');
    if (typeof step.anchor !== 'string' || !step.anchor) throw new Error(`scroll-to ${step.value} needs an anchor`);
    if (requireUIKit && !hasUIKit) throw new Error(`scroll-to ${step.value} needs current UIKit probe`);
    if (anchors.includes(step.anchor)) throw new Error(`scroll-to ${step.value} anchor repeated`);
    anchors.push(step.anchor);
  }
  return anchors;
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const check = (value, reason) => { if (!value) throw new Error(`scroll-to end: ${reason}`); };

/** Called only after the original full probe pair has passed its provenance and equality checks. */
export function nativeScrollEnds(capture, steps = [], observations = []) {
  const anchors = validateScrollSteps(steps);
  if (!anchors.length) return [];
  check(capture?.windows?.length === 1, 'one owned window required');
  const window = capture.windows[0], scale = window.screenScale;
  check(finite(scale) && scale > 0, 'invalid physical scale');
  const nodes = [];
  const walk = (node, parents, path) => {
    check(node && typeof node === 'object' && path.length <= 65 && nodes.length < 2048, 'invalid or unbounded current tree');
    nodes.push({ node, parents, path });
    for (const [index, child] of (node.children ?? []).entries()) walk(child, [...parents, node], [...path, index]);
  };
  walk(window.tree, [], [0]);
  return anchors.map(anchor => {
    const endpoint = steps.find(step => step.action === 'scroll-to' && step.anchor === anchor && step.value !== undefined).value;
    const found = nodes.filter(item => item.node.identifier === anchor);
    check(found.length === 1, 'unique exact target required');
    const target = found[0];
    const observed = observations.filter(item => item.anchor === anchor);
    check(observed.length === 1 && observed[0].source === 'XCUIAutomation.publicScrollGesture' && observed[0].endpointVerified === false
      && (endpoint === 'start' ? observed[0].endpoint === 'start' : observed[0].endpoint === undefined || observed[0].endpoint === 'end'), 'unique public gesture observation required');
    const observation = observed[0];
    check(Number.isInteger(observation.gestureCount) && observation.gestureCount >= 1 && observation.gestureCount <= 10
      && Number.isInteger(observation.stationarySamples) && observation.stationarySamples >= 0 && observation.stationarySamples <= 2, 'invalid gesture bounds');
    check(target.node.attachedToWindow && !target.node.ancestorOrSelfHidden && target.node.renderEligible, 'target is not rendered');
    const ancestors = target.parents.filter(node => node.scrollGeometry?.isScrollView === true);
    check(ancestors.length === 1, ancestors.length > 1 ? 'nested scroll unsupported' : 'unique vertical scroll ancestor required');
    const scroll = ancestors[0], geometry = scroll.scrollGeometry, viewport = scroll.bounds;
    check(![...target.parents, target.node].some(node => node.transformed), 'transformed geometry unsupported');
    check(scroll.attachedToWindow && scroll.renderEligible && geometry.source === 'UIScrollView.publicGeometry' && geometry.scrollEnabled === true, 'scroll is not rendered and enabled');
    check(viewport && ['width', 'height'].every(key => finite(viewport[key]) && viewport[key] > 0), 'invalid viewport');
    check(['width', 'height'].every(key => finite(geometry.contentSize?.[key]) && geometry.contentSize[key] >= 0)
      && ['x', 'y'].every(key => finite(geometry.contentOffset?.[key])), 'invalid extent or offset');
    const inset = geometry.adjustedContentInset;
    check(inset && ['top', 'left', 'bottom', 'right'].every(key => finite(inset[key])), 'adjusted content inset required');
    const tolerance = 1 / scale;
    check(['x', 'y', 'width', 'height'].every(key => finite(observation.scrollFrame?.[key])
      && Math.abs(observation.scrollFrame[key] - scroll.frameInScreen?.[key]) <= tolerance
      && finite(observation.targetFrame?.[key]) && Math.abs(observation.targetFrame[key] - target.node.frameInScreen?.[key]) <= tolerance), 'public gesture scope changed');
    check(geometry.contentSize.width + inset.left + inset.right <= viewport.width + tolerance
      && Math.abs(geometry.contentOffset.x + inset.left) <= tolerance, 'horizontal scroll unsupported');
    const minimum = -inset.top;
    const maximum = Math.max(minimum, geometry.contentSize.height - viewport.height + inset.bottom);
    check(Math.abs(geometry.contentOffset.y - (endpoint === 'start' ? minimum : maximum)) <= tolerance, `not at scroll ${endpoint}`);
    return { anchor, ...(endpoint === 'start' && { endpoint }), nativeNodePath: nodes.find(item => item.node === scroll).path, source: geometry.source,
      screenScale: scale, tolerance, viewport: { width: viewport.width, height: viewport.height },
      contentSize: geometry.contentSize, adjustedContentInset: inset, contentOffset: geometry.contentOffset, minimum, maximum };
  });
}

/** DOM observations are read again after every remaining state step, including a modal-opening click. */
export async function webScrollEnd(page, attribute, anchor, { execute = false, endpoint = 'end' } = {}) {
  if (!['start', 'end'].includes(endpoint)) throw new Error('unsupported scroll-to value');
  return page.evaluate(({ attribute, anchor, execute, endpoint }) => {
    const reject = reason => { throw new Error(`scroll-to ${endpoint}: ${reason}`); };
    const matches = [...document.querySelectorAll(`[${attribute}]`)].filter(node => node.getAttribute(attribute) === anchor);
    if (matches.length !== 1) reject('unique exact target required');
    const target = matches[0], scrolls = [];
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (['auto', 'scroll'].includes(style.overflowY) && parent.clientHeight > 0) scrolls.push(parent);
    }
    if (scrolls.length !== 1) reject(scrolls.length > 1 ? 'nested scroll unsupported' : 'unique vertical scroll ancestor required');
    const scroll = scrolls[0], rect = scroll.getBoundingClientRect(), scale = devicePixelRatio;
    if (![rect.x, rect.y, rect.width, rect.height, scale].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || scale <= 0) reject('invalid viewport');
    for (let node = target; node; node = node.parentElement) if (getComputedStyle(node).transform !== 'none') reject('transformed geometry unsupported');
    if (scroll.scrollWidth > scroll.clientWidth || scroll.scrollLeft !== 0) reject('horizontal scroll unsupported');
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const destination = endpoint === 'start' ? 0 : maximum;
    if (execute) scroll.scrollTo({ top: destination, left: scroll.scrollLeft, behavior: 'instant' });
    if (Math.abs(scroll.scrollTop - destination) > 1 / scale) reject(`not at scroll ${endpoint}`);
    const targetRect = target.getBoundingClientRect();
    const visible = targetRect.width > 0 && targetRect.height > 0 && Math.min(targetRect.right, rect.right, innerWidth) > Math.max(targetRect.left, rect.left, 0)
      && Math.min(targetRect.bottom, rect.bottom, innerHeight) > Math.max(targetRect.top, rect.top, 0);
    if (!visible) reject('target is not rendered');
    for (let node = target; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility !== 'visible' || Number(style.opacity) <= 0) reject('target is not rendered');
    }
    return { anchor, ...(endpoint === 'start' && { endpoint, minimum: 0 }), source: 'DOM.scrollGeometry', viewport: { width: scroll.clientWidth, height: scroll.clientHeight },
      contentSize: { width: scroll.scrollWidth, height: scroll.scrollHeight }, contentOffset: { x: scroll.scrollLeft, y: scroll.scrollTop }, maximum, tolerance: 1 / scale };
  }, { attribute, anchor, execute, endpoint });
}
