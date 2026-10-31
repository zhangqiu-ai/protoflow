import { createHash } from 'node:crypto';
import { interpretUIKitCapture } from './uikit-probe-text.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TEXT_SOURCES = new Set(['UILabel.text', 'UIButton.currentTitle', 'RCTParagraphComponentView.attributedText']);
const BUILD_KEYS = ['bundleIdentifier', 'shortVersion', 'buildVersion', 'reactNativeVersion', 'executableSha256', 'javascriptSha256'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const check = (condition, reason) => { if (!condition) throw new Error(`UIKit probe: ${reason}`); };
function sorted(value) {
  if (!value || typeof value !== 'object') return value;
  return Array.isArray(value) ? value.map(sorted) : Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}
const canonical = value => JSON.stringify(sorted(value));
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const rectangle = value => value && ['x', 'y', 'width', 'height'].every(key => finite(value[key])) && value.width >= 0 && value.height >= 0;

function bounded(value, depth = 0) {
  check(depth <= 200, 'response depth limit');
  if (typeof value === 'string') check(value.length <= 4096, 'string limit');
  if (typeof value === 'number') check(finite(value), 'nonfinite number');
  if (value && typeof value === 'object') for (const child of Object.values(value)) bounded(child, depth + 1);
}
const SEMANTIC_SOURCES = {
  userInteractionEnabled: ['UIView.userInteractionEnabled'], effectiveUserInteractionEnabled: ['currentUIKitAncestorInteraction'],
  buttonTrait: ['UIAccessibilityTraitsButton'], linkTrait: ['UIAccessibilityTraitsLink'], controlEnabled: ['UIControl.enabled'],
  inputKind: ['UIKit.publicType'], editable: ['UITextField.enabled', 'UITextView.editable'],
  rnRole: ['RCTComponentViewProtocol.props.ViewProps.role', 'RCTComponentViewProtocol.props.ViewProps.accessibilityRole'],
  rnDisabled: ['RCTComponentViewProtocol.props.ViewProps.accessibilityState.disabled']
};
function semanticFacts(node) {
  const facts = node.observedSemantics;
  if (!facts) return {};
  check(facts.sources && typeof facts.sources === 'object', 'semantic sources missing');
  const fields = Object.keys(facts).filter(key => key !== 'sources');
  check(fields.length === Object.keys(facts.sources).length, 'semantic source count mismatch');
  for (const key of fields) {
    check(SEMANTIC_SOURCES[key]?.includes(facts.sources[key]), 'untrusted semantic source');
    if (key === 'rnRole') check(['button', 'link', 'checkbox', 'radio', 'switch'].includes(facts[key]), 'unknown RN role');
    else if (key === 'inputKind') check(['textField', 'textView', 'switch'].includes(facts[key]), 'unknown native input kind');
    else check(typeof facts[key] === 'boolean', 'invalid semantic value');
  }
  check(typeof facts.userInteractionEnabled === 'boolean' && typeof facts.effectiveUserInteractionEnabled === 'boolean', 'interaction evidence missing');
  check(!facts.effectiveUserInteractionEnabled || facts.userInteractionEnabled, 'inconsistent interaction state');
  const role = facts.inputKind ?? facts.rnRole ?? (facts.buttonTrait ? 'button' : facts.linkTrait ? 'link' : null);
  const on = facts.effectiveUserInteractionEnabled === true;
  const editable = ['textField', 'textView'].includes(role) ? facts.editable === true && on : ['switch', 'checkbox', 'radio'].includes(role) && on;
  const output = { interactive: Boolean(role) && on, editable, role: ({ checkbox: 'checkBox', radio: 'radioButton' })[role] ?? role ?? 'other',
    inputType: ['switch', 'checkbox'].includes(role) ? 'checkbox' : role === 'radio' ? 'radio' : role === 'textField' ? 'text' : null };
  if (typeof facts.controlEnabled === 'boolean') output.enabled = facts.controlEnabled;
  if (typeof facts.rnDisabled === 'boolean') output.enabled = output.enabled !== false && !facts.rnDisabled;
  return output;
}

function validateCapture(capture, screenAnchor) {
  check(capture?.source === 'currentUIKitViewTree' && capture.occlusion === 'notComputed', 'unknown observation provenance');
  check(capture.windows?.length === 1, 'expected one owned window');
  const window = capture.windows[0];
  check(window.screenAnchor === screenAnchor && typeof window.sceneSession === 'string' && window.sceneSession, 'window correlation');
  for (const key of ['bounds', 'windowFrame', 'screenBounds']) check(rectangle(window[key]), `invalid window ${key}`);
  check(finite(window.screenScale) && window.screenScale > 0, 'invalid scale');
  check(window.tree?.attachedToWindow === true && window.tree.renderEligible === true, 'owned foreground window root is not attached/render eligible');
  let count = 0, anchored = false;
  const visit = (node, depth, parentHidden = false, parentAlpha = 1) => {
    check(node && typeof node === 'object' && depth <= 64 && ++count <= 2048, 'tree limit');
    check(typeof node.identifier === 'string' && typeof node.class === 'string', 'invalid node identity');
    if (node.identifier === screenAnchor) anchored = true;
    for (const key of ['frameInWindow', 'frameInScreen', 'bounds', 'clipIntersection']) check(rectangle(node[key]), `invalid geometry ${key}`);
    check(finite(node.alpha) && finite(node.effectiveAlpha) && Number.isInteger(node.order) && node.order >= 0, 'invalid node state');
    for (const key of ['hidden', 'ancestorOrSelfHidden', 'attachedToWindow', 'renderEligible', 'clipsToBounds', 'transformed']) check(typeof node[key] === 'boolean', `missing ${key}`);
    check(node.occlusion === 'notComputed' && node.clipMethod === 'axisAlignedBoundsIntersection', 'unknown visibility method');
    const rendered = node.attachedToWindow && !node.ancestorOrSelfHidden && node.effectiveAlpha > 0 && node.clipIntersection.width > 0 && node.clipIntersection.height > 0;
    check(node.renderEligible === rendered && node.ancestorOrSelfHidden === (parentHidden || node.hidden) && Math.abs(node.effectiveAlpha - parentAlpha * node.alpha) <= 1e-8, 'inconsistent rendered state');
    check(typeof node.text === 'string' && (node.textSource === 'none' || node.textSource === 'redactedInput' || TEXT_SOURCES.has(node.textSource)), 'unknown text provenance');
    check(!('value' in node) && !('accessibilityValue' in node), 'input value present');
    semanticFacts(node);
    if (node.inputRedacted) {
      check(node.text === '' && node.textSource === 'redactedInput' && !node.children && !('accessibilityLabel' in node), 'redacted input contains content');
      return;
    }
    check(node.textSource !== 'redactedInput' && (!node.text || TEXT_SOURCES.has(node.textSource)), 'text without public source');
    check(Array.isArray(node.children), 'missing current subviews');
    for (const child of node.children) visit(child, depth + 1, node.ancestorOrSelfHidden, node.effectiveAlpha);
  };
  visit(window.tree, 0);
  check(count === capture.nodeCount && anchored, 'node count or current screen anchor mismatch');
}

/** Validate unchanged current samples around the original AX/screenshot; never reconstruct observations. */
export function validateProbePair({ before, after, timing, expectedBuild, session }) {
  check(session && UUID.test(session.nonce) && /^CTX-[A-Za-z0-9_-]+$/.test(session.contextId), 'invalid session');
  for (const key of ['sceneId', 'screenAnchor']) check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session[key]), 'invalid scene');
  check(expectedBuild && Object.keys(expectedBuild).length === BUILD_KEYS.length && BUILD_KEYS.every(key => typeof expectedBuild[key] === 'string' && (key.endsWith('Sha256') ? /^[0-9a-f]{64}$/.test(expectedBuild[key]) : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(expectedBuild[key]))) && expectedBuild.reactNativeVersion === '0.86.3', 'invalid independent build identity');
  for (const sample of [before, after]) {
    check(sample && Buffer.byteLength(JSON.stringify(sample)) <= 2 * 1024 * 1024, 'response byte limit');
    bounded(sample);
    check(sample.schemaVersion === 1 && sample.status === 'OK' && sample.mainThread === true, `capture unavailable ${sample.reason ?? ''}`);
    check(sample.nonce === session.nonce && UUID.test(sample.sampleId) && canonical(sample.correlation) === canonical(session), 'session or sample mismatch');
    check(canonical(sample.actualBuild) === canonical(expectedBuild), 'actual installed build mismatch');
    check(finite(sample.startedAt) && finite(sample.finishedAt) && sample.startedAt <= sample.finishedAt, 'invalid sample time');
    validateCapture(sample.capture, session.screenAnchor);
  }
  check(before.sampleId !== after.sampleId, 'sample replay');
  const times = [before.finishedAt, timing?.axStartedAt, timing?.axFinishedAt, timing?.screenshotStartedAt, timing?.screenshotFinishedAt, after.startedAt];
  check(times.every(finite) && times.every((value, index) => !index || value >= times[index - 1]), 'AX/screenshot not bracketed');
  check(after.finishedAt - before.startedAt <= 10, 'expired capture bracket');
  const currentHash = hash(before.capture);
  check(currentHash === hash(after.capture), 'current tree changed during capture');
  return { capture: before.capture, hash: currentHash };
}

