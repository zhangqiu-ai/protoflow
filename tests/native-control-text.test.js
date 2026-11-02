import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorFacts, elementText, subtreeText } from '../src/drivers/native-tree.js';
import { compareStructure } from '../src/tiers.js';

const frame = (x, y, width, height) => ({ x, y, width, height });
const text = (label, identifier, x = 20) => ({ type: 'staticText', label, identifier, frame: frame(x, 20, 100, 20) });
const chip = children => ({ type: 'switch', identifier: 'settings.context', label: 'Accessibility name only', value: '1', frame: frame(10, 10, 360, 44), children });

test('a composite native control reads visible staticText descendants, not its accessible name or state', () => {
  const label = text('Use my growth data', 'settings.context.label');
  // XCUITest can repeat a Text's label in a nested staticText node.
  label.children = [{ ...label, identifier: '' }];
  const control = chip([
    { type: 'other', label: 'Wrapper name', children: [text('3 goals', 'settings.context.summary', 180)] },
    label,
    { type: 'button', label: 'Accessibility-only icon' },
    { type: 'other', label: 'Accessibility-only leaf' }
  ]);
  assert.equal(elementText(control), 'Use my growth data 3 goals');
  assert.equal(subtreeText({ type: 'other', children: [control] }), 'Use my growth data 3 goals');
  const container = { type: 'other', frame: frame(0, 0, 400, 100) };
  assert.equal(elementText(container, { type: 'application', children: [container, control] }), 'Use my growth data 3 goals');
});

test('leaf native controls never infer text from their label, value, width or nearby text', () => {
  for (const type of ['switch', 'toggle', 'checkBox', 'radioButton', 'slider', 'stepper', 'picker', 'pickerWheel', 'datePicker', 'segmentedControl']) {
    for (const width of [51, 360]) {
      const control = { ...chip([]), type, frame: frame(10, 10, width, 44) };
      const tree = { type: 'application', children: [control, text('Nearby visible text', 'settings.other')] };
      assert.equal(elementText(control, tree), '', `${type} width=${width}`);
    }
  }
});

test('a control does not read hidden descendants or text-entry values and never falls back to its label', () => {
  const control = chip([
    { ...text('Hidden direct label', 'hidden'), visible: false },
    { type: 'other', visible: false, children: [text('Hidden by ancestor', 'hidden.parent')] },
    { type: 'secureTextField', value: 'private input', children: [text('private input', 'field.child')] },
    { type: 'button', label: 'Not static text' },
    { type: 'staticText', label: '' }
  ]);
  assert.equal(elementText(control), '');
  assert.equal(elementText({ ...chip([text('Hidden control label', 'hidden.control')]), visible: false }), '');
});

const contract = { anchors: [
  { id: 'settings', role: 'screen', parent: null },
  { id: 'settings.context', role: 'action', parent: 'settings' },
  { id: 'settings.context.label', role: 'element', parent: 'settings.context' },
  { id: 'settings.context.summary', role: 'element', parent: 'settings.context', dynamic: true }
] };
const capture = (label, summary) => {
  const control = chip([text(label, 'settings.context.label'), text(summary, 'settings.context.summary', 180)]);
  const tree = { type: 'other', identifier: 'settings', frame: frame(0, 0, 400, 100), children: [control] };
  return { elements: Object.fromEntries(anchorFacts(tree, {
    anchors: contract.anchors.map(anchor => anchor.id), screen: 'settings', content: tree.frame
  }).elements.map(item => [item.anchor, item])) };
};

test('dynamic descendant anchors are excluded by the existing structure comparison, while static text still fails', () => {
  const prototype = capture('Use my growth data', '1 goal');
  for (const [id, element] of Object.entries(prototype.elements)) {
    element.dynamicExcluded = true;
    if (id !== 'settings.context.summary') element.text = 'Use my growth data';
  }
  assert.equal(compareStructure(contract, {}, prototype, capture('Use my growth data', '3 goals'), { native: true }).status, 'PASS');
  // The dynamic value can repeat the static label without removing the actual label.
  assert.equal(compareStructure(contract, {}, prototype, capture('Use my growth data', 'Use my growth data'), { native: true }).status, 'PASS');
  const wrong = compareStructure(contract, {}, prototype, capture('Different visible label', '3 goals'), { native: true });
  assert.equal(wrong.status, 'FAIL');
  assert.ok(wrong.reasons.some(reason => reason.startsWith('settings.context: text')));
});

test('a composite control with only a dynamic summary cannot masquerade as a visible main label', () => {
  const prototype = capture('Use my growth data', '1 goal');
  for (const [id, element] of Object.entries(prototype.elements)) {
    element.dynamicExcluded = true;
    if (id !== 'settings.context.summary') element.text = 'Use my growth data';
  }
  const application = capture('', '3 goals');
  const result = compareStructure(contract, {}, prototype, application, { native: true });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.reasons.includes('settings.context: text "Use my growth data" vs ""'));
});

test('a segmented control reads the titles its segments draw, which XCUITest reports as buttons', () => {
  const segments = ['Day', 'Week', 'Month'].map((label, index) => ({ type: 'button', label, frame: frame(10 + index * 100, 50, 100, 30) }));
  const control = { type: 'segmentedControl', identifier: 'stats.range', label: 'Range', frame: frame(10, 50, 300, 30), children: segments };
  const tree = { type: 'other', identifier: 'stats', frame: frame(0, 0, 400, 100), children: [text('Stats', 'stats.title'), control] };
  assert.equal(elementText(control), 'Day Week Month');
  assert.equal(subtreeText(tree), 'Stats Day Week Month');
  // A switch's button descendants are still not its text.
  assert.equal(elementText({ ...control, type: 'switch' }), '');
});
