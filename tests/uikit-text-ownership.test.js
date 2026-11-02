import test from 'node:test';
import assert from 'node:assert/strict';
import { ownershipFixture, fact } from './uikit-text-ownership-fixtures.js';
const immutable = fixture => {
  assert.deepEqual(fixture.capture, fixture.before.capture);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.response, fixture.before.response);
  const rest = ({ text, provenance, ...item }) => item;
  for (const item of fixture.response.elements) assert.deepEqual(rest(fact(fixture, item.anchor)), rest(item));
};
for (const [kind, id, expected] of [
  ['row', 'test.container', '29 Read a book 7 sessions Later C together'],
  ['usage', 'test.screen', 'Available today 18 text replies 3 images Resets tomorrow At limit, stop.'],
  ['footer', 'test.screen', 'Save Growth Together AI Chats Me'],
  ['thumb', 'test.thumb', ''],
  ['path', 'test.path', 'Path heading Path detail'],
]) test(`${kind}: correlated rendered text keeps its real owner and hierarchy`, () => {
  const fixture = ownershipFixture(kind);
  assert.equal(fact(fixture, id).text, expected);
  immutable(fixture);
});
test('validated nested-scroll parent uses its own public text without the ancestor aggregate', () => {
  const fixture = ownershipFixture('thumb');
  assert.equal(fact(fixture, 'test.action').text, 'Card title Card subtitle');
  immutable(fixture);
});

const find = (node, id) => node.identifier === id ? node : (node.children ?? []).map(child => find(child, id)).find(Boolean);
for (const [name, change] of [
  ['frame mismatch', fixture => { find(fixture.rawAX, 'test.path').frame.x += 1; }],
  ['missing role observation', fixture => { const node = find(fixture.tree, 'test.path'); delete node.observedSemantics.buttonTrait; delete node.observedSemantics.sources.buttonTrait; }],
  ['conflicting role', fixture => { find(fixture.tree, 'test.path').observedSemantics.buttonTrait = true; }],
  ['hidden current owner', fixture => { Object.assign(find(fixture.tree, 'test.path'), { hidden: true, ancestorOrSelfHidden: true, renderEligible: false }); }],
  ['different original observation', fixture => { fixture.changeResponse = response => { response.elements.find(item => item.anchor === 'test.path').text = 'Different observation'; }; }],
  ['input-containing owner', fixture => {
    const input = fixture.uikit('', '', [], fixture.rect(450, 750, 30, 20), { inputRedacted: true, textSource: 'redactedInput' });
    delete input.children; find(fixture.tree, 'test.path').children.push(input);
  }],
]) test(`direct current text cannot bypass ${name}`, () => {
  const fixture = ownershipFixture('path', change);
  assert.equal(fact(fixture, 'test.path').text, fixture.before.response.elements.find(item => item.anchor === 'test.path').text);
  immutable(fixture);
});
test('genuine same-rectangle flattened peer ambiguity remains rejected', () => {
  assert.throws(() => ownershipFixture('path', fixture => {
    const owner = find(fixture.tree, 'test.path');
    const locate = node => {
      if ((node.children ?? []).includes(owner)) return node;
      return (node.children ?? []).map(locate).find(Boolean);
    };
    const peer = structuredClone(owner); peer.identifier = 'test.peer';
    locate(fixture.tree).children.push(peer);
  }), /ambiguous flattened sibling geometry/);
});

test('a correlated parent cannot bypass a contributor role mismatch', () => {
  const fixture = ownershipFixture('row', value => {
    const node = find(value.tree, 'test.action');
    node.observedSemantics.rnRole = 'link';
    node.observedSemantics.sources.rnRole = 'RCTComponentViewProtocol.props.ViewProps.accessibilityRole';
  });
  assert.equal(fact(fixture, 'test.container').text, fixture.before.response.elements.find(item => item.anchor === 'test.container').text);
  immutable(fixture);
});