const allNodes = tree => [tree, ...(tree.children ?? []).flatMap(allNodes)];
/** Supplement missing facts without mutating AX evidence or inventing interaction semantics. */
export function supplementUIKitFacts(response, rawAX, capture, { anchors, screen, content }) {
  if (response.status !== 'PASS') return response;
  const window = capture.windows[0], nodes = allNodes(window.tree);
  const interpretation = interpretUIKitCapture(capture, semanticFacts);
  const byId = new Map();
  for (const node of nodes) if (node.identifier && (!node.inputRedacted || ['textField', 'textView'].includes(node.observedSemantics?.inputKind) && typeof node.observedSemantics?.editable === 'boolean')) byId.set(node.identifier, [...(byId.get(node.identifier) ?? []), node]);
  const existing = new Map((response.elements ?? []).map(item => [item.anchor, item]));
  const axIds = new Set(rawAX ? allNodes(rawAX).map(node => node.identifier).filter(Boolean) : []);
  const missing = anchors.filter(id => !existing.get(id)?.count);
  const paths = new Map();
  const locate = (node, at) => { paths.set(node, at); (node.children ?? []).forEach((child, index) => locate(child, [...at, index])); };
  locate(window.tree, [0]);
  const observedMissing = missing.filter(id => byId.has(id) && !axIds.has(id));
  if (!observedMissing.length) return response;
  const additions = [];
  const provenance = (fields, node, scope) => ({ source: 'currentUIKitViewTree', fields, occlusion: 'notComputed', textScope: scope,
    frameSource: 'frameInScreen', renderEligible: node.renderEligible, class: node.class, nativeNodePath: paths.get(node) });
  for (const id of observedMissing) {
    const found = byId.get(id), node = found[0], frame = node.frameInScreen;
    const semantic = semanticFacts(node);
    const textFacts = interpretation.facts(node, { screen: id === screen });
    const { text, visible, ...textEvidence } = textFacts;
    const derived = Object.keys(semantic).length ? semantic : { interactive: false, editable: false, role: TEXT_SOURCES.has(node.textSource) ? 'staticText' : 'other', inputType: null };
    additions.push({ anchor: id, count: found.length, visible: textFacts.visible, ...derived,
      bounds: id === screen ? { x: 0, y: 0, width: content.width, height: content.height }
        : { x: frame.x - content.x, y: frame.y - content.y, width: frame.width, height: frame.height },
      text: textFacts.text,
      provenance: { ...provenance(['count', 'visible', 'bounds', 'text', ...Object.keys(semantic)], node, id === screen ? 'ownedWindow' : 'subtree'), ...textEvidence, ...(node.observedSemantics && { semanticSources: node.observedSemantics.sources }) } });
  }
  const elements = (response.elements ?? []).map(item => {
    const found = byId.get(item.anchor);
    if (!found || found.length !== 1) return item;
    const node = found[0], scope = item.anchor === screen ? window.tree : node;
    if (!allNodes(scope).some(child => observedMissing.includes(child.identifier))) return item;
    const textFacts = interpretation.facts(node, { screen: item.anchor === screen });
    const { text, visible, ...evidence } = textFacts;
    return { ...item, text, provenance: { ...provenance(['text'], node, textFacts.textScope), ...evidence } };
  });
  const replaced = new Set(observedMissing);
  return { ...response, elements: [...elements.filter(item => !replaced.has(item.anchor)), ...additions],
    missing: missing.filter(id => !replaced.has(id)) };
}
