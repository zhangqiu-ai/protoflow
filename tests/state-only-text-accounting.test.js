import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStructure } from '../src/tiers.js';
import { page, state, shot, cases } from './state-only-text-fixtures.js';
for (const [name, changes, expected] of cases) test(name, () => {
  const options = { values: changes.values ?? ['shared-key'], dom: true };
  const prototype = shot(options), application = shot(changes), before = structuredClone({ page, state, prototype, application });
  assert.equal(compareStructure(page, state, prototype, application, { native: true }).status, expected);
  assert.deepEqual({ page, state, prototype, application }, before);
});
test('missing role is not synthesized and state visible remains presence-only', () => {
  const prototype = shot({ dom: true }), application = shot();
  assert.equal(compareStructure(page, state, prototype, application, { native: true }).status, 'PASS');
  for (const capture of [prototype, application]) for (const item of Object.values(capture.elements)) assert.equal(Object.hasOwn(item, 'role'), false);
  assert.deepEqual(state.expect.visible, ['sample.panel', 'sample.row', 'sample.close']);
});
test('existing declared static leaf is not counted twice through a state scope', () => {
  const contract = { anchors: [...page.anchors, { id: 'sample.row', parent: 'sample', role: 'element' }] };
  assert.equal(compareStructure(contract, state, shot({ dom: true }), shot(), { native: true }).status, 'PASS');
});
test('no state-only scope does not claim the unobserved static ownership is resolved', () => {
  assert.equal(compareStructure(page, { expect: { visible: [], hidden: [] } }, shot({ dom: true }), shot(), { native: true }).status, 'FAIL');
});

test('ambiguous full scope spans do not select an occurrence by value', () => {
  const prototype = shot({ dom: true }), application = shot();
  application.elements.sample.text += ' ' + application.elements['sample.panel'].text;
  assert.equal(compareStructure(page, state, prototype, application, { native: true }).status, 'FAIL');
});
test('a state-only input does not have its private text/value inspected for accounting', () => {
  const prototype = shot({ dom: true }), application = shot({ input: true });
  for (const id of state.expect.visible) for (const key of ['text', 'value']) Object.defineProperty(application.elements[id], key, { get() { throw Error('private state-only input read'); } });
  assert.equal(compareStructure(page, state, prototype, application, { native: true }).status, 'FAIL');
});
