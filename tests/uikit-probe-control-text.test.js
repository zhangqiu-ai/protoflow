import test from 'node:test';
import assert from 'node:assert/strict';
import { controlCases, controlFixture, summarizeControlCase, savedHomeFixture } from './uikit-probe-control-fixtures.js';

for (const scenario of controlCases) test(scenario.name, () => {
  const fixture = controlFixture(scenario.change);
  const { result, response, before, rawAX, capture } = fixture;
  if (scenario.unchangedExisting) {
    for (const original of response.elements) assert.deepEqual(result.elements.find(item => item.anchor === original.anchor), original);
    assert.equal(result.elements.find(item => item.anchor === 'test.title').text, 'Visible heading');
  } else if (scenario.unchanged) assert.deepEqual(result, response);
  else {
    assert.deepEqual(summarizeControlCase(fixture), scenario.expected);
    for (const item of result.elements) {
      const original = response.elements.find(other => other.anchor === item.anchor);
      const { text, provenance, ...facts } = item;
      const { text: originalText, provenance: originalProvenance, ...originalFacts } = original;
      assert.deepEqual(facts, originalFacts, 'only text and provenance may change');
      if (provenance?.textCorrection) {
        assert.equal(provenance.originalAX.text, originalText);
        assert.equal(provenance.source, item.anchor === 'test.action' ? 'currentUIKitViewTree' : 'derivedAXWithCurrentUIKitControlText');
        if (originalProvenance) assert.deepEqual(provenance.previousProvenance, originalProvenance);
        assert.deepEqual(provenance.fields, ['text']);
        assert.ok(provenance.correctedControls.every(control => control.originalAXLabel === 'Accessible operation'));
      }
    }
    assert.equal(result.elements.find(item => item.anchor === 'test.action').provenance.originalAX.label, 'Accessible operation');
    assert.deepEqual(result.elements.find(item => item.anchor === 'test.title'), response.elements.find(item => item.anchor === 'test.title'));
  }
  assert.deepEqual(rawAX, before.rawAX);
  assert.deepEqual(response, before.response);
  assert.deepEqual(capture, before.capture);
});

test('without opt-in supplementation the default AX normalizer retains its original accessible-label behavior', () => {
  const { response } = controlFixture();
  assert.equal(response.elements.find(item => item.anchor === 'test.action').text, 'Accessible operation');
  assert.equal(response.elements.find(item => item.anchor === 'test.screen').text, 'Visible heading Accessible operation');
});

test('preserved real QA Home reinterprets only verified control contributions without changing other AX facts', () => {
  const { saved, before, result } = savedHomeFixture();
  assert.deepEqual(saved, before);
  const changed = result.elements.filter(item => item.text !== saved.response.elements.find(original => original.anchor === item.anchor).text);
  assert.deepEqual(changed.map(item => item.anchor), ['ai.home', 'ai.home.bar', 'ai.home.new', 'ai.home.composer', 'ai.home.send', 'ai.home.recent', 'ai.home.recent.1', 'ai.home.recent.2', 'ai.home.recent.3']);
  assert.equal(result.elements.find(item => item.anchor === 'ai.home.send').text, '');
  assert.equal(result.elements.find(item => item.anchor === 'ai.home.send').provenance.originalAX.label, 'Send');
  assert.equal(result.elements.find(item => item.anchor === 'ai.home.composer').text, 'What’s on your mind? Use my growth data 3 goals · 3 tasks today');
  for (const item of result.elements) {
    const original = saved.response.elements.find(value => value.anchor === item.anchor);
    const { text, provenance, ...facts } = item;
    const { text: originalText, provenance: previousProvenance, ...originalFacts } = original;
    assert.deepEqual(facts, originalFacts);
    if (provenance?.textCorrection) {
      assert.ok(provenance.textParts.every(part => part && Array.isArray(part.nativeNodePath)));
      assert.equal(provenance.source, original.role === 'button' ? 'currentUIKitViewTree' : 'derivedAXWithCurrentUIKitControlText');
    }
    else assert.deepEqual(item, original);
  }
});

test('untrusted public semantic provenance is rejected before any correction', () => {
  assert.throws(() => controlFixture(({ control }) => { control.observedSemantics.sources.rnRole = 'expectedPrototypeRole'; }), /untrusted semantic source/);
});
