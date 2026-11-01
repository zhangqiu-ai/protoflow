import test from 'node:test';
import assert from 'node:assert/strict';
import { elementText, subtreeText, textWithin, layeredSubtreeText } from '../src/drivers/native-tree.js';
const frame = (x, y, width, height) => ({ x, y, width, height });
const text = (label, x, y) => ({ type: 'staticText', label, frame: frame(x, y, 100, 24) });
function tree() {
  const left = { type: 'other', frame: frame(0, 0, 200, 600), children: [text('Left top', 20, 20), text('Left bottom', 20, 550)] };
  const right = { type: 'other', frame: frame(200, 0, 800, 600), children: [text('Right top', 220, 20), text('Right bottom', 400, 350)] };
  const popup = { type: 'other', frame: frame(0, 0, 1000, 600), children: [text('Dialog', 300, 200), text('Confirm', 300, 350)] };
  return { type: 'window', frame: frame(0, 0, 1000, 600), children: [left, right, popup] };
}

test('legacy subtree/element text and default textWithin behavior remain unchanged beside the opt-in entry', () => {
  const root = tree();
  assert.equal(subtreeText(root), 'Left top Left bottom Dialog Confirm Right top Right bottom');
  assert.equal(elementText(root, root, undefined, { screen: true }), subtreeText(root));
  assert.equal(textWithin(root, root), '');
  assert.equal(textWithin(root, root, undefined, { includeContainerDescendants: false }), '');
  assert.equal(layeredSubtreeText(root), 'Left top Left bottom Right top Right bottom Dialog Confirm');
});

test('the opt-in layer reader returns original text-node references, without cloning or changing their fields', () => {
  const root = tree(), before = structuredClone(root), parts = [];
  layeredSubtreeText(root, { onTextParts: values => parts.push(...values) });
  const expected = root.children.flatMap(child => child.children);
  assert.equal(parts.length, expected.length);
  assert.ok(parts.every(part => expected.includes(part)));
  assert.deepEqual(root, before);
});

test('a text entry and its descendants are excluded without accessing input values or placeholders', () => {
  const root = tree();
  const input = { type: 'secureTextField', frame: frame(10, 100, 150, 40), children: [text('Input-only content', 20, 100)],
    get value() { throw new Error('private input value read'); }, get placeholder() { throw new Error('private placeholder read'); } };
  root.children[0].children.push(input);
  assert.equal(layeredSubtreeText(root), 'Left top Left bottom Right top Right bottom Dialog Confirm');
});

test('same-layer subtree order remains stable through ordinary empty wrappers with no text ownership guesses', () => {
  const root = tree(); root.children.pop();
  root.children[1] = { type: 'other', frame: root.children[1].frame, children: [root.children[1]] };
  root.children.push({ type: 'other', frame: root.frame, children: [] });
  assert.equal(layeredSubtreeText(root), 'Left top Left bottom Right top Right bottom');
});
