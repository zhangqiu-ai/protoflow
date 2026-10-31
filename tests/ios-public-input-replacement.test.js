import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
const publicClear = source.slice(source.indexOf('private func clearPublicly('), source.indexOf('/// Typing can drop'));
const performFill = source.slice(source.indexOf('case "fill", "clear":'), source.indexOf('case "select":'));
const type = source.slice(source.indexOf('private func type(_ text:'), source.indexOf('private func serialize('));

test('generic nonsecure fill and clear require public whole-value replacement while secure fields retain their old path', () => {
  assert.match(performFill, /target\.elementType == \.secureTextField[\s\S]*clear\(target\)[\s\S]*else if let reason = clearPublicly\(target, app: app\)/);
  assert.match(publicClear, /\[\.textField, \.textView, \.searchField\]/);
  assert.match(publicClear, /if fieldValue\(field\)\.isEmpty \{ return nil \}/);
  assert.match(type, /if field\.elementType == \.secureTextField \{ return nil \}/);
});

test('public selection must exist and be hittable; no private setter or coordinate force-tap can bypass failure', () => {
  assert.match(publicClear, /app\.menuItems\["Select All"\]/);
  assert.match(publicClear, /app\.buttons\["Select All"\]/);
  assert.match(publicClear, /guard menu\.isHittable else \{ return/);
  assert.match(publicClear, /guard button\.isHittable else \{ return/);
  assert.match(publicClear, /public Select All action is unavailable/);
  assert.doesNotMatch(publicClear, /setValue|performSelector|coordinate\(|withOffset|String\(repeating:/);
});

test('public replacement verifies empty before typing and every retry uses the same complete replacement path', () => {
  assert.match(publicClear, /field\.typeText\(XCUIKeyboardKey\.delete\.rawValue\)/);
  assert.match(publicClear, /fieldValue\(field\)\.isEmpty \? nil : "public Select All did not clear the complete input"/);
  assert.match(type, /for _ in 0\.\.<3[\s\S]*clearPublicly\(field, app: app\)/);
  assert.doesNotMatch(type, /clear\(field\)/);
  assert.match(type, /shown == text \? nil :/);
});
