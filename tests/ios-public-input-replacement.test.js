import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
const publicClear = source.slice(source.indexOf('private func clearPublicly('), source.indexOf('/// Typing can drop'));
const clearField = source.slice(source.indexOf('private func clearField('), source.indexOf('private func clearPublicly('));
const performFill = source.slice(source.indexOf('case "fill", "clear":'), source.indexOf('case "select":'));
const type = source.slice(source.indexOf('private func type(_ text:'), source.indexOf('private func serialize('));

test('nonsecure fill and clear replace the whole value while secure fields retain their old path', () => {
  assert.match(performFill, /target\.elementType == \.secureTextField[\s\S]*clear\(target\)[\s\S]*else if let reason = clearField\(target, app: app\)/);
  // Without the probe the original delete-key clear runs first; only text it leaves goes to Select All.
  assert.match(source, /publicReplacementOnly = job\.captureProbe != nil/);
  assert.match(clearField, /if !publicReplacementOnly \{\s*clear\(field\)\s*if fieldValue\(field\)\.isEmpty \|\| !\[\.textField, \.textView, \.searchField\]\.contains\(field\.elementType\) \{ return nil \}\s*\}\s*return clearPublicly\(field, app: app\)/);
  assert.match(publicClear, /\[\.textField, \.textView, \.searchField\]/);
  assert.match(publicClear, /if fieldValue\(field\)\.isEmpty \{ return nil \}/);
  assert.match(type, /if field\.elementType == \.secureTextField \{ return nil \}/);
});

test('public selection must exist and be hittable; no private setter or coordinate force-tap can bypass failure', () => {
  assert.match(publicClear, /app\.menuItems\["Select All"\]/);
  assert.match(publicClear, /app\.buttons\["Select All"\]/);
  assert.match(publicClear, /menu\.isEnabled && menu\.isHittable/);
  assert.match(publicClear, /button\.isEnabled && button\.isHittable/);
  assert.match(publicClear, /public Select All action is unavailable/);
  assert.doesNotMatch(publicClear, /setValue|performSelector|coordinate\(|withOffset|String\(repeating:/);
});

test('public replacement verifies empty before typing and every retry uses the same clearing path', () => {
  assert.match(publicClear, /field\.typeText\(XCUIKeyboardKey\.delete\.rawValue\)/);
  assert.match(publicClear, /fieldValue\(field\)\.isEmpty \? nil : "public Select All did not clear the complete input"/);
  assert.match(type, /for _ in 0\.\.<3[\s\S]*clearField\(field, app: app\)/);
  assert.doesNotMatch(type, /clear\(field\)/);
  assert.match(type, /shown == text \? nil :/);
});

const editMenu = source.slice(source.indexOf('// BEGIN PUBLIC EDIT MENU GEOMETRY:'), source.indexOf('/// Typing can drop'));

test('pagination requires a visible nonsecure field and an actual menu row, and inspects at most four pages', () => {
  assert.match(publicClear, /guard field\.exists && field\.isEnabled && field\.isHittable/);
  assert.match(publicClear, /for page in 0\.\.<4/);
  assert.match(publicClear, /app\.menuItems\.allElementsBoundByIndex\.filter \{ \$0\.exists && \$0\.isEnabled && \$0\.isHittable \}/);
  assert.match(publicClear, /guard page < 3, let forward = publicEditMenuForward\(app, items: items\)/);
  assert.match(publicClear, /forward\.tap\(\)/);
  assert.doesNotMatch(editMenu, /setValue|performSelector|coordinate\(|withOffset/);
});

test('a Forward button must be unique, enabled, hittable and share a measured AX edit-menu container', () => {
  assert.match(editMenu, /button\.label == "Forward" && button\.isEnabled && button\.isHittable/);
  assert.match(editMenu, /contains\(root, type: \.menuItem, label: menu\.label, frame: menu\.frame\)/);
  assert.match(editMenu, /contains\(root, type: \.button, label: "Forward", frame: forward\.frame\)/);
  assert.match(editMenu, /publicEditMenuForwardRow\(menu\.frame, forward\.frame, root\.frame\)/);
  assert.match(editMenu, /candidates\.count == 1 \? candidates\[0\] : nil/);
});

test('pagination cannot treat layout motion as progress or delete before Select All has actually been tapped', () => {
  assert.match(publicClear, /items\.map \{ \$0\.label \}\.sorted\(\)/);
  assert.match(publicClear, /guard pages\.insert\(signature\)\.inserted else \{ return "public edit menu did not advance" \}/);
  assert.match(publicClear, /guard selectedAll else[\s\S]*field\.typeText\(XCUIKeyboardKey\.delete\.rawValue\)/);
  assert.equal((publicClear.match(/field\.typeText\(XCUIKeyboardKey\.delete\.rawValue\)/g) ?? []).length, 1);
});
