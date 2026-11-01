export const page = { anchors: [
  { id: 'sample', role: 'screen', parent: null },
  { id: 'sample.value', role: 'element', parent: 'sample', dynamic: true },
] };
export const state = { expect: { visible: ['sample.panel', 'sample.row', 'sample.close'], hidden: [] } };
const rect = (x, y, width, height) => ({ x, y, width, height });
const leaf = (text, bounds, extra = {}) => ({ count: 1, visible: true, enabled: true, interactive: false, editable: false, inputType: null, text, bounds, ...extra });
export function shot({ value = 'shared-key', values = ['shared-key'], dom = false, wrong = false, missing = false, unknown = false, hidden = false, duplicate = false, input = false } = {}) {
  const names = values.map((x, i) => wrong && i === 0 ? 'wrong-key' : missing && i === 0 ? '' : x);
  const row = names.map(x => `Choice ${x}`).join(' '), panel = `Choices ${row} Done`;
  const elements = {
    sample: leaf(`Shell Current ${dom ? '' : value + ' '}${panel}`, rect(0, 0, 1210, 782)),
    'sample.value': leaf(value, rect(974, 394, 83, 18)),
    'sample.panel': leaf(panel, rect(399, 277.5, 412, 265)),
    'sample.row': leaf(row, rect(399, 368, 412, 64)),
    'sample.close': leaf('Done', rect(399, 496.5, 412, 46)),
  };
  if (dom) for (const item of Object.values(elements)) item.dynamicExcluded = true;
  if (unknown) for (const id of ['sample.panel', 'sample.row', 'sample.close']) { delete elements[id].editable; delete elements[id].inputType; }
  if (hidden) for (const id of ['sample.panel', 'sample.row']) elements[id].visible = false;
  if (duplicate) for (const id of ['sample.panel', 'sample.row']) elements[id].count = 2;
  if (input) for (const id of ['sample.panel', 'sample.row', 'sample.close']) { elements[id].editable = true; elements[id].inputType = 'text'; }
  return { viewport: { width: 1210, height: 782, scale: 1 }, elements };
}
export const cases = [
  ['one static occurrence survives an equal dynamic value', {}, 'PASS'],
  ['two static occurrences survive one equal dynamic value', { values: ['shared-key', 'shared-key'] }, 'PASS'],
  ['a genuinely changed dynamic value is still excluded', { value: 'changed-key' }, 'PASS'],
  ['a wrong static value remains a failure', { wrong: true }, 'FAIL'],
  ['a missing static value remains a failure', { missing: true }, 'FAIL'],
  ['unknown state-only editability supplies no evidence', { unknown: true }, 'FAIL'],
  ['hidden state-only scope cannot supply evidence', { hidden: true }, 'FAIL'],
  ['duplicate state-only scopes cannot supply evidence', { duplicate: true }, 'FAIL'],
  ['input state-only values cannot supply evidence', { input: true }, 'FAIL'],
];
export const html = ({ value = 'shared-key', values = ['shared-key'], wrong = false, missing = false, hidden = false, duplicate = false } = {}) => {
  const names = values.map((x, i) => wrong && i === 0 ? 'wrong-key' : missing && i === 0 ? '' : x);
  const row = `<div data-pf="sample.row">${names.map(x => `<span>Choice ${x}</span>`).join(' ')}</div>`;
  const panel = `<section data-pf="sample.panel"${hidden ? ' style="display:none"' : ''}>Choices ${row} <button data-pf="sample.close">Done</button></section>`;
  return `<!doctype html><main data-pf="sample">Shell Current <span data-pf="sample.value">${value}</span> ${panel}${duplicate ? panel : ''}</main>`;
};
