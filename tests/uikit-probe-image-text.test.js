import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCases, imageFixture, imageCaptionConflictFixture, observedBranches, unconfirmedSiblingFixture } from './uikit-probe-image-text-fixtures.js';

const nonText = ({ text, provenance, ...facts }) => facts;
test('an image with AX descendants cannot change its own caption while ancestors retain the original child text', () => {
  const fixture = imageCaptionConflictFixture();
  const original = fixture.response.elements.find(item => item.anchor === 'test.action');
  const image = fixture.result.elements.find(item => item.anchor === 'test.action');
  const ancestor = fixture.result.elements.find(item => item.anchor === 'test.screen');
  assert.equal(original.text, 'AX caption A');
  assert.equal(ancestor.text, 'Visible heading AX caption A');
  assert.equal(image.text, original.text, 'image and ancestor must retain the same original AX caption');
  assert.deepEqual(fixture.result, fixture.before.response);
  assert.deepEqual(fixture.response, fixture.before.response);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
});

for (const scenario of imageCases) test(scenario.name, () => {
  const fixture = imageFixture(scenario.change), item = fixture.result.elements.find(value => value.anchor === 'test.action');
  if (scenario.unchanged) assert.deepEqual(fixture.result, fixture.before.response);
  else {
    assert.equal(item.text, scenario.text);
    assert.equal(item.role, 'image');
    assert.equal(item.provenance.originalAX.label, 'Accessible operation');
    for (const value of fixture.result.elements) assert.deepEqual(nonText(value), nonText(fixture.response.elements.find(original => original.anchor === value.anchor)));
  }
  assert.deepEqual(fixture.response, fixture.before.response);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
});

test('an unconfirmed unrelated subtree cannot become an empty-text candidate and invalidate observed icon text', () => {
  const fixture = unconfirmedSiblingFixture();
  assert.equal(fixture.result.elements.find(item => item.anchor === 'test.action').text, '');
  assert.deepEqual(fixture.result.elements.find(item => item.anchor === 'test.unconfirmed'), fixture.response.elements.find(item => item.anchor === 'test.unconfirmed'));
  assert.deepEqual(fixture.result.elements.find(item => item.anchor === 'test.unconfirmed.thumb'), fixture.response.elements.find(item => item.anchor === 'test.unconfirmed.thumb'));
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
});

for (const { observation, fixture } of observedBranches()) test(`recorded ${observation.ax.type} branch keeps its AX name and geometry while visible text follows current UIKit`, () => {
  const item = fixture.result.elements.find(value => value.anchor === observation.ax.identifier);
  assert.equal(item.text, '');
  assert.equal(item.provenance.originalAX.label, observation.ax.label);
  for (const value of fixture.result.elements) assert.deepEqual(nonText(value), nonText(fixture.response.elements.find(original => original.anchor === value.anchor)));
  assert.deepEqual(fixture.response, fixture.before.response);
  assert.deepEqual(fixture.rawAX, fixture.before.rawAX);
  assert.deepEqual(fixture.capture, fixture.before.capture);
});
