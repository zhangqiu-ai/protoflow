import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStructure } from '../src/tiers.js';
import { page, state, shot } from './state-only-text-fixtures.js';
const roles = ['textField', 'secureTextField', 'searchField', 'textView', 'switch', 'toggle', 'checkBox', 'radioButton', 'slider', 'stepper', 'picker', 'pickerWheel', 'datePicker', 'segmentedControl', 'input', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'listbox'];
for (const role of roles) for (const enabled of [true, false]) test(`state-only readonly ${role} enabled=${enabled} never reads text or value`, () => {
  const prototype = shot({ dom: true }), application = shot();
  const item = application.elements['sample.panel'];
  Object.assign(item, { role, editable: false, inputType: null, enabled });
  let reads = 0;
  for (const key of ['text', 'value']) Object.defineProperty(item, key, { get() { reads++; throw Error('private readonly input read'); } });
  assert.doesNotThrow(() => compareStructure(page, state, prototype, application, { native: true }));
  assert.equal(reads, 0);
});
for (const [name, actualRoot, observedScope] of [
  ['dynamic part starts outside and ends inside static scope', 'Lead joined edge tail', 'edge tail'],
  ['dynamic part starts inside and ends outside static scope', 'Lead joined edge tail', 'Lead joined'],
]) test(name + ' preserves every overlapping static character', () => {
  const prototype = shot({ dom: true }), application = shot();
  for (const capture of [prototype, application]) {
    capture.elements.sample.text = actualRoot;
    capture.elements['sample.value'].text = 'joined edge';
    capture.elements['sample.panel'].text = observedScope;
    capture.elements['sample.row'].text = '';
    capture.elements['sample.close'].text = '';
  }
  // A field value may be absent from its parent while the same words occur independently across a static
  // scope boundary. Equal observed parent strings must not lose those static characters through value removal.
  prototype.elements.sample.dynamicExcluded = true;
  const result = compareStructure(page, state, prototype, application, { native: true });
  const altered = result.reasons.find(reason => reason.startsWith('sample: text '));
  assert.equal(altered, undefined, 'a crossing value must not consume any observed static-span character');
});
