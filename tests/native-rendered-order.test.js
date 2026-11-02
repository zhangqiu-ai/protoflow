import test from 'node:test';
import assert from 'node:assert/strict';
import { subtreeText, layeredSubtreeText, elementText } from '../src/drivers/native-tree.js';
import { ownershipFixture } from './uikit-text-ownership-fixtures.js';
const frame = (x, y, width, height) => ({ x, y, width, height });
const text = (label, rect, extra = {}) => ({ type: 'staticText', label, frame: rect, children: [], ...extra });
const find = (node, id) => node.identifier === id ? node : (node.children ?? []).map(child => find(child, id)).find(Boolean);

test('opt-in rendered hierarchy preserves every original part reference including partial/zero text', () => {
  const value = text('0', frame(12, 20, 20, 20));
  const partial = text('Partly visible', frame(-600, 220, 800, 24));
  const hidden = text('Hidden', frame(10, 10, 20, 20), { visible: false });
  const input = { type: 'textField', frame: frame(10, 40, 20, 20), children: [] };
  Object.defineProperty(input, 'value', { get() { throw Error('private input read'); } });
  const tree = { type: 'window', frame: frame(0, 0, 1210, 834), children: [
    { type: 'other', frame: frame(0, 0, 1210, 834), children: [] }, value, partial, hidden, input,
  ] };
  let original, ordered;
  subtreeText(tree, { onTextParts: values => { original = values; } });
  const rendered = layeredSubtreeText(tree, { renderedHierarchy: true, onTextParts: values => { ordered = values; } });
  assert.equal(ordered.length, original.length);
  assert.ok(original.every(part => ordered.includes(part)));
  assert.ok(ordered.every(part => original.includes(part)));
  assert.ok(rendered.includes('0') && rendered.includes('Partly visible'));
  assert.ok(!rendered.includes('Hidden'));
});
test('ordinary ring wrapper retains its real place before an adjacent title', () => {
  const ring = { type: 'other', frame: frame(425, 609.5, 46, 46), children: [text('29', frame(439.5, 625, 16.5, 14.5))] };
  const title = text('Read a book', frame(485, 609.5, 570, 21));
  const tree = { type: 'other', frame: frame(411, 595.5, 688, 74), children: [ring, title] };
  assert.equal(subtreeText(tree, { renderedHierarchy: true }), '29 Read a book');
  assert.equal(subtreeText(tree), '29 Read a book');
});
test('ancestor exclusion is opt-in and cannot let a thumbnail own its ancestor aggregate', () => {
  const fixture = ownershipFixture('thumb'), thumb = find(fixture.rawAX, 'test.thumb');
  assert.equal(elementText(thumb, fixture.rawAX), 'C Card title Card subtitle');
  assert.equal(elementText(thumb, fixture.rawAX, undefined, { excludeAncestorLabels: true }), '');
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
});
