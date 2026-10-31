import test from 'node:test';
import assert from 'node:assert/strict';
import { otherFixture, otherCases, observedOtherBranches } from './uikit-probe-other-text-fixtures.js';
const nonText = ({ text, provenance, ...facts }) => facts;

for (const scenario of otherCases) test(scenario.name, () => {
  const fixture = otherFixture(scenario.change);
  if (scenario.unchanged) assert.deepEqual(fixture.result, fixture.before.response);
  else {
    const own = fixture.result.elements.find(item => item.anchor === 'test.action');
    assert.equal(own.text, scenario.text);
    assert.equal(fixture.result.elements.find(item => item.anchor === 'test.screen').text, `Visible heading ${scenario.text}`);
    assert.equal(own.provenance.originalAX.label, 'Accessible operation');
    assert.equal(own.provenance.textScope, 'subtree');
    assert.ok(own.provenance.textParts.length > 0);
    assert.ok(own.provenance.textParts.every(part => part.source === 'currentUIKitViewTree' && own.provenance.nativeNodePath.every((index, depth) => part.nativeNodePath[depth] === index)));
    for (const item of fixture.result.elements) {
      const original = fixture.response.elements.find(value => value.anchor === item.anchor);
      assert.deepEqual(nonText(item), nonText(original));
      if (original.provenance) assert.deepEqual(item.provenance.previousProvenance, original.provenance);
    }
  }
  assert.deepEqual(fixture.response, fixture.before.response);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
});

for (const { observation, fixture } of observedOtherBranches()) test(`recorded ${observation.sourceScene} avatar own text agrees with the actual profile character`, () => {
  const own = fixture.result.elements.find(item => item.anchor === observation.ax.identifier);
  assert.equal(own.text, observation.observedPublicText);
  assert.equal(own.role, 'other');
  assert.equal(own.provenance.originalAX.label, observation.ax.label);
  assert.equal(fixture.result.elements.find(item => item.anchor === 'test.container').text, `Visible heading ${observation.observedPublicText}`);
  for (const item of fixture.result.elements) assert.deepEqual(nonText(item), nonText(fixture.response.elements.find(value => value.anchor === item.anchor)));
  assert.deepEqual(fixture.response, fixture.before.response);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
});
