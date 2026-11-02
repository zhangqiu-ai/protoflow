import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStructure } from '../src/tiers.js';
const screen = { anchors: [
  { id: 'sample', role: 'screen', parent: null },
  { id: 'sample.static', role: 'element', parent: 'sample' },
  { id: 'sample.dynamic', role: 'element', parent: 'sample', dynamic: true },
] };
const state = { expect: { visible: [], hidden: [] } };
const fact = (text, role = 'element') => ({ text, role, count: 1, visible: true, enabled: true, editable: false, interactive: false, inputType: null, bounds: { x: 0, y: 0, width: 100, height: 20 } });
function shot({ dom = false, dynamic = 'same-key', fixed = 'same-key', omitDynamic = false, reverse = false } = {}) {
  return { elements: {
    sample: { ...fact(reverse ? `Body ${dom || omitDynamic ? '' : dynamic} Sidebar ${fixed}` : `Sidebar ${fixed} Body ${dom || omitDynamic ? '' : dynamic}`, 'screen'), dynamicExcluded: dom },
    'sample.static': fact(fixed),
    'sample.dynamic': fact(dynamic),
  } };
}
for (const [name, options, expected] of [
  ['true static leaf before equal dynamic content', {}, 'PASS'],
  ['true static leaf before changed dynamic content', { dynamic: 'changed-key' }, 'PASS'],
  ['input omitted from parent cannot consume the only static text', { omitDynamic: true }, 'PASS'],
  ['wrong visible static leaf remains a failure', { fixed: 'wrong-key' }, 'FAIL'],
  ['missing visible static leaf remains a failure', { fixed: '' }, 'FAIL'],
]) test(name, () => assert.equal(compareStructure(screen, state, shot({ dom: true }), shot(options), { native: true }).status, expected));
test('old count accounting does not claim reverse-order ownership', () => {
  assert.equal(compareStructure(screen, state, shot({ dom: true, reverse: true }), shot({ reverse: true }), { native: true }).status, 'FAIL');
});
