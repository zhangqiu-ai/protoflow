import { test, expect } from '@playwright/test';
import { controlCases, controlFixture, summarizeControlCase, savedHomeFixture } from '../uikit-probe-control-fixtures.js';
import { recordedNote, recordedNoteFacts, flatScopeCases, scopeCaseFacts } from '../uikit-flat-scope-fixtures.js';

// Node Playwright regression of the actual public driver interpreter. No simulator/browser/provider is needed.
for (const scenario of controlCases) test(scenario.name, () => {
  const fixture = controlFixture(scenario.change);
  if (scenario.unchangedExisting) {
    for (const original of fixture.response.elements) expect(fixture.result.elements.find(item => item.anchor === original.anchor)).toEqual(original);
    expect(fixture.result.elements.find(item => item.anchor === 'test.title').text).toBe('Visible heading');
  } else if (scenario.unchanged) expect(fixture.result).toEqual(fixture.response);
  else {
    expect(summarizeControlCase(fixture)).toEqual(scenario.expected);
    expect(fixture.result.elements.find(item => item.anchor === 'test.action').provenance.originalAX.label).toBe('Accessible operation');
    for (const item of fixture.result.elements) {
      const original = fixture.response.elements.find(other => other.anchor === item.anchor);
      const { text, provenance, ...facts } = item;
      const { text: previousText, provenance: previousProvenance, ...originalFacts } = original;
      expect(facts).toEqual(originalFacts);
      if (provenance?.textCorrection) expect(provenance.source).toBe(item.anchor === 'test.action' ? 'currentUIKitViewTree' : 'derivedAXWithCurrentUIKitControlText');
      if (previousProvenance) expect(provenance.previousProvenance).toEqual(previousProvenance);
    }
  }
  expect(fixture.rawAX).toEqual(fixture.before.rawAX);
  expect(fixture.capture).toEqual(fixture.before.capture);
});

test('preserved real QA Home keeps AX facts and corrects the observed control text contributions', () => {
  const { saved, before, result } = savedHomeFixture();
  expect(saved).toEqual(before);
  expect(result.elements.find(item => item.anchor === 'ai.home.send').text).toBe('');
  expect(result.elements.find(item => item.anchor === 'ai.home.send').provenance.originalAX.label).toBe('Send');
  expect(result.elements.find(item => item.anchor === 'ai.home.composer').text).toBe('What’s on your mind? Use my growth data 3 goals · 3 tasks today');
  for (const item of result.elements) {
    const original = saved.response.elements.find(value => value.anchor === item.anchor);
    const { text, provenance, ...facts } = item;
    const { text: originalText, provenance: previousProvenance, ...originalFacts } = original;
    expect(facts).toEqual(originalFacts);
    if (provenance?.textCorrection) {
      if (item.anchor === 'ai.home') {
        expect(provenance.textCorrection).toBe('publicOwnedWindowScreenText');
        expect(provenance.source).toBe('currentUIKitViewTree');
        expect(provenance.textScope).toBe('ownedWindow');
        expect(provenance.fields).toEqual(['text']);
        expect(provenance.scopeNativeNodePath).toEqual([0]);
        const publicAt = at => at.slice(1).reduce((node, index) => node.children[index], saved.capture.windows[0].tree);
        expect(publicAt(provenance.nativeNodePath).identifier).toBe('ai.home');
        expect(provenance.textNodePaths.length).toBeGreaterThan(0);
        for (const at of provenance.textNodePaths) {
          const node = publicAt(at);
          expect(['UILabel.text', 'UIButton.currentTitle', 'RCTParagraphComponentView.attributedText']).toContain(node.textSource);
          expect(node.text).toBeTruthy();
          expect(node.inputRedacted || node.observedSemantics?.inputKind).toBeFalsy();
        }
        expect(provenance.originalAX.text).toBe(original.text);
        expect(provenance.previousProvenance.source).toBe('derivedAXWithCurrentUIKitControlText');
      } else expect(provenance.source).toBe(original.role === 'button' ? 'currentUIKitViewTree' : 'derivedAXWithCurrentUIKitControlText');
    }
    if (!provenance?.textCorrection) expect(item).toEqual(original);
  }
});

test('untrusted public semantic provenance cannot drive a correction', () => {
  expect(() => controlFixture(({ control }) => { control.observedSemantics.sources.rnRole = 'expectedPrototypeRole'; })).toThrow(/untrusted semantic source/);
});

// Pure Node Playwright driver regressions; these do not run UIKit or claim native acceptance.
test('recorded compact note keeps its public captions without borrowing the background scroll branch', () => {
  const before = structuredClone(recordedNote), facts = recordedNoteFacts();
  expect(facts.elements.find(item => item.anchor === 'ai.note').text).toBe(recordedNote.expectedNoteTextParts.join(' '));
  expect(recordedNote).toEqual(before);
});
for (const scenario of flatScopeCases) test(`parent scope: ${scenario.name}`, () => {
  if (scenario.error) { expect(() => scopeCaseFacts(scenario)).toThrow(scenario.error); return; }
  const facts = scopeCaseFacts(scenario), note = facts.elements.find(item => item.anchor === 'test.note');
  expect(note.text).toBe(scenario.expected);
  if (scenario.offscreen) { expect(note.provenance.scrollContentEligible).toBe(true); expect(note.provenance.renderEligible).toBe(false); }
  for (const text of scenario.screenIncludes ?? []) expect(facts.elements.find(item => item.anchor === 'test.screen').text).toContain(text);
});
