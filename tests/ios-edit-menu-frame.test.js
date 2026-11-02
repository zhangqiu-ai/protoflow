import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../drivers/ios/UITests/CaptureTests.swift', import.meta.url), 'utf8');
const menu = source.slice(source.indexOf('private func publicEditMenuContainsForward('), source.indexOf('private func publicEditMenuForward('));

test('AX menu identity retains type and label checks while using the finite ULP frame comparator', () => {
  assert.match(menu, /node\.elementType == type && node\.label == label && publicEditMenuSameFrame\(node\.frame, frame\)/);
  assert.doesNotMatch(menu, /node\.frame == frame|PF_MENU_DIAGNOSTIC/);
  assert.match(source, /\/\/ BEGIN PUBLIC EDIT MENU FRAME IDENTITY:/);
  assert.match(source, /\/\/ END PUBLIC EDIT MENU FRAME IDENTITY/);
});
