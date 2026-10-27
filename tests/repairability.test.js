import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailures, identicalFailures, failureKeys, functionalFailure, unrepairableSummary, UNREPAIRABLE_KINDS } from '../src/repairability.js';

const tier = (status, reasons = []) => ({ status, reasons });
const scene = (id, variant, tiers, extra = {}) => ({ id, variant, status: 'FAIL', tiers, ...extra });
const report = (scenes, extra = {}) => ({ id: 'VER-1', status: 'FAIL', build: { status: 'PASS' }, functional: { status: 'PASS' }, hygiene: { status: 'PASS' }, visual: { status: 'FAIL', scenes }, ...extra });
const SIZE = 'application viewport 834×1153@2 does not match requested 834×1166@2';
const SHOT = 'application screenshot 1668×2306 px does not match requested 1668×2332 px';
const APK = "APK apps/mobile/android/app/build/outputs/apk/release/app-release.apk does not exist; the target's build must produce it";
const TEXT = 'static text "張小明" expected at 1 row(s), found at 0';

test('each unrepairable kind is recognised from the scene reasons', () => {
  const cases = [
    ['capture-size', scene('nav.me.initial', 'ipad', { structure: tier('PASS'), tokens: tier('FAIL', [SIZE]), visual: tier('FAIL', [SIZE, SHOT]) })],
    ['build-output', scene('home', 'android', { structure: tier('FAIL', [APK]), tokens: tier('FAIL', [APK]), layout: tier('FAIL', [APK]), visual: tier('FAIL', [APK]) }, { reason: APK })],
    ['prototype-unreachable', scene('settings', null, {}, { reason: 'prototype state is unreachable: timeout waiting for selector' })],
    ['tier-off', scene('cart', null, { layout: tier('FAIL', ['tier is off for this target']) })]
  ];
  for (const [kind, item] of cases) {
    const classified = classifyFailures(report([item]));
    assert.deepEqual(classified.repairable, [], kind);
    assert.equal(classified.unrepairable.length, 1, kind);
    assert.equal(classified.unrepairable[0].kind, kind);
    assert.equal(classified.unrepairable[0].key, `scene:${item.variant ? `${item.variant}/` : ''}${item.id}`);
    assert.ok(classified.unrepairable[0].reasons.length >= 1);
    assert.ok(UNREPAIRABLE_KINDS[kind]);
  }
});

test('a scene with any application failure stays repairable, build/functional keys always do, and the summary names kinds', () => {
  const mixed = report([
    scene('nav.me.initial', 'iphone', { structure: tier('FAIL', [TEXT]), visual: tier('FAIL', [SIZE]) }),
    scene('nav.me.initial', 'ipad', { tokens: tier('FAIL', [SIZE]) }),
    scene('home', 'android', {}, { reason: APK })
  ], { build: { status: 'FAIL', variants: { android: { status: 'FAIL' }, iphone: { status: 'PASS' } } }, functional: { status: 'FAIL', stdout: '1) [chromium] › a.spec.ts:3\nError: boom' } });
  const classified = classifyFailures(mixed);
  assert.deepEqual(classified.repairable, ['build', 'functional', 'build:android', 'scene:iphone/nav.me.initial']);
  assert.deepEqual(classified.unrepairable.map(item => [item.key, item.kind]), [['scene:ipad/nav.me.initial', 'capture-size'], ['scene:android/home', 'build-output']]);
  assert.equal(unrepairableSummary(classified), 'capture-size: ipad/nav.me.initial; build-output: android/home');
  const many = { unrepairable: Array.from({ length: 11 }, (_, index) => ({ key: `scene:v/s${index}`, kind: 'capture-size', reasons: [SIZE] })) };
  assert.equal(unrepairableSummary(many), `capture-size: ${Array.from({ length: 8 }, (_, index) => `v/s${index}`).join(', ')} and 3 more`);
  assert.equal(unrepairableSummary({ unrepairable: [] }), '');
  // Empty tier reasons are not evidence of a config problem.
  assert.deepEqual(classifyFailures(report([scene('x', null, { structure: tier('FAIL') })])).repairable, ['scene:x']);
});

test('identicalFailures holds only when keys, verdicts, tiers and reasons all repeat', () => {
  const base = () => report([
    scene('nav.me.initial', 'iphone', { structure: tier('FAIL', [TEXT, ' second reason ']), layout: tier('PASS') }),
    scene('home', 'ipad', { tokens: tier('FAIL', [SIZE]) }, { reason: 'x' })
  ], { build: { status: 'PASS', variants: { iphone: { status: 'PASS' }, ipad: { status: 'PASS' } } }, functional: { status: 'FAIL', stdout: '1) [chromium] › a.spec.ts:3\nError: boom' } });
  const previous = base();
  const same = base();
  same.id = 'VER-2';
  same.visual.scenes[0].tiers.structure.reasons = [TEXT, 'second reason']; // whitespace only
  assert.equal(identicalFailures(previous, same), true);
  assert.equal(identicalFailures(null, same), false);
  assert.equal(identicalFailures(previous, undefined), false);
  const reason = base(); reason.visual.scenes[0].tiers.structure.reasons = [TEXT];
  assert.equal(identicalFailures(previous, reason), false);
  const added = base(); added.visual.scenes.push(scene('cart', null, { structure: tier('FAIL', [TEXT]) }));
  assert.equal(identicalFailures(previous, added), false);
  const functional = base(); functional.functional.stdout = '2) [chromium] › b.spec.ts:9\nError: boom';
  assert.equal(identicalFailures(previous, functional), false);
  const fixedTest = base(); fixedTest.functional = { status: 'PASS' };
  assert.equal(identicalFailures(previous, fixedTest), false);
  const variant = base(); variant.build.variants.ipad.status = 'FAIL';
  assert.equal(identicalFailures(previous, variant), false);
  const tierSwap = base(); tierSwap.visual.scenes[0].tiers = { structure: tier('PASS'), layout: tier('FAIL', [TEXT, 'second reason']) };
  assert.equal(identicalFailures(previous, tierSwap), false);
});

test('failureKeys and functionalFailure keep the runner shapes', () => {
  assert.deepEqual(failureKeys({ build: { status: 'FAIL', variants: { android: { status: 'FAIL' }, iphone: { status: 'PASS' } } } }), ['build', 'build:android']);
  assert.deepEqual(failureKeys({ visual: { status: 'FAIL' } }), ['visual']);
  assert.deepEqual(failureKeys({ visual: { status: 'FAIL', scenes: [{ id: 'a', status: 'FAIL' }, { id: 'b', variant: 'ipad', status: 'NOT_RUN' }, { id: 'c', status: 'PASS' }] } }), ['scene:a', 'scene:ipad/b']);
  assert.deepEqual(failureKeys({ functional: { status: 'PASS' }, changedDuringVerification: true }), ['changedDuringVerification']);
  assert.deepEqual(failureKeys(null), []);
  assert.equal(functionalFailure({ functional: { status: 'FAIL', stdout: 'noise\n  1) [chromium] › a.spec.ts:3 › x\n', stderr: 'TypeError: boom: x\n' } }), '1) [chromium] › a.spec.ts:3 › x — TypeError: boom: x');
  assert.equal(functionalFailure({ functional: { status: 'PASS', stdout: '1) nope' } }), null);
  assert.equal(functionalFailure({}), null);
});
