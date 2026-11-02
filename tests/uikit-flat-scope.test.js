import test from 'node:test';
import assert from 'node:assert/strict';
import { elementText } from '../src/drivers/native-tree.js';
import { recordedNote, recordedNoteFacts, flatScopeCases, scopeCaseFacts } from './uikit-flat-scope-fixtures.js';

test('reduced original compact note geometry reads only its own public parent captions', () => {
  const saved = structuredClone(recordedNote), facts = recordedNoteFacts();
  const note = facts.elements.find(item => item.anchor === 'ai.note');
  assert.equal(note.text, recordedNote.expectedNoteTextParts.join(' '));
  assert.equal(note.provenance.textScope, 'flattenedSiblingGeometry');
  for (const text of recordedNote.expectedNoteTextParts) assert.ok(facts.elements.find(item => item.anchor === 'ai.thread').text.includes(text));
  assert.deepEqual(recordedNote, saved);
});
for (const scenario of flatScopeCases) test(scenario.name, () => {
  if (scenario.error) { assert.throws(() => scopeCaseFacts(scenario), scenario.error); return; }
  const result = scopeCaseFacts(scenario), note = result.elements.find(item => item.anchor === 'test.note');
  assert.equal(note.text, scenario.expected);
  if (scenario.offscreen) { assert.equal(note.visible, true); assert.equal(note.provenance.renderEligible, false); assert.equal(note.provenance.scrollContentEligible, true); }
  for (const text of scenario.screenIncludes ?? []) assert.ok(result.elements.find(item => item.anchor === 'test.screen').text.includes(text));
});
test('default native-tree retains its original whole-tree geometry behavior', () => {
  const frame = { x: 0, y: 0, width: 400, height: 500 }, note = { type: 'other', identifier: 'flat', frame, children: [] };
  const text = label => ({ type: 'staticText', label, frame, children: [] });
  const root = { type: 'application', frame, children: [{ type: 'other', frame, children: [text('Background')] }, { type: 'other', frame, children: [note, text('Own')] }] };
  assert.equal(elementText(note, root), 'Background Own');
});
